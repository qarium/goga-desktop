import {
  openConflictDraft,
  applyConflictBlock,
} from "../src/renderer/git-conflict-draft";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { NodeRunner, CommandExitError } from "../src/host/process";
import { GitWorkspaceReader } from "../src/host/git-workspace-reader";
import { GitConflictReader } from "../src/host/git-conflicts";

vi.mock("node:fs/promises", { spy: true });
vi.setConfig({ testTimeout: 15000 });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
type Input =
  string | Buffer | null | { mode: "120000" | "160000"; value: string };
async function fixture(
  inputs: [Input, Input, Input],
  working: string | Buffer | null = "user edited working text\n",
) {
  const dir = await fs.mkdtemp("/private/tmp/goga-conflicts-");
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "repo"),
    home = path.join(dir, "home");
  await fs.mkdir(root);
  await fs.mkdir(home);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "",
  };
  for (const key of Object.keys(process.env))
    if (key.startsWith("GIT_") && !(key in env)) env[key] = undefined;
  const runner = new NodeRunner(10000, env);
  cleanup.push(() => runner.dispose());
  const git = (args: string[], options?: { stdin?: string }) =>
    runner.command(
      "git",
      ["-c", "core.hooksPath=/dev/null", ...args],
      root,
      env,
      options?.stdin,
    );
  await git(["init", "-b", "main"]);
  await fs.writeFile(path.join(root, "a"), "initial\n");
  await git(["add", "a"]);
  await git(["commit", "-m", "fixture"]);
  const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
  await git(["update-index", "--force-remove", "a"]);
  const oids: (string | null)[] = [];
  let index = "";
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    if (input === null) {
      oids.push(null);
      continue;
    }
    const special =
      !Buffer.isBuffer(input) && typeof input === "object" ? input : null;
    const mode = special?.mode ?? "100644";
    const file = path.join(dir, `stage-${i}`);
    await fs.writeFile(
      file,
      special ? special.value : (input as string | Buffer),
    );
    const oid =
      mode === "160000"
        ? head
        : (await git(["hash-object", "-w", "--", file])).stdout.trim();
    oids.push(oid);
    index += `${mode} ${oid} ${i + 1}\ta\n`;
  }
  await git(["update-index", "--index-info"], { stdin: index });
  if (working === null) await fs.unlink(path.join(root, "a"));
  else await fs.writeFile(path.join(root, "a"), working);
  const verify = vi.fn(async () => {}),
    calls: string[][] = [];
  let intercept: ((args: string[]) => Promise<void>) | undefined;
  const context = {
    scope: "project",
    root,
    ownerKey: "owner",
    verify,
    git: async (args: string[]) => {
      calls.push(args);
      await intercept?.(args);
      return git(args);
    },
    snapshot: async () => workspace.snapshot(),
  };
  const workspace = new GitWorkspaceReader({
    scope: "project",
    root,
    verify,
    git: async (args) => (await git(args)).stdout,
  });
  const reader = new GitConflictReader({
    context: async (_scope, fn) => fn(context),
  });
  const read = async () =>
    reader.read({
      scope: "project",
      path: "a",
      revision: (await workspace.snapshot()).revision,
    });
  return {
    dir,
    root,
    git,
    oids,
    calls,
    reader,
    workspace,
    read,
    context,
    intercept: (fn: typeof intercept) => {
      intercept = fn;
    },
  };
}

describe("verified read-only Git conflict model", () => {
  it("reads verified stages and native three-way blocks without replacing edited working text", async () => {
    const f = await fixture([
      "before\nbase\nafter\n",
      "before\ncurrent\nafter\n",
      "before\nincoming\nafter\n",
    ]);
    const before = await fs.readFile(path.join(f.root, ".git/index"));
    const result = await f.read();
    expect(result.base).toMatchObject({
      oid: f.oids[0],
      mode: "100644",
      kind: "text",
      text: "before\nbase\nafter\n",
    });
    expect(result.current.oid).toBe(f.oids[1]);
    expect(result.incoming.oid).toBe(f.oids[2]);
    expect(result.working).toMatchObject({
      kind: "text",
      text: "user edited working text\n",
    });
    expect(result.generated).toMatchObject({
      kind: "text",
      requiresExplicitReconstruction: true,
    });
    if (result.generated.kind !== "text") throw Error("model missing");
    expect(result.generated.blocks).toHaveLength(1);
    const block = result.generated.blocks[0];
    expect(block.current).toEqual({
      text: "current\n",
      range: { from: 7, to: 15 },
    });
    expect(block.base).toEqual({ text: "base\n", range: { from: 7, to: 12 } });
    expect(block.incoming.text).toBe("incoming\n");
    expect(
      result.generated.text.slice(block.resultRange.from, block.resultRange.to),
    ).toContain("current\n");
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(before);
    expect(await fs.readFile(path.join(f.root, "a"), "utf8")).toBe(
      "user edited working text\n",
    );
    expect(
      f.calls
        .filter((args) => args.includes("cat-file"))
        .every((args) => f.oids.includes(args.at(-1)!)),
    ).toBe(true);
  });
  it("keeps literal marker lines as content and independently maps repeated conflict blocks", async () => {
    const common = Array.from({ length: 12 }, (_, i) => `shared-${i}\n`).join(
      "",
    );
    const literal =
      "<<<<<<< literal\n||||||| literal\n=======\n>>>>>>> literal\n";
    const f = await fixture([
      `${literal}base\n${common}base\n`,
      `${literal}same\n${common}same\n`,
      `${literal}other\n${common}other\n`,
    ]);
    const result = await f.read();
    if (result.generated.kind !== "text") throw Error("model missing");
    expect(result.generated.blocks).toHaveLength(2);
    expect(new Set(result.generated.blocks.map((b) => b.id)).size).toBe(2);
    for (const block of result.generated.blocks) {
      expect(block.current.text).toBe("same\n");
      expect(
        result.current.text!.slice(
          block.current.range!.from,
          block.current.range!.to,
        ),
      ).toBe("same\n");
    }
    expect(result.generated.blocks[0].current.range!.from).toBe(literal.length);
    expect(result.generated.blocks[1].current.range!.from).toBe(
      literal.length + 5 + common.length,
    );
    expect(result.generated.text.startsWith(literal)).toBe(true);
    expect(Object.isFrozen(result.generated.blocks[0])).toBe(true);
  });
  it("does not invent a first occurrence range for ambiguous identical payloads", async () => {
    const common = Array.from({ length: 12 }, (_, i) => `shared-${i}\n`).join(
      "",
    );
    const f = await fixture([
      `same\n${common}base\n`,
      `same\n${common}same\n`,
      `same\n${common}other\n`,
    ]);
    const result = await f.read();
    if (result.generated.kind !== "text") throw Error("model missing");
    expect(result.generated.blocks[0].current).toEqual({
      text: "same\n",
      range: null,
    });
  });
  it.each(["\n", "\r\n"])(
    "preserves exact %j endings and no-final-newline side payloads",
    async (eol) => {
      const f = await fixture(
        [`header${eol}base`, `header${eol}ours`, `header${eol}theirs`],
        `edited${eol}without-final`,
      );
      const result = await f.read();
      expect(result.working.text).toBe(`edited${eol}without-final`);
      expect(result.current.text).toBe(`header${eol}ours`);
      if (result.generated.kind !== "text") throw Error("model missing");
      expect(result.generated.blocks[0].current).toEqual({
        text: "ours",
        range: { from: 6 + eol.length, to: 10 + eol.length },
      });
      expect(result.generated.text.startsWith(`header${eol}`)).toBe(true);
    },
  );
  it("handles add/add with an absent base and preserves an empty existing version", async () => {
    const f = await fixture([null, "ours\n", "theirs\n"]);
    const result = await f.read();
    expect(result.base).toEqual({ oid: null, mode: null, kind: "absent" });
    if (result.generated.kind !== "text") throw Error("model missing");
    expect(result.generated.blocks[0].base).toEqual({
      text: "",
      range: { from: 0, to: 0 },
    });
    const empty = await fixture(["base\n", "", "incoming\n"]);
    expect((await empty.read()).current).toMatchObject({
      kind: "text",
      text: "",
      mode: "100644",
    });
  });
  it.each([0, 1])(
    "keeps modify/delete stage absence explicit (%i)",
    async (side) => {
      const f = await fixture(
        side ? ["base\n", "current\n", null] : ["base\n", null, "incoming\n"],
        null,
      );
      const result = await f.read();
      expect(side ? result.incoming.kind : result.current.kind).toBe("absent");
      expect(result.working.kind).toBe("absent");
      expect(result.generated.kind).toBe("unavailable");
    },
  );
  it.each([Buffer.from([0, 1, 2]), Buffer.from([0xff, 0xfe])])(
    "does not expose binary or invalid UTF-8 blobs as editable text",
    async (bytes) => {
      const f = await fixture(["base\n", bytes, "incoming\n"], bytes);
      const result = await f.read();
      expect(result.current).toMatchObject({ kind: "binary", oid: f.oids[1] });
      expect(result.current.text).toBeUndefined();
      expect(result.working.kind).toBe("binary");
      expect(result.generated.kind).toBe("unavailable");
    },
  );
  it.each(["120000", "160000"] as const)(
    "reports special index mode %s without opening targets",
    async (mode) => {
      const input = { mode, value: "/private/tmp/never-open-this-target" };
      const f = await fixture([input, input, input]);
      const result = await f.read();
      expect(result.current.kind).toBe(
        mode === "120000" ? "symlink" : "submodule",
      );
      expect(result.generated.kind).toBe("unavailable");
      expect(f.calls.some((args) => args.includes("cat-file"))).toBe(false);
    },
  );
  it("does not reconstruct over a symlink working file", async () => {
    const f = await fixture(["base\n", "ours\n", "theirs\n"], null);
    const target = path.join(f.dir, "outside");
    await fs.writeFile(target, "private\n");
    await fs.symlink(target, path.join(f.root, "a"));
    const result = await f.read();
    expect(result.working.kind).toBe("symlink");
    expect(result.generated.kind).toBe("unavailable");
    expect(await fs.readFile(target, "utf8")).toBe("private\n");
  });
  it("rejects stale revisions, mismatched owner, and a staged-content race", async () => {
    const f = await fixture(["base\n", "ours\n", "theirs\n"]);
    const request = { scope: "project", path: "a", revision: "0".repeat(64) };
    await expect(f.reader.read(request)).rejects.toThrow(/устарел/);
    f.context.scope = "different";
    await expect(f.read()).rejects.toThrow(/контекст/);
    f.context.scope = "project";
    let done = false;
    f.intercept(async (args) => {
      if (!done && args.includes("cat-file")) {
        done = true;
        await fs.writeFile(path.join(f.root, "a"), "new user edit\n");
      }
    });
    await expect(f.read()).rejects.toThrow(/устарел/);
  });
  it("fails closed on a malformed native conflict exit and cleans up only temporary inputs", async () => {
    const f = await fixture(["base\n", "ours\n", "theirs\n"]);
    let temporary = "";
    f.intercept(async (args) => {
      if (args.includes("merge-file")) {
        temporary = path.dirname(args.at(-1)!);
        throw new CommandExitError(
          "private stderr must not escape",
          1,
          "garbage\n",
          "",
        );
      }
    });
    await expect(f.read()).rejects.toThrow(/Некорректный/);
    expect(temporary).not.toBe(f.root);
    await expect(fs.stat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("bounds input sizes before reading a blob or attempting a generated model", async () => {
    const f = await fixture([
      "base\n",
      "x".repeat(1024 * 1024 + 1),
      "incoming\n",
    ]);
    const result = await f.read();
    expect(result.current.kind).toBe("unavailable");
    expect(result.generated.kind).toBe("unavailable");
    expect(
      f.calls.some(
        (args) => args.includes("blob") && args.at(-1) === f.oids[1],
      ),
    ).toBe(false);
  });
  it("rejects object payloads whose bytes do not match the verified index OID", async () => {
    const f = await fixture(["base\n", "ours\n", "theirs\n"]);
    const run = f.context.git;
    f.context.git = async (args) =>
      args.includes("cat-file") && args.includes("blob")
        ? { stdout: "forged\n", stderr: "" }
        : run(args);
    await expect(f.read()).rejects.toThrow(/Некорректный/);
  });
  it("rejects out-of-scope, duplicate and malformed index stages", async () => {
    const f = await fixture(["base\n", "ours\n", "theirs\n"]);
    const run = f.context.git;
    for (const raw of [
      `100644 ${f.oids[1]} 2\tother\0`,
      `100644 ${f.oids[1]} 2\ta\0`.repeat(2),
      `100644 HEAD 2\ta\0`,
      `100644 ${f.oids[1]} 0\ta\0`,
    ]) {
      f.context.git = async (args) =>
        args.includes("ls-files") ? { stdout: raw, stderr: "" } : run(args);
      await expect(f.read()).rejects.toThrow(/Некорректный/);
    }
  });
  it("rejects an owner identity change during reading", async () => {
    const f = await fixture(["base\n", "ours\n", "theirs\n"]);
    f.intercept(async (args) => {
      if (args.includes("cat-file")) f.context.ownerKey = "replacement owner";
    });
    await expect(f.read()).rejects.toThrow(/устарел/);
  });
  it("never invokes repository filters, merge drivers or diff helpers", async () => {
    const f = await fixture(["base\n", "ours\n", "theirs\n"]);
    const sentinel = path.join(f.dir, "helper-executed");
    for (const key of [
      "filter.evil.clean",
      "filter.evil.smudge",
      "merge.evil.driver",
      "diff.external",
      "core.fsmonitor",
    ])
      await f.git(["config", key, `touch '${sentinel}'`]);
    await fs.writeFile(
      path.join(f.root, ".gitattributes"),
      "a filter=evil merge=evil diff=evil\n",
    );
    expect((await f.read()).generated.kind).toBe("text");
    await expect(fs.stat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    for (const args of f.calls) {
      expect(args).toContain("--no-replace-objects");
      expect(args).toContain("protocol.allow=never");
      expect(args).toContain("core.hooksPath=/dev/null");
      expect(args).toContain("core.fsmonitor=false");
    }
  });
  it("reads rename/rename stages at their literal paths without guessing missing-side contents", async () => {
    const f = await fixture(["base\n", "ours\n", "theirs\n"]);
    await f.git(["reset", "--hard", "HEAD"]);
    await f.git(["checkout", "-b", "incoming"]);
    await f.git(["mv", "a", "incoming-name"]);
    await f.git(["commit", "-m", "incoming rename"]);
    await f.git(["checkout", "main"]);
    await f.git(["mv", "a", "current-name"]);
    await f.git(["commit", "-m", "current rename"]);
    await expect(f.git(["merge", "incoming"])).rejects.toBeInstanceOf(
      CommandExitError,
    );
    const snapshot = await f.workspace.snapshot();
    const result = await f.reader.read({
      scope: "project",
      path: "current-name",
      revision: snapshot.revision,
    });
    expect(result.current.kind).toBe("text");
    expect(result.incoming.kind).toBe("absent");
    expect(result.generated.kind).toBe("unavailable");
  });
  it("preserves BOM and valid literal replacement characters as exact UTF-8", async () => {
    const f = await fixture(
      ["\ufeffbase\n", "\ufeffours\ufffd\n", "\ufefftheirs\n"],
      "\ufeffedited\ufffd",
    );
    const result = await f.read();
    expect(result.current.text).toBe("\ufeffours\ufffd\n");
    expect(result.working.text).toBe("\ufeffedited\ufffd");
    expect(result.generated.kind).toBe("text");
  });
  it("returns explicit unavailable generation rather than losing all sources when payload mapping is ambiguous", async () => {
    const common = Array.from({ length: 12 }, (_, i) => `common-${i}\n`).join(
      "",
    );
    const f = await fixture([
      `same\n${common}base`,
      `same\n${common}same`,
      `same\n${common}incoming`,
    ]);
    const result = await f.read();
    expect(result.current.text).toBe(`same\n${common}same`);
    expect(result.generated.kind).toBe("unavailable");
  });
  it("audits unsafe index topology before invoking any conflict Git command", async () => {
    const f = await fixture(["base\n", "ours\n", "theirs\n"]);
    const revision = (await f.workspace.snapshot()).revision;
    const target = path.join(f.dir, "external-index"),
      index = path.join(f.root, ".git/index");
    await fs.rename(index, target);
    await fs.symlink(target, index);
    await expect(
      f.reader.read({ scope: "project", path: "a", revision }),
    ).rejects.toThrow(/символическая ссылка/);
    expect(f.calls).toHaveLength(0);
  });
  it("requests fresh snapshots around actual reads and rejects index replacement", async () => {
    const f = await fixture(["base\n", "ours\n", "theirs\n"]);
    const snapshot = vi.fn(f.context.snapshot);
    f.context.snapshot = snapshot;
    f.intercept(async (args) => {
      if (args.includes("merge-file")) {
        const index = path.join(f.root, ".git/index"),
          replacement = path.join(f.root, ".git/index-replacement");
        await fs.copyFile(index, replacement);
        await fs.rename(replacement, index);
      }
    });
    await expect(f.read()).rejects.toThrow(/устарел/);
    expect(snapshot).toHaveBeenCalledTimes(2);
  });
  it("grows delimiter size around literal long marker content", async () => {
    const literal = `${"=".repeat(31)}\n${"=".repeat(32)}\n`;
    const f = await fixture([
      `${literal}base\n`,
      `${literal}ours\n`,
      `${literal}theirs\n`,
    ]);
    const result = await f.read();
    expect(result.generated.kind).toBe("text");
    expect(f.calls.find((args) => args.includes("merge-file"))).toContain(
      "--marker-size=33",
    );
    if (result.generated.kind === "text")
      expect(result.generated.text.startsWith(literal)).toBe(true);
  });
  it("uses UTF-16 result/source offsets after supplementary Unicode", async () => {
    const f = await fixture([
      "😀 prefix\nbase\n",
      "😀 prefix\nours\n",
      "😀 prefix\ntheirs\n",
    ]);
    const result = await f.read();
    if (result.generated.kind !== "text") throw Error("model missing");
    expect(result.generated.blocks[0].current.range).toEqual({
      from: 10,
      to: 15,
    });
    expect(result.generated.blocks[0].resultRange.from).toBe(10);
  });
  it("rejects oversized native output without exposing its text in an error", async () => {
    const f = await fixture(["base\n", "ours\n", "theirs\n"]);
    f.intercept(async (args) => {
      if (args.includes("merge-file"))
        throw new CommandExitError(
          "do not expose content",
          1,
          "secret".repeat(800000),
          "",
        );
    });
    await expect(f.read()).rejects.toThrow(
      /^Некорректный ответ Git при чтении конфликта\.$/,
    );
  });
  it("checks parent identity after opening before reading bytes through a swapped parent", async () => {
    const f = await fixture(["base\n", "ours\n", "theirs\n"]);
    const originalOpen = (await vi.importActual<typeof fs>("node:fs/promises"))
      .open;
    let readCalled = false;
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (args[0] === path.join(f.root, "a")) {
        const moved = path.join(f.dir, "moved-repository");
        await fs.rename(f.root, moved);
        await fs.symlink(moved, f.root);
        const handle = await originalOpen(...args);
        const originalRead = handle.read.bind(handle);
        handle.read = ((...readArgs: Parameters<typeof handle.read>) => {
          readCalled = true;
          return originalRead(...readArgs);
        }) as typeof handle.read;
        return handle;
      }
      return originalOpen(...args);
    });
    try {
      await expect(f.read()).rejects.toThrow();
      expect(readCalled).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
  it("never creates merge-file inputs under the repository even if the process temp path points there", async () => {
    const f = await fixture(["base\n", "ours\n", "theirs\n"]);
    const spy = vi.spyOn(os, "tmpdir").mockReturnValue(f.root);
    try {
      await expect(f.read()).rejects.toThrow(/временн/);
      expect(f.calls.some((args) => args.includes("merge-file"))).toBe(false);
      expect(
        (await fs.readdir(f.root)).some((name) =>
          name.startsWith("goga-conflict-"),
        ),
      ).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
  it("binds fingerprints to distinct literal paths even for identical stages and absent working files", async () => {
    const f = await fixture(["base\n", "ours\n", "theirs\n"], null);
    const rows = (await f.git(["ls-files", "--unmerged", "--", "a"])).stdout;
    await f.git(["update-index", "--index-info"], {
      stdin: rows.replaceAll("\ta\n", "\tb\n"),
    });
    const revision = (await f.workspace.snapshot()).revision;
    const a = await f.reader.read({ scope: "project", path: "a", revision });
    const b = await f.reader.read({ scope: "project", path: "b", revision });
    expect(a.current.oid).toBe(b.current.oid);
    expect(a.working.kind).toBe("absent");
    expect(b.working.kind).toBe("absent");
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});

it.each([
  ["merge", "\n"],
  ["diff3", "\n"],
  ["merge", ""],
  ["diff3", ""],
])(
  "maps actual native %s working conflicts on first open (ending %j) without rewriting them",
  async (style, ending) => {
    const inputs: [string, string, string] = [
      "line\nbase" + ending,
      "line\nours" + ending,
      "line\ntheirs" + ending,
    ];
    const f = await fixture(inputs);
    let actual: string;
    try {
      actual = (
        await f.git([
          "merge-file",
          "--stdout",
          ...(style === "diff3" ? ["--diff3"] : []),
          "-L",
          "HEAD",
          "-L",
          "base",
          "-L",
          "incoming",
          path.join(f.dir, "stage-1"),
          path.join(f.dir, "stage-0"),
          path.join(f.dir, "stage-2"),
        ])
      ).stdout;
    } catch (error) {
      if (!(error instanceof CommandExitError) || error.exitCode !== 1)
        throw error;
      actual = error.stdout;
    }
    await fs.writeFile(path.join(f.root, "a"), actual);
    const doc = await f.read();
    const draft = openConflictDraft(doc);
    expect(draft.text).toBe(actual);
    expect(draft.blocks).toHaveLength(1);
    expect(applyConflictBlock(draft, draft.blocks[0].id, "current").text).toBe(
      inputs[1],
    );
    expect(await fs.readFile(path.join(f.root, "a"), "utf8")).toBe(actual);
  },
);

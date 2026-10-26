import { afterEach, expect, it, vi } from "vitest";
const fault = vi.hoisted(() => ({
  objectSync: false,
  metadataInjection: false,
  recoveryStat: false,
  finalJournal: false,
  finalJournalFired: false,
  descriptors: new Map<number, string>(),
}));
vi.mock("node:fs", async (load) => {
  const actual = await load<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: (...a: Parameters<typeof actual.lstatSync>) => {
      if (fault.recoveryStat && /\/goga-continue-[^/]+$/.test(String(a[0])))
        throw Error("fixture recovery EIO");
      return actual.lstatSync(...a);
    },
    openSync: (...a: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...a);
      fault.descriptors.set(fd, String(a[0]));
      return fd;
    },
    closeSync: (fd: number) => {
      fault.descriptors.delete(fd);
      return actual.closeSync(fd);
    },
    renameSync: (...a: Parameters<typeof actual.renameSync>) => {
      if (fault.finalJournal && String(a[1]).endsWith("/journal.json")) {
        const facts = JSON.parse(actual.readFileSync(String(a[0]), "utf8"));
        if (facts.status === "success" && facts.retainedLocks.length === 0) {
          fault.finalJournalFired = true;
          throw Error("fixture final journal EIO");
        }
      }
      actual.renameSync(...a);
      if (fault.metadataInjection && String(a[1]).endsWith("/.git/HEAD")) {
        fault.metadataInjection = false;
        actual.writeFileSync(
          path.join(String(a[1]), "..", "BISECT_START"),
          "unrelated\n",
        );
      }
    },
    fsyncSync: (fd: number) => {
      if (
        fault.objectSync &&
        /\/\.git\/objects\/[a-f0-9]{2}\/[a-f0-9]{38}$/.test(
          fault.descriptors.get(fd) ?? "",
        )
      ) {
        fault.objectSync = false;
        throw Error("fixture object fsync");
      }
      return actual.fsyncSync(fd);
    },
  };
});
import * as fs from "node:fs/promises";
import path from "node:path";
import { readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  NodeRunner,
  CommandExitError,
  RunnerShutdownError,
} from "../src/host/process";
import { GitWorkspaceReader } from "../src/host/git-workspace-reader";
import { GitRebaseOperations } from "../src/host/git-rebase-operations";
import { readRebaseBinding } from "../src/host/git-rebase-read-binding";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  fault.objectSync = false;
  fault.metadataInjection = false;
  fault.recoveryStat = false;
  fault.finalJournal = false;
  fault.finalJournalFired = false;
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const repeated = {
  base: "D\nB\nD\nC\nA\nB\nA\nD\nE\nB\nD\nA\nC\nC\nD\nD\nB\nE\nE\nA\n",
  ours: "D\nB\nA\nA\nC\nA\nB\nA\nD\nQ\nB\nD\nA\nC\nQ\nC\nD\nB\nE\nE\nA\n",
  theirs: "D\nB\nD\nC\nA\nA\nA\nA\nE\nA\nD\nR\nA\nC\nC\nD\nB\nB\nE\nE\nA\n",
};
async function fixture(
  next = false,
  directories = 0,
  cleanNext = false,
  futureKind = "text",
  bounds: {
    messageBytes?: number;
    patchBytes?: number;
    unicode?: boolean;
  } = {},
) {
  const base = await fs.mkdtemp("/private/tmp/goga-rebase-continue-");
  cleanup.push(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "repo"),
    home = path.join(base, "home");
  await fs.mkdir(root);
  await fs.mkdir(home);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "",
    GIT_EDITOR: ":",
    GIT_SEQUENCE_EDITOR: "/usr/bin/false",
  };
  for (const key of Object.keys(process.env))
    if (key.startsWith("GIT_") && !(key in env)) env[key] = undefined;
  const runner = new NodeRunner(10000, env);
  cleanup.push(() => runner.dispose());
  const git = (a: string[], overrides = {}) =>
    runner.command(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "gc.auto=0", ...a],
      root,
      { ...env, ...overrides },
    );
  const write = (n: string, s: string) => fs.writeFile(path.join(root, n), s);
  const read = (n: string) => fs.readFile(path.join(root, n), "utf8");
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Current Committer"]);
  await git(["config", "user.email", "committer@example.invalid"]);
  for (const n of ["a", "b", "c", "other"]) await write(n, "base\n");
  if (futureKind === "repeated") await write("c", repeated.base);
  for (let i = 0; i < directories; i++) {
    await fs.mkdir(path.join(root, `dir-${i}`));
    await write(`dir-${i}/keep`, "keep\n");
  }
  if (bounds.patchBytes)
    await write("large", "old line\n".repeat(Math.ceil(bounds.patchBytes / 9)));
  await write(".gitignore", "ignored\n");
  await git(["add", "."]);
  await git(["commit", "-m", "base"]);
  await git(["branch", "feature"]);
  for (const n of cleanNext ? ["a", "b"] : ["a", "b", "c"])
    await write(n, "upstream\n");
  if (futureKind === "repeated") await write("c", repeated.ours);
  await git(["commit", "-am", "upstream"]);
  await git(["checkout", "feature"]);
  for (const n of ["a", "b"]) await write(n, "topic\n");
  await git(["commit", "-am", "Original first message"], {
    GIT_AUTHOR_NAME: "Original Author",
    GIT_AUTHOR_EMAIL: "author@example.invalid",
    GIT_AUTHOR_DATE: "2020-01-01T01:02:03+0300",
  });
  const first = (await git(["rev-parse", "HEAD"])).stdout.trim();
  if (next) {
    if (futureKind !== "delete")
      await write(
        "c",
        futureKind === "binary"
          ? "binary\0bytes"
          : futureKind === "repeated"
            ? repeated.theirs
            : "second topic\n",
      );
    if (futureKind === "add") {
      await write("added", "future\n");
      await git(["add", "added"]);
    }
    if (futureKind === "delete") await git(["rm", "c"]);
    if (futureKind === "mode") {
      await fs.chmod(path.join(root, "c"), 0o755);
    }
    if (bounds.patchBytes)
      await write(
        "large",
        "new line\n".repeat(Math.ceil(bounds.patchBytes / 9)),
      );
    await git(["commit", "-am", "Original second message"]);
    if (bounds.messageBytes) {
      const message = path.join(base, "message");
      const unit = bounds.unicode ? "я" : "x";
      await fs.writeFile(
        message,
        "second\n\n" +
          unit.repeat(
            Math.ceil(bounds.messageBytes / Buffer.byteLength(unit)),
          ) +
          "\n",
      );
      await git(["commit", "--amend", "-F", message]);
    }
    if (futureKind === "long") {
      await write("other", "third\n");
      await git(["commit", "-am", "third"]);
    }
  }
  const original = (await git(["rev-parse", "HEAD"])).stdout.trim();
  await expect(git(["rebase", "--merge", "main"])).rejects.toThrow();
  for (const n of ["a", "b"]) await write(n, `resolved ${n}\n`);
  await git(["add", "a", "b"]);
  await write("untracked", "keep untracked\n");
  await write("ignored", "keep ignored\n");
  const reader = new GitWorkspaceReader({
    root,
    scope: "project",
    verify: async () => {},
    git: async (a) => (await git(a)).stdout,
  });
  let now = 1000,
    ownerKey = "owner",
    beforeNative: (() => void) | undefined,
    afterNative: (() => void) | undefined,
    afterPublish: ((step: string) => void) | undefined;
  let nativeOverride:
    | ((
        run: () => Promise<{ stdout: string; stderr: string }>,
      ) => Promise<{ stdout: string; stderr: string }>)
    | undefined;
  let proofError: Error | undefined;
  const calls: string[][] = [];
  const engine = new GitRebaseOperations({
    now: () => now,
    beforeNative: () => beforeNative?.(),
    afterNative: () => afterNative?.(),
    afterPublish: (step: string) => afterPublish?.(step),
    context: async (_scope, fn) =>
      fn({
        root,
        scope: "project",
        ownerKey,
        verify: async () => {},
        verifyOwner: async () => {},
        snapshot: () => reader.snapshot(),
        git: (a) => git(a),
        isolatedGit: (a) => {
          calls.push(a);
          if (a.includes("merge-file") && proofError) throw proofError;
          const run = () => git(a);
          return a.includes("--continue") && nativeOverride
            ? nativeOverride(run)
            : run();
        },
      }),
  });
  const prepare = async () =>
    engine.prepare({
      scope: "project",
      revision: (await reader.snapshot()).revision,
      action: "continue",
    } as any);
  const digest = async () => {
    const rows: unknown[] = [];
    const walk = async (dir: string) => {
      for (const n of (await fs.readdir(dir)).sort()) {
        const p = path.join(dir, n),
          s = await fs.lstat(p);
        if (s.isDirectory()) await walk(p);
        else
          rows.push([
            path.relative(root, p),
            s.mode,
            createHash("sha256")
              .update(await fs.readFile(p))
              .digest("hex"),
          ]);
      }
    };
    await walk(root);
    return JSON.stringify(rows);
  };
  return {
    base,
    root,
    home,
    git,
    write,
    read,
    prepare,
    engine,
    reader,
    original,
    first,
    calls,
    digest,
    failProof: (e: Error) => (proofError = e),
    setNow: (n: number) => (now = n),
    setOwner: (n: string) => (ownerKey = n),
    before: (f: () => void) => (beforeNative = f),
    after: (f: () => void) => (afterNative = f),
    publish: (f: (s: string) => void) => (afterPublish = f),
    native: (f: typeof nativeOverride) => (nativeOverride = f),
  };
}
it("continues resolved multiple existing paths without preview writes and preserves native author/message/committer", async () => {
  const f = await fixture(),
    before = await f.digest(),
    p = await f.prepare();
  expect(await f.digest()).toBe(before);
  expect(p).toMatchObject({ action: "continue", hooks: "disabled" });
  const r = await f.engine.execute(p.token);
  expect(r, r.log).toMatchObject({
    action: "continue",
    status: "success",
    changed: true,
    objectsPublished: true,
    indexPublished: true,
    headPublished: true,
    branchPublished: true,
    metadataCleared: true,
    lockRetained: false,
  });
  expect((await f.git(["symbolic-ref", "HEAD"])).stdout).toBe(
    "refs/heads/feature\n",
  );
  const commit = (await f.git(["cat-file", "commit", "HEAD"])).stdout;
  expect(commit).toContain(
    "author Original Author <author@example.invalid> 1577829723 +0300\n",
  );
  expect(commit).toContain(
    "committer Current Committer <committer@example.invalid>",
  );
  expect(commit).toContain("\n\nOriginal first message\n");
  expect(await f.read("untracked")).toBe("keep untracked\n");
  expect(await f.read("ignored")).toBe("keep ignored\n");
  expect(f.calls.filter((a) => a.includes("--continue"))).toHaveLength(1);
  await expect(f.engine.execute(p.token)).rejects.toThrow();
});
it("publishes recognizable next conflict on another existing path then permits a second native continuation", async () => {
  const f = await fixture(true),
    p = await f.prepare(),
    r = await f.engine.execute(p.token);
  expect(r, r.log).toMatchObject({
    status: "conflict",
    action: "continue",
    objectsPublished: true,
    indexPublished: true,
    headPublished: true,
    branchPublished: false,
    metadataCleared: false,
    lockRetained: false,
  });
  expect((await f.git(["rev-parse", "refs/heads/feature"])).stdout.trim()).toBe(
    f.original,
  );
  expect(
    await readRebaseBinding(
      {
        path: f.root,
        gitCommonDir: path.join(f.root, ".git"),
        branch: "feature",
      },
      async (a) => (await f.git(a)).stdout,
    ),
  ).toMatch(/^[a-f0-9]{64}$/);
  expect((await f.reader.snapshot()).operation).toBe("rebase");
  await f.write("c", "resolved c\n");
  await f.git(["add", "c"]);
  expect(await f.engine.execute((await f.prepare()).token)).toMatchObject({
    status: "success",
    metadataCleared: true,
  });
});
it.each(["staged", "unstaged", "signing", "message", "todo", "too-many"])(
  "refuses %s before publishing anything",
  async (kind) => {
    const f = await fixture(true);
    if (kind === "staged") {
      await f.write("other", "user stage\n");
      await f.git(["add", "other"]);
    }
    if (kind === "unstaged") await f.write("other", "user work\n");
    if (kind === "signing") await f.git(["config", "commit.gpgsign", "true"]);
    if (kind === "message")
      await fs.writeFile(
        path.join(f.root, ".git/rebase-merge/message"),
        "injected\n",
      );
    if (kind === "todo")
      await fs.appendFile(
        path.join(f.root, ".git/rebase-merge/git-rebase-todo"),
        "exec false\n",
      );
    if (kind === "too-many")
      await fs.appendFile(
        path.join(f.root, ".git/rebase-merge/git-rebase-todo"),
        `pick ${f.original} again\n`,
      );
    const before = await f.digest();
    await expect(f.prepare()).rejects.toThrow();
    expect(await f.digest()).toBe(before);
    expect(f.calls.some((a) => a.includes("--continue"))).toBe(false);
  },
);
it("retains recovery and reports uncertainty after a native lost acknowledgement, never retries", async () => {
  const f = await fixture(true);
  f.native(async (run) => {
    await run().catch((e) => {
      if (!(e instanceof CommandExitError)) throw e;
    });
    throw Error("fixture lost acknowledgement");
  });
  const r = await f.engine.execute((await f.prepare()).token);
  expect(r, r.log).toMatchObject({
    status: "uncertain",
    mutationStarted: true,
    indexPublished: false,
    headPublished: false,
    lockRetained: true,
    recoveryStatus: "retained",
  });
  expect(f.calls.filter((a) => a.includes("--continue"))).toHaveLength(1);
});
it.each(["objects", "index", "head", "branch", "metadata"])(
  "reports exact partial publication after %s",
  async (step) => {
    const f = await fixture();
    f.publish((s) => {
      if (s === step) throw Error("fixture partial " + step);
    });
    const r = await f.engine.execute((await f.prepare()).token);
    expect(r.status, r.log).toBe("uncertain");
    expect(r.changed).toBe(true);
    expect(r.recoveryStatus).toBe("retained");
    expect(r.lockRetained).toBe(true);
    expect(
      (r as any)[
        step === "objects"
          ? "objectsPublished"
          : step === "branch"
            ? "branchPublished"
            : step === "metadata"
              ? "metadataCleared"
              : step + "Published"
      ],
    ).toBe(true);
  },
);

it("counts a source object created before its fsync fails and retains exact partial facts", async () => {
  const f = await fixture();
  const p = await f.prepare();
  fault.objectSync = true;
  const r = await f.engine.execute(p.token);
  expect(r, r.log).toMatchObject({
    status: "uncertain",
    changed: true,
    mutationStarted: true,
    objectsPublished: false,
    publishedObjectCount: 1,
    indexPublished: false,
    headPublished: false,
    lockRetained: true,
    recoveryStatus: "retained",
  });
  expect(r.log).toContain("fixture object fsync");
});
it.each(["stale-owner", "expired", "stale-index"])(
  "consumes a %s ticket without native execution",
  async (kind) => {
    const f = await fixture(),
      p = await f.prepare();
    if (kind === "stale-owner") f.setOwner("changed");
    if (kind === "expired") f.setNow(p.expiresAt);
    if (kind === "stale-index") {
      await f.write("other", "changed\n");
      await f.git(["add", "other"]);
    }
    const before = await f.digest();
    await expect(f.engine.execute(p.token)).rejects.toThrow();
    expect(await f.digest()).toBe(before);
    await expect(f.engine.execute(p.token)).rejects.toThrow();
    expect(f.calls.some((a) => a.includes("--continue"))).toBe(false);
  },
);

it("does not adopt an unrelated operation marker injected during its own HEAD rename", async () => {
  const f = await fixture(),
    p = await f.prepare();
  fault.metadataInjection = true;
  const r = await f.engine.execute(p.token);
  expect(r, r.log).toMatchObject({
    status: "uncertain",
    headPublished: true,
    branchPublished: false,
    metadataCleared: false,
    lockRetained: true,
  });
  expect(await f.read(".git/BISECT_START")).toBe("unrelated\n");
});
it("rejects a conservative native object envelope overflow before any live writes", async () => {
  const f = await fixture(false, 90),
    before = await f.digest();
  await expect(f.prepare()).rejects.toThrow();
  expect(await f.digest()).toBe(before);
  expect(f.calls.some((a) => a.includes("--continue"))).toBe(false);
});

it("finishes two native picks when the one remaining pick merges cleanly on another existing path", async () => {
  const f = await fixture(true, 0, true),
    r = await f.engine.execute((await f.prepare()).token);
  expect(r, r.log).toMatchObject({
    status: "success",
    branchPublished: true,
    metadataCleared: true,
  });
  expect(await f.read("c")).toBe("second topic\n");
  expect((await f.git(["log", "-2", "--format=%s"])).stdout).toBe(
    "Original second message\nOriginal first message\n",
  );
});

it.each(["head-name", "author-script", "msgnum"])(
  "refuses corrupt native next %s before any source object or index publication",
  async (name) => {
    const f = await fixture(true);
    f.after(() => {
      const recovery = readdirSync(path.join(f.root, ".git")).find((n) =>
        n.startsWith("goga-continue-"),
      )!;
      writeFileSync(
        path.join(f.root, ".git", recovery, "native/rebase-merge", name),
        "injected\n",
      );
    });
    const r = await f.engine.execute((await f.prepare()).token);
    expect(r, r.log).toMatchObject({
      status: "uncertain",
      publishedObjectCount: 0,
      indexPublished: false,
      headPublished: false,
      metadataPublished: false,
      lockRetained: true,
    });
  },
);
it("rejects a decoded source commit whose bytes no longer hash to the requested object", async () => {
  const f = await fixture();
  const { sourceCommit } =
    await import("../src/host/git-rebase-continue-state");
  await expect(
    sourceCommit(
      {
        root: f.root,
        isolatedGit: async (a: string[]) => {
          const result = await f.git(a);
          return a.includes("cat-file")
            ? {
                ...result,
                stdout: result.stdout.replace(
                  "Original first message",
                  "lossy message",
                ),
              }
            : result;
        },
      } as any,
      f.first,
    ),
  ).rejects.toThrow();
});

it.each(["add", "delete", "mode", "binary"])(
  "refuses unsupported future %s before writes",
  async (kind) => {
    const f = await fixture(true, 0, false, kind),
      before = await f.digest();
    await expect(f.prepare()).rejects.toThrow();
    expect(await f.digest()).toBe(before);
  },
);
it.each([
  "unmerged",
  "empty",
  "signing-metadata",
  "autostash",
  "notes",
  "cleanup",
  "attributes",
])("refuses unsupported %s state without effects", async (kind) => {
  const f = await fixture();
  if (kind === "unmerged") await f.git(["checkout", "-m", "--", "a"]);
  if (kind === "empty") {
    await f.write("a", "upstream\n");
    await f.write("b", "upstream\n");
    await f.git(["add", "a", "b"]);
  }
  if (kind === "signing-metadata")
    await f.write(".git/rebase-merge/gpg_sign_opt", "-S\n");
  if (kind === "autostash")
    await f.write(".git/rebase-merge/autostash", f.original + "\n");
  if (kind === "notes")
    await f.git(["config", "notes.rewriteRef", "refs/notes/commits"]);
  if (kind === "cleanup") await f.git(["config", "commit.cleanup", "verbatim"]);
  if (kind === "attributes") await f.write(".gitattributes", "* text\n");
  const before = await f.digest();
  await expect(f.prepare()).rejects.toThrow();
  expect(await f.digest()).toBe(before);
  expect(f.calls.some((a) => a.includes("--continue"))).toBe(false);
});

it("reports an unverified created recovery directory when its first identity read fails", async () => {
  const f = await fixture(),
    p = await f.prepare();
  fault.recoveryStat = true;
  const r = await f.engine.execute(p.token);
  expect(r, r.log).toMatchObject({
    status: "error",
    mutationStarted: false,
    recoveryStatus: "unverified",
  });
  expect(r.lastKnownRecoveryPath).toContain("goga-continue-");
  expect(r.recoveryPath).toBeUndefined();
});

it.each([
  ["large message conflict", false, { messageBytes: 1200000 }],
  ["large message clean", true, { messageBytes: 2200000 }],
  ["large unicode message", false, { messageBytes: 1200000, unicode: true }],
  ["large patch conflict", false, { patchBytes: 600000 }],
] as const)(
  "refuses future native output bounds: %s before any writes",
  async (_label, clean, bounds) => {
    const f = await fixture(true, 0, clean, "text", bounds),
      before = await f.digest();
    await expect(f.prepare()).rejects.toThrow();
    expect(f.calls.some((a) => a.includes("--continue"))).toBe(false);
    expect(await f.digest()).toBe(before);
  },
);

it.each(["9000", "05", "+5", "5 ", "999999999999999999999"])(
  "rejects malformed native loose object payload length %s before any object publication",
  async (size) => {
    const f = await fixture();
    const inflated = Buffer.from(`blob ${size}\0SPEC\n`),
      oid = createHash("sha1").update(inflated).digest("hex");
    f.after(() => {
      const recovery = readdirSync(path.join(f.root, ".git")).find((n) =>
        n.startsWith("goga-continue-"),
      )!;
      const dir = path.join(
        f.root,
        ".git",
        recovery,
        "native/objects",
        oid.slice(0, 2),
      );
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, oid.slice(2)), deflateSync(inflated));
    });
    const r = await f.engine.execute((await f.prepare()).token);
    expect(r, r.log).toMatchObject({
      status: "uncertain",
      objectsPublished: false,
      publishedObjectCount: 0,
      indexPublished: false,
      headPublished: false,
      branchPublished: false,
    });
    expect(
      existsSync(
        path.join(f.root, ".git/objects", oid.slice(0, 2), oid.slice(2)),
      ),
    ).toBe(false);
  },
);

it("reports final journal failure without success wording or invented retained locks", async () => {
  const f = await fixture(),
    p = await f.prepare();
  fault.finalJournal = true;
  const r = await f.engine.execute(p.token);
  expect(fault.finalJournalFired).toBe(true);
  expect(r, r.log).toMatchObject({
    status: "uncertain",
    mutationStarted: true,
    objectsPublished: true,
    indexPublished: true,
    headPublished: true,
    branchPublished: true,
    metadataCleared: true,
    lockRetained: false,
    retainedLocks: [],
  });
  expect(r.message).not.toContain("Rebase завершён");
  expect(r.message).toMatch(/журнал.*не подтвержд/i);
  expect(r.publishedObjectCount).toBeGreaterThan(0);
});

it("publishes repeated ASCII next conflict with the native ORT histogram proof", async () => {
  const f = await fixture(true, 0, false, "repeated"),
    p = await f.prepare();
  const r = await f.engine.execute(p.token);
  expect(r, r.log).toMatchObject({
    status: "conflict",
    indexPublished: true,
    headPublished: true,
    metadataPublished: true,
    lockRetained: false,
  });
  expect(f.calls.filter((a) => a.includes("--continue"))).toHaveLength(1);
  expect(
    f.calls
      .filter((a) => a.includes("merge-file"))
      .every((a) => a.includes("--diff-algorithm=histogram")),
  ).toBe(true);
  expect(await f.read("c")).toContain("<<<<<<< HEAD");
  expect(
    await readRebaseBinding(
      {
        path: f.root,
        gitCommonDir: path.join(f.root, ".git"),
        branch: "feature",
      },
      async (a) => (await f.git(a)).stdout,
    ),
  ).toBeDefined();
});
it("refuses unavailable histogram capability before writes with no fallback", async () => {
  const f = await fixture(),
    before = await f.digest();
  f.failProof(
    new CommandExitError(
      "fixture usage",
      129,
      "",
      "error: unknown option `diff-algorithm=histogram'",
    ),
  );
  await expect(f.prepare()).rejects.toThrow(/histogram.*недоступно/);
  expect(f.calls.filter((a) => a.includes("merge-file"))).toHaveLength(1);
  expect(f.calls.some((a) => a.includes("--continue"))).toBe(false);
  expect(await f.digest()).toBe(before);
});
it.each([
  new RunnerShutdownError("interrupted"),
  Error("fixture proof timeout"),
  new CommandExitError("fixture proof fatal", 128),
])(
  "preserves proof process error without a false unsupported-Git diagnosis: %s",
  async (error) => {
    const f = await fixture(),
      before = await f.digest();
    f.failProof(error);
    await expect(f.prepare()).rejects.toBe(error);
    expect(f.calls.some((a) => a.includes("--continue"))).toBe(false);
    expect(await f.digest()).toBe(before);
  },
);

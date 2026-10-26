import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createOperationFixture,
  type OperationFixture,
} from "./helpers/git-operation-fixtures";
import { GitRebaseOperations } from "../src/host/git-rebase-operations";
import { GitWorkspaceReader } from "../src/host/git-workspace-reader";
import {
  NodeRunner,
  CommandExitError,
  RunnerShutdownError,
} from "../src/host/process";

const fixtures: OperationFixture[] = [];
const runners: NodeRunner[] = [];
afterEach(async () => {
  for (const r of runners.splice(0)) await r.dispose();
  for (const f of fixtures.splice(0)) await f.dispose();
});
async function fixture(commits = 3, conflictAt = [1, 3]) {
  const f = await createOperationFixture("apply-rebase", {
    commits,
    conflictAt,
  });
  fixtures.push(f);
  const env: NodeJS.ProcessEnv = { ...f.env, GIT_ATTR_NOSYSTEM: undefined };
  const runner = new NodeRunner(10000, env);
  runners.push(runner);
  let commandFault: ((a: string[]) => void) | undefined;
  const git = (a: string[]) => {
    commandFault?.(a);
    return runner.command("git", a, f.root, env);
  };
  const reader = new GitWorkspaceReader({
    root: f.root,
    scope: "project",
    verify: async () => {},
    git: async (a) => (await git(a)).stdout,
  });
  let beforeNative: (() => void) | undefined,
    afterNative: (() => void) | undefined;
  const engine = new GitRebaseOperations({
    beforeNative: () => beforeNative?.(),
    afterNative: () => afterNative?.(),
    context: async (_scope, fn) =>
      fn({
        root: f.root,
        scope: "project",
        ownerKey: f.root,
        verify: async () => {},
        verifyOwner: async () => {},
        snapshot: () => reader.snapshot(),
        git,
        isolatedGit: git,
      }),
  });
  const prepare = async () =>
    engine.prepare({
      scope: "project",
      revision: (await reader.snapshot()).revision,
      action: "abort",
    });
  return {
    ...f,
    reader,
    engineEnv: env,
    prepare,
    engine,
    setCommandFault: (fn: (a: string[]) => void) => {
      commandFault = fn;
    },
    setAfterNative: (fn: () => void) => {
      afterNative = fn;
    },
    setBeforeNative: (fn: () => void) => {
      beforeNative = fn;
    },
  };
}
async function identities(f: OperationFixture) {
  const base = path.join(f.root, ".git");
  return {
    index: await fs.readFile(path.join(base, "index")),
    head: await f.read(".git/HEAD"),
    refs: await f.git(["show-ref"]),
    operation: await Promise.all(
      (await fs.readdir(path.join(base, "rebase-apply")))
        .sort()
        .map(async (n) => [
          n,
          await fs.readFile(path.join(base, "rebase-apply", n)),
        ]),
    ),
    files: await Promise.all(
      ["file-1", "untouched", "untracked", "ignored"].map(async (n) => [
        n,
        await f.read(n),
      ]),
    ),
  };
}
it.each(["unresolved", "manual", "staged"])(
  "aborts native apply (%s) without merge-backend metadata or losing unrelated files",
  async (state) => {
    const f = await fixture();
    if (state === "manual") await f.write("file-1", "manual solution\n");
    if (state === "staged") await f.resolve();
    const before = await identities(f);
    const p = await f.prepare();
    expect(p.backend).toBe("apply");
    expect(p.discardedResolutionPaths).toEqual(
      state === "unresolved" ? [] : ["file-1"],
    );
    expect(await identities(f)).toEqual(before);
    const r = await f.engine.execute(p.token);
    expect(r, r.log).toMatchObject({
      status: "success",
      worktreeRestored: true,
      indexPublished: true,
      headPublished: true,
      metadataCleared: true,
      lockRetained: false,
    });
    expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(f.original);
    expect((await f.git(["symbolic-ref", "--short", "HEAD"])).trim()).toBe(
      f.branch,
    );
    expect(await f.git(["diff", "HEAD"])).toBe("");
    expect(await f.read("untracked")).toBe("preserve untracked\n");
    expect(await f.read("ignored")).toBe("preserve ignored\n");
    expect(await fs.readdir(path.join(f.root, ".git"))).not.toContain(
      "rebase-apply",
    );
  },
);
it("aborts apply at a later native stop after completed patches", async () => {
  const f = await fixture();
  await f.resolve();
  await expect(f.git(["rebase", "--continue"])).rejects.toMatchObject({
    exitCode: 1,
  });
  await f.resolve();
  const p = await f.prepare();
  const r = await f.engine.execute(p.token);
  expect(r, r.log).toMatchObject({ status: "success", lockRetained: false });
  expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(f.original);
});
it.each([
  ["applying", ""],
  ["author-script", "touch /not-authorized\n"],
  ["patch", "forged patch\n"],
  ["next", "2\n"],
  ["last", "2\n"],
  ["0002", "forged mailbox\n"],
  ["apply-opt", "--unsafe-paths\n"],
  ["final-commit", "forged message\n"],
  ["patch-merge-index", "forged index"],
  ["head-name", "refs/heads/main\n"],
  ["abort-safety", "0".repeat(40) + "\n"],
])("rejects altered apply %s before writes", async (name, value) => {
  const f = await fixture();
  await f.write(`.git/rebase-apply/${name}`, value);
  const before = await identities(f);
  await expect(f.prepare()).rejects.toThrow();
  expect(await identities(f)).toEqual(before);
});
it("rejects mixed backend markers", async () => {
  const f = await fixture();
  await fs.mkdir(path.join(f.root, ".git/rebase-merge"));
  const before = await identities(f);
  await expect(f.prepare()).rejects.toThrow();
  expect(await identities(f)).toEqual(before);
});
it("rejects unrelated tracked edits and consumes stale confirmation without mutation", async () => {
  const f = await fixture();
  const p = await f.prepare();
  await f.write("untouched", "user edit\n");
  const before = await identities(f);
  await expect(f.engine.execute(p.token)).rejects.toThrow();
  await expect(f.engine.execute(p.token)).rejects.toThrow(/использовано/);
  await expect(f.prepare()).rejects.toThrow();
  expect(await identities(f)).toEqual(before);
});

it.each([
  { commits: 1, stops: [1] },
  { commits: 4, stops: [1, 3] },
  { commits: 4, stops: [1, 2, 4] },
])(
  "continues native apply through $stops preserving backend/authors/messages and native-control tree",
  async ({ commits, stops }) => {
    const f = await fixture(commits, stops);
    const control = await createOperationFixture("apply-rebase", {
      commits,
      conflictAt: stops,
    });
    fixtures.push(control);
    for (let i = 0; i < stops.length; i++) {
      await f.resolve();
      await control.resolve();
      const p = await f.engine.prepare({
        scope: "project",
        revision: (await f.reader.snapshot()).revision,
        action: "continue",
      });
      expect(p.backend).toBe("apply");
      const r = await f.engine.execute(p.token);
      expect(r, r.log).toMatchObject({
        status: i + 1 < stops.length ? "conflict" : "success",
        lockRetained: false,
        headPublished: true,
        indexPublished: true,
        objectsPublished: true,
      });
      try {
        await control.git(["rebase", "--continue"]);
      } catch (e) {
        expect(e).toMatchObject({ exitCode: 1 });
        expect(r.status).toBe("conflict");
      }
      expect(await f.git(["rev-parse", "HEAD^{tree}"])).toBe(
        await control.git(["rev-parse", "HEAD^{tree}"]),
      );
      expect(await f.git(["ls-files", "--stage", "-z"])).toBe(
        await control.git(["ls-files", "--stage", "-z"]),
      );
      const a = [
        "log",
        "--reverse",
        "--format=%an <%ae>%n%aI%n%B",
        `${f.onto}..HEAD`,
      ];
      expect(await f.git(a)).toBe(await control.git(a));
      expect(await fs.readdir(path.join(f.root, ".git"))).not.toContain(
        "rebase-merge",
      );
      if (r.status === "conflict")
        expect(await f.read(".git/rebase-apply/next")).toBe(
          `${stops[i + 1]}\n`,
        );
    }
    expect((await f.reader.snapshot()).operation).toBe("none");
    expect(await f.read("untracked")).toBe("preserve untracked\n");
  },
);

it("refuses a real stopped git am rather than treating it as rebase", async () => {
  const f = await fixture();
  await f.git(["rebase", "--abort"]);
  await f.git(["checkout", "main"]);
  const mailbox = path.join(f.home, "mailbox.patch");
  await fs.writeFile(
    mailbox,
    await f.git([
      "format-patch",
      "-k",
      "--stdout",
      "--full-index",
      "-1",
      f.sources[0],
    ]),
  );
  await expect(f.git(["am", "--3way", mailbox])).rejects.toMatchObject({
    exitCode: 128,
  });
  const before = await identities(f);
  for (const action of ["continue", "abort"] as const)
    await expect(
      f.engine.prepare({
        scope: "project",
        revision: (await f.reader.snapshot()).revision,
        action,
      }),
    ).rejects.toThrow();
  expect(await identities(f)).toEqual(before);
});
it.each(["format.signaturefile", "am.threeway", "diff.external"])(
  "rejects unsafe apply policy %s before invoking mailbox generation",
  async (key) => {
    const f = await fixture();
    await f.git([
      "config",
      key,
      key === "am.threeway" ? "true" : path.join(f.home, "not-to-read"),
    ]);
    const before = await identities(f);
    await expect(f.prepare()).rejects.toThrow(/конфигурац/i);
    expect(await identities(f)).toEqual(before);
  },
);
it("does not silently disable requested commit signing", async () => {
  const f = await fixture();
  await f.resolve();
  await f.git(["config", "commit.gpgsign", "true"]);
  const before = await identities(f);
  await expect(
    f.engine.prepare({
      scope: "project",
      revision: (await f.reader.snapshot()).revision,
      action: "continue",
    }),
  ).rejects.toThrow();
  expect(await identities(f)).toEqual(before);
});
it.each(["0002", "author-script", "patch", "next", "last"])(
  "invalidates apply continuation confirmation when %s changes",
  async (name) => {
    const f = await fixture();
    await f.resolve();
    const p = await f.engine.prepare({
      scope: "project",
      revision: (await f.reader.snapshot()).revision,
      action: "continue",
    });
    await f.write(`.git/rebase-apply/${name}`, "changed after confirmation\n");
    const before = await identities(f);
    await expect(f.engine.execute(p.token)).rejects.toThrow();
    expect(await identities(f)).toEqual(before);
    await expect(f.engine.execute(p.token)).rejects.toThrow(/использовано/);
  },
);

async function multiline(
  f: OperationFixture,
  fallback: boolean,
  nested: boolean,
) {
  await f.git(["rebase", "--abort"]);
  await f.git(["checkout", "main"]);
  const name = nested ? "nested/ещё/space name.txt" : "file-1";
  await fs.mkdir(path.dirname(path.join(f.root, name)), { recursive: true });
  const base = Array.from({ length: 100 }, (_, i) => `line ${i}\n`);
  await f.write(name, base.join(""));
  await f.git(["add", "--", name]);
  await f.git(["commit", "-m", "multiline base"]);
  const baseCommit = (await f.git(["rev-parse", "HEAD"])).trim();
  await f.git(["checkout", "-B", "topic", baseCommit]);
  await f.git(["config", "user.name", "O'Neil Fixture"]);
  const topic = [...base];
  topic[0] = "topic first\n";
  await f.write(name, topic.join(""));
  await f.git(["commit", "-am", "first conflict"]);
  topic[50] = "topic clean\n";
  await f.write(name, topic.join(""));
  await f.git(["commit", "-am", "second patch"]);
  const original = (await f.git(["rev-parse", "HEAD"])).trim();
  await f.git(["checkout", "main"]);
  const upstream = [...base];
  upstream[0] = "upstream first\n";
  if (fallback) upstream[48] = "upstream adjacent context\n";
  await f.write(name, upstream.join(""));
  await f.git(["commit", "-am", "upstream multiline"]);
  const onto = (await f.git(["rev-parse", "HEAD"])).trim();
  await f.git(["checkout", "topic"]);
  await expect(f.git(["rebase", "--apply", "main"])).rejects.toMatchObject({
    exitCode: 1,
  });
  upstream[0] = "resolved first\n";
  await f.write(name, upstream.join(""));
  await f.git(["add", "--", name]);
  return { name, original, onto };
}
it.each([
  { fallback: false, nested: false },
  { fallback: true, nested: false },
  { fallback: true, nested: true },
])(
  "preserves a multiline resolution with direct/fallback apply and nested paths: $fallback/$nested",
  async ({ fallback, nested }) => {
    const f = await fixture();
    const control = await createOperationFixture("apply-rebase", {
      commits: 3,
      conflictAt: [1, 3],
    });
    fixtures.push(control);
    const setup = await multiline(f, fallback, nested);
    await multiline(control, fallback, nested);
    const p = await f.engine.prepare({
      scope: "project",
      revision: (await f.reader.snapshot()).revision,
      action: "continue",
    });
    const r = await f.engine.execute(p.token);
    expect(r, r.log).toMatchObject({ status: "success", lockRetained: false });
    await control.git(["rebase", "--continue"]);
    expect(await f.git(["rev-parse", "HEAD^{tree}"])).toBe(
      await control.git(["rev-parse", "HEAD^{tree}"]),
    );
    const a = [
      "log",
      "--reverse",
      "--format=%an <%ae>%n%aI%n%B",
      `${setup.onto}..HEAD`,
    ];
    expect(await f.git(a)).toBe(await control.git(a));
    expect((await f.read(setup.name)).split("\n")[0]).toBe("resolved first");
    expect((await f.read(setup.name)).split("\n")[50]).toBe("topic clean");
  },
);
it("stops before native mutation when captured apply input changes at the last guard", async () => {
  const f = await fixture();
  await f.resolve();
  const p = await f.engine.prepare({
    scope: "project",
    revision: (await f.reader.snapshot()).revision,
    action: "continue",
  });
  const head = await f.read(".git/HEAD"),
    index = await fs.readFile(path.join(f.root, ".git/index"));
  f.setBeforeNative(() =>
    writeFileSync(
      path.join(f.root, ".git/rebase-apply/patch"),
      "external patch\n",
    ),
  );
  const r = await f.engine.execute(p.token);
  expect(r, r.log).toMatchObject({
    status: "error",
    mutationStarted: false,
    indexPublished: false,
    headPublished: false,
    lockRetained: false,
  });
  expect(await f.read(".git/HEAD")).toBe(head);
  expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
});
it.each([
  "REBASE_HEAD",
  "ORIG_HEAD",
  "rebase-apply/author-script",
  "rebase-apply/0002",
  "rebase-apply/patch-merge-index",
])(
  "does not publish native apply metadata after unexpected change to %s",
  async (name) => {
    const f = await fixture();
    await f.resolve();
    const p = await f.engine.prepare({
      scope: "project",
      revision: (await f.reader.snapshot()).revision,
      action: "continue",
    });
    const head = await f.read(".git/HEAD"),
      index = await fs.readFile(path.join(f.root, ".git/index")),
      refs = await f.git(["show-ref"]);
    f.setAfterNative(() => {
      const gd = path.join(f.root, ".git");
      const owned = readdirSync(gd).find((n) =>
        n.startsWith("goga-continue-"),
      )!;
      writeFileSync(
        path.join(gd, owned, "native", name),
        "unexpected output\n",
      );
    });
    const r = await f.engine.execute(p.token);
    expect(r, r.log).toMatchObject({
      status: "uncertain",
      mutationStarted: true,
      indexPublished: false,
      headPublished: false,
      objectsPublished: false,
      lockRetained: true,
      recoveryStatus: "retained",
    });
    expect(await f.read(".git/HEAD")).toBe(head);
    expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
    expect(await f.git(["show-ref"])).toBe(refs);
  },
);
it("does not publish a finished apply result containing a foreign operation marker", async () => {
  const f = await fixture(1, [1]);
  await f.resolve();
  const p = await f.engine.prepare({
    scope: "project",
    revision: (await f.reader.snapshot()).revision,
    action: "continue",
  });
  const head = await f.read(".git/HEAD");
  f.setAfterNative(() => {
    const gd = path.join(f.root, ".git"),
      owned = readdirSync(gd).find((n) => n.startsWith("goga-continue-"))!;
    writeFileSync(
      path.join(gd, owned, "native", "CHERRY_PICK_HEAD"),
      `${f.sources[0]}\n`,
    );
  });
  const r = await f.engine.execute(p.token);
  expect(r, r.log).toMatchObject({
    status: "uncertain",
    indexPublished: false,
    headPublished: false,
    objectsPublished: false,
    lockRetained: true,
  });
  expect(await f.read(".git/HEAD")).toBe(head);
});
it.each([
  new RunnerShutdownError("interrupted"),
  Error("fixture apply proof timeout"),
  new CommandExitError("fixture apply fatal", 128),
])(
  "propagates direct apply proof failure without treating it as a content conflict: %s",
  async (error) => {
    const f = await fixture();
    const before = await identities(f);
    f.setCommandFault((a) => {
      if (a.includes("apply") && a.includes("--no-index")) throw error;
    });
    await expect(f.prepare()).rejects.toBe(error);
    expect(await identities(f)).toEqual(before);
  },
);
it("reports missing native Myers proof capability without naming histogram or falling back", async () => {
  const f = await fixture();
  const before = await identities(f);
  f.setCommandFault((a) => {
    if (a.includes("merge-file") && a.includes("--diff-algorithm=myers"))
      throw new CommandExitError("unsupported proof argument", 129);
  });
  await expect(f.prepare()).rejects.toThrow(/diff-algorithm=myers/);
  expect(await identities(f)).toEqual(before);
});
it("refuses an empty remaining apply result without silently skipping its commit", async () => {
  const f = await fixture();
  const setup = await multiline(f, false, false);
  const text = (await f.read(setup.name)).split("\n");
  text[50] = "topic clean";
  await f.write(setup.name, text.join("\n"));
  await f.git(["add", "--", setup.name]);
  const before = await identities(f);
  await expect(
    f.engine.prepare({
      scope: "project",
      revision: (await f.reader.snapshot()).revision,
      action: "continue",
    }),
  ).rejects.toThrow(/Продолжение поддерживает/);
  expect(await identities(f)).toEqual(before);
});
it.each([
  ["apply.whitespace", "fix"],
  ["core.quotepath", "false"],
])(
  "refuses apply-specific formatting policy %s before confirmation rather than ignoring it in private native Git",
  async (key, value) => {
    const f = await fixture();
    await f.git(["config", key, value]);
    const before = await identities(f);
    await expect(f.prepare()).rejects.toThrow(/конфигурац/i);
    expect(await identities(f)).toEqual(before);
  },
);
it("does not silently drop inherited apply policy when continuing with immutable native config", async () => {
  const f = await fixture();
  await f.resolve();
  const config = path.join(f.home, "fixture-git-config");
  await fs.writeFile(config, "[apply]\nwhitespace = fix\n");
  f.engineEnv.GIT_CONFIG_GLOBAL = config;
  const before = await identities(f);
  await expect(
    f.engine.prepare({
      scope: "project",
      revision: (await f.reader.snapshot()).revision,
      action: "continue",
    }),
  ).rejects.toThrow();
  expect(await identities(f)).toEqual(before);
});

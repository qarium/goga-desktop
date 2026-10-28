import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  lstat,
  rm,
  rename,
  symlink,
  chmod,
  link,
} from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { HostService } from "../src/host/service";
import { NodeRunner } from "../src/host/process";
import { CloneManager } from "../src/host/clones";
import { CloneStore } from "../src/host/clone-store";
import { writeFileSync, chmodSync } from "node:fs";
import * as ownedLocks from "../src/host/owned-lock";
import { withReadScope } from "../src/host/read-scope";
import { DesktopStateStore } from "../src/host/desktop-state";
import { worktreeContextRef } from "../src/shared/worktrees";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const action of cleanup.splice(0).reverse()) await action();
});
async function fixture(
  backend: "merge" | "apply" = "merge",
  remainingCommits = 0,
) {
  const base = await mkdtemp("/private/tmp/goga-rebase-save-");
  cleanup.push(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, "home"),
    root = path.join(base, "source");
  await mkdir(home);
  await mkdir(root);
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const runner = new NodeRunner(10000, env);
  cleanup.push(() => runner.dispose());
  const git = async (cwd: string, args: string[], stdin?: string) =>
    (
      await runner.command(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "commit.gpgSign=false",
          ...args,
        ],
        cwd,
        env,
        stdin,
      )
    ).stdout;
  await git(root, ["init", "-b", "main"]);
  for (const name of ["file.txt", "second.txt", "other.txt"])
    await writeFile(path.join(root, name), "base\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "base"]);
  await git(root, ["branch", "feature"]);
  const host = new HostService({
    home,
    dataDir: path.join(base, "data"),
    runner,
    goga: "/nonexistent-fixture-goga",
  });
  cleanup.push(() => host.dispose());
  const project = await host.addProject(root),
    manager = new CloneManager(home, runner);
  const record = await manager.ensure(project, {
    projectId: project.id,
    year: "2026",
    topic: "feature",
    branch: "feature",
  });
  await git(record.path, ["checkout", "-b", "upstream-fixture"]);
  for (const name of ["file.txt", "second.txt"])
    await writeFile(path.join(record.path, name), "upstream\n");
  await git(record.path, ["commit", "-am", "upstream"]);
  await git(record.path, ["checkout", "feature"]);
  for (const name of ["file.txt", "second.txt"])
    await writeFile(path.join(record.path, name), "topic\n");
  await git(record.path, ["commit", "-am", "topic"]);
  for (let index = 0; index < remainingCommits; index++) {
    const name = `later-${index}.txt`;
    await writeFile(path.join(record.path, name), `later ${index}\n`);
    await git(record.path, ["add", "--", name]);
    await git(record.path, ["commit", "-m", `later ${index}`]);
  }
  await expect(
    git(record.path, ["rebase", `--${backend}`, "upstream-fixture"]),
  ).rejects.toThrow();
  expect(await git(record.path, ["ls-files", "-u"])).not.toBe("");
  expect(
    (await git(record.path, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(),
  ).toBe("HEAD");
  return {
    base,
    home,
    root,
    runner,
    git,
    host,
    project,
    manager,
    record,
    scope: worktreeContextRef(record),
    metadata: path.join(record.gitCommonDir, `rebase-${backend}`),
  };
}
async function tree(root: string): Promise<string> {
  const result: unknown[] = [];
  async function visit(file: string) {
    const s = await lstat(file, { bigint: true });
    result.push([
      file,
      String(s.mode),
      String(s.ino),
      String(s.mtimeNs),
      String(s.ctimeNs),
      s.isFile()
        ? createHash("sha256")
            .update(await readFile(file))
            .digest("hex")
        : "directory",
    ]);
    if (s.isDirectory())
      for (const name of (await readdir(file)).sort())
        await visit(path.join(file, name));
  }
  await visit(root);
  return JSON.stringify(result);
}
async function repositories(f: Awaited<ReturnType<typeof fixture>>) {
  // Project-settings reads retain their existing service-private lock protocol.
  // They must not mutate either repository or the managed clone registry/owners.
  return JSON.stringify([await tree(f.root), await tree(f.manager.store.root)]);
}

async function request(
  f: Awaited<ReturnType<typeof fixture>>,
  name = "file.txt",
) {
  const snapshot = await f.host.readGitWorkspace(f.scope);
  const req = { scope: f.scope, revision: snapshot.revision, path: name };
  const doc = await f.host.readGitConflict(req);
  return { ...req, fingerprint: doc.fingerprint };
}
async function stable(f: Awaited<ReturnType<typeof fixture>>) {
  return JSON.stringify(
    await Promise.all([
      tree(f.root),
      tree(f.metadata),
      tree(path.join(f.record.gitCommonDir, "HEAD")),
      tree(path.join(f.record.gitCommonDir, "refs")),
      tree(path.join(f.record.gitCommonDir, "ORIG_HEAD")),
      tree(path.join(f.record.gitCommonDir, "REBASE_HEAD")),
      tree(path.join(f.manager.store.root, "registry.json")),
    ]),
  );
}
it.each(["merge", "apply"] as const)(
  "saves one conflict during a native multi-commit %s rebase without advancing the operation",
  async (backend) => {
    const f = await fixture(backend, 1);
    await writeFile(path.join(f.record.path, "other.txt"), "staged other\n");
    await f.git(f.record.path, ["add", "--", "other.txt"]);
    await writeFile(path.join(f.record.path, "other.txt"), "working other\n");
    await writeFile(path.join(f.record.path, "untracked.txt"), "untracked\n");
    const untouched = await stable(f),
      before = await tree(f.record.path);
    const unrelatedIndex = await f.git(f.record.path, [
      "ls-files",
      "--stage",
      "-z",
      "--",
      "second.txt",
      "other.txt",
    ]);
    const unrelatedWork = await tree(path.join(f.record.path, "second.txt"));
    const start = Date.now();
    const call = vi.spyOn(f.runner, "command");
    const req = await request(f);
    console.info(
      `M5D4 read ${Date.now() - start} ms, ${call.mock.calls.length} calls`,
    );
    const preview = await f.host.prepareGitConflictSave({
      ...req,
      resolution: { kind: "text", text: "resolved\n" },
    });
    expect(await tree(f.record.path)).toBe(before);
    expect(await stable(f)).toBe(untouched);
    console.info(
      `M5D4 prepared ${Date.now() - start} ms, ${call.mock.calls.length} calls`,
    );
    const result = await f.host.executeGitConflictSave(preview.token);
    console.info(
      `M5D4 executed ${Date.now() - start} ms, ${call.mock.calls.length} calls`,
    );
    expect(result).toMatchObject({
      status: "saved",
      worktreePublished: true,
      indexPublished: true,
    });
    expect(await readFile(path.join(f.record.path, "file.txt"), "utf8")).toBe(
      "resolved\n",
    );
    expect(await f.git(f.record.path, ["show", ":file.txt"])).toBe(
      "resolved\n",
    );
    expect(
      await f.git(f.record.path, ["ls-files", "--unmerged", "--", "file.txt"]),
    ).toBe("");
    expect(await f.git(f.record.path, ["show", ":other.txt"])).toBe(
      "staged other\n",
    );
    expect(await readFile(path.join(f.record.path, "other.txt"), "utf8")).toBe(
      "working other\n",
    );
    expect(
      await readFile(path.join(f.record.path, "untracked.txt"), "utf8"),
    ).toBe("untracked\n");
    expect(await stable(f)).toBe(untouched);
    expect(
      await f.git(f.record.path, [
        "ls-files",
        "--stage",
        "-z",
        "--",
        "second.txt",
        "other.txt",
      ]),
    ).toBe(unrelatedIndex);
    expect(await tree(path.join(f.record.path, "second.txt"))).toBe(
      unrelatedWork,
    );
    for (const [exe, args] of call.mock.calls) {
      expect(exe).toBe("git");
      expect(
        args.some((arg) =>
          [
            "commit",
            "checkout",
            "rebase",
            "fetch",
            "push",
            "reset",
            "stash",
          ].includes(arg),
        ),
      ).toBe(false);
    }
    expect(
      await f.git(f.record.path, [
        "ls-files",
        "--unmerged",
        "--",
        "second.txt",
      ]),
    ).not.toBe("");
    await expect(
      f.host.executeGitConflictSave(preview.token),
    ).rejects.toThrow();
    await writeFile(
      `/private/tmp/goga-m5d4-metrics-${backend}.json`,
      JSON.stringify({
        backend,
        elapsedMs: Date.now() - start,
        calls: call.mock.calls.length,
      }),
    );
  },
);

describe.each(["merge", "apply"] as const)("next conflict in %s", (backend) => {
  let f: Awaited<ReturnType<typeof fixture>>,
    req: Awaited<ReturnType<typeof request>>;
  beforeEach(async () => {
    f = await fixture(backend, 1);
    req = await request(f);
  });
  beforeEach(async () => {
    const preview = await f.host.prepareGitConflictSave({
      ...req,
      resolution: { kind: "current" },
    });
    expect((await f.host.executeGitConflictSave(preview.token)).status).toBe(
      "saved",
    );
  });
  it("keeps the operation pending and the next unresolved file readable and preparable", async () => {
    expect((await f.host.readGitWorkspace(f.scope)).operation).toBe("rebase");
    const req = await request(f, "second.txt"),
      before = await tree(f.record.path);
    expect(
      (
        await f.host.prepareGitConflictSave({
          ...req,
          resolution: { kind: "incoming" },
        })
      ).path,
    ).toBe("second.txt");
    expect(await tree(f.record.path)).toBe(before);
    expect(await f.git(f.record.path, ["show", ":file.txt"])).toBe(
      "upstream\n",
    );
  });
});

it.each(["current", "incoming", "delete", "crlf"] as const)(
  "supports explicit %s resolution without completing rebase",
  async (kind) => {
    const f = await fixture("merge", 1);
    if (kind === "crlf")
      await f.git(f.record.path, ["config", "core.autocrlf", "true"]);
    const req = await request(f),
      unchanged = await stable(f);
    const preview = await f.host.prepareGitConflictSave({
      ...req,
      resolution:
        kind === "crlf" ? { kind: "text", text: "resolved\r\n" } : { kind },
    });
    expect((await f.host.executeGitConflictSave(preview.token)).status).toBe(
      "saved",
    );
    if (kind === "delete") {
      await expect(
        lstat(path.join(f.record.path, "file.txt")),
      ).rejects.toThrow();
      expect(await f.git(f.record.path, ["ls-files", "--", "file.txt"])).toBe(
        "",
      );
    } else {
      const work =
        kind === "current"
          ? "upstream\n"
          : kind === "incoming"
            ? "topic\n"
            : "resolved\r\n";
      expect(await readFile(path.join(f.record.path, "file.txt"), "utf8")).toBe(
        work,
      );
      expect(await f.git(f.record.path, ["show", ":file.txt"])).toBe(
        work.replaceAll("\r\n", "\n"),
      );
    }
    expect(await stable(f)).toBe(unchanged);
  },
);

it("rejects every forged owner dimension and revision without a primary fallback", async () => {
  const f = await fixture(),
    req = await request(f);
  const before = await tree(f.record.path),
    primary = await tree(f.root);
  for (const change of [
    { projectId: "other-project" },
    { year: "2025" },
    { topic: "other" },
    { branch: "other" },
    { contextId: "ctx-other" },
    { revision: randomUUID() },
  ])
    await expect(
      f.host.prepareGitConflictSave({
        ...req,
        scope: { ...f.scope, ...change },
        resolution: { kind: "current" },
      }),
    ).rejects.toThrow();
  expect(await tree(f.record.path)).toBe(before);
  expect(await tree(f.root)).toBe(primary);
});

async function changeFixture(
  f: Awaited<ReturnType<typeof fixture>>,
  change: string,
) {
  const gd = f.record.gitCommonDir;
  if (change === "operation")
    await writeFile(
      path.join(f.metadata, "done"),
      (await readFile(path.join(f.metadata, "done"), "utf8")) + "# changed\n",
    );
  if (change === "HEAD")
    await writeFile(
      path.join(gd, "HEAD"),
      await readFile(path.join(f.metadata, "orig-head")),
    );
  if (change === "ref")
    await writeFile(
      path.join(gd, "refs/heads/feature"),
      await readFile(path.join(gd, "HEAD")),
    );
  if (change === "config")
    await f.git(f.record.path, ["config", "core.eol", "crlf"]);
  if (change === "remote")
    await f.git(f.record.path, [
      "config",
      "remote.desktop-source.url",
      "/nonexistent-fixture-source",
    ]);
  if (change === "index") {
    await writeFile(path.join(f.record.path, "other.txt"), "changed stage\n");
    await f.git(f.record.path, ["add", "--", "other.txt"]);
  }
  if (change === "content")
    await writeFile(path.join(f.record.path, "file.txt"), "new working edit\n");
  if (change === "revision")
    await f.manager.store.update(
      { ...f.record, revision: randomUUID() },
      f.record.revision,
    );
  if (change === "owner")
    await writeFile(path.join(gd, "desktop-owner.json"), "{}\n");
  if (change === "owner pair") {
    const ownerFile = path.join(
      f.manager.store.root,
      `.owner-${f.scope.contextId}.json`,
    );
    const owner = JSON.parse(await readFile(ownerFile, "utf8")),
      nonce = randomUUID();
    await writeFile(ownerFile, JSON.stringify({ ...owner, nonce }));
    await writeFile(
      path.join(gd, "desktop-owner.json"),
      JSON.stringify({ contextId: f.scope.contextId, nonce }),
    );
  }
  if (change === "registry")
    await rm(path.join(f.manager.store.root, "registry.json"));
  if (change === "source") {
    await rename(f.root, f.root + "-moved");
    await mkdir(f.root);
    await writeFile(path.join(f.root, "sentinel"), "untouched\n");
  }
  if (change === "source topology")
    await writeFile(
      path.join(f.root, ".git/commondir"),
      "/nonexistent-fixture-common\n",
    );
  if (change === "plain detached") {
    await rm(f.metadata, { recursive: true });
    await rm(path.join(gd, "REBASE_HEAD"));
  }
  if (change === "wrong reason")
    await f.manager.store.update(
      {
        ...f.record,
        state: "conflict",
        reason: "repository",
        revision: randomUUID(),
      },
      f.record.revision,
    );
  if (change === "wrong branch")
    await writeFile(path.join(f.metadata, "head-name"), "refs/heads/main\n");
  if (change === "malformed")
    await writeFile(
      path.join(f.metadata, "git-rebase-todo"),
      "exec forbidden\n",
    );
  if (change === "mixed")
    await writeFile(
      path.join(gd, "MERGE_HEAD"),
      await readFile(path.join(gd, "HEAD")),
    );
  if (change === "symlink") {
    await rename(
      path.join(f.record.path, "file.txt"),
      path.join(f.record.path, "original.txt"),
    );
    await symlink("original.txt", path.join(f.record.path, "file.txt"));
  }
  if (change === "hardlink")
    await link(
      path.join(f.record.path, "file.txt"),
      path.join(f.record.path, "linked.txt"),
    );
  if (change === "metadata link") {
    await rename(f.metadata, f.metadata + "-original");
    await symlink(f.metadata + "-original", f.metadata);
  }
  if (change === "settings") {
    const store = new DesktopStateStore(f.home, path.join(f.base, "data")),
      doc = await store.read(f.project.id);
    await store.save(
      f.project.id,
      {
        ...doc.value,
        env: [{ key: "CHANGED", value: "yes", secret: false, runtime: false }],
      },
      doc.version,
    );
  }
}
const races = [
  "operation",
  "HEAD",
  "ref",
  "config",
  "remote",
  "index",
  "content",
  "revision",
  "owner",
  "owner pair",
  "registry",
  "source",
  "source topology",
  "settings",
];
it.each(races)(
  "rejects %s changes between read and prepare without writes",
  async (change) => {
    const f = await fixture(),
      req = await request(f);
    await changeFixture(f, change);
    const clone = await tree(f.record.path),
      source = await tree(f.root);
    await expect(
      f.host.prepareGitConflictSave({
        ...req,
        resolution: { kind: "current" },
      }),
    ).rejects.toThrow();
    expect(await tree(f.record.path)).toBe(clone);
    expect(await tree(f.root)).toBe(source);
  },
);
it.each(races)(
  "rejects %s changes between prepare and execute without publication",
  async (change) => {
    const f = await fixture(),
      req = await request(f);
    const preview = await f.host.prepareGitConflictSave({
      ...req,
      resolution: { kind: "incoming" },
    });
    await changeFixture(f, change);
    const clone = await tree(f.record.path),
      source = await tree(f.root);
    await expect(
      f.host.executeGitConflictSave(preview.token),
    ).rejects.toThrow();
    expect(await tree(f.record.path)).toBe(clone);
    expect(await tree(f.root)).toBe(source);
    await expect(
      f.host.executeGitConflictSave(preview.token),
    ).rejects.toThrow();
  },
);
it.each([
  "plain detached",
  "wrong reason",
  "wrong branch",
  "malformed",
  "mixed",
  "symlink",
  "hardlink",
  "metadata link",
])("refuses %s despite an earlier readable document", async (change) => {
  const f = await fixture(),
    req = await request(f);
  await changeFixture(f, change);
  const clone = await tree(f.record.path),
    source = await tree(f.root);
  await expect(
    f.host.prepareGitConflictSave({ ...req, resolution: { kind: "delete" } }),
  ).rejects.toThrow();
  expect(await tree(f.record.path)).toBe(clone);
  expect(await tree(f.root)).toBe(source);
});

it.each(["settings", "revision", "operation", "remote", "source topology"])(
  "rejects a late %s race during native pre-publication verification",
  async (change) => {
    const f = await fixture(),
      req = await request(f);
    const preview = await f.host.prepareGitConflictSave({
      ...req,
      resolution: { kind: "current" },
    });
    const beforeIndex = await readFile(
        path.join(f.record.gitCommonDir, "index"),
      ),
      beforeWork = await readFile(path.join(f.record.path, "file.txt"));
    // The old --git-path text probe now runs only in final owner validation.
    // Inject at the native byte transport's first read instead: same safety
    // invariant (race during preparation, before any publication), new seam.
    const original = f.runner.commandBytes.bind(f.runner);
    let triggered = false;
    vi.spyOn(f.runner, "commandBytes").mockImplementation(async (command) => {
      const result = await original(command);
      if (!triggered && command.args.includes("rev-parse")) {
        triggered = true;
        await changeFixture(f, change);
      }
      return result;
    });
    await expect(
      f.host.executeGitConflictSave(preview.token),
    ).rejects.toThrow();
    expect(triggered).toBe(true);
    expect(await readFile(path.join(f.record.gitCommonDir, "index"))).toEqual(
      beforeIndex,
    );
    expect(await readFile(path.join(f.record.path, "file.txt"))).toEqual(
      beforeWork,
    );
  },
);

it.each(["clones", "desktop"])(
  "never repairs %s root permissions between admission and lifecycle lock",
  async (which) => {
    const f = await fixture(),
      req = await request(f);
    const target =
      which === "clones"
        ? f.manager.store.root
        : path.dirname(f.manager.store.root);
    const before = await tree(f.record.path),
      original = CloneStore.prototype.withRepositoryLock;
    let triggered = false;
    vi.spyOn(CloneStore.prototype, "withRepositoryLock").mockImplementation(
      async function (this: CloneStore, key, fn, ...rest) {
        if (!triggered && this.root === f.manager.store.root) {
          triggered = true;
          await chmod(target, 0o755);
        }
        return original.call(this, key, fn, ...rest);
      },
    );
    await expect(
      f.host.prepareGitConflictSave({
        ...req,
        resolution: { kind: "current" },
      }),
    ).rejects.toThrow();
    expect(triggered).toBe(true);
    expect((await lstat(target)).mode & 0o777).toBe(0o755);
    expect(await tree(f.record.path)).toBe(before);
  },
);

describe("detached rebase publication recovery", () => {
  let f: Awaited<ReturnType<typeof fixture>>,
    req: Awaited<ReturnType<typeof request>>,
    token: string;
  beforeEach(async () => {
    f = await fixture();
    req = await request(f);
  });
  beforeEach(async () => {
    token = (
      await f.host.prepareGitConflictSave({
        ...req,
        resolution: { kind: "text", text: "resolved\n" },
      })
    ).token;
  });
  it.each([
    ["beforePublishWork", "uncertain", false, false, true],
    ["afterPublishWork", "uncertain", true, false, true],
    ["afterPublishIndex", "uncertain", true, true, true],
  ] as const)(
    "preserves recovery semantics for a race at %s",
    async (hook, status, worktreePublished, indexPublished, lockRetained) => {
      const metadata = path.join(f.metadata, "done"),
        old = await readFile(metadata, "utf8");
      const oldWork = await readFile(path.join(f.record.path, "file.txt")),
        oldIndex = await readFile(path.join(f.record.gitCommonDir, "index"));
      (f.host as any).gitConflictActions.options[hook] = () =>
        writeFileSync(metadata, old + "# external change\n");
      const result = await f.host.executeGitConflictSave(token);
      expect(result).toMatchObject({
        status,
        worktreePublished,
        indexPublished,
        lockRetained,
      });
      expect(result.recoveryPath).toBeTruthy();
      await retainedNativeRecovery(f, result, status);
      expect(await readFile(path.join(f.record.path, "file.txt"))).toEqual(
        worktreePublished ? Buffer.from("resolved\n") : oldWork,
      );
      if (!indexPublished)
        expect(
          await readFile(path.join(f.record.gitCommonDir, "index")),
        ).toEqual(oldIndex);
      expect(await readFile(metadata, "utf8")).toBe(
        old + "# external change\n",
      );
      await expect(f.host.executeGitConflictSave(token)).rejects.toThrow();
    },
  );
});

it("requires explicit deletion instead of silently selecting an absent current side", async () => {
  const f = await fixture();
  const stages = await f.git(f.record.path, [
    "ls-files",
    "--unmerged",
    "--stage",
    "-z",
    "--",
    "file.txt",
  ]);
  const retained =
    stages
      .split("\0")
      .filter((row) => row && !row.includes(" 2\t"))
      .join("\0") + "\0";
  await f.git(
    f.record.path,
    ["update-index", "-z", "--index-info"],
    `0 ${"0".repeat(40)}\tfile.txt\0${retained}`,
  );
  const req = await request(f),
    before = await tree(f.record.path);
  await expect(
    f.host.prepareGitConflictSave({ ...req, resolution: { kind: "current" } }),
  ).rejects.toThrow(/отсутствует/);
  expect(await tree(f.record.path)).toBe(before);
  const preview = await f.host.prepareGitConflictSave({
    ...req,
    resolution: { kind: "delete" },
  });
  expect((await f.host.executeGitConflictSave(preview.token)).status).toBe(
    "saved",
  );
  expect(await f.git(f.record.path, ["ls-files", "--", "file.txt"])).toBe("");
});
it.each(["symlink stage", "binary stage"])(
  "refuses unsupported %s even for explicit deletion",
  async (kind) => {
    const f = await fixture();
    const original = (
      await f.git(f.record.path, [
        "ls-files",
        "--unmerged",
        "--stage",
        "-z",
        "--",
        "file.txt",
      ])
    )
      .split("\0")
      .filter(Boolean);
    const blob = (
      await f.git(
        f.record.path,
        ["hash-object", "-w", "--stdin"],
        kind === "binary stage" ? "binary\0data" : "target",
      )
    ).trim();
    const stages =
      original
        .map((row) =>
          row.includes(" 2\t")
            ? `${kind === "symlink stage" ? "120000" : "100644"} ${blob} 2\tfile.txt`
            : row,
        )
        .join("\0") + "\0";
    await f.git(
      f.record.path,
      ["update-index", "-z", "--index-info"],
      `0 ${"0".repeat(40)}\tfile.txt\0${stages}`,
    );
    const req = await request(f),
      before = await tree(f.record.path);
    await expect(
      f.host.prepareGitConflictSave({ ...req, resolution: { kind: "delete" } }),
    ).rejects.toThrow(/symlink|binary/);
    expect(await tree(f.record.path)).toBe(before);
  },
);

describe("lifecycle cleanup preserves completed conflict-save facts", () => {
  const secret = "private-cleanup-fixture-value";
  let f: Awaited<ReturnType<typeof fixture>>,
    req: Awaited<ReturnType<typeof request>>,
    token: string;
  beforeEach(async () => {
    f = await fixture("merge", 1);
    const store = new DesktopStateStore(f.home, path.join(f.base, "data")),
      settings = await store.read(f.project.id);
    await store.save(
      f.project.id,
      {
        ...settings.value,
        env: [
          {
            key: "CLEANUP_SECRET",
            value: secret,
            secret: true,
            runtime: false,
          },
        ],
      },
      settings.version,
    );
    req = await request(f);
  });
  beforeEach(async () => {
    token = (
      await f.host.prepareGitConflictSave({
        ...req,
        resolution: { kind: "text", text: "saved before cleanup\n" },
      })
    ).token;
  });
  function failAfterRelease(after?: () => void) {
    const acquire = ownedLocks.acquireOwnedLock;
    let releases = 0;
    vi.spyOn(ownedLocks, "acquireOwnedLock").mockImplementation(
      async (file, options) => {
        const lock = await acquire(file, options);
        if (!path.basename(file).startsWith(".repository-")) return lock;
        return {
          release: async () => {
            await lock.release();
            releases++;
            after?.();
            // Unlink may succeed before a subsequent directory fsync fails.
            throw Error(`CLEANUP_FAILED ${secret}`);
          },
        };
      },
    );
    return () => releases;
  }
  it("retains uncertain native recovery and exact publication facts after EACCES releasing the lifecycle lock", async () => {
    const index = await readFile(path.join(f.record.gitCommonDir, "index"));
    (f.host as any).gitConflictActions.options.afterPublishWork = () =>
      chmodSync(f.manager.store.root, 0o500);
    try {
      const result = await f.host.executeGitConflictSave(token);
      expect(result).toMatchObject({
        status: "uncertain",
        worktreePublished: true,
        indexPublished: false,
        lockRetained: true,
      });
      expect(result.recoveryPath).toBeTruthy();
      expect(result.log).toMatch(/блокировки/);
      expect(await readFile(path.join(f.record.path, "file.txt"), "utf8")).toBe(
        "saved before cleanup\n",
      );
      expect(await readFile(path.join(f.record.gitCommonDir, "index"))).toEqual(
        index,
      );
      await retainedNativeRecovery(f, result, "uncertain");
      await expect(f.host.executeGitConflictSave(token)).rejects.toThrow(
        /использовано/,
      );
    } finally {
      chmodSync(f.manager.store.root, 0o700);
    }
  });
  it("downgrades saved to uncertain after lifecycle cleanup failure and retains the native write fence", async () => {
    const releases = failAfterRelease();
    const result = await f.host.executeGitConflictSave(token);
    expect(result).toMatchObject({
      status: "uncertain",
      worktreePublished: true,
      indexPublished: true,
      lockRetained: true,
    });
    expect(result.recoveryPath).toBeTruthy();
    expect(result.log).toMatch(/блокировки/);
    expect(result.log).toContain("CLEANUP_FAILED");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(await f.git(f.record.path, ["show", ":file.txt"])).toBe(
      "saved before cleanup\n",
    );
    await expect(
      lstat(
        path.join(
          f.manager.store.root,
          `.repository-${f.record.repositoryKey}.lock`,
        ),
      ),
    ).rejects.toThrow();
    await retainedNativeRecovery(f, result, "completed");
    await expect(f.host.executeGitConflictSave(token)).rejects.toThrow(
      /использовано/,
    );
    expect(releases()).toBe(1);
  });
  it("preserves no-publication facts and both diagnostics without retry after native and lifecycle failures", async () => {
    const releases = failAfterRelease(),
      work = await readFile(path.join(f.record.path, "file.txt")),
      index = await readFile(path.join(f.record.gitCommonDir, "index"));
    (f.host as any).gitConflictActions.options.beforePublishWork = () => {
      throw Error(`ACTION_FAILED ${secret}`);
    };
    const result = await f.host.executeGitConflictSave(token);
    expect(result).toMatchObject({
      status: "uncertain",
      worktreePublished: false,
      indexPublished: false,
      lockRetained: true,
    });
    // The prepared native transport deliberately replaces callback exceptions
    // with its safe verification failure; the lifecycle diagnostic stays visible.
    expect(result.log).toContain("verification");
    expect(result.log).toContain("CLEANUP_FAILED");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.recoveryPath).toBeTruthy();
    expect(await readFile(path.join(f.record.path, "file.txt"))).toEqual(work);
    expect(await readFile(path.join(f.record.gitCommonDir, "index"))).toEqual(
      index,
    );
    await expect(f.host.executeGitConflictSave(token)).rejects.toThrow(
      /использовано/,
    );
    expect(releases()).toBe(1);
  });
  it("rejects canceled prepare after cleanup failure instead of issuing an apparently successful preview", async () => {
    const controller = new AbortController();
    const releases = failAfterRelease(() => controller.abort()),
      before = await tree(f.record.path);
    const error = await withReadScope(controller.signal, () =>
      f.host.prepareGitConflictSave({
        ...req,
        resolution: { kind: "current" },
      }),
    ).then(
      () => {
        throw Error("unexpected preview");
      },
      (e: Error) => e,
    );
    expect(error.message).toContain("CLEANUP_FAILED");
    expect(error.message).not.toContain(secret);
    expect(await tree(f.record.path)).toBe(before);
    expect(releases()).toBe(1);
  });
  it("preserves and redacts action and cleanup errors when execute failed before producing a result", async () => {
    const releases = failAfterRelease(),
      before = await tree(f.record.path),
      command = f.runner.command.bind(f.runner);
    vi.spyOn(f.runner, "command").mockImplementation(
      (exe, args, cwd, env, stdin) => {
        if (args.includes("check-attr")) throw Error(`ACTION_FAILED ${secret}`);
        return command(exe, args, cwd, env, stdin);
      },
    );
    const error = await f.host.executeGitConflictSave(token).then(
      () => {
        throw Error("unexpected result");
      },
      (e: Error) => e,
    );
    expect(error.message).toContain("ACTION_FAILED");
    expect(error.message).toContain("CLEANUP_FAILED");
    expect(error.message).not.toContain(secret);
    expect(await tree(f.record.path)).toBe(before);
    await expect(f.host.executeGitConflictSave(token)).rejects.toThrow(
      /использовано/,
    );
    expect(releases()).toBe(1);
  });
});

async function retainedNativeRecovery(
  f: Awaited<ReturnType<typeof fixture>>,
  result: { recoveryPath?: string },
  state: string,
) {
  expect(result.recoveryPath).toBeTruthy();
  const record = JSON.parse(await readFile(result.recoveryPath!, "utf8"));
  expect(record).toMatchObject({ state, recovery: expect.any(Object) });
  // The old private journal directory is gone. Verify durable recovery and the
  // actual write fence instead of asserting an artificial index/HEAD pin.
  await expect(
    (f.host as any).nativeGitJournal.assertAdmission(
      f.record.path,
      record.recovery.owner,
    ),
  ).rejects.toThrow();
}

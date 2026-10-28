import { gitIntegrationBudget } from "./helpers/git-integration";
import { installGitFixtureScope } from "./helpers/git-test-scope";
const fixtureScope = installGitFixtureScope();
import { expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readdir,
  readFile,
  stat,
  utimes,
} from "node:fs/promises";
import path from "node:path";
import { HostService } from "../src/host/service";
import { NodeRunner } from "../src/host/process";
import { CloneManager } from "../src/host/clones";
import { worktreeContextRef } from "../src/shared/worktrees";
import { isOfflineGitRead } from "../src/host/read-scope";
async function fixture() {
  const base = await mkdtemp("/private/tmp/goga-git-workspace-host-");
  fixtureScope().cleanup(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, "home"),
    root = path.join(base, "repo");
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
  const runner = fixtureScope.runner(new NodeRunner(10000, env));
  fixtureScope().cleanup(() => runner.dispose());
  const git = async (args: string[]) =>
    (
      await runner.command(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "gc.auto=0",
          "-c",
          "maintenance.auto=false",
          ...args,
        ],
        root,
        env,
      )
    ).stdout;
  await git(["init", "-b", "main"]);
  await writeFile(path.join(root, "file.txt"), "base\n");
  await git(["add", "."]);
  await git(["-c", "commit.gpgSign=false", "commit", "-m", "fixture"]);
  await git(["branch", "feature"]);
  const host = fixtureScope().own(
    new HostService({
      home,
      dataDir: path.join(base, "data"),
      runner,
      goga: "/nonexistent-fixture-goga",
    }),
  );
  fixtureScope().cleanup(() => host.dispose());
  const project = await host.addProject(root);
  return { base, home, root, runner, host, project, git };
}
it(
  "commits only selected primary files through a one-use ticket without publishing",
  fixtureScope.run(async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, "file.txt"), "chosen\n");
    await writeFile(path.join(f.root, "other.txt"), "staged other\n");
    await f.git(["add", "other.txt"]);
    const snapshot = await f.host.readGitWorkspace(f.project.id);
    const preview = await (f.host as any).prepareGitCommit({
      scope: f.project.id,
      revision: snapshot.revision,
      paths: ["file.txt"],
      message: "selected",
    });
    expect(preview.root).toBe(f.root);
    const result = await (f.host as any).executeGitCommit(preview.token);
    expect(result.status).toBe("committed");
    expect(result.indexPublished).toBe(true);
    expect(await f.git(["show", "HEAD:file.txt"])).toBe("chosen\n");
    expect((await f.git(["diff", "--cached", "--name-only"])).trim()).toBe(
      "other.txt",
    );
    await expect(
      (f.host as any).executeGitCommit(preview.token),
    ).rejects.toThrow();
  }),
  gitIntegrationBudget(15000),
);
it(
  "commits in the exact managed clone and refuses disappeared or forged owners",
  fixtureScope.run(async () => {
    const f = await fixture();
    const clone = await new CloneManager(f.home, f.runner).ensure(f.project, {
      projectId: f.project.id,
      year: "2026",
      topic: "feature",
      branch: "feature",
    });
    const scope = worktreeContextRef(clone);
    await writeFile(path.join(clone.path, "file.txt"), "only clone\n");
    const snapshot = await f.host.readGitWorkspace(scope);
    const request = {
      scope,
      revision: snapshot.revision,
      paths: ["file.txt"],
      message: "clone selected",
    };
    const preview = await (f.host as any).prepareGitCommit(request);
    const result = await (f.host as any).executeGitCommit(preview.token);
    expect(result.status).toBe("committed");
    expect(result.scope).toEqual(scope);
    expect(await f.git(["show", "HEAD:file.txt"])).toBe("base\n");
    expect(
      (await f.runner.command("git", ["show", "HEAD:file.txt"], clone.path))
        .stdout,
    ).toBe("only clone\n");
    await expect(
      (f.host as any).prepareGitCommit({
        ...request,
        scope: { ...scope, branch: "main" },
      }),
    ).rejects.toThrow();
    await rm(clone.path, { recursive: true, force: true });
    await expect((f.host as any).prepareGitCommit(request)).rejects.toThrow();
    expect(await f.git(["show", "HEAD:file.txt"])).toBe("base\n");
  }),
  gitIntegrationBudget(15000),
);
it(
  "invalidates commit authority after project settings change",
  fixtureScope.run(async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, "file.txt"), "chosen\n");
    const snap = await f.host.readGitWorkspace(f.project.id);
    const preview = await (f.host as any).prepareGitCommit({
      scope: f.project.id,
      revision: snap.revision,
      paths: ["file.txt"],
      message: "selected",
    });
    const settings = await f.host.readProjectSettings(f.project.id);
    await f.host.saveProjectSettings(
      f.project.id,
      {
        ...settings.value,
        env: [
          { key: "FIXTURE", value: "changed", secret: false, runtime: false },
        ],
      },
      settings.version,
    );
    const outcome = await (f.host as any)
      .executeGitCommit(preview.token)
      .catch((e: Error) => e);
    expect(outcome instanceof Error || outcome.status === "not-committed").toBe(
      true,
    );
    expect(await f.git(["rev-parse", "HEAD"])).toBe(snap.head + "\n");
  }),
  gitIntegrationBudget(15000),
);
it(
  "refuses a runner without the native byte-command capability without falling back",
  fixtureScope.run(async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, "file.txt"), "chosen\n");
    const snap = await f.host.readGitWorkspace(f.project.id);
    const preview = await f.host.prepareGitCommit({
      scope: f.project.id,
      revision: snap.revision,
      paths: ["file.txt"],
      message: "selected",
    });
    const before = await readFile(path.join(f.root, ".git/index"));
    Object.defineProperty(f.runner, "commandBytes", { value: undefined });
    const outcome = await f.host
      .executeGitCommit(preview.token)
      .catch((e: Error) => e);
    expect(outcome instanceof Error || outcome.status === "not-committed").toBe(
      true,
    );
    expect(await f.git(["rev-parse", "HEAD"])).toBe(snap.head + "\n");
    expect(await readFile(path.join(f.root, ".git/index"))).toEqual(before);
    expect(
      (await readdir(path.join(f.root, ".git"))).some(
        (name) => name === "index.lock" || name.startsWith("goga-commit-"),
      ),
    ).toBe(false);
  }),
  gitIntegrationBudget(15000),
);
it(
  "reads primary changes offline without Goga and rejects invalid scope/path",
  fixtureScope.run(async () => {
    const f = await fixture();
    expect((f.host as any).readGitWorkspace).toBeTypeOf("function");
    await writeFile(path.join(f.root, "file.txt"), "primary edit\n");
    const original = f.runner.command.bind(f.runner);
    const calls = vi
      .spyOn(f.runner, "command")
      .mockImplementation(async (exe, args, cwd, env, stdin) => {
        expect(exe).toBe("git");
        expect(isOfflineGitRead()).toBe(true);
        return original(exe, args, cwd, env, stdin);
      });
    const snapshot = await (f.host as any).readGitWorkspace(f.project.id);
    expect(snapshot.scope).toBe(f.project.id);
    expect(snapshot.root).toBe(f.root);
    expect(snapshot.files.map((x: any) => x.path)).toEqual(["file.txt"]);
    const diff = await (f.host as any).readGitDiff({
      scope: f.project.id,
      path: "file.txt",
      revision: snapshot.revision,
    });
    expect(diff.unstaged.text).toContain("+primary edit");
    expect(
      calls.mock.calls.every(
        (c) => !c[1].includes("board") && !c[1].includes("fetch"),
      ),
    ).toBe(true);
    const count = calls.mock.calls.length;
    await expect((f.host as any).readGitWorkspace("missing")).rejects.toThrow();
    await expect(
      (f.host as any).readGitDiff({
        scope: f.project.id,
        path: "../outside",
        revision: snapshot.revision,
      }),
    ).rejects.toThrow();
    expect(calls).toHaveBeenCalledTimes(count);
  }),
  gitIntegrationBudget(15000),
);
it(
  "reads exactly the clone owner, rejects stale revision and never falls back to primary",
  fixtureScope.run(async () => {
    const f = await fixture();
    expect((f.host as any).readGitWorkspace).toBeTypeOf("function");
    const clone = await new CloneManager(f.home, f.runner).ensure(f.project, {
      projectId: f.project.id,
      year: "2026",
      topic: "feature",
      branch: "feature",
    });
    const scope = worktreeContextRef(clone);
    await writeFile(path.join(f.root, "primary.txt"), "only primary\n");
    await writeFile(path.join(clone.path, "clone.txt"), "only clone\n");
    const snapshot = await (f.host as any).readGitWorkspace(scope);
    expect(snapshot.scope).toEqual(scope);
    expect(snapshot.root).toBe(clone.path);
    expect(snapshot.files.some((x: any) => x.path === "clone.txt")).toBe(true);
    expect(snapshot.files.some((x: any) => x.path === "primary.txt")).toBe(
      false,
    );
    await expect(
      (f.host as any).readGitWorkspace({
        ...scope,
        revision: scope.revision + 1,
      }),
    ).rejects.toThrow();
    await rm(clone.path, { recursive: true, force: true });
    await expect((f.host as any).readGitWorkspace(scope)).rejects.toThrow();
  }),
  gitIntegrationBudget(15000),
);
it(
  "keeps a managed clone readable while a real merge conflict is present",
  fixtureScope.run(async () => {
    const f = await fixture();
    const clone = await new CloneManager(f.home, f.runner).ensure(f.project, {
      projectId: f.project.id,
      year: "2026",
      topic: "feature",
      branch: "feature",
    });
    const git = (args: string[]) =>
      f.runner.command(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "gc.auto=0",
          "-c",
          "maintenance.auto=false",
          "-c",
          "commit.gpgSign=false",
          ...args,
        ],
        clone.path,
      );
    await writeFile(path.join(clone.path, "file.txt"), "ours\n");
    await git(["add", "file.txt"]);
    await git(["commit", "-m", "ours"]);
    await git(["checkout", "-b", "other", "HEAD~1"]);
    await writeFile(path.join(clone.path, "file.txt"), "theirs\n");
    await git(["add", "file.txt"]);
    await git(["commit", "-m", "theirs"]);
    await git(["checkout", "feature"]);
    await expect(git(["merge", "--no-edit", "other"])).rejects.toThrow();
    const snapshot = await f.host.readGitWorkspace(worktreeContextRef(clone));
    expect(snapshot.operation).toBe("merge");
    expect(snapshot.files.find((file) => file.path === "file.txt")?.kind).toBe(
      "conflict",
    );
    expect(snapshot.root).toBe(clone.path);
  }),
  gitIntegrationBudget(15000),
);

it.each(["primary", "clone"] as const)(
  "rejects a %s split index before touching shared metadata through host resolution",
  fixtureScope.run(async (kind) => {
    const f = await fixture();
    const clone =
      kind === "clone"
        ? await new CloneManager(f.home, f.runner).ensure(f.project, {
            projectId: f.project.id,
            year: "2026",
            topic: "feature",
            branch: "feature",
          })
        : null;
    const root = clone?.path ?? f.root;
    const scope = clone ? worktreeContextRef(clone) : f.project.id;
    const before = await f.host.readGitWorkspace(scope);
    await f.runner.command("git", ["update-index", "--split-index"], root);
    const dir = path.join(root, ".git");
    const shared = (await readdir(dir)).find((name) =>
      name.startsWith("sharedindex."),
    )!;
    expect(shared).toBeTruthy();
    const file = path.join(dir, shared);
    await utimes(file, new Date(1000), new Date(1000));
    const bytes = await readFile(file),
      mtime = (await stat(file)).mtimeMs;
    await expect(f.host.readGitWorkspace(scope)).rejects.toThrow(/split-index/);
    await expect(
      f.host.readGitDiff({
        scope,
        path: "file.txt",
        revision: before.revision,
      }),
    ).rejects.toThrow(/split-index/);
    expect(await readFile(file)).toEqual(bytes);
    expect((await stat(file)).mtimeMs).toBe(mtime);
  }),
  gitIntegrationBudget(15000),
);

async function makeConflict(
  f: Awaited<ReturnType<typeof fixture>>,
  root: string,
) {
  const git = async (args: string[]) =>
    (
      await f.runner.command(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "gc.auto=0",
          "-c",
          "maintenance.auto=false",
          "-c",
          "commit.gpgSign=false",
          ...args,
        ],
        root,
      )
    ).stdout;
  const branch = (await git(["branch", "--show-current"])).trim();
  await git(["checkout", "-b", "incoming"]);
  await writeFile(path.join(root, "file.txt"), "incoming\n");
  await git(["commit", "-am", "incoming"]);
  await git(["checkout", branch]);
  await writeFile(path.join(root, "file.txt"), "current\n");
  await git(["commit", "-am", "current"]);
  await git(["merge", "incoming"]).catch(() => undefined);
  expect(await git(["ls-files", "-u"])).not.toBe("");
  return git;
}
it.each([false, true])(
  "reads exact conflict stages offline in primary/clone=%s with no mutation or fallback",
  fixtureScope.run(async (inClone) => {
    const f = await fixture();
    const clone = inClone
      ? await new CloneManager(f.home, f.runner).ensure(f.project, {
          projectId: f.project.id,
          year: "2026",
          topic: "feature",
          branch: "feature",
        })
      : undefined;
    const root = clone?.path ?? f.root,
      scope = clone ? worktreeContextRef(clone) : f.project.id;
    await makeConflict(f, root);
    const before = await readFile(path.join(root, ".git/index"));
    const work = await readFile(path.join(root, "file.txt"));
    const read = (request: object) => (f.host as any).readGitConflict(request);
    const snapshot = await f.host.readGitWorkspace(scope);
    const original = f.runner.command.bind(f.runner);
    const calls = vi
      .spyOn(f.runner, "command")
      .mockImplementation(async (exe, args, cwd, env, stdin) => {
        expect(exe).toBe("git");
        expect(isOfflineGitRead()).toBe(true);
        return original(exe, args, cwd, env, stdin);
      });
    const request = { scope, path: "file.txt", revision: snapshot.revision };
    const document = await read(request);
    expect(document.scope).toEqual(scope);
    expect(document.current.text).toBe("current\n");
    expect(document.incoming.text).toBe("incoming\n");
    expect(document.base.text).toBe("base\n");
    expect(document.working.text).toBe(work.toString());
    expect(await readFile(path.join(root, ".git/index"))).toEqual(before);
    expect(await readFile(path.join(root, "file.txt"))).toEqual(work);
    expect(
      calls.mock.calls.every(
        (c) => !c[1].includes("board") && !c[1].includes("fetch"),
      ),
    ).toBe(true);
    calls.mockRestore();
    if (clone) {
      await expect(
        read({ ...request, scope: { ...(scope as object), topic: "forged" } }),
      ).rejects.toThrow();
      await rm(clone.path, { recursive: true, force: true });
      await expect(read(request)).rejects.toThrow();
      expect(await f.git(["show", "HEAD:file.txt"])).toBe("base\n");
    } else {
      await writeFile(path.join(root, "file.txt"), "manual change\n");
      await expect(read(request)).rejects.toThrow();
    }
  }),
  gitIntegrationBudget(15000),
);

it.each([false, true])(
  "saves exactly one conflict in primary/clone=%s without committing or changing another staged file",
  fixtureScope.run(async (inClone) => {
    const f = await fixture();
    const clone = inClone
      ? await new CloneManager(f.home, f.runner).ensure(f.project, {
          projectId: f.project.id,
          year: "2026",
          topic: "feature",
          branch: "feature",
        })
      : undefined;
    const root = clone?.path ?? f.root,
      scope = clone ? worktreeContextRef(clone) : f.project.id;
    const git = await makeConflict(f, root);
    await writeFile(path.join(root, "other.txt"), "unrelated staged\n");
    await git(["add", "other.txt"]);
    const unrelated = await git(["ls-files", "--stage", "--", "other.txt"]);
    const before = await readFile(path.join(root, ".git/index")),
      work = await readFile(path.join(root, "file.txt"));
    const snap = await f.host.readGitWorkspace(scope);
    const document = await f.host.readGitConflict({
      scope,
      path: "file.txt",
      revision: snap.revision,
    });
    expect(typeof (f.host as any).prepareGitConflictSave).toBe("function");
    const request = {
      scope,
      path: "file.txt",
      revision: snap.revision,
      fingerprint: document.fingerprint,
      resolution: { kind: "text", text: "\ufeffresolved\r\nno final newline" },
    };
    const nativeCommand = f.runner.command.bind(f.runner);
    let isolatedCalls = 0;
    const canonicalCalls = vi
      .spyOn(f.runner, "command")
      .mockImplementation((exe, args, cwd, env, stdin) => {
        // Saving a conflict must not ask status to hash unrelated working files:
        // a concurrently installed clean filter could run before stale rejection.
        expect(args).not.toContain("status");
        expect(args).not.toContain("diff");
        if (
          args.some(
            (arg) =>
              arg.startsWith("--git-dir=") &&
              arg.includes("goga-conflict-canonical-"),
          )
        ) {
          isolatedCalls++;
          expect(env).toMatchObject({
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_ATTR_NOSYSTEM: "1",
            GIT_NO_LAZY_FETCH: "1",
            GIT_ALLOW_PROTOCOL: "",
          });
        }
        return nativeCommand(exe, args, cwd, env, stdin);
      });
    const preview = await (f.host as any).prepareGitConflictSave(request);
    expect(preview.scope).toEqual(scope);
    expect(preview.hooks).toBe("disabled");
    expect(await readFile(path.join(root, ".git/index"))).toEqual(before);
    expect(await readFile(path.join(root, "file.txt"))).toEqual(work);
    const result = await (f.host as any).executeGitConflictSave(preview.token);
    expect(result.status).toBe("saved");
    expect(isolatedCalls).toBeGreaterThanOrEqual(2);
    canonicalCalls.mockRestore();
    expect(result.worktreePublished).toBe(true);
    expect(result.indexPublished).toBe(true);
    expect(result.scope).toEqual(scope);
    expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(
      request.resolution.text,
    );
    expect(await git(["ls-files", "-u"])).toBe("");
    expect(await git(["ls-files", "--stage", "--", "other.txt"])).toBe(
      unrelated,
    );
    expect((await git(["rev-parse", "HEAD"])).trim()).toBe(snap.head);
    expect(
      await readFile(path.join(root, ".git/MERGE_HEAD"), "utf8"),
    ).toBeTruthy();
    await expect(
      (f.host as any).executeGitConflictSave(preview.token),
    ).rejects.toThrow();
    if (clone) {
      expect(await f.git(["show", "HEAD:file.txt"])).toBe("base\n");
      await expect(
        (f.host as any).prepareGitConflictSave({
          ...request,
          scope: { ...worktreeContextRef(clone), topic: "forged" },
        }),
      ).rejects.toThrow();
      await rm(clone.path, { recursive: true, force: true });
      await expect(
        (f.host as any).prepareGitConflictSave(request),
      ).rejects.toThrow();
      expect(await f.git(["show", "HEAD:file.txt"])).toBe("base\n");
    }
  }),
  gitIntegrationBudget(15000),
);

it(
  "invalidates conflict-save authority after settings change before writing any bytes",
  fixtureScope.run(async () => {
    const f = await fixture();
    await makeConflict(f, f.root);
    const scope = f.project.id,
      snap = await f.host.readGitWorkspace(scope);
    const document = await f.host.readGitConflict({
      scope,
      path: "file.txt",
      revision: snap.revision,
    });
    expect(typeof (f.host as any).prepareGitConflictSave).toBe("function");
    const preview = await (f.host as any).prepareGitConflictSave({
      scope,
      path: "file.txt",
      revision: snap.revision,
      fingerprint: document.fingerprint,
      resolution: { kind: "current" },
    });
    const before = await readFile(path.join(f.root, ".git/index")),
      work = await readFile(path.join(f.root, "file.txt"));
    const settings = await f.host.readProjectSettings(scope);
    await f.host.saveProjectSettings(
      scope,
      {
        ...settings.value,
        env: [
          {
            key: "FIXTURE",
            value: "new-setting",
            secret: false,
            runtime: false,
          },
        ],
      },
      settings.version,
    );
    const result = await (f.host as any)
      .executeGitConflictSave(preview.token)
      .catch((e: Error) => e);
    expect(result instanceof Error || result.status === "not-saved").toBe(true);
    expect(await readFile(path.join(f.root, ".git/index"))).toEqual(before);
    expect(await readFile(path.join(f.root, "file.txt"))).toEqual(work);
  }),
  gitIntegrationBudget(15000),
);

it.each(["content", "operation", "head"] as const)(
  "refuses a read document after %s changes before conflict preview",
  fixtureScope.run(async (changed) => {
    const f = await fixture();
    await makeConflict(f, f.root);
    const scope = f.project.id,
      snapshot = await f.host.readGitWorkspace(scope);
    const document = await f.host.readGitConflict({
      scope,
      path: "file.txt",
      revision: snapshot.revision,
    });
    if (changed === "content")
      await writeFile(path.join(f.root, "file.txt"), "new local edit\n");
    else if (changed === "operation")
      await writeFile(
        path.join(f.root, ".git/MERGE_MSG"),
        "new operation message\n",
      );
    else await f.git(["update-ref", "HEAD", "HEAD^"]);
    const work = await readFile(path.join(f.root, "file.txt")),
      index = await readFile(path.join(f.root, ".git/index"));
    await expect(
      f.host.prepareGitConflictSave({
        scope,
        path: "file.txt",
        revision: snapshot.revision,
        fingerprint: document.fingerprint,
        resolution: { kind: "text", text: "obsolete draft\n" },
      }),
    ).rejects.toThrow();
    expect(await readFile(path.join(f.root, "file.txt"))).toEqual(work);
    expect(await readFile(path.join(f.root, ".git/index"))).toEqual(index);
    expect(
      (await readdir(path.join(f.root, ".git"))).includes("index.lock"),
    ).toBe(false);
  }),
  gitIntegrationBudget(15000),
);
it(
  "reads display summaries only from the authorized primary or exact managed owner",
  fixtureScope.run(async () => {
    const f = await fixture();
    const clone = await new CloneManager(f.home, f.runner).ensure(f.project, {
      projectId: f.project.id,
      year: "2026",
      topic: "feature",
      branch: "feature",
    });
    const scope = worktreeContextRef(clone);
    await writeFile(path.join(f.root, "file.txt"), "primary change\n");
    await writeFile(path.join(f.root, "primary.txt"), "primary only\n");
    await writeFile(path.join(clone.path, "clone.txt"), "clone only\n");
    const original = f.runner.command.bind(f.runner);
    const commands = vi
      .spyOn(f.runner, "command")
      .mockImplementation((exe, args, cwd, env, stdin) => {
        expect(exe).toBe("git");
        expect(isOfflineGitRead()).toBe(true);
        return original(exe, args, cwd, env, stdin);
      });
    expect(await f.host.readGitSummary(f.project.id)).toEqual({
      scope: f.project.id,
      branch: "main",
      changedFiles: 2,
      conflicts: 0,
    });
    expect(await f.host.readGitSummary(scope)).toEqual({
      scope,
      branch: "feature",
      changedFiles: 1,
      conflicts: 0,
    });
    const count = commands.mock.calls.length;
    await expect(f.host.readGitSummary("unknown-project")).rejects.toThrow();
    await expect(
      f.host.readGitSummary({ ...scope, revision: scope.revision + 1 }),
    ).rejects.toThrow();
    await expect(
      f.host.readGitSummary({ ...scope, branch: "main" }),
    ).rejects.toThrow();
    expect(commands).toHaveBeenCalledTimes(count);
    await rm(clone.path, { recursive: true, force: true });
    await expect(f.host.readGitSummary(scope)).rejects.toThrow();
    expect(commands).toHaveBeenCalledTimes(count);
  }),
  gitIntegrationBudget(15000),
);

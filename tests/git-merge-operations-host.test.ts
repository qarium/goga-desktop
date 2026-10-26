import {
  GitMetadataLockCleanupError,
  preserveGitMergeCleanupError,
} from "../src/host/git-merge-safety";
import { afterEach, expect, it, vi } from "vitest";
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
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
it.each([
  ["primary", "continue", false],
  ["clone", "continue", false],
  ["primary", "abort", false],
  ["clone", "abort", false],
  ["primary", "abort", true],
] as const)(
  "preserves typed cleanup outcome and redacts host diagnostics: %s %s legacy=%s",
  async (kind, action, legacy) => {
    const f = await pending(kind);
    const secret = "configured-sensitive-fixture-728491";
    const settings = await f.host.readProjectSettings(f.project.id);
    await f.host.saveProjectSettings(
      f.project.id,
      {
        ...settings.value,
        env: [
          {
            key: "FIXTURE_SECRET",
            value: secret,
            secret: true,
            runtime: false,
          },
        ],
      },
      settings.version,
    );
    if (action === "continue") {
      await writeFile(path.join(f.executionRoot, "file.txt"), "resolved\n");
      await f.git(["add", "file.txt"]);
    }
    const native = f.runner.command.bind(f.runner);
    vi.spyOn(f.runner, "command").mockImplementation(
      async (file, args, cwd, env, stdin) => {
        try {
          const out = await native(file, args, cwd, env, stdin);
          if (args.includes("commit-tree"))
            out.stderr += "\ndiagnostic " + secret;
          return out;
        } catch (error) {
          if (args.includes("--abort"))
            (error as any).stderr += "\ndiagnostic " + secret;
          throw error;
        }
      },
    );
    const actions = (f.host as any)[
      legacy ? "gitBranches" : "gitMergeOperations"
    ];
    actions.releaseLockFault = (name: string, phase: string) => {
      if (name === "config.lock" && phase === "before")
        throw Error("outer cleanup fault " + secret);
    };
    const preview = legacy
      ? await f.host.prepareGitBranch({
          projectId: f.project.id,
          action: "abort-merge",
          revision: (await f.host.readGitBranches(f.project.id)).revision,
        })
      : await f.host.prepareGitMergeOperation({
          scope: f.scope,
          action,
          revision: (await f.host.readGitWorkspace(f.scope)).revision,
        });
    const out = legacy
      ? await f.host.executeGitBranch(preview.token)
      : await f.host.executeGitMergeOperation(preview.token);
    expect(
      await stat(path.join(f.executionRoot, ".git/config.lock")),
    ).toBeTruthy();
    expect(out).toMatchObject({
      status: "uncertain",
      changed: true,
      lockRetained: true,
      retainedLocks: ["config.lock"],
    });
    expect(out.log).not.toContain(secret);
    expect(out.message).not.toContain(secret);
    expect(out.log).toContain("outer cleanup fault");
    expect(out.recoveryPath).toBeTruthy();
    expect((await f.host.readGitWorkspace(f.scope)).operation).toBe("none");
  },
);
async function fixture(namespace = "") {
  const base = await mkdtemp(
    "/private/tmp/goga-git-workspace-host-" + namespace,
  );
  cleanup.push(() => rm(base, { recursive: true, force: true }));
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
  const runner = new NodeRunner(10000, env);
  cleanup.push(() => runner.dispose());
  const git = async (args: string[]) =>
    (
      await runner.command(
        "git",
        ["-c", "core.hooksPath=/dev/null", ...args],
        root,
        env,
      )
    ).stdout;
  await git(["init", "-b", "main"]);
  await writeFile(path.join(root, "file.txt"), "base\n");
  await git(["add", "."]);
  await git(["-c", "commit.gpgSign=false", "commit", "-m", "fixture"]);
  await git(["branch", "feature"]);
  const host = new HostService({
    home,
    dataDir: path.join(base, "data"),
    runner,
    goga: "/nonexistent-fixture-goga",
  });
  cleanup.push(() => host.dispose());
  const project = await host.addProject(root);
  return { base, home, root, runner, host, project, git, env };
}

async function pending(kind: "primary" | "clone", namespace = "") {
  const f = await fixture(namespace);
  const clone =
    kind === "clone"
      ? await new CloneManager(f.home, f.runner).ensure(f.project, {
          projectId: f.project.id,
          year: "2026",
          topic: "feature",
          branch: "feature",
        })
      : null;
  const root = clone?.path ?? f.root,
    scope = clone ? worktreeContextRef(clone) : f.project.id,
    branch = clone?.branch ?? "main";
  const git = async (args: string[]) =>
    (
      await f.runner.command(
        "git",
        ["-c", "core.hooksPath=/dev/null", ...args],
        root,
        f.env,
      )
    ).stdout;
  await writeFile(path.join(root, "unrelated"), "original\n");
  await git(["add", "unrelated"]);
  await git(["commit", "-m", "unrelated"]);
  const base = (await git(["rev-parse", "HEAD"])).trim();
  await writeFile(path.join(root, "file.txt"), "ours\n");
  await git(["add", "file.txt"]);
  await git(["commit", "-m", "ours"]);
  const old = (await git(["rev-parse", "HEAD"])).trim();
  await git(["checkout", "-b", "other", base]);
  await writeFile(path.join(root, "file.txt"), "theirs\n");
  await git(["add", "file.txt"]);
  await git(["commit", "-m", "theirs"]);
  const source = (await git(["rev-parse", "HEAD"])).trim();
  await git(["checkout", branch]);
  await expect(git(["merge", "--no-edit", source])).rejects.toThrow();
  return { ...f, git, executionRoot: root, scope, clone, old, source, branch };
}
it.each(["primary", "clone"] as const)(
  "completes pending merge only in exact %s owner with offline admission",
  async (kind) => {
    const f = await pending(kind);
    expect((f.host as any).prepareGitMergeOperation).toBeTypeOf("function");
    await writeFile(path.join(f.executionRoot, "file.txt"), "resolved\n");
    await f.git(["add", "file.txt"]);
    await writeFile(path.join(f.executionRoot, "unrelated"), "draft\n");
    const primaryHead = await f.runner.command(
      "git",
      ["rev-parse", "HEAD"],
      f.root,
    );
    const original = f.runner.command.bind(f.runner),
      calls: { cwd: string; offline: boolean }[] = [];
    vi.spyOn(f.runner, "command").mockImplementation(
      (file, args, cwd, env, stdin) => {
        expect(file).toBe("git");
        calls.push({ cwd, offline: isOfflineGitRead() });
        return original(file, args, cwd, env, stdin);
      },
    );
    const snapshot = await f.host.readGitWorkspace(f.scope);
    const preview = await (f.host as any).prepareGitMergeOperation({
      scope: f.scope,
      revision: snapshot.revision,
      action: "continue",
      message: "Explicit merge",
    });
    expect(preview.root).toBe(f.executionRoot);
    expect(preview.message).toBe("Explicit merge\n");
    const out = await (f.host as any).executeGitMergeOperation(preview.token);
    expect(out, JSON.stringify(out)).toMatchObject({
      status: "success",
      scope: f.scope,
    });
    expect(calls.every((c) => c.offline)).toBe(true);
    expect(
      (await f.git(["show", "-s", "--format=%P%n%B", "HEAD"])).trim(),
    ).toBe(`${f.old} ${f.source}\nExplicit merge`);
    expect(
      await readFile(path.join(f.executionRoot, "unrelated"), "utf8"),
    ).toBe("draft\n");
    if (f.clone)
      expect(
        (await original("git", ["rev-parse", "HEAD"], f.root)).stdout,
      ).toBe(primaryHead.stdout);
    await expect(
      (f.host as any).executeGitMergeOperation(preview.token),
    ).rejects.toThrow();
  },
);
it("aborts an attached clone merge without touching primary or unrelated work", async () => {
  const f = await pending("clone");
  expect((f.host as any).prepareGitMergeOperation).toBeTypeOf("function");
  await writeFile(path.join(f.executionRoot, "unrelated"), "draft\n");
  const snapshot = await f.host.readGitWorkspace(f.scope);
  const p = await (f.host as any).prepareGitMergeOperation({
    scope: f.scope,
    revision: snapshot.revision,
    action: "abort",
  });
  expect(await (f.host as any).executeGitMergeOperation(p.token)).toMatchObject(
    { status: "success", scope: f.scope },
  );
  expect(await readFile(path.join(f.executionRoot, "unrelated"), "utf8")).toBe(
    "draft\n",
  );
  expect(await readFile(path.join(f.root, "file.txt"), "utf8")).toBe("base\n");
});
it.each(["missing", "branch", "revision"])(
  "rejects %s clone owner after confirmation and never falls back to primary",
  async (kind) => {
    const f = await pending("clone");
    expect((f.host as any).prepareGitMergeOperation).toBeTypeOf("function");
    const snap = await f.host.readGitWorkspace(f.scope),
      primaryIndex = await readFile(path.join(f.root, ".git/index"));
    const p = await (f.host as any).prepareGitMergeOperation({
      scope: f.scope,
      revision: snap.revision,
      action: "abort",
    });
    if (kind === "missing")
      await rm(f.executionRoot, { recursive: true, force: true });
    if (kind === "branch")
      await f.git(["symbolic-ref", "HEAD", "refs/heads/other"]);
    if (kind === "revision") {
      const manager = new CloneManager(f.home, f.runner);
      const registry = await manager.store.read();
      const row = registry.records.find(
        (r) => r.contextId === f.clone!.contextId,
      )!;
      row.revision = "00000000-0000-4000-8000-000000000002";
      await manager.store.write(registry.revision, registry.records);
    }
    const result = await (f.host as any)
      .executeGitMergeOperation(p.token)
      .catch((e: Error) => e);
    expect(
      result instanceof Error || (result.status === "error" && !result.changed),
    ).toBe(true);
    expect(await readFile(path.join(f.root, ".git/index"))).toEqual(
      primaryIndex,
    );
    expect(await readFile(path.join(f.root, "file.txt"), "utf8")).toBe(
      "base\n",
    );
  },
);

it("preserves only typed cleanup metadata without copying raw error causes", () => {
  const secret = "private-cause-fixture";
  const typed = preserveGitMergeCleanupError(
    new GitMetadataLockCleanupError("config.lock", true, Error(secret), true),
    "safe diagnostic",
  );
  expect(typed).toBeInstanceOf(GitMetadataLockCleanupError);
  expect(typed).toMatchObject({
    lock: "config.lock",
    retained: true,
    message: "safe diagnostic",
    cause: "safe diagnostic",
    unchecked: true,
  });
  expect(JSON.stringify(typed)).not.toContain(secret);
  const forged = preserveGitMergeCleanupError(
    Object.assign(Error(secret), { lock: "config.lock", retained: true }),
    "safe diagnostic",
  );
  expect(forged).not.toBeInstanceOf(GitMetadataLockCleanupError);
  expect(forged).not.toHaveProperty("lock");
  expect(forged).not.toHaveProperty("retained");
  expect(forged).not.toHaveProperty("cause");
});
it.each(["primary", "clone"] as const)(
  "redacts abort cleanup root pathname without manufacturing native HEAD warnings (%s)",
  async (kind) => {
    const secret = "sensitive-native-root-728491";
    const f = await pending(kind, secret);
    const settings = await f.host.readProjectSettings(f.project.id);
    await f.host.saveProjectSettings(
      f.project.id,
      {
        ...settings.value,
        env: [
          {
            key: "FIXTURE_SECRET",
            value: secret,
            secret: true,
            runtime: false,
          },
        ],
      },
      settings.version,
    );
    (f.host as any).gitMergeOperations.releaseLockFault = (
      name: string,
      phase: string,
    ) => {
      if (name === "config.lock" && phase === "before")
        throw Error(`native cleanup fault ${f.executionRoot}`);
    };
    const p = await f.host.prepareGitMergeOperation({
      scope: f.scope,
      revision: (await f.host.readGitWorkspace(f.scope)).revision,
      action: "abort",
    });
    const out = await f.host.executeGitMergeOperation(p.token);
    expect(out).toMatchObject({
      status: "uncertain",
      changed: true,
      lockRetained: true,
      retainedLocks: ["config.lock"],
    });
    expect(
      await stat(path.join(f.executionRoot, ".git/config.lock")),
    ).toBeTruthy();
    expect(out.log).toContain("config.lock");
    expect(out.log).not.toContain("HEAD.lock");
    expect(out.log).not.toContain(secret);
    expect(out.message).not.toContain(secret);
    expect((await f.host.readGitWorkspace(f.scope)).operation).toBe("none");
  },
);

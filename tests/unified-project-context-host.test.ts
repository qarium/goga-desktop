import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { HostService } from "../src/host/service";
import { CloneManager } from "../src/host/clones";
import { WorktreeManager } from "../src/host/worktrees";
import { DesktopStateStore } from "../src/host/desktop-state";
import { withReadScope } from "../src/host/read-scope";
import { worktreeContextRef } from "../src/shared/worktrees";
import type { ScopeRef } from "../src/shared/context";
import type { ProjectDocumentTarget } from "../src/shared/project-documents";
import type { Runner } from "../src/host/process";

const exec = promisify(execFile);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}
async function bytes(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of (await fs.readdir(root, { recursive: true })).sort()) {
    const file = path.join(root, name);
    if ((await fs.lstat(file)).isFile())
      result[name] = (await fs.readFile(file)).toString("base64");
  }
  return result;
}
async function fixture() {
  const root = await fs.mkdtemp("/private/tmp/goga-unified51-host-");
  cleanup.push(() =>
    fs.rm(root, { recursive: true, force: true, maxRetries: 5 }),
  );
  const home = path.join(root, "home"),
    primary = path.join(root, "primary");
  await fs.mkdir(home);
  await fs.mkdir(primary);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = async (args: string[], cwd = primary) =>
    (
      await exec("git", ["-c", "core.hooksPath=/dev/null", ...args], {
        cwd,
        env,
      })
    ).stdout;
  await git(["init", "-b", "primary-current"]);
  await fs.writeFile(path.join(primary, "README"), "committed fixture\n");
  await git(["add", "."]);
  await git(["commit", "-m", "fixture"]);
  await git(["branch", "alpha"]);
  await git(["branch", "beta"]);
  const calls: { exe: string; args: string[]; cwd: string }[] = [];
  const starts: { exe: string; args: string[]; cwd: string; child: any }[] = [];
  const labels = new Map([[primary, "primary"]]);
  const runner: Runner = {
    command: async (exe, args, cwd, overrides) => {
      calls.push({ exe, args, cwd });
      if (exe === "git")
        return exec("git", args, {
          cwd,
          env: { ...env, ...overrides, HOME: home },
        });
      // No native Goga, Docker, pipeline or build is ever executed.
      const label = labels.get(cwd);
      if (!label || !["synthetic-goga", "synthetic-shared"].includes(exe))
        throw Error("Unexpected executable/root");
      if (args[0] === "pipeline" && args.includes("--list"))
        return {
          stdout: `* work\n    name: ${label}\n    description: fixture\n`,
          stderr: "",
        };
      if (args[0] === "pipeline" && args.includes("--info"))
        return {
          stdout: `name: ${label}\n---\n* work:\n    title: ${label}\n`,
          stderr: "",
        };
      if (args[0] === "topics" && args.includes("board")) {
        const branch = (await git(["branch", "--show-current"], cwd)).trim();
        return {
          stdout: JSON.stringify([
            {
              topic: branch,
              branch,
              current: true,
              remote: false,
              todo: `${label} task`,
              statuses: ["todo"],
            },
          ]),
          stderr: "",
        };
      }
      if (args.join(" ") === "build --help")
        return {
          stdout:
            "--workflow --profile --skip-review --no-skip-review --clean --update --skip-manifest-check",
          stderr: "",
        };
      if (args.join(" ") === "config build.review.skip")
        return { stdout: "# build.review.skip\nFalse\n", stderr: "" };
      if (args.join(" ") === "history path -f plan.md")
        return { stdout: "plan.md\n", stderr: "" };
      throw Error(`Unexpected synthetic command: ${args.join(" ")}`);
    },
    start: (exe, args, cwd) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      starts.push({ exe, args, cwd, child });
      return child as any;
    },
    kill: async (child) => {
      child.emit("close", 0, null);
    },
  };
  const service = new HostService({
    home,
    dataDir: path.join(home, "data"),
    goga: "synthetic-goga",
    runner,
  });
  cleanup.push(() => service.dispose());
  const project = await service.addProject(primary);
  const manager = new CloneManager(home, runner);
  const a = await manager.ensure(project, {
    projectId: project.id,
    year: "2026",
    topic: "alpha",
    branch: "alpha",
  });
  const b = await manager.ensure(project, {
    projectId: project.id,
    year: "2026",
    topic: "beta",
    branch: "beta",
  });
  labels.set(a.path, "alpha");
  labels.set(b.path, "beta");
  const owners = [
    {
      scope: project.id as ScopeRef,
      path: primary,
      label: "primary",
      branch: "primary-current",
    },
    {
      scope: worktreeContextRef(a) as ScopeRef,
      path: a.path,
      label: "alpha",
      branch: "alpha",
    },
    {
      scope: worktreeContextRef(b) as ScopeRef,
      path: b.path,
      label: "beta",
      branch: "beta",
    },
  ];
  for (const owner of owners) {
    const content = `# ${owner.label}\nlabel: ${owner.label}\n`;
    const files = {
      ".goga/config.yml": content,
      [`.goga/workflows/${owner.label}.yml`]: content,
      [`.goga/pipelines/${owner.label}.yml`]: content,
      [`.goga/profiles/${owner.label}.yml`]: content,
      [`.goga/tools/${owner.label}/settings.yml`]: content,
      [`.goga/history/2026/${owner.branch}/todo.md`]: `${owner.label} task\n`,
      "plan.md": `# ${owner.label} plan\n`,
    };
    for (const [relative, text] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(owner.path, relative)), {
        recursive: true,
      });
      await fs.writeFile(path.join(owner.path, relative), text);
    }
  }
  await fs.mkdir(path.join(home, ".goga/profiles"), { recursive: true });
  await fs.writeFile(
    path.join(home, ".goga/profiles/personal.yml"),
    "# personal\n",
  );
  await fs.writeFile(path.join(primary, "README"), "dirty primary\n");
  await fs.writeFile(
    path.join(primary, "valuable-untracked"),
    "primary only\n",
  );
  // DesktopStateStore intentionally initializes its shared defaults on first read.
  // Characterize subsequent read-only operations after that registry bootstrap.
  await service.readProjectSettings(project.id);
  calls.length = 0;
  return {
    root,
    home,
    primary,
    git,
    calls,
    starts,
    runner,
    service,
    project,
    manager,
    a,
    b,
    owners,
  };
}

describe(
  "unified primary and exact owned clone host scope",
  { timeout: 30000 },
  () => {
    it("characterizes settings reads as one shared execution document with owner-local profile catalogs", async () => {
      const f = await fixture();
      const before = await bytes(f.root);
      const views = [];
      for (const owner of f.owners) {
        const view = await f.service.readProjectSettings(owner.scope);
        views.push(view);
        expect(view.profiles).toEqual(
          [
            { name: owner.label, source: "project" },
            { name: "personal", source: "home" },
          ].sort((a, b) => a.name.localeCompare(b.name)),
        );
      }
      expect(views.map((v) => v.version)).toEqual(
        Array(3).fill(views[0].version),
      );
      expect(await bytes(f.root)).toEqual(before);
      expect(f.starts).toHaveLength(0);
    });
    it("characterizes exact catalogs/documents/discovery/preview and build reads without changing any fixture bytes", async () => {
      const f = await fixture();
      const before = await bytes(f.root);
      for (const owner of f.owners) {
        expect(
          (await f.service.listProjectWorkflows(owner.scope)).map(
            (x) => x.name,
          ),
        ).toEqual([owner.label]);
        expect(
          (await f.service.listProjectPipelines(owner.scope)).map(
            (x) => x.name,
          ),
        ).toEqual([owner.label]);
        expect(
          (await f.service.listProjectProfiles(owner.scope)).map((x) => x.name),
        ).toEqual([owner.label]);
        expect(
          (await f.service.listProjectTools(owner.scope)).map((x) => x.name),
        ).toEqual([owner.label]);
        const targets: ProjectDocumentTarget[] = [
          { kind: "config" },
          { kind: "workflow", name: owner.label },
          { kind: "pipeline", name: owner.label },
          { kind: "profile", name: owner.label },
          { kind: "tool", tool: owner.label, path: "settings.yml" },
        ];
        for (const target of targets)
          expect(
            (await f.service.readProjectDocument(owner.scope, target)).text,
          ).toContain(`label: ${owner.label}`);
        const start = f.calls.length;
        const context =
          typeof owner.scope === "string" ? undefined : owner.scope;
        const discovery = await f.service.discover(owner.scope);
        expect(discovery.currentBranch).toBe(owner.branch);
        expect(discovery.workflows).toEqual([owner.label]);
        const preview = await f.service.preview({
          projectId: f.project.id,
          context,
          pipeline: "work",
          workflow: owner.label,
          profile: "",
          skips: [],
        });
        expect(preview.stages[0].title).toBe(owner.label);
        expect((await f.service.buildContext(owner.scope)).branch).toBe(
          owner.branch,
        );
        expect(
          (await f.service.readBuildPlan(owner.scope, "plan.md")).text,
        ).toBe(`# ${owner.label} plan\n`);
        expect(
          (await f.service.listBuildFiles(owner.scope)).entries.some(
            (e) => e.name === "plan.md",
          ),
        ).toBe(true);
        expect(
          f.calls
            .slice(start)
            .filter((c) => c.exe !== "git")
            .every((c) => c.cwd === owner.path),
        ).toBe(true);
      }
      expect(await bytes(f.root)).toEqual(before);
      expect(f.starts).toHaveLength(0);
      expect(
        f.calls
          .filter((c) => c.exe === "git")
          .some((c) =>
            c.args.some((a) =>
              [
                "clone",
                "switch",
                "checkout",
                "add",
                "commit",
                "fetch",
              ].includes(a),
            ),
          ),
      ).toBe(false);
    });
    it("characterizes all document saves as exact-owner writes despite dirty primary and other clone", async () => {
      const f = await fixture();
      for (const owner of f.owners) {
        const others = f.owners.filter((x) => x !== owner);
        const before = await Promise.all(others.map((x) => bytes(x.path)));
        const targets: ProjectDocumentTarget[] = [
          { kind: "config" },
          { kind: "workflow", name: owner.label },
          { kind: "pipeline", name: owner.label },
          { kind: "profile", name: owner.label },
          { kind: "tool", tool: owner.label, path: "settings.yml" },
        ];
        for (const target of targets) {
          const doc = await f.service.readProjectDocument(owner.scope, target);
          const changed = doc.text + "# saved exact scope\n";
          expect(
            (
              await f.service.saveProjectDocument(
                owner.scope,
                target,
                changed,
                doc.version,
              )
            ).text,
          ).toBe(changed);
          expect(
            (await f.service.readProjectDocument(owner.scope, target)).text,
          ).toBe(changed);
        }
        expect(await Promise.all(others.map((x) => bytes(x.path)))).toEqual(
          before,
        );
      }
    });
    it("characterizes shared registry save and rejects profiles absent from the requested owner", async () => {
      const f = await fixture();
      const a = await f.service.readProjectSettings(f.owners[1].scope);
      const value = {
        ...a.value,
        executable: "synthetic-shared",
        profile: "alpha",
      };
      const saved = await f.service.saveProjectSettings(
        f.owners[1].scope,
        value,
        a.version,
      );
      for (const owner of f.owners)
        expect(
          (await f.service.readProjectSettings(owner.scope)).value,
        ).toEqual(value);
      for (const owner of [f.owners[0], f.owners[2]])
        await expect(
          f.service.saveProjectSettings(owner.scope, value, saved.version),
        ).rejects.toThrow(/профиль отсутствует/);
      expect((await f.service.readProjectSettings(f.project.id)).version).toBe(
        saved.version,
      );
    });
    it("rejects a settings read cancelled while the shared document was being read", async () => {
      const f = await fixture(),
        started = barrier(),
        finish = barrier();
      const original = DesktopStateStore.prototype.read;
      vi.spyOn(DesktopStateStore.prototype, "read").mockImplementation(
        async function (this: DesktopStateStore, id) {
          const result = await original.call(this, id);
          started.release();
          await finish.promise;
          return result;
        },
      );
      const abort = new AbortController();
      const pending = withReadScope(abort.signal, () =>
        f.service.readProjectSettings(f.owners[1].scope),
      );
      const rejected = expect(pending).rejects.toThrow(/отмен|прерван/i);
      await started.promise;
      abort.abort();
      finish.release();
      await rejected;
    });
    it("rejects a settings read whose exact clone owner changed before publishing profiles", async () => {
      const f = await fixture(),
        started = barrier(),
        finish = barrier();
      const original = DesktopStateStore.prototype.read;
      vi.spyOn(DesktopStateStore.prototype, "read").mockImplementation(
        async function (this: DesktopStateStore, id) {
          const result = await original.call(this, id);
          started.release();
          await finish.promise;
          return result;
        },
      );
      const pending = f.service.readProjectSettings(f.owners[1].scope);
      const rejected = expect(pending).rejects.toThrow(
        /ветк|контекст|клон|измен/i,
      );
      await started.promise;
      await f.git(["checkout", "--detach"], f.a.path);
      finish.release();
      await rejected;
    });
    it("rejects a settings save whose exact owner changes during profile validation", async () => {
      const f = await fixture();
      const scope = f.owners[1].scope;
      const before = await f.service.readProjectSettings(scope);
      const primaryBefore = await bytes(f.primary);
      const betaBefore = await bytes(f.b.path);
      const settingsBefore = await bytes(
        path.join(f.home, ".goga/desktop/settings"),
      );
      const started = barrier(),
        finish = barrier();
      // Pause the real filesystem profile read at its asynchronous boundary.
      const internal = f.service as unknown as {
        profiles(project: {
          id: string;
          name: string;
          path: string;
        }): Promise<{ name: string; source: "home" | "project" }[]>;
      };
      const original = internal.profiles.bind(internal);
      vi.spyOn(internal, "profiles").mockImplementation(async (project) => {
        const result = await original(project);
        started.release();
        await finish.promise;
        return result;
      });
      const pending = f.service.saveProjectSettings(
        scope,
        { ...before.value, executable: "synthetic-shared", profile: "alpha" },
        before.version,
      );
      const rejected = expect(pending).rejects.toThrow(
        /ветк|контекст|клон|измен/i,
      );
      await started.promise;
      await f.git(["checkout", "--detach"], f.a.path);
      finish.release();
      await rejected;
      expect(await bytes(path.join(f.home, ".goga/desktop/settings"))).toEqual(
        settingsBefore,
      );
      expect((await f.service.readProjectSettings(f.project.id)).version).toBe(
        before.version,
      );
      expect(await bytes(f.primary)).toEqual(primaryBefore);
      expect(await bytes(f.b.path)).toEqual(betaBefore);
      expect(f.starts).toHaveLength(0);
    });
    it("characterizes a queued document save as captured owner A while reads move to B", async () => {
      const f = await fixture(),
        entered = barrier(),
        release = barrier();
      const original = DesktopStateStore.prototype.save;
      vi.spyOn(DesktopStateStore.prototype, "save").mockImplementation(
        async function (this: DesktopStateStore, ...args) {
          entered.release();
          await release.promise;
          return original.apply(this, args);
        },
      );
      const settings = await f.service.readProjectSettings(f.project.id);
      const first = f.service.saveProjectSettings(
        f.project.id,
        settings.value,
        settings.version,
      );
      await entered.promise;
      let selected = f.owners[1].scope;
      const doc = await f.service.readProjectDocument(selected, {
        kind: "config",
      });
      const queued = f.service.saveProjectDocument(
        selected,
        { kind: "config" },
        doc.text + "# captured A\n",
        doc.version,
      );
      selected = f.owners[2].scope;
      expect(
        (await f.service.readProjectDocument(selected, { kind: "config" }))
          .text,
      ).toContain("label: beta");
      release.release();
      await first;
      await queued;
      expect(
        (
          await f.service.readProjectDocument(f.owners[1].scope, {
            kind: "config",
          })
        ).text,
      ).toContain("# captured A");
      expect(
        (await f.service.readProjectDocument(selected, { kind: "config" }))
          .text,
      ).not.toContain("# captured A");
      expect(
        (await f.service.readProjectDocument(f.project.id, { kind: "config" }))
          .text,
      ).not.toContain("# captured A");
    });
    it(
      "characterizes primary and clone synthetic pipeline/build launches with exact cwd, task gates and saved repeat owner",
      { timeout: 60000 },
      async () => {
        const f = await fixture();
        for (const owner of f.owners) {
          const context =
            typeof owner.scope === "string" ? undefined : owner.scope;
          const pipeline = {
            projectId: f.project.id,
            context,
            pipeline: "work",
            workflow: "none",
            profile: "",
            skips: [],
          };
          const preview = await f.service.preview(pipeline);
          const task = await f.service.readTopicTask({
            projectId: f.project.id,
            context,
            branch: owner.branch,
            topic: owner.branch,
          });
          const request = {
            ...pipeline,
            previewToken: preview.token,
            topic: {
              mode: "existing" as const,
              branch: owner.branch,
              topic: owner.branch,
            },
            task: task.text,
            taskVersion: task.version,
            confirmEmptyTask: true,
            expectedBranch: owner.branch,
            confirmBranchSwitch: false,
            clean: false,
          };
          const startsBefore = f.starts.length;
          await expect(
            f.service.launch({ ...request, taskVersion: "a".repeat(64) }),
          ).rejects.toThrow(/устарел|изменен|изменён/i);
          if (context)
            await expect(
              f.service.launch({ ...request, task: " \n" }),
            ).rejects.toThrow(/непуст|описание задачи/i);
          expect(f.starts).toHaveLength(startsBefore);
          const run = await f.service.launch(request);
          expect(f.starts.at(-1)?.cwd).toBe(owner.path);
          expect(run.branch).toBe(owner.branch);
          expect(run.context?.contextId).toBe(context?.contextId);
          // Selecting another view is a read only operation; stop remains run-owned.
          await f.service.readProjectSettings(
            f.owners[owner === f.owners[2] ? 0 : 2].scope,
          );
          await f.service.stop(run.id);
          expect(f.service.runs().find((x) => x.id === run.id)?.status).toBe(
            "stopped",
          );
          const buildContext = await f.service.buildContext(owner.scope);
          const plan = await f.service.readBuildPlan(owner.scope, "plan.md");
          const build = await f.service.launchBuild({
            projectId: f.project.id,
            context,
            expectedBranch: owner.branch,
            contextRevision: buildContext.revision,
            planPath: plan.path,
            planVersion: plan.version,
            options: {},
            confirmClean: false,
          });
          expect(f.starts.at(-1)?.cwd).toBe(owner.path);
          expect(f.starts.at(-1)?.args[0]).toBe("build");
          await f.service.stop(build.id);
          const repeat = await f.service.prepareBuildRepeat(build.id);
          expect(repeat.context).toEqual(context);
          expect(repeat.projectId).toBe(f.project.id);
          expect(repeat.planPath).toBe("plan.md");
          expect(await f.service.checkoutBranch(f.project.id)).toBe(
            "primary-current",
          );
        }
        expect(await fs.readFile(path.join(f.primary, "README"), "utf8")).toBe(
          "dirty primary\n",
        );
        expect(
          await fs.readFile(path.join(f.primary, "valuable-untracked"), "utf8"),
        ).toBe("primary only\n");
      },
    );
    it.each(["stale", "missing", "legacy"])(
      "characterizes %s context as error, never primary fallback",
      async (kind) => {
        const f = await fixture();
        let scope = f.owners[1].scope;
        if (typeof scope === "string") throw Error("fixture owner required");
        if (kind === "stale")
          scope = {
            ...scope,
            revision: "00000000-0000-4000-8000-000000000001",
          };
        if (kind === "missing")
          await fs.rename(f.a.path, `${f.a.path}.preserved`);
        if (kind === "legacy") {
          await f.git(["branch", "legacy"]);
          const linked = await new WorktreeManager(f.home, f.runner).ensure(
            f.project,
            {
              projectId: f.project.id,
              year: "2026",
              topic: "legacy",
              branch: "legacy",
            },
          );
          scope = worktreeContextRef(linked);
          expect(
            (await fs.lstat(path.join(linked.path, ".git"))).isFile(),
          ).toBe(true);
        }
        const before = await bytes(f.primary);
        for (const read of [
          () => f.service.readProjectSettings(scope),
          () => f.service.listProjectWorkflows(scope),
          () => f.service.readProjectDocument(scope, { kind: "config" }),
          () => f.service.discover(scope),
          () => f.service.readBuildPlan(scope, "plan.md"),
          () => f.service.buildContext(scope),
        ])
          await expect(read()).rejects.toThrow();
        expect(await bytes(f.primary)).toEqual(before);
        expect(f.starts).toHaveLength(0);
      },
    );
  },
);

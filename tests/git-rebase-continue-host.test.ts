import {
  afterEach,
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as fs from "node:fs/promises";
import { writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { HostService } from "../src/host/service";
import { NodeRunner } from "../src/host/process";
import { CloneManager } from "../src/host/clones";
import { worktreeContextRef } from "../src/shared/worktrees";
import * as ownedLocks from "../src/host/owned-lock";
const cleanup: (() => Promise<unknown>)[] = [];
let retainFixture = false;
afterEach(async () => {
  if (retainFixture) return;
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(kind: "primary" | "managed", long = false) {
  const base = await fs.mkdtemp("/private/tmp/goga-rebase-continue-host-");
  cleanup.push(() => fs.rm(base, { recursive: true, force: true }));
  const home = path.join(base, "home"),
    source = path.join(base, "source");
  await fs.mkdir(home);
  await fs.mkdir(source);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_NO_LAZY_FETCH: "1",
  };
  const runner = new NodeRunner(10000, env);
  cleanup.push(() => runner.dispose());
  const git = (cwd: string, a: string[]) =>
    runner.command(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...a],
      cwd,
      env,
    );
  await git(source, ["init", "-b", "main"]);
  for (const n of [
    "file",
    "second",
    ...(long ? ["clean-before", "clean-after"] : []),
  ])
    await fs.writeFile(path.join(source, n), "base\n");
  await git(source, ["add", "."]);
  await git(source, ["commit", "-m", "base"]);
  await git(source, ["branch", "feature"]);
  const host = new HostService({
    home,
    dataDir: path.join(base, "data"),
    runner,
    goga: "/nonexistent/disabled",
  });
  cleanup.push(() => host.dispose());
  const project = await host.addProject(source);
  const record =
    kind === "managed"
      ? await new CloneManager(home, runner).ensure(project, {
          projectId: project.id,
          year: "2026",
          topic: "feature",
          branch: "feature",
        })
      : null;
  const root = record?.path ?? source,
    branch = record?.branch ?? "main",
    scope = record ? worktreeContextRef(record) : project.id;
  await git(root, ["checkout", "-b", "upstream-fixture"]);
  for (const n of ["file", "second"])
    await fs.writeFile(path.join(root, n), "upstream\n");
  await git(root, ["commit", "-am", "upstream"]);
  await git(root, ["checkout", branch]);
  await fs.writeFile(path.join(root, "file"), "topic\n");
  await git(root, ["commit", "-am", "topic"]);
  if (long) {
    await fs.writeFile(path.join(root, "clean-before"), "clean before\n");
    await git(root, ["commit", "-am", "clean before"]);
  }
  await fs.writeFile(path.join(root, "second"), "second topic\n");
  await git(root, ["commit", "-am", "second topic"]);
  if (long) {
    await fs.writeFile(path.join(root, "clean-after"), "clean after\n");
    await git(root, ["commit", "-am", "clean after"]);
  }
  const original = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  await expect(
    git(root, ["rebase", "--merge", "upstream-fixture"]),
  ).rejects.toThrow();
  await fs.writeFile(path.join(root, "file"), "resolved first\n");
  await git(root, ["add", "file"]);
  expect(
    (host as any).prepareGitRebaseOperation,
    "host operation admission is missing",
  ).toBeTypeOf("function");
  const prepare = async () =>
    host.prepareGitRebaseOperation({
      scope,
      action: "continue",
      revision: (await host.readGitWorkspace(scope)).revision,
    });
  return {
    base,
    home,
    source,
    root,
    record,
    scope,
    host,
    project,
    runner,
    git,
    prepare,
    original,
    branch,
  };
}

describe.each(["primary", "managed"] as const)(
  "native %s continuation roundtrip",
  (kind) => {
    let f: Awaited<ReturnType<typeof fixture>>,
      manager: CloneManager,
      registry: string,
      beforeRegistry: Buffer | null,
      sourceHead: string;
    beforeAll(async () => {
      retainFixture = true;
      f = await fixture(kind);
      manager = new CloneManager(f.home, f.runner);
      registry = path.join(manager.store.root, "registry.json");
      beforeRegistry = f.record ? await fs.readFile(registry) : null;
      sourceHead = (await f.git(f.source, ["rev-parse", "HEAD"])).stdout;
    });
    afterAll(async () => {
      retainFixture = false;
      vi.restoreAllMocks();
      for (const fn of cleanup.splice(0).reverse()) await fn();
    });
    it("publishes the next stopped conflict on the exact original owner", async () => {
      const r = await f.host.executeGitRebaseOperation(
        (await f.prepare()).token,
      );
      expect(r, r.log).toMatchObject({
        status: "conflict",
        branchPublished: false,
        metadataPublished: true,
      });
      if (f.record) {
        expect(await fs.readFile(registry)).toEqual(beforeRegistry);
        expect(await (manager as any).validate(f.record)).toMatchObject({
          state: "conflict",
          reason: "branch",
        });
        expect((await f.git(f.source, ["rev-parse", "HEAD"])).stdout).toBe(
          sourceHead,
        );
      }
    });
    it("reads the same stopped owner and saves a single-file resolution", async () => {
      const snapshot = await f.host.readGitWorkspace(f.scope);
      expect(snapshot.operation).toBe("rebase");
      expect(snapshot.branch).toBe(null);
      const req = {
          scope: f.scope,
          revision: snapshot.revision,
          path: "second",
        },
        doc = await f.host.readGitConflict(req);
      expect(doc.incoming.text).toBe("second topic\n");
      const p = await f.host.prepareGitConflictSave({
        ...req,
        fingerprint: doc.fingerprint,
        resolution: { kind: "text", text: "resolved second\n" },
      });
      const r = await f.host.executeGitConflictSave(p.token);
      expect(r, r.log).toMatchObject({ status: "saved" });
      if (f.record) expect(await fs.readFile(registry)).toEqual(beforeRegistry);
    });
    it("finishes with a second native continuation without repairing registry or source", async () => {
      const r = await f.host.executeGitRebaseOperation(
        (await f.prepare()).token,
      );
      expect(r, r.log).toMatchObject({
        status: "success",
        branchPublished: true,
        metadataCleared: true,
      });
      expect((await f.git(f.root, ["symbolic-ref", "HEAD"])).stdout).toBe(
        `refs/heads/${f.branch}\n`,
      );
      if (f.record) {
        expect(await fs.readFile(registry)).toEqual(beforeRegistry);
        expect((await f.git(f.source, ["rev-parse", "HEAD"])).stdout).toBe(
          sourceHead,
        );
      }
    });
  },
);
describe.each(["primary", "managed"] as const)(
  "%s four-pick continuation",
  (kind) => {
    let f: Awaited<ReturnType<typeof fixture>>, sourceHead: string;
    beforeAll(async () => {
      retainFixture = true;
      f = await fixture(kind, true);
      sourceHead = (await f.git(f.source, ["rev-parse", "HEAD"])).stdout;
    });
    afterAll(async () => {
      retainFixture = false;
      vi.restoreAllMocks();
      for (const fn of cleanup.splice(0).reverse()) await fn();
    });
    it("publishes the entire clean prefix before the next conflict", async () => {
      const first = await f.host.executeGitRebaseOperation(
        (await f.prepare()).token,
      );
      expect(first, first.log).toMatchObject({
        status: "conflict",
        lockRetained: false,
      });
      expect((await f.git(f.root, ["show", "HEAD:clean-before"])).stdout).toBe(
        "clean before\n",
      );
    });
    it("reads and saves the next conflict for the same owner", async () => {
      const snapshot = await f.host.readGitWorkspace(f.scope);
      const req = {
        scope: f.scope,
        revision: snapshot.revision,
        path: "second",
      };
      const doc = await f.host.readGitConflict(req);
      const save = await f.host.prepareGitConflictSave({
        ...req,
        fingerprint: doc.fingerprint,
        resolution: { kind: "text", text: "resolved second\n" },
      });
      expect(await f.host.executeGitConflictSave(save.token)).toMatchObject({
        status: "saved",
      });
    });
    it("finishes all remaining picks without modifying the source project", async () => {
      const last = await f.host.executeGitRebaseOperation(
        (await f.prepare()).token,
      );
      expect(last, last.log).toMatchObject({
        status: "success",
        lockRetained: false,
        metadataCleared: true,
      });
      expect((await f.host.readGitWorkspace(f.scope)).branch).toBe(f.branch);
      expect((await f.git(f.root, ["show", "HEAD:clean-after"])).stdout).toBe(
        "clean after\n",
      );
      if (kind === "managed")
        expect((await f.git(f.source, ["rev-parse", "HEAD"])).stdout).toBe(
          sourceHead,
        );
    });
  },
);
it.each(["primary", "managed"] as const)(
  "%s aborts a long rebase after saved resolution and returns to its original branch",
  async (kind) => {
    const f = await fixture(kind, true);
    const p = await f.host.prepareGitRebaseOperation({
      scope: f.scope,
      action: "abort",
      revision: (await f.host.readGitWorkspace(f.scope)).revision,
    });
    const r = await f.host.executeGitRebaseOperation(p.token);
    expect(r, r.log).toMatchObject({
      status: "success",
      lockRetained: false,
      worktreeRestored: true,
    });
    expect((await f.git(f.root, ["rev-parse", "HEAD"])).stdout.trim()).toBe(
      f.original,
    );
    expect((await f.host.readGitWorkspace(f.scope)).branch).toBe(f.branch);
  },
);
it("managed continuation refuses settings drift before execute without primary fallback", async () => {
  const f = await fixture("managed"),
    p = await f.prepare(),
    before = await fs.readFile(path.join(f.root, ".git/index")),
    settings = await f.host.readProjectSettings(f.project.id);
  await f.host.saveProjectSettings(
    f.project.id,
    {
      ...settings.value,
      env: [
        ...settings.value.env,
        { key: "FIXTURE", value: "changed", secret: false, runtime: false },
      ],
    },
    settings.version,
  );
  await expect(f.host.executeGitRebaseOperation(p.token)).rejects.toThrow();
  expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(before);
});

it.each(["primary", "managed"] as const)(
  "reports %s postpublication settings mismatch as uncertain without adopting a new owner",
  async (kind) => {
    const f = await fixture(kind),
      p = await f.prepare(),
      settingsDir = path.join(f.home, ".goga/desktop/settings"),
      file = path.join(settingsDir, (await fs.readdir(settingsDir))[0]);
    (f.host as any).gitRebaseOperations.options.afterPublish = (
      step: string,
    ) => {
      if (step === "metadata")
        writeFileSync(file, readFileSync(file, "utf8") + "\n");
    };
    const r = await f.host.executeGitRebaseOperation(p.token);
    expect(r, r.log).toMatchObject({
      status: "uncertain",
      metadataPublished: true,
      headPublished: true,
      lockRetained: true,
    });
  },
);

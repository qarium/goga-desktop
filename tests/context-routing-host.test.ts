import { DesktopStateStore } from "../src/host/desktop-state";
import { CloneStore } from "../src/host/clone-store";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { HostService } from "../src/host/service";
import { CloneManager } from "../src/host/clones";
import {
  worktreeContextRef,
  type WorktreeRecord,
} from "../src/shared/worktrees";
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const root = await mkdtemp(
    "/private/tmp/goga-context-ab-research-20261019-impl-routing-",
  );
  const primary = path.join(root, "primary"),
    clone = path.join(root, "clone"),
    home = path.join(root, "home");
  for (const dir of [primary, clone]) {
    await mkdir(path.join(dir, "docs"), { recursive: true });
    await mkdir(path.join(dir, ".git"));
    await mkdir(path.join(dir, ".goga/workflows"), { recursive: true });
  }
  await mkdir(home);
  await writeFile(path.join(primary, "docs/plan.md"), "PRIMARY\n");
  await writeFile(path.join(clone, "docs/plan.md"), "CLONE\n");
  await writeFile(
    path.join(primary, ".goga/workflows/primary.yml"),
    "name: primary\n",
  );
  await writeFile(
    path.join(clone, ".goga/workflows/owner.yml"),
    "name: owner\n",
  );
  const project = { id: "p", name: "Fixture", path: primary };
  const record: WorktreeRecord = {
    projectId: "p",
    projectPath: primary,
    year: "2026",
    topic: "feature",
    branch: "feature",
    contextId: "ctx-" + "c".repeat(64),
    revision: "00000000-0000-4000-8000-000000000001",
    repositoryKey: "d".repeat(64),
    path: clone,
    gitCommonDir: path.join(clone, ".git"),
    ownership: "managed",
    state: "ready",
    storageKind: "clone",
    sourceCommonDir: path.join(primary, ".git"),
  };
  vi.spyOn(CloneManager.prototype, "resolve").mockResolvedValue(record);
  vi.spyOn(CloneStore.prototype, "assertOwned").mockResolvedValue(undefined);
  const runner = {
    command: vi.fn(async (_exe: string, args: string[], cwd: string) => ({
      stdout: args.includes("--show-toplevel")
        ? [
            cwd,
            path.join(cwd, ".git"),
            path.join(cwd, ".git"),
            path.join(cwd, ".git/index"),
            path.join(cwd, ".git/objects"),
          ].join("\n") + "\n"
        : "feature\n",
      stderr: "",
    })),
    start: vi.fn(),
    kill: vi.fn(),
  };
  const service = new HostService({
    home,
    dataDir: path.join(home, "data"),
    runner: runner as any,
  });
  vi.spyOn(service, "listProjects").mockResolvedValue([project]);
  return {
    service,
    record,
    ref: worktreeContextRef(record),
    runner,
    project,
    home,
  };
}
it("resolves relative plans only in the owned clone, without replacing Project.path", async () => {
  const f = await fixture();
  expect(
    (await f.service.readBuildPlan(f.ref as any, "docs/plan.md")).text,
  ).toBe("CLONE\n");
  expect(f.project.path).toBe(f.record.projectPath);
  await f.service.dispose();
});
it("lists topic workflow definitions from the same clone rather than primary", async () => {
  const f = await fixture();
  expect(
    (await f.service.listProjectWorkflows(f.ref as any)).map((x) => x.name),
  ).toEqual(["owner"]);
  await f.service.dispose();
});
it("passes explicit context cwd to the Git branch reader", async () => {
  const f = await fixture();
  expect(await f.service.checkoutBranch(f.ref as any)).toBe("feature");
  expect(f.runner.command.mock.calls.every((c) => c[2] === f.record.path)).toBe(
    true,
  );
  await f.service.dispose();
});
it("a lost context never falls back to primary or starts a process", async () => {
  const f = await fixture();
  vi.mocked(CloneManager.prototype.resolve).mockRejectedValueOnce(
    Error("Клон отсутствует"),
  );
  await expect(
    f.service.readBuildPlan(f.ref as any, "docs/plan.md"),
  ).rejects.toThrow(/Клон/);
  expect(f.runner.start).not.toHaveBeenCalled();
  expect(f.runner.command).not.toHaveBeenCalled();
  await f.service.dispose();
});
it("recovers a partial deletion by durable token without resolving deleting owner as ready", async () => {
  const f = await fixture();
  vi.spyOn(CloneManager.prototype, "deletionRecovery").mockResolvedValue([
    {
      owner: f.ref,
      projectPath: f.record.projectPath,
      token: "00000000-0000-4000-8000-000000000003",
      stage: "archived",
      expiresAt: Date.now() + 60000,
    },
  ] as any);
  vi.mocked(CloneManager.prototype.resolve).mockRejectedValue(
    Error("deleting"),
  );
  expect((await f.service.prepareContextDeletion(f.ref)).stage).toBe(
    "archived",
  );
  await f.service.dispose();
});

it("resolves and edits Dockerfile in exact clone only; unavailable clone never falls back", async () => {
  const f = await fixture();
  await new DesktopStateStore(f.home, path.join(f.home, "data")).addProject(
    f.project,
  );
  const original = f.runner.command.getMockImplementation()!;
  f.runner.command.mockImplementation(async (exe, args, cwd) =>
    args.join(" ") === "config dockerfile"
      ? { stdout: "# dockerfile\nDockerfile\n", stderr: "" }
      : original(exe, args, cwd),
  );
  await writeFile(path.join(f.record.path, "Dockerfile"), "FROM clone");
  await writeFile(path.join(f.project.path, "Dockerfile"), "FROM primary");
  expect(await f.service.resolveProjectDockerfile(f.ref)).toEqual({
    relativePath: "Dockerfile",
    configured: true,
  });
  const target = { kind: "dockerfile", path: "Dockerfile" } as const;
  const before = await f.service.readProjectDocument(f.ref, target);
  expect(before.text).toBe("FROM clone");
  await f.service.saveProjectDocument(
    f.ref,
    target,
    "FROM edited",
    before.version,
  );
  expect(
    f.runner.command.mock.calls
      .filter((c) => c[1].join(" ") === "config dockerfile")
      .every((c) => c[2] === f.record.path),
  ).toBe(true);
  expect((await f.service.readProjectDocument("p", target)).text).toBe(
    "FROM primary",
  );
  vi.mocked(CloneManager.prototype.resolve).mockRejectedValue(
    Error("Клон отсутствует"),
  );
  await expect(f.service.resolveProjectDockerfile(f.ref)).rejects.toThrow(
    /Клон/,
  );
  await expect(
    f.service.saveProjectDocument(f.ref, target, "bad", before.version),
  ).rejects.toThrow(/Клон/);
  await f.service.dispose();
});

it("rejects an owner changed during the final Dockerfile config guard before disk replacement", async () => {
  const f = await fixture();
  await new DesktopStateStore(f.home, path.join(f.home, "data")).addProject(
    f.project,
  );
  const original = f.runner.command.getMockImplementation()!;
  let configCalls = 0,
    changeOwner = false;
  f.runner.command.mockImplementation(async (exe, args, cwd) => {
    if (args.join(" ") !== "config dockerfile") return original(exe, args, cwd);
    if (changeOwner && ++configCalls === 3) {
      vi.mocked(CloneManager.prototype.resolve).mockResolvedValue({
        ...f.record,
        path: f.record.path + "-replaced",
      });
    }
    return { stdout: "# dockerfile\nDockerfile\n", stderr: "" };
  });
  await writeFile(path.join(f.record.path, "Dockerfile"), "FROM clone");
  await writeFile(path.join(f.project.path, "Dockerfile"), "FROM primary");
  await writeFile(
    path.join(f.record.path, ".goga/config.yml"),
    "unchanged: true\n",
  );
  const target = { kind: "dockerfile", path: "Dockerfile" } as const;
  const before = await f.service.readProjectDocument(f.ref, target);
  changeOwner = true;
  try {
    await expect(
      f.service.saveProjectDocument(
        f.ref,
        target,
        "FROM draft",
        before.version,
      ),
    ).rejects.toThrow(/Контекст изменился/);
    expect(configCalls).toBe(3);
    expect(await readFile(path.join(f.record.path, "Dockerfile"), "utf8")).toBe(
      "FROM clone",
    );
    expect(
      await readFile(path.join(f.project.path, "Dockerfile"), "utf8"),
    ).toBe("FROM primary");
    expect(
      await readFile(path.join(f.record.path, ".goga/config.yml"), "utf8"),
    ).toBe("unchanged: true\n");
  } finally {
    await f.service.dispose();
  }
});

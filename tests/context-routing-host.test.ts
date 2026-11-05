import { DesktopStateStore } from "../src/host/desktop-state";
import { CloneStore } from "../src/host/clone-store";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { HostService } from "../src/host/service";
import { CloneManager } from "../src/host/clones";
import {
  worktreeContextRef,
  type WorktreeRecord,
} from "../src/shared/worktrees";
afterEach(() => vi.restoreAllMocks());
async function fixture(
  options: { trashItem?: (root: string) => Promise<void> } = {},
) {
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
  vi.spyOn(CloneManager.prototype, "list").mockResolvedValue([record]);
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
        : cwd === primary &&
            args[0] === "branch" &&
            args[1] === "--show-current"
          ? "main\n"
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
    trashItem: options.trashItem,
  });
  vi.spyOn(service, "listProjects").mockResolvedValue([project]);
  vi.spyOn(service as any, "contextTopicDeletion").mockResolvedValue(undefined);
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
it("refuses to reinterpret an old archive-first journal as a new deletion", async () => {
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
  await expect(f.service.prepareContextDeletion(f.ref)).rejects.toThrow(
    /старый журнал/,
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
it("prepares terminal roots and all Desktop environment rows without invoking Goga", async () => {
  const f = await fixture();
  const store = new DesktopStateStore(f.home, path.join(f.home, "data"));
  await store.addProject(f.project);
  const doc = await store.read("p");
  await store.save(
    "p",
    {
      ...doc.value,
      env: [
        {
          key: "LOCAL_SECRET",
          value: "synthetic-value",
          secret: true,
          runtime: false,
        },
        {
          key: "RUNTIME_VALUE",
          value: "runtime",
          secret: false,
          runtime: true,
        },
      ],
    },
    doc.version,
  );
  for (const [scope, root] of [
    ["p", f.project.path],
    [f.ref, f.record.path],
  ] as const) {
    const launch = await f.service.prepareTerminalLaunch(scope, {
      accountShell: () => "/bin/zsh",
      inherited: { HOME: f.home, PATH: "/usr/bin:/bin" },
    });
    expect(launch.cwd).toBe(root);
    expect(launch.env).toMatchObject({
      LOCAL_SECRET: "synthetic-value",
      RUNTIME_VALUE: "runtime",
    });
    await launch.verifyRoot();
    launch.dispose?.();
  }
  expect(f.runner.command.mock.calls.every((c) => c[0] === "git")).toBe(true);
  expect(f.runner.start).not.toHaveBeenCalled();
  await f.service.dispose();
});
it("terminal preparation never falls back from a missing or foreign clone", async () => {
  const f = await fixture();
  await new DesktopStateStore(f.home, path.join(f.home, "data")).addProject(
    f.project,
  );
  vi.mocked(CloneManager.prototype.resolve).mockRejectedValueOnce(
    Error("lost"),
  );
  await expect(f.service.prepareTerminalLaunch(f.ref)).rejects.toThrow();
  vi.mocked(CloneManager.prototype.resolve).mockResolvedValue({
    ...f.record,
    topic: "other",
  });
  await expect(f.service.prepareTerminalLaunch(f.ref)).rejects.toThrow();
  expect(f.runner.start).not.toHaveBeenCalled();
  await f.service.dispose();
});
it("holds a clone lease and blocks deletion preparation", async () => {
  const f = await fixture();
  await new DesktopStateStore(f.home, path.join(f.home, "data")).addProject(
    f.project,
  );
  const prepare = vi
    .spyOn(CloneManager.prototype, "prepareContextDeletion")
    .mockRejectedValue(Error("fixture-delete"));
  const lease = await f.service.acquireTerminalContext(f.ref, {
    accountShell: () => "/bin/zsh",
    inherited: { HOME: f.home },
  });
  await expect(f.service.prepareContextDeletion(f.ref)).rejects.toThrow(
    /активный/i,
  );
  expect(prepare).not.toHaveBeenCalled();
  const dispose = vi.spyOn(lease.launch, "dispose");
  lease.release();
  lease.release();
  expect(dispose).toHaveBeenCalledTimes(1);
  await expect(f.service.prepareContextDeletion(f.ref)).rejects.toThrow(
    "fixture-delete",
  );
  expect(prepare).toHaveBeenCalledTimes(1);
  await f.service.dispose();
});
it("releases failed terminal preparation instead of permanently blocking deletion", async () => {
  const f = await fixture();
  await new DesktopStateStore(f.home, path.join(f.home, "data")).addProject(
    f.project,
  );
  await expect(
    f.service.acquireTerminalContext(f.ref, {
      accountShell: () => "/bin/unsupported",
    }),
  ).rejects.toThrow(/оболочк/i);
  const prepare = vi
    .spyOn(CloneManager.prototype, "prepareContextDeletion")
    .mockRejectedValue(Error("fixture-delete"));
  await expect(f.service.prepareContextDeletion(f.ref)).rejects.toThrow(
    "fixture-delete",
  );
  expect(prepare).toHaveBeenCalledTimes(1);
  await f.service.dispose();
});
it("revalidates an existing terminal by stable owner after a harmless revision change", async () => {
  const f = await fixture();
  await new DesktopStateStore(f.home, path.join(f.home, "data")).addProject(
    f.project,
  );
  const launch = await f.service.prepareTerminalLaunch(f.ref);
  const fresh = {
    ...f.record,
    revision: "00000000-0000-4000-8000-000000000009",
  };
  vi.mocked(CloneManager.prototype.list).mockResolvedValue([fresh]);
  vi.mocked(CloneManager.prototype.resolve).mockImplementation(async (ref) => {
    if (ref.revision !== fresh.revision) throw Error("stale");
    return fresh;
  });
  await launch.verifyRoot();
  vi.mocked(CloneManager.prototype.list).mockResolvedValue([
    { ...fresh, topic: "foreign" },
  ]);
  await expect(launch.verifyRoot()).rejects.toThrow(/контекст/);
  launch.dispose?.();
  await f.service.dispose();
});
it("rejects a previously prepared deletion after a terminal acquired the clone", async () => {
  const trashItem = vi.fn(async () => {});
  const f = await fixture({ trashItem });
  await new DesktopStateStore(f.home, path.join(f.home, "data")).addProject(
    f.project,
  );
  const token = "00000000-0000-4000-8000-000000000009";
  vi.spyOn(CloneManager.prototype, "readContextDeletion").mockResolvedValue({
    token,
    owner: f.ref,
    projectPath: f.project.path,
  } as any);
  const execute = vi
    .spyOn(CloneManager.prototype, "trashContext")
    .mockRejectedValue(Error("fixture-execute"));
  const lease = await f.service.acquireTerminalContext(f.ref);
  await expect(
    f.service.deleteContext({ projectId: "p", token }),
  ).rejects.toThrow(/активный/i);
  expect(execute).not.toHaveBeenCalled();
  expect(trashItem).not.toHaveBeenCalled();
  lease.release();
  await expect(
    f.service.deleteContext({ projectId: "p", token }),
  ).rejects.toThrow("fixture-execute");
  await f.service.dispose();
});
it("serializes pending acquisition with deletion preparation", async () => {
  const f = await fixture();
  await new DesktopStateStore(f.home, path.join(f.home, "data")).addProject(
    f.project,
  );
  let unblock!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
      unblock = r;
    }),
    started = new Promise<void>((r) => {
      entered = r;
    });
  vi.mocked(CloneManager.prototype.resolve).mockImplementationOnce(async () => {
    entered();
    await gate;
    return f.record;
  });
  const prepare = vi.spyOn(CloneManager.prototype, "prepareContextDeletion");
  const opening = f.service.acquireTerminalContext(f.ref);
  await started;
  const deletion = f.service.prepareContextDeletion(f.ref);
  const rejected = expect(deletion).rejects.toThrow(/активный/i);
  expect(prepare).not.toHaveBeenCalled();
  unblock();
  const lease = await opening;
  await rejected;
  expect(prepare).not.toHaveBeenCalled();
  lease.release();
  await f.service.dispose();
});
it("a completed deletion wins over a queued acquisition; no stale root is granted", async () => {
  const f = await fixture({ trashItem: async () => {} });
  await new DesktopStateStore(f.home, path.join(f.home, "data")).addProject(
    f.project,
  );
  const token = "00000000-0000-4000-8000-000000000009";
  vi.spyOn(CloneManager.prototype, "readContextDeletion").mockResolvedValue({
    token,
    owner: f.ref,
    projectPath: f.project.path,
  } as any);
  let unblock!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
      unblock = r;
    }),
    started = new Promise<void>((r) => {
      entered = r;
    });
  vi.spyOn(CloneManager.prototype, "trashContext").mockImplementation(
    async () => {
      entered();
      await gate;
      vi.mocked(CloneManager.prototype.resolve).mockRejectedValue(
        Error("deleted"),
      );
      return {
        status: "success",
        stage: "completed",
        message: "fixture",
      } as any;
    },
  );
  const deleting = f.service.deleteContext({ projectId: "p", token });
  await started;
  const opening = f.service.acquireTerminalContext(f.ref);
  const rejected = expect(opening).rejects.toThrow(/контекст/);
  unblock();
  await deleting;
  await rejected;
  await f.service.dispose();
});
it("keeps deletion blocked until every terminal lease in that clone is released", async () => {
  const f = await fixture();
  await new DesktopStateStore(f.home, path.join(f.home, "data")).addProject(
    f.project,
  );
  const one = await f.service.acquireTerminalContext(f.ref),
    two = await f.service.acquireTerminalContext(f.ref);
  one.release();
  one.release();
  await expect(f.service.prepareContextDeletion(f.ref)).rejects.toThrow(
    /активный/i,
  );
  two.release();
  const prepare = vi
    .spyOn(CloneManager.prototype, "prepareContextDeletion")
    .mockRejectedValue(Error("fixture-delete"));
  await expect(f.service.prepareContextDeletion(f.ref)).rejects.toThrow(
    "fixture-delete",
  );
  expect(prepare).toHaveBeenCalledOnce();
  await f.service.dispose();
});

it("resolves terminal catalog ownership without shell preparation, env exposure or context inheritance", async () => {
  const f = await fixture();
  await new DesktopStateStore(f.home, path.join(f.home, "data")).addProject(
    f.project,
  );
  const prepare = vi.spyOn(f.service, "prepareTerminalLaunch");
  const { revision: _, ...identity } = f.ref;
  expect(await f.service.resolveTerminalOwner(f.ref)).toEqual({
    kind: "topic",
    ...identity,
  });
  expect(await f.service.resolveTerminalOwner("p")).toEqual({
    kind: "primary",
    projectId: "p",
  });
  expect(prepare).not.toHaveBeenCalled();
  expect(f.runner.start).not.toHaveBeenCalled();
  vi.mocked(CloneManager.prototype.resolve).mockRejectedValueOnce(
    Error("missing clone"),
  );
  await expect(f.service.resolveTerminalOwner(f.ref)).rejects.toThrow();
  await f.service.dispose();
});

it("validates terminal presentation identity once, without repeating clone Git discovery", async () => {
  const f = await fixture();
  await new DesktopStateStore(f.home, path.join(f.home, "data")).addProject(
    f.project,
  );
  vi.mocked(CloneManager.prototype.resolve).mockClear();
  f.runner.command.mockClear();
  await f.service.resolveTerminalOwner(f.ref);
  expect(CloneManager.prototype.resolve).toHaveBeenCalledTimes(1);
  expect(
    f.runner.command.mock.calls.filter(([, args]) =>
      args.includes("--show-toplevel"),
    ),
  ).toHaveLength(1);
  await f.service.dispose();
});

it("a late clone selection cannot overwrite a newer primary selection", async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(f.service, "resolveTopicContext").mockImplementationOnce(
    async () => {
      await gate;
      return f.record;
    },
  );
  const selecting = f.service.selectTopicContext(f.ref);
  await f.service.selectTopicContext(null);
  release();
  await selecting;
  expect((f.service as any).selectedContext).toBeNull();
  await f.service.dispose();
});

it.each([
  ["primary", "starting"],
  ["primary", "running"],
  ["primary", "unverified"],
  ["clone", "starting"],
  ["clone", "running"],
  ["clone", "unverified"],
] as const)(
  "allows versioned file saves in %s with a %s run, but refuses external changes",
  async (owner, status) => {
    const f = await fixture();
    const scope = owner === "clone" ? f.ref : f.project.id;
    const root = owner === "clone" ? f.record.path : f.project.path;
    await new DesktopStateStore(f.home, path.join(f.home, "data")).addProject(
      f.project,
    );
    const originalCommand = f.runner.command.getMockImplementation()!;
    f.runner.command.mockImplementation(async (exe, args, cwd) =>
      args.join(" ") === "config dockerfile"
        ? { stdout: "# dockerfile\nDockerfile\n", stderr: "" }
        : originalCommand(exe, args, cwd),
    );
    (f.service as any).runList = [
      {
        id: "synthetic-active",
        projectId: f.project.id,
        status: status === "unverified" ? "running" : status,
        ...(owner === "clone" ? { context: f.ref } : {}),
        ...(status === "unverified" ? { recovery: "unverified" } : {}),
      },
    ];
    const documents = [
      [{ kind: "config" }, ".goga/config.yml", "value: initial\n"],
      [
        { kind: "workflow", name: "Edit" },
        ".goga/workflows/Edit.yml",
        "value: initial\n",
      ],
      [
        { kind: "pipeline", name: "Edit" },
        ".goga/pipelines/Edit.yml",
        "value: initial\n",
      ],
      [
        { kind: "profile", name: "Edit" },
        ".goga/profiles/Edit.yml",
        "value: initial\n",
      ],
      [
        { kind: "tool", tool: "sample", path: "config.yml" },
        ".goga/tools/sample/config.yml",
        "value: initial\n",
      ],
      [
        { kind: "dockerfile", path: "Dockerfile" },
        "Dockerfile",
        "FROM initial\n",
      ],
    ] as const;
    try {
      for (const [target, relative, initial] of documents) {
        const filename = path.join(root, relative);
        await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(filename, initial);
        const before = await f.service.readProjectDocument(scope, target);
        const edited = initial + "# editor draft\r\n";
        const saved = await f.service.saveProjectDocument(
          scope,
          target,
          edited,
          before.version,
        );
        expect(saved.text).toBe(edited);
        expect(await readFile(filename, "utf8")).toBe(edited);
        const external = initial + "# external writer\n";
        await writeFile(filename, external);
        await expect(
          f.service.saveProjectDocument(
            scope,
            target,
            edited + "# stale\n",
            saved.version,
          ),
        ).rejects.toThrow(/Конфликт сохранения/);
        expect(await readFile(filename, "utf8")).toBe(external);
      }
      const filename = path.join(root, "docs/plan.md");
      const before = await f.service.readOverviewFile(scope, "docs/plan.md");
      const saved = await f.service.saveOverviewFile(
        scope,
        "docs/plan.md",
        "# draft\r\n",
        before.version,
      );
      expect(saved.text).toBe("# draft\r\n");
      await writeFile(filename, "# external\n");
      await expect(
        f.service.saveOverviewFile(
          scope,
          "docs/plan.md",
          "# stale\n",
          saved.version,
        ),
      ).rejects.toThrow(/Конфликт сохранения/);
      expect(await readFile(filename, "utf8")).toBe("# external\n");
      // File editing remains available; it grants no process or Git permissions.
      await f.service.createOverviewEntry(scope, "created.txt", "file", "new");
      expect(await readFile(path.join(root, "created.txt"), "utf8")).toBe(
        "new",
      );
      expect(f.runner.start).not.toHaveBeenCalled();
      expect(f.runner.kill).not.toHaveBeenCalled();
      expect(
        (
          await f.service.readProjectDocument(owner === "clone" ? "p" : f.ref, {
            kind: "workflow",
            name: owner === "clone" ? "primary" : "owner",
          })
        ).text,
      ).toBe(`name: ${owner === "clone" ? "primary" : "owner"}\n`);
    } finally {
      (f.service as any).runList = [];
      await f.service.dispose();
      await rm(path.dirname(f.home), { recursive: true, force: true });
    }
  },
);

it.each(["external-content", "changed-owner"] as const)(
  "revalidates %s immediately before replacing a file during an active run",
  async (change) => {
    const f = await fixture();
    await new DesktopStateStore(f.home, path.join(f.home, "data")).addProject(
      f.project,
    );
    const target = { kind: "workflow", name: "owner" } as const;
    const filename = path.join(f.record.path, ".goga/workflows/owner.yml");
    const before = await f.service.readProjectDocument(f.ref, target);
    (f.service as any).runList = [
      { id: "fake-run", projectId: "p", context: f.ref, status: "running" },
    ];
    let checks = 0;
    vi.mocked(CloneManager.prototype.resolve).mockImplementation(async () => {
      if (++checks === 3) {
        if (change === "external-content")
          await writeFile(filename, "# external during save\n");
        else return { ...f.record, path: f.record.path + "-replaced" };
      }
      return f.record;
    });
    try {
      await expect(
        f.service.saveProjectDocument(
          f.ref,
          target,
          "# pending editor\n",
          before.version,
        ),
      ).rejects.toThrow(
        change === "external-content"
          ? /Конфликт сохранения/
          : /Контекст изменился/,
      );
      expect(checks).toBe(3);
      expect(await readFile(filename, "utf8")).toBe(
        change === "external-content"
          ? "# external during save\n"
          : before.text,
      );
      expect(
        (await readdir(path.dirname(filename))).some((name) =>
          name.endsWith(".tmp"),
        ),
      ).toBe(false);
      expect(
        await readFile(
          path.join(f.project.path, ".goga/workflows/primary.yml"),
          "utf8",
        ),
      ).toBe("name: primary\n");
    } finally {
      (f.service as any).runList = [];
      await f.service.dispose();
      await rm(path.dirname(f.home), { recursive: true, force: true });
    }
  },
);

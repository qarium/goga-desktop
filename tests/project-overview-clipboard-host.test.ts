import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  lstat,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { HostService } from "../src/host/service";
import { DesktopStateStore } from "../src/host/desktop-state";
import type { ScopeRef } from "../src/shared/context";
const clean: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of clean.splice(0)) await f();
});
async function fixture(clone = false) {
  const dir = await mkdtemp("/private/tmp/overview-clipboard-");
  const root = path.join(dir, "project"),
    home = path.join(dir, "home"),
    dataDir = path.join(dir, "data"),
    external = path.join(dir, "finder");
  await Promise.all([root, home, external].map((p) => mkdir(p)));
  const state = new DesktopStateStore(home, dataDir);
  await state.addProject({ id: "p", name: "Fixture", path: root });
  let files: string[] = [];
  const fileClipboard = {
    writeText: vi.fn(async (_text: string) => {}),
    readFiles: vi.fn(async () => [...files]),
    writeFiles: vi.fn(async (paths: string[]) => {
      files = [...paths];
    }),
  };
  const runner = {
    command: vi.fn(async () => {
      throw Error("No real commands");
    }),
    start: vi.fn(),
    kill: vi.fn(),
  } as any;
  const host = new HostService({ home, dataDir, runner, fileClipboard } as any);
  clean.push(async () => {
    await host.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  const ref = {
    projectId: "p",
    year: "2026",
    topic: "fixture",
    branch: "fixture",
    contextId: "ctx-" + "a".repeat(64),
    revision: "12345678-1234-4234-8234-123456789012",
  };
  let revision = ref.revision;
  const ownedRoot = clone ? path.join(dir, "clone") : root;
  if (clone) {
    await mkdir(ownedRoot);
    const clones = (host as any).clones;
    vi.spyOn(clones, "resolve").mockImplementation(async (raw: any) => {
      if (JSON.stringify(raw) !== JSON.stringify({ ...ref, revision }))
        throw Error("Stale owner or revision");
      return {
        ...ref,
        revision,
        storageKind: "clone",
        path: ownedRoot,
        projectPath: root,
        gitCommonDir: path.join(ownedRoot, ".git"),
        ownership: "managed",
        state: "ready",
        repositoryKey: "a".repeat(64),
      };
    });
    vi.spyOn(clones.store, "assertOwned").mockResolvedValue(undefined);
    runner.command.mockResolvedValue({
      stdout: [
        ownedRoot,
        ownedRoot + "/.git",
        ownedRoot + "/.git",
        ownedRoot + "/.git/index",
        ownedRoot + "/.git/objects",
      ].join("\n"),
      stderr: "",
    });
  }
  const scope: ScopeRef = clone ? ref : "p";
  return {
    host: host as any,
    root,
    ownedRoot,
    external,
    scope,
    ref,
    runner,
    fileClipboard,
    setFiles: (paths: string[]) => {
      files = paths;
    },
    changeRevision: () => {
      revision = "22345678-1234-4234-8234-123456789012";
    },
  };
}
it("copies actual selected files using the Host-owned workspace, deduplicating descendants", async () => {
  const f = await fixture();
  await mkdir(path.join(f.root, "src"));
  await writeFile(path.join(f.root, "src/a"), "disk");
  expect(f.host.copyOverviewEntries).toBeTypeOf("function");
  await f.host.copyOverviewEntries(f.scope, ["src", "src/a", "src"]);
  expect(f.fileClipboard.writeFiles).toHaveBeenCalledExactlyOnceWith([
    path.join(f.root, "src"),
  ]);
  expect(f.fileClipboard.readFiles).not.toHaveBeenCalled();
});
it.each([false, true])(
  "pastes Finder files into the exact owner while a pipeline runs (clone=%s)",
  async (clone) => {
    const f = await fixture(clone);
    await writeFile(path.join(f.external, "new.txt"), "Finder\r\n");
    await mkdir(path.join(f.ownedRoot, "target"));
    f.setFiles([path.join(f.external, "new.txt")]);
    (f.host as any).runList = [
      {
        id: "active",
        projectId: "p",
        status: "running",
        ...(clone ? { context: f.ref } : {}),
      },
    ];
    expect(f.host.pasteOverviewEntries).toBeTypeOf("function");
    const result = await f.host.pasteOverviewEntries(f.scope, "target");
    expect(result).toMatchObject({
      status: "done",
      completedPaths: ["target/new.txt"],
      touchedPaths: ["target/new.txt"],
    });
    expect(
      await readFile(path.join(f.ownedRoot, "target/new.txt"), "utf8"),
    ).toBe("Finder\r\n");
    if (clone)
      await expect(lstat(path.join(f.root, "target"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    expect(f.runner.start).not.toHaveBeenCalled();
    expect(f.runner.kill).not.toHaveBeenCalled();
  },
);
it("freezes scope and destination before awaiting clipboard and rejects stale owner rather than pasting elsewhere", async () => {
  const f = await fixture(true);
  await writeFile(path.join(f.external, "new"), "Finder");
  await mkdir(path.join(f.ownedRoot, "target"));
  let release!: (v: string[]) => void;
  f.fileClipboard.readFiles.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const request = { ...f.ref };
  const pending = f.host.pasteOverviewEntries?.(request, "target");
  expect(pending).toBeDefined();
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  request.contextId = "ctx-" + "b".repeat(64);
  f.changeRevision();
  release([path.join(f.external, "new")]);
  await expect(pending).rejects.toThrow();
  await expect(
    lstat(path.join(f.ownedRoot, "target/new")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(path.join(f.root, "target"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
it("never accepts absolute source paths from renderer or reads clipboard for invalid destinations", async () => {
  const f = await fixture();
  expect(f.host.copyOverviewEntries).toBeTypeOf("function");
  for (const paths of [
    [],
    ["../a"],
    ["/etc/passwd"],
    [".git/config"],
    Array(129).fill("a"),
  ])
    await expect(f.host.copyOverviewEntries(f.scope, paths)).rejects.toThrow();
  for (const dest of ["../a", "/etc", ".git"])
    await expect(f.host.pasteOverviewEntries(f.scope, dest)).rejects.toThrow();
  expect(f.fileClipboard.readFiles).not.toHaveBeenCalled();
  expect(f.fileClipboard.writeFiles).not.toHaveBeenCalled();
});
it("does not redirect an awaiting primary paste when the registered project path changes", async () => {
  const f = await fixture();
  await writeFile(path.join(f.external, "new"), "Finder");
  const other = path.join(f.external, "other-project");
  await mkdir(other);
  let release!: (v: string[]) => void;
  f.fileClipboard.readFiles.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = f.host.pasteOverviewEntries("p", "");
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const state = (f.host as any).state;
  const registry = path.join((state as any).root, "projects.json");
  const value = JSON.parse(await readFile(registry, "utf8"));
  value.projects[0].path = other;
  await writeFile(registry, JSON.stringify(value));
  release([path.join(f.external, "new")]);
  await expect(pending).rejects.toThrow(/папка|проект/i);
  await expect(lstat(path.join(other, "new"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(lstat(path.join(f.root, "new"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it.each([false, true])(
  "copies checked text paths from exact primary/clone owner (clone=%s)",
  async (clone) => {
    const f = await fixture(clone);
    await mkdir(path.join(f.ownedRoot, "src"));
    await writeFile(path.join(f.ownedRoot, "src/a"), "a");
    await f.host.copyOverviewPaths(f.scope, ["src", "src/a", "src"], false);
    expect(f.fileClipboard.writeText).toHaveBeenLastCalledWith("src\nsrc/a");
    await f.host.copyOverviewPaths(f.scope, ["src/a"], true);
    expect(f.fileClipboard.writeText).toHaveBeenLastCalledWith(
      path.join(f.ownedRoot, "src/a"),
    );
    for (const paths of [["/etc/passwd"], ["../a"], [".git/config"], []])
      await expect(
        f.host.copyOverviewPaths(f.scope, paths, true),
      ).rejects.toThrow();
    await expect(
      f.host.copyOverviewPaths(f.scope, ["src/a"], "true"),
    ).rejects.toThrow();
    expect(f.fileClipboard.writeFiles).not.toHaveBeenCalled();
    expect(f.fileClipboard.readFiles).not.toHaveBeenCalled();
  },
);
it.each([false, true])(
  "consumes exact captured clipboard plan once while a pipeline runs (clone=%s)",
  async (clone) => {
    const f = await fixture(clone);
    await writeFile(path.join(f.external, "a"), "new");
    await writeFile(path.join(f.external, "b"), "second");
    for (const folder of ["one", "two"]) {
      await mkdir(path.join(f.external, folder));
      await writeFile(path.join(f.external, folder, "file"), folder);
    }
    await writeFile(path.join(f.ownedRoot, "a"), "old");
    f.setFiles(
      ["a", "b", "one", "two"].map((name) => path.join(f.external, name)),
    );
    (f.host as any).runList = [
      {
        id: "active",
        projectId: "p",
        status: "running",
        ...(clone ? { context: f.ref } : {}),
      },
    ];
    const preview = await f.host.prepareOverviewPaste(f.scope, "");
    expect(preview).toEqual({
      token: expect.any(String),
      conflicts: [{ path: "a", replaceable: true }],
    });
    expect(await readFile(path.join(f.ownedRoot, "a"), "utf8")).toBe("old");
    f.setFiles(["/not/the/captured/clipboard"]);
    const execute = () =>
      f.host.executeOverviewPaste(preview.token, [
        { path: "a", action: "replace" },
      ]);
    const results = await Promise.all([execute(), execute()]);
    expect(results.map((r) => r.status).sort()).toEqual(["done", "not-done"]);
    expect(results.find((r) => r.status === "done")).toMatchObject({
      completedPaths: ["a", "b", "one", "two"],
      touchedPaths: ["a", "b", "one", "two"],
    });
    expect(await readFile(path.join(f.ownedRoot, "b"), "utf8")).toBe("second");
    for (const folder of ["one", "two"])
      expect(
        await readFile(path.join(f.ownedRoot, folder, "file"), "utf8"),
      ).toBe(folder);
    expect(await readFile(path.join(f.ownedRoot, "a"), "utf8")).toBe("new");
    expect(f.fileClipboard.readFiles).toHaveBeenCalledOnce();
  },
);
it("rejects prepared clone owner drift and never redirects a token to another context", async () => {
  const f = await fixture(true);
  await writeFile(path.join(f.external, "a"), "new");
  f.setFiles([path.join(f.external, "a")]);
  const preview = await f.host.prepareOverviewPaste(f.scope, "");
  f.changeRevision();
  expect(await f.host.executeOverviewPaste(preview.token, [])).toMatchObject({
    status: "not-done",
    touchedPaths: [],
  });
  await expect(lstat(path.join(f.ownedRoot, "a"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await f.host.executeOverviewPaste(preview.token, [])).toMatchObject({
    status: "not-done",
  });
});
it("prepares against the frozen owner before clipboard await and rejects primary root drift at execute", async () => {
  const f = await fixture();
  await writeFile(path.join(f.external, "a"), "new");
  f.setFiles([path.join(f.external, "a")]);
  const preview = await f.host.prepareOverviewPaste("p", "");
  const other = path.join(f.external, "other");
  await mkdir(other);
  const state = (f.host as any).state,
    registry = path.join((state as any).root, "projects.json");
  const value = JSON.parse(await readFile(registry, "utf8"));
  value.projects[0].path = other;
  await writeFile(registry, JSON.stringify(value));
  expect(await f.host.executeOverviewPaste(preview.token, [])).toMatchObject({
    status: "not-done",
    touchedPaths: [],
  });
  await expect(lstat(path.join(other, "a"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(lstat(path.join(f.root, "a"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
it("never changes a mutable clone request while preparation awaits clipboard", async () => {
  const f = await fixture(true);
  await writeFile(path.join(f.external, "a"), "new");
  let release!: (files: string[]) => void;
  f.fileClipboard.readFiles.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const request = { ...f.ref },
    pending = f.host.prepareOverviewPaste(request, "");
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  request.contextId = "ctx-" + "b".repeat(64);
  release([path.join(f.external, "a")]);
  const preview = await pending;
  expect(await f.host.executeOverviewPaste(preview.token, [])).toMatchObject({
    status: "done",
    touchedPaths: ["a"],
  });
  expect(await readFile(path.join(f.ownedRoot, "a"), "utf8")).toBe("new");
});

it("preserves partial-stage evidence when the final Host owner guard also fails", async () => {
  const f = await fixture();
  await writeFile(path.join(f.external, "a"), "data".repeat(40000));
  await writeFile(path.join(f.root, "a"), "keep");
  f.setFiles([path.join(f.external, "a")]);
  const preview = await f.host.prepareOverviewPaste("p", "");
  const original = f.host.validateBinding.bind(f.host);
  let failed = false,
    stage = "";
  vi.spyOn(f.host, "validateBinding").mockImplementation(
    async (project: any) => {
      const name = (await readdir(f.root)).find((name) =>
        name.startsWith(".goga-paste-"),
      );
      if (failed || (name && (await lstat(path.join(f.root, name))).size > 0)) {
        failed = true;
        stage = name ?? stage;
        throw Error("owner changed");
      }
      return original(project);
    },
  );
  const result = await f.host.executeOverviewPaste(preview.token, [
    { path: "a", action: "replace" },
  ]);
  expect(result).toMatchObject({
    status: "uncertain",
    completedPaths: [],
    touchedPaths: ["a"],
  });
  expect(stage).not.toBe("");
  expect(result.message).toContain(stage);
  expect(await readFile(path.join(f.root, "a"), "utf8")).toBe("keep");
  expect((await lstat(path.join(f.root, stage))).size).toBeGreaterThan(0);
});

import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rename,
  rm,
  symlink,
  lstat,
  readdir,
} from "node:fs/promises";
import path from "node:path";
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    mkdir: vi.fn(actual.mkdir),
    rmdir: vi.fn(actual.rmdir),
  };
});
import { HostService } from "../src/host/service";
import { DesktopStateStore } from "../src/host/desktop-state";
import type { ScopeRef } from "../src/shared/context";
const clean: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const f of clean.splice(0)) await f();
});
async function fixture() {
  const dir = await mkdtemp("/private/tmp/overview-actions-");
  const root = path.join(dir, "project"),
    home = path.join(dir, "home"),
    dataDir = path.join(dir, "data");
  await mkdir(root);
  await mkdir(home);
  await mkdir(path.join(dir, "trash"));
  const state = new DesktopStateStore(home, dataDir);
  await state.addProject({ id: "p", name: "Fixture", path: root });
  const trash = vi.fn(async (p: string) => {
    await rename(p, path.join(dir, "trash", path.basename(p)));
  });
  const reveal = vi.fn();
  const runner = {
    command: vi.fn(async () => {
      throw Error("No real commands");
    }),
    start: vi.fn(),
    kill: vi.fn(),
  } as any;
  const host = new HostService({
    home,
    dataDir,
    runner,
    trashItem: trash,
    showItemInFolder: reveal,
  });
  clean.push(async () => {
    await host.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  const file = async (p: string, text = "contents") => {
    await mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await writeFile(path.join(root, p), text);
  };
  return { host, root, dir, state, trash, reveal, file, runner };
}
// Real temporary files, fake process membership and an exact Host-owned clone.
async function ownedFixture(owner: "primary" | "clone") {
  const f = await fixture();
  const ref = {
    projectId: "p",
    year: "2026",
    topic: "fixture",
    branch: "fixture",
    contextId: "ctx-" + "a".repeat(64),
    revision: "12345678-1234-4234-8234-123456789012",
  };
  let revision = ref.revision;
  const root = owner === "clone" ? path.join(f.dir, "clone") : f.root;
  if (owner === "clone") {
    await mkdir(root);
    const clones = (f.host as any).clones;
    vi.spyOn(clones, "resolve").mockImplementation(async (raw: any) => {
      if (JSON.stringify(raw) !== JSON.stringify({ ...ref, revision }))
        throw Error("Stale owner or revision");
      return {
        ...ref,
        revision,
        storageKind: "clone",
        path: root,
        projectPath: f.root,
        gitCommonDir: path.join(root, ".git"),
        ownership: "managed",
        state: "ready",
        repositoryKey: "a".repeat(64),
      };
    });
    vi.spyOn(clones.store, "assertOwned").mockResolvedValue(undefined);
    f.runner.command.mockResolvedValue({
      stdout: [
        root,
        root + "/.git",
        root + "/.git",
        root + "/.git/index",
        root + "/.git/objects",
      ].join("\n"),
      stderr: "",
    });
  }
  const scope: ScopeRef = owner === "clone" ? ref : "p";
  return {
    ...f,
    scope,
    ownedRoot: root,
    setRevision: (value: string) => {
      revision = value;
    },
    setRun: (status: "starting" | "running" | "unverified") => {
      (f.host as any).runList = [
        {
          id: "synthetic-active",
          projectId: "p",
          status: status === "unverified" ? "running" : status,
          ...(owner === "clone" ? { context: ref } : {}),
          ...(status === "unverified" ? { recovery: "unverified" } : {}),
        },
      ];
    },
  };
}
const activeOwners = (["primary", "clone"] as const).flatMap((owner) =>
  (["starting", "running", "unverified"] as const).map((status) => ({
    owner,
    status,
  })),
);
it.each(activeOwners)(
  "creates files and directories in $owner during a $status pipeline without touching the other owner",
  async ({ owner, status }) => {
    const f = await ownedFixture(owner);
    f.setRun(status);
    await f.host.createOverviewEntry(f.scope, "created", "directory");
    const created = await f.host.createOverviewEntry(
      f.scope,
      "created/file.txt",
      "file",
      "draft\r\n",
    );
    expect(created).toMatchObject({ text: "draft\r\n", exists: true });
    expect(
      await readFile(path.join(f.ownedRoot, "created/file.txt"), "utf8"),
    ).toBe("draft\r\n");
    if (owner === "clone")
      await expect(lstat(path.join(f.root, "created"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    expect(f.runner.start).not.toHaveBeenCalled();
    expect(f.runner.kill).not.toHaveBeenCalled();
  },
);
it.each(activeOwners)(
  "prepares and executes rename in $owner during a $status pipeline",
  async ({ owner, status }) => {
    const f = await ownedFixture(owner);
    await writeFile(path.join(f.ownedRoot, "source"), "keep\n");
    f.setRun(status);
    const preview = await f.host.prepareOverviewFileAction(f.scope, {
      kind: "rename",
      path: "source",
      destination: "renamed",
    });
    expect(await f.host.executeOverviewFileAction(preview.token)).toMatchObject(
      { status: "done", completedPaths: ["source"] },
    );
    expect(await readFile(path.join(f.ownedRoot, "renamed"), "utf8")).toBe(
      "keep\n",
    );
    await expect(lstat(path.join(f.ownedRoot, "source"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
    if (owner === "clone")
      await expect(lstat(path.join(f.root, "renamed"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    expect((await f.host.executeOverviewFileAction(preview.token)).status).toBe(
      "not-done",
    );
    expect(f.runner.start).not.toHaveBeenCalled();
    expect(f.runner.kill).not.toHaveBeenCalled();
  },
);
it.each(activeOwners)(
  "trashes selected entries in $owner during a $status pipeline through the fake adapter only",
  async ({ owner, status }) => {
    const f = await ownedFixture(owner);
    await mkdir(path.join(f.ownedRoot, "folder"));
    await writeFile(path.join(f.ownedRoot, "folder/child"), "nested");
    await writeFile(path.join(f.ownedRoot, "selected"), "selected");
    await writeFile(path.join(f.ownedRoot, "sibling"), "keep");
    if (owner === "clone") {
      await f.file("folder/child", "primary nested");
      await f.file("selected", "primary selected");
    }
    f.setRun(status);
    const preview = await f.host.prepareOverviewFileAction(f.scope, {
      kind: "trash",
      paths: ["folder", "folder/child", "selected"],
    });
    expect(preview.paths).toEqual(["folder", "selected"]);
    expect(f.trash).not.toHaveBeenCalled();
    expect(await f.host.executeOverviewFileAction(preview.token)).toMatchObject(
      {
        status: "done",
        completedPaths: ["folder", "selected"],
      },
    );
    expect(f.trash.mock.calls).toEqual([
      [path.join(f.ownedRoot, "folder")],
      [path.join(f.ownedRoot, "selected")],
    ]);
    for (const relative of ["folder", "selected"])
      await expect(
        lstat(path.join(f.ownedRoot, relative)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(f.dir, "trash/folder/child"), "utf8")).toBe(
      "nested",
    );
    expect(await readFile(path.join(f.dir, "trash/selected"), "utf8")).toBe(
      "selected",
    );
    expect(await readFile(path.join(f.ownedRoot, "sibling"), "utf8")).toBe(
      "keep",
    );
    if (owner === "clone") {
      expect(await readFile(path.join(f.root, "folder/child"), "utf8")).toBe(
        "primary nested",
      );
      expect(await readFile(path.join(f.root, "selected"), "utf8")).toBe(
        "primary selected",
      );
    }
    expect((await f.host.executeOverviewFileAction(preview.token)).status).toBe(
      "not-done",
    );
    expect(f.trash).toHaveBeenCalledTimes(2);
    expect(f.runner.start).not.toHaveBeenCalled();
    expect(f.runner.kill).not.toHaveBeenCalled();
  },
);
it.each(["primary", "clone"] as const)(
  "keeps a %s rename confirmation valid when a pipeline starts after preview",
  async (owner) => {
    const f = await ownedFixture(owner);
    await writeFile(path.join(f.ownedRoot, "source"), "keep");
    const preview = await f.host.prepareOverviewFileAction(f.scope, {
      kind: "rename",
      path: "source",
      destination: "renamed",
    });
    f.setRun("unverified");
    expect(await f.host.executeOverviewFileAction(preview.token)).toMatchObject(
      { status: "done" },
    );
    expect(await readFile(path.join(f.ownedRoot, "renamed"), "utf8")).toBe(
      "keep",
    );
  },
);
it.each(["primary", "clone"] as const)(
  "still rejects externally changed sources and settings in %s during a pipeline",
  async (owner) => {
    const f = await ownedFixture(owner);
    await writeFile(path.join(f.ownedRoot, "source"), "original");
    f.setRun("running");
    let preview = await f.host.prepareOverviewFileAction(f.scope, {
      kind: "rename",
      path: "source",
      destination: "renamed",
    });
    await writeFile(path.join(f.ownedRoot, "source"), "external");
    expect((await f.host.executeOverviewFileAction(preview.token)).status).toBe(
      "not-done",
    );
    expect(await readFile(path.join(f.ownedRoot, "source"), "utf8")).toBe(
      "external",
    );
    preview = await f.host.prepareOverviewFileAction(f.scope, {
      kind: "rename",
      path: "source",
      destination: "renamed",
    });
    const document = await f.state.read("p");
    await f.state.save(
      "p",
      { ...document.value, profile: "changed" },
      document.version,
    );
    expect((await f.host.executeOverviewFileAction(preview.token)).status).toBe(
      "not-done",
    );
    expect(await readFile(path.join(f.ownedRoot, "source"), "utf8")).toBe(
      "external",
    );
    await expect(
      lstat(path.join(f.ownedRoot, "renamed")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
);
it("still rejects an obsolete clone revision while a pipeline is running", async () => {
  const f = await ownedFixture("clone");
  await writeFile(path.join(f.ownedRoot, "source"), "clone");
  await f.file("source", "primary");
  f.setRun("running");
  const preview = await f.host.prepareOverviewFileAction(f.scope, {
    kind: "rename",
    path: "source",
    destination: "renamed",
  });
  f.setRevision("87654321-1234-4234-8234-123456789012");
  expect((await f.host.executeOverviewFileAction(preview.token)).status).toBe(
    "not-done",
  );
  await expect(
    f.host.createOverviewEntry(f.scope, "created", "file"),
  ).rejects.toThrow(/Stale owner or revision/);
  expect(await readFile(path.join(f.ownedRoot, "source"), "utf8")).toBe(
    "clone",
  );
  expect(await readFile(path.join(f.root, "source"), "utf8")).toBe("primary");
});
it("previews without writes, collapses nested selections and consumes confirmation once", async () => {
  const f = await fixture();
  await f.file("folder/child");
  await f.file("other");
  const p = await f.host.prepareOverviewFileAction("p", {
    kind: "trash",
    paths: ["folder/child", "folder", "other", "other"],
  });
  expect(p.paths).toEqual(["folder", "other"]);
  expect(f.trash).not.toHaveBeenCalled();
  expect(await f.host.executeOverviewFileAction(p.token)).toMatchObject({
    status: "done",
    completedPaths: ["folder", "other"],
  });
  expect((await f.host.executeOverviewFileAction(p.token)).status).toBe(
    "not-done",
  );
  expect(f.trash).toHaveBeenCalledTimes(2);
  expect(f.runner.command).not.toHaveBeenCalled();
});
it("reports confirmed successful subset and stops without retry after a failed trash", async () => {
  const f = await fixture();
  for (const p of ["a", "b", "c"]) await f.file(p);
  f.trash.mockImplementation(async (p) => {
    if (path.basename(p) === "b") throw Error("OS failure");
    await rename(p, path.join(f.dir, "trash", path.basename(p)));
  });
  const p = await f.host.prepareOverviewFileAction("p", {
    kind: "trash",
    paths: ["a", "b", "c"],
  });
  expect(await f.host.executeOverviewFileAction(p.token)).toMatchObject({
    status: "partial",
    completedPaths: ["a"],
  });
  expect(f.trash).toHaveBeenCalledTimes(2);
  expect(await readFile(path.join(f.root, "c"), "utf8")).toBe("contents");
});
it("reports an uncertain adapter failure with absent source without treating it as confirmed success", async () => {
  const f = await fixture();
  await f.file("a");
  f.trash.mockImplementation(async (p) => {
    await rename(p, path.join(f.dir, "trash", "a"));
    throw Error("lost response");
  });
  const p = await f.host.prepareOverviewFileAction("p", {
    kind: "trash",
    paths: ["a"],
  });
  expect(await f.host.executeOverviewFileAction(p.token)).toMatchObject({
    status: "uncertain",
    completedPaths: [],
  });
  await f.host.executeOverviewFileAction(p.token);
  expect(f.trash).toHaveBeenCalledOnce();
});
it("rejects stale leaf, directory identity and changed nested contents before trash", async () => {
  const f = await fixture();
  await f.file("folder/a");
  let p = await f.host.prepareOverviewFileAction("p", {
    kind: "trash",
    paths: ["folder"],
  });
  await f.file("folder/a", "updated");
  expect((await f.host.executeOverviewFileAction(p.token)).status).toBe(
    "not-done",
  );
  p = await f.host.prepareOverviewFileAction("p", {
    kind: "trash",
    paths: ["folder/a"],
  });
  await rename(path.join(f.root, "folder"), path.join(f.root, "old"));
  await f.file("folder/a");
  expect((await f.host.executeOverviewFileAction(p.token)).status).toBe(
    "not-done",
  );
  expect(f.trash).not.toHaveBeenCalled();
});
it("rejects root, Git, traversal, symbolic links and recursive Git selections", async () => {
  const f = await fixture();
  await f.file("a");
  await symlink(f.root, path.join(f.root, "link"));
  await f.file("nested/.git/config");
  for (const p of [
    "",
    "../a",
    "/etc/passwd",
    ".git/config",
    "link/a",
    "link",
    "nested",
  ])
    await expect(
      f.host.prepareOverviewFileAction("p", { kind: "trash", paths: [p] }),
    ).rejects.toThrow();
  await expect(
    f.host.prepareOverviewFileAction("missing", {
      kind: "trash",
      paths: ["a"],
    }),
  ).rejects.toThrow();
  expect(f.trash).not.toHaveBeenCalled();
});
it("invalidates expired and settings-stale tickets and does not reveal an unchecked path", async () => {
  const f = await fixture();
  await f.file("a");
  let p = await f.host.prepareOverviewFileAction("p", {
    kind: "trash",
    paths: ["a"],
  });
  const realNow = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(realNow + 300001);
  expect((await f.host.executeOverviewFileAction(p.token)).status).toBe(
    "not-done",
  );
  vi.restoreAllMocks();
  p = await f.host.prepareOverviewFileAction("p", {
    kind: "trash",
    paths: ["a"],
  });
  const doc = await f.state.read("p");
  await f.state.save("p", { ...doc.value, profile: "updated" }, doc.version);
  expect((await f.host.executeOverviewFileAction(p.token)).status).toBe(
    "not-done",
  );
  await f.host.revealOverviewEntry("p", "a");
  expect(f.reveal).toHaveBeenCalledWith(path.join(f.root, "a"));
  await expect(f.host.revealOverviewEntry("p", "../a")).rejects.toThrow();
  expect(f.reveal).toHaveBeenCalledOnce();
  expect(f.trash).not.toHaveBeenCalled();
});
it("rejects rename onto existing entries without changing source or destination", async () => {
  const f = await fixture();
  await f.file("a", "original");
  await f.file("b", "keep");
  await expect(
    f.host.prepareOverviewFileAction("p", {
      kind: "rename",
      path: "a",
      destination: "b",
    }),
  ).rejects.toThrow();
  expect(await readFile(path.join(f.root, "a"), "utf8")).toBe("original");
  expect(await readFile(path.join(f.root, "b"), "utf8")).toBe("keep");
});

it.each(["file", "directory"] as const)(
  "renames exactly one %s without overwriting existing names",
  async (kind) => {
    const f = await fixture();
    if (kind === "file") await f.file("a", "original");
    else await f.file("a/child", "original");
    const before = await lstat(path.join(f.root, "a"));
    const p = await f.host.prepareOverviewFileAction("p", {
      kind: "rename",
      path: "a",
      destination: "renamed",
    });
    expect(await f.host.executeOverviewFileAction(p.token)).toMatchObject({
      status: "done",
      completedPaths: ["a"],
    });
    await expect(lstat(path.join(f.root, "a"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await lstat(path.join(f.root, "renamed"))).ino).toBe(before.ino);
    expect(
      await readFile(
        path.join(f.root, kind === "file" ? "renamed" : "renamed/child"),
        "utf8",
      ),
    ).toBe("original");
  },
);
it.each(["file", "directory", "symlink"] as const)(
  "preserves a %s destination created after rename preview",
  async (kind) => {
    const f = await fixture();
    await f.file("source/child", "source");
    const p = await f.host.prepareOverviewFileAction("p", {
      kind: "rename",
      path: "source",
      destination: "target",
    });
    if (kind === "file") await f.file("target", "keep");
    else if (kind === "directory") await f.file("target/child", "keep");
    else
      await symlink(path.join(f.root, "source"), path.join(f.root, "target"));
    const identity = await lstat(path.join(f.root, "target"));
    expect((await f.host.executeOverviewFileAction(p.token)).status).toBe(
      "not-done",
    );
    expect((await lstat(path.join(f.root, "target"))).ino).toBe(identity.ino);
    expect(await readFile(path.join(f.root, "source/child"), "utf8")).toBe(
      "source",
    );
  },
);
it("preserves external data added to a directory reservation before rename and does not retry", async () => {
  const f = await fixture();
  await f.file("source/child", "source");
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(rename).mockImplementation(async (a, b) => {
    if (a === path.join(f.root, "source"))
      await writeFile(path.join(b.toString(), "external"), "keep");
    return actual.rename(a, b);
  });
  const p = await f.host.prepareOverviewFileAction("p", {
    kind: "rename",
    path: "source",
    destination: "target",
  });
  expect((await f.host.executeOverviewFileAction(p.token)).status).toBe(
    "not-done",
  );
  expect(await readFile(path.join(f.root, "target/external"), "utf8")).toBe(
    "keep",
  );
  expect(await readFile(path.join(f.root, "source/child"), "utf8")).toBe(
    "source",
  );
  expect(
    vi
      .mocked(rename)
      .mock.calls.filter(([p]) => p === path.join(f.root, "source")),
  ).toHaveLength(1);
});
it("removes only its own empty directory reservation after rename fails", async () => {
  const f = await fixture();
  await f.file("source/child");
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  let attempted = 0;
  let reservation: { isDirectory: boolean; entries: string[] } | undefined;
  vi.mocked(rename).mockImplementation(async (source, destination) => {
    if (
      source === path.join(f.root, "source") &&
      destination === path.join(f.root, "target")
    ) {
      attempted++;
      reservation = {
        isDirectory: (await lstat(destination)).isDirectory(),
        entries: await readdir(destination),
      };
      throw Object.assign(Error("denied"), { code: "EACCES" });
    }
    return actual.rename(source, destination);
  });
  const p = await f.host.prepareOverviewFileAction("p", {
    kind: "rename",
    path: "source",
    destination: "target",
  });
  expect((await f.host.executeOverviewFileAction(p.token)).status).toBe(
    "not-done",
  );
  expect(attempted).toBe(1);
  expect(reservation).toEqual({ isDirectory: true, entries: [] });
  await expect(lstat(path.join(f.root, "target"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(path.join(f.root, "source/child"), "utf8")).toBe(
    "contents",
  );
});
it("does not overwrite a concurrently created file destination during hard-link creation", async () => {
  const f = await fixture();
  await f.file("a", "original");
  const p = await f.host.prepareOverviewFileAction("p", {
    kind: "rename",
    path: "a",
    destination: "b",
  });
  await f.file("b", "keep");
  expect((await f.host.executeOverviewFileAction(p.token)).status).toBe(
    "not-done",
  );
  expect(await readFile(path.join(f.root, "a"), "utf8")).toBe("original");
  expect(await readFile(path.join(f.root, "b"), "utf8")).toBe("keep");
});
it("rejects hard-linked source entries and does not silently traverse to another owner", async () => {
  const f = await fixture();
  await f.file("a");
  const { link } = await import("node:fs/promises");
  await link(path.join(f.root, "a"), path.join(f.root, "alias"));
  await expect(
    f.host.prepareOverviewFileAction("p", { kind: "trash", paths: ["alias"] }),
  ).rejects.toThrow();
  const ref = {
    projectId: "p",
    year: "2026",
    topic: "fixture",
    branch: "fixture",
    contextId: "ctx-" + "a".repeat(64),
    revision: "12345678-1234-4234-8234-123456789012",
  };
  await expect(
    f.host.prepareOverviewFileAction(ref, { kind: "trash", paths: ["a"] }),
  ).rejects.toThrow();
  expect(f.trash).not.toHaveBeenCalled();
});

it("binds confirmation to the exact managed scope and rejects a later revision without primary fallback", async () => {
  const f = await fixture();
  await f.file("a", "primary");
  const clone = path.join(f.dir, "clone");
  await mkdir(clone);
  await writeFile(path.join(clone, "a"), "clone");
  const ref = {
    projectId: "p",
    year: "2026",
    topic: "fixture",
    branch: "fixture",
    contextId: "ctx-" + "a".repeat(64),
    revision: "12345678-1234-4234-8234-123456789012",
  };
  let revision = ref.revision;
  const clones = (f.host as any).clones;
  vi.spyOn(clones, "resolve").mockImplementation(async (raw: any) => {
    if (JSON.stringify(raw) !== JSON.stringify({ ...ref, revision }))
      throw Error("Stale owner or revision");
    return {
      ...ref,
      revision,
      storageKind: "clone",
      path: clone,
      projectPath: f.root,
      gitCommonDir: path.join(clone, ".git"),
      ownership: "managed",
      state: "ready",
      repositoryKey: "a".repeat(64),
    };
  });
  vi.spyOn(clones.store, "assertOwned").mockResolvedValue(undefined);
  f.runner.command.mockResolvedValue({
    stdout: [
      clone,
      clone + "/.git",
      clone + "/.git",
      clone + "/.git/index",
      clone + "/.git/objects",
    ].join("\n"),
    stderr: "",
  });
  const p = await f.host.prepareOverviewFileAction(ref, {
    kind: "trash",
    paths: ["a"],
  });
  revision = "87654321-1234-4234-8234-123456789012";
  expect((await f.host.executeOverviewFileAction(p.token)).status).toBe(
    "not-done",
  );
  expect(f.trash).not.toHaveBeenCalled();
  expect(await readFile(path.join(f.root, "a"), "utf8")).toBe("primary");
  expect(await readFile(path.join(clone, "a"), "utf8")).toBe("clone");
});
it("never cleans up a replaced directory reservation or calls rename after its guard fails", async () => {
  const f = await fixture();
  await f.file("source/child");
  const { prepareOverviewAction } =
    await import("../src/host/overview-file-actions");
  const prepared = await prepareOverviewAction(f.root, {
    kind: "rename",
    path: "source",
    destination: "target",
  });
  let replaced = false;
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const action = await prepared.perform(async () => {
    if (
      !replaced &&
      (await lstat(path.join(f.root, "target")).then(
        () => true,
        () => false,
      ))
    ) {
      replaced = true;
      await actual.rename(
        path.join(f.root, "target"),
        path.join(f.root, "our-reservation"),
      );
      await actual.mkdir(path.join(f.root, "target"));
      await writeFile(path.join(f.root, "target", "external"), "keep");
    }
  });
  expect(action.status).toBe("not-done");
  expect(await readFile(path.join(f.root, "target/external"), "utf8")).toBe(
    "keep",
  );
  expect(await readFile(path.join(f.root, "source/child"), "utf8")).toBe(
    "contents",
  );
  expect(
    vi
      .mocked(rename)
      .mock.calls.filter(([p]) => p === path.join(f.root, "source")),
  ).toHaveLength(0);
});
it("bounds and consumes host-owned capabilities without leaking source content", async () => {
  const { OverviewFileActionTickets } =
    await import("../src/host/overview-file-actions");
  const tickets = new OverviewFileActionTickets();
  const prepared = {
    request: { kind: "trash" as const, paths: ["a"] },
    paths: ["a"],
    perform: vi.fn(),
  };
  const item = {
    scope: "p",
    root: "/not-exposed",
    settingsVersion: "revision",
    prepared,
  };
  const first = tickets.issue(item);
  for (let i = 0; i < 128; i++) tickets.issue(item);
  expect(tickets.take(first.token)).toBeUndefined();
  const last = tickets.issue(item);
  expect(Object.keys(last).sort()).toEqual(["kind", "paths", "token"]);
  expect(tickets.take(last.token)).toMatchObject({
    scope: "p",
    settingsVersion: "revision",
  });
  expect(tickets.take(last.token)).toBeUndefined();
});
it("rejects queued confirmations which expire before adapter entry", async () => {
  const f = await fixture();
  await f.file("a");
  const p = await f.host.prepareOverviewFileAction("p", {
    kind: "trash",
    paths: ["a"],
  });
  let release!: () => void;
  const blocker = new Promise<void>((r) => {
    release = r;
  });
  (f.host as any).operationTail = blocker;
  const execution = f.host.executeOverviewFileAction(p.token);
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 300001);
  release();
  expect((await execution).status).toBe("not-done");
  expect(f.trash).not.toHaveBeenCalled();
});

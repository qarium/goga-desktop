import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  rename,
  lstat,
  symlink,
  link,
  opendir,
} from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Runner } from "../src/host/process";
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    opendir: vi.fn(actual.opendir),
  };
});
const services: HostService[] = [];
import { HostService } from "../src/host/service";
import { SettingsStore } from "../src/host/settings";
import { DesktopStateStore } from "../src/host/desktop-state";
const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(rename).mockImplementation(actual.rename);
  await Promise.all(services.splice(0).map((s) => s.dispose()));
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function setup(
  adapter?: (file: string) => Promise<void>,
  runner?: Runner,
) {
  const dir = await mkdtemp("/private/tmp/document-trash-host-");
  dirs.push(dir);
  const root = path.join(dir, "project"),
    home = path.join(dir, "home"),
    dataDir = path.join(dir, "data");
  await mkdir(root);
  await mkdir(home);
  await mkdir(path.join(dir, "trash"));
  await new DesktopStateStore(home, dataDir).addProject({
    id: "p",
    name: "Synthetic",
    path: root,
  });
  const calls: string[] = [];
  const settings = new SettingsStore(home);
  const host = new HostService({
    home,
    dataDir,
    settings,
    runner,
    trashItem: async (file: string) => {
      calls.push(file);
      if (adapter) return adapter(file);
      await rename(file, path.join(dir, "trash", path.basename(file)));
    },
  });
  services.push(host);
  const file = async (
    relative: string,
    text: string | Buffer = "secret: hidden\r\n",
    base = root,
  ) => {
    const p = path.join(base, relative);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, text);
    return p;
  };
  const source = {
    scope: "project",
    projectId: "p",
    target: { kind: "workflow", name: "build" },
  } as const;
  return { host, root, home, settings, dir, calls, file, source };
}
it.each(["workflow", "pipeline", "tool", "profile"] as const)(
  "prepares metadata only and moves exactly the %s file after confirmation",
  async (kind) => {
    const f = await setup();
    const relative =
      kind === "tool"
        ? ".goga/tools/demo/nested/build.yml"
        : `.goga/${kind}s/build.yml`;
    const p = await f.file(
      relative,
      undefined,
      kind === "profile" ? f.home : f.root,
    );
    const sibling = await f.file(".goga/keep.yml", "keep");
    const source =
      kind === "profile"
        ? { scope: "home", kind: "profile", name: "build" }
        : {
            scope: "project",
            projectId: "p",
            target:
              kind === "tool"
                ? { kind, tool: "demo", path: "nested/build.yml" }
                : { kind, name: "build" },
          };
    const ticket = await f.host.prepareDocumentDeletion(source as any);
    expect(Object.keys(ticket).sort()).toEqual([
      "name",
      "relativePath",
      "token",
    ]);
    expect(JSON.stringify(ticket)).not.toContain("secret");
    expect(ticket.relativePath).toBe(relative);
    expect(f.calls).toEqual([]);
    expect(await readFile(p, "utf8")).toContain("secret");
    expect(await f.host.deleteDocument(ticket.token)).toEqual({
      status: "trashed",
    });
    expect(f.calls).toEqual([p]);
    await expect(lstat(p)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(sibling, "utf8")).toBe("keep");
    await writeFile(p, "restored");
    expect((await f.host.deleteDocument(ticket.token)).status).toBe(
      "not-trashed",
    );
    expect(await readFile(p, "utf8")).toBe("restored");
  },
);
it("rejects configs, generic paths, traversal and invalid direct-host unions", async () => {
  const f = await setup();
  for (const source of [
    { scope: "project", projectId: "p", target: { kind: "config" } },
    { scope: "home", kind: "config" },
    { ...f.source, path: "/tmp/x" },
    { ...f.source, target: { kind: "tool", tool: "demo", path: "../x.yml" } },
    {
      ...f.source,
      target: { kind: "workflow", name: "build", path: "/tmp/x" },
    },
    { scope: "home", kind: "profile", name: "../x" },
  ])
    await expect(
      f.host.prepareDocumentDeletion(source as any),
    ).rejects.toThrow();
  expect(f.calls).toEqual([]);
});
it.each(["directory", "symlink", "hardlink", "binary", "oversize"] as const)(
  "refuses unsafe %s source",
  async (kind) => {
    const f = await setup();
    const p = await f.file(".goga/workflows/build.yml");
    if (kind === "directory") {
      await rm(p);
      await mkdir(p);
    }
    if (kind === "symlink") {
      await rm(p);
      await symlink(f.root, p);
    }
    if (kind === "hardlink") await link(p, p + ".link");
    if (kind === "binary") await writeFile(p, Buffer.from([0xff, 0]));
    if (kind === "oversize")
      await writeFile(p, Buffer.alloc(1024 * 1024 + 1, 65));
    await expect(f.host.prepareDocumentDeletion(f.source)).rejects.toThrow();
    expect(f.calls).toEqual([]);
  },
);
it.each(["bytes", "leaf", "parent", "missing", "symlink", "hardlink"] as const)(
  "refuses %s change after preparation",
  async (kind) => {
    const f = await setup();
    const p = await f.file(".goga/workflows/build.yml");
    const ticket = await f.host.prepareDocumentDeletion(f.source);
    if (kind === "bytes") await writeFile(p, "changed");
    if (kind === "leaf") {
      await rename(p, p + ".old");
      await writeFile(p, "secret: hidden\r\n");
    }
    if (kind === "parent") {
      await rename(path.dirname(p), path.dirname(p) + ".old");
      await mkdir(path.dirname(p));
      await rename(path.dirname(p) + ".old/build.yml", p);
    }
    if (kind === "missing") await rm(p);
    if (kind === "symlink") {
      await rename(p, p + ".old");
      await symlink(p + ".old", p);
    }
    if (kind === "hardlink") await link(p, p + ".link");
    expect((await f.host.deleteDocument(ticket.token)).status).toBe(
      "not-trashed",
    );
    expect(f.calls).toEqual([]);
  },
);
it.each(["workflow", "profile"] as const)(
  "editor %s version includes ancestor identity even with same leaf and bytes",
  async (kind) => {
    const f = await setup();
    const p = await f.file(
      `.goga/${kind}s/build.yml`,
      undefined,
      kind === "profile" ? f.home : f.root,
    );
    const source =
      kind === "profile"
        ? ({ scope: "home", kind: "profile", name: "build" } as const)
        : f.source;
    const doc =
      kind === "profile"
        ? await f.settings.readSettings("profile", "build")
        : await f.host.readProjectDocument("p", f.source.target);
    const originalLeaf = await lstat(p);
    const goga = path.dirname(path.dirname(p));
    await rename(goga, goga + ".old");
    await mkdir(goga);
    await rename(path.join(goga + ".old", kind + "s"), path.dirname(p));
    const currentLeaf = await lstat(p);
    expect([
      currentLeaf.dev,
      currentLeaf.ino,
      currentLeaf.size,
      currentLeaf.ctimeMs,
      currentLeaf.mtimeMs,
    ]).toEqual([
      originalLeaf.dev,
      originalLeaf.ino,
      originalLeaf.size,
      originalLeaf.ctimeMs,
      originalLeaf.mtimeMs,
    ]);
    await expect(
      f.host.prepareDocumentDeletion(source, doc.version),
    ).rejects.toThrow();
    expect(f.calls).toEqual([]);
  },
);
it.each([
  "reject-before",
  "reject-after",
  "resolve-no-move",
  "resolve-replaced",
] as const)("reports guarded adapter outcome: %s", async (mode) => {
  const f = await setup(async (p) => {
    if (mode === "reject-before") throw new Error("secret payload");
    if (mode === "resolve-no-move") return;
    await rename(p, p + ".moved");
    if (mode === "reject-after") throw new Error("secret payload");
    await writeFile(p, "replacement");
  });
  await f.file(".goga/workflows/build.yml");
  const ticket = await f.host.prepareDocumentDeletion(f.source);
  const result = await f.host.deleteDocument(ticket.token);
  expect(result.status).toBe(
    mode === "reject-before" || mode === "resolve-no-move"
      ? "not-trashed"
      : "uncertain",
  );
  expect(JSON.stringify(result)).not.toContain("secret payload");
  expect((await f.host.deleteDocument(ticket.token)).status).toBe(
    "not-trashed",
  );
  expect(f.calls).toHaveLength(1);
});
it("expires one-use tickets and bounds retained tickets", async () => {
  const f = await setup();
  await f.file(".goga/workflows/build.yml");
  const ticket = await f.host.prepareDocumentDeletion(f.source);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60 * 1000);
  expect((await f.host.deleteDocument(ticket.token)).status).toBe(
    "not-trashed",
  );
  expect(f.calls).toEqual([]);
  vi.restoreAllMocks();
});
it("has no deletion fallback when the host has no desktop trash adapter", async () => {
  const f = await setup();
  await f.file(".goga/workflows/build.yml");
  const host = new HostService({
    home: f.home,
    dataDir: path.join(f.dir, "data"),
  });
  const ticket = await host.prepareDocumentDeletion(f.source);
  expect((await host.deleteDocument(ticket.token)).status).toBe("not-trashed");
  expect(f.calls).toEqual([]);
});
it("rejects alias spelling at each tool path component", async () => {
  const f = await setup();
  await f.file(".goga/tools/demo/Nested/build.yml");
  await expect(
    f.host.prepareDocumentDeletion({
      scope: "project",
      projectId: "p",
      target: { kind: "tool", tool: "demo", path: "nested/build.yml" },
    }),
  ).rejects.toThrow();
});

function gate() {
  let release!: () => void, entered!: () => void;
  return {
    blocked: new Promise<void>((r) => (release = r)),
    reached: new Promise<void>((r) => (entered = r)),
    release: () => release(),
    entered: () => entered(),
  };
}
function fakeRunner() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const command = vi.fn<Runner["command"]>(async (exe, args) => {
    let stdout = "";
    if (exe === "git")
      stdout =
        args[0] === "branch"
          ? "main\n"
          : args.includes("--git-common-dir")
            ? "."
            : args[0] === "rev-parse"
              ? "a".repeat(40)
              : args[0] === "for-each-ref"
                ? "main\n"
                : "";
    else if (args.includes("board"))
      stdout = JSON.stringify([
        { topic: "main", branch: "main", current: true, remote: false },
      ]);
    else if (args.includes("--list")) stdout = "* build\n    name: Build\n";
    else if (args.includes("--info")) stdout = "* work:\n    title: Work\n";
    else throw Error("Unexpected command");
    return { stdout, stderr: "" };
  });
  const runner: Runner = {
    command,
    start: vi.fn(() => child as any),
    kill: vi.fn(),
  };
  return { runner, command };
}
const request = {
  projectId: "p",
  pipeline: "build",
  workflow: "auto",
  profile: "",
  skips: [],
};
async function launchRequest(host: HostService) {
  return {
    ...request,
    previewToken: (await host.preview(request)).token,
    topic: { mode: "existing" as const, branch: "main", topic: "main" },
    task: "",
    taskVersion: (
      await host.readTopicTask({
        projectId: "p",
        branch: "main",
        topic: "main",
      })
    ).version,
    confirmEmptyTask: false,
    expectedBranch: "main",
    confirmBranchSwitch: false,
    clean: false,
  };
}
it("second pre-issued ticket cannot delete an externally restored replacement", async () => {
  const f = await setup();
  const p = await f.file(".goga/workflows/build.yml");
  const a = await f.host.prepareDocumentDeletion(f.source),
    b = await f.host.prepareDocumentDeletion(f.source);
  expect((await f.host.deleteDocument(a.token)).status).toBe("trashed");
  await writeFile(p, "secret: hidden\r\n");
  expect((await f.host.deleteDocument(b.token)).status).toBe("not-trashed");
  expect(f.calls).toHaveLength(1);
});
it("evicts oldest tickets after bounded issuance", async () => {
  const f = await setup();
  await f.file(".goga/workflows/build.yml");
  const oldest = await f.host.prepareDocumentDeletion(f.source);
  for (let i = 0; i < 128; i++) await f.host.prepareDocumentDeletion(f.source);
  expect((await f.host.deleteDocument(oldest.token)).status).toBe(
    "not-trashed",
  );
  expect(f.calls).toHaveLength(0);
});
it.each(["workflow", "profile"] as const)(
  "serializes %s save then deletion and refuses the stale ticket",
  async (kind) => {
    const f = await setup();
    const p = await f.file(
      `.goga/${kind}s/build.yml`,
      undefined,
      kind === "profile" ? f.home : f.root,
    );
    const source =
      kind === "profile"
        ? ({ scope: "home", kind: "profile", name: "build" } as const)
        : f.source;
    const doc =
      kind === "profile"
        ? await f.settings.readSettings("profile", "build")
        : await f.host.readProjectDocument("p", f.source.target);
    const ticket = await f.host.prepareDocumentDeletion(source);
    const g = gate();
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(rename).mockImplementation(async (a, b) => {
      if (String(a).includes(".goga-document-")) {
        g.entered();
        await g.blocked;
      }
      return actual.rename(a, b);
    });
    const save =
      kind === "profile"
        ? f.settings.saveSettings(
            "profile",
            "build",
            "saved: true\n",
            doc.version,
          )
        : f.host.saveProjectDocument(
            "p",
            f.source.target,
            "saved: true\n",
            doc.version,
          );
    await g.reached;
    const deletion = f.host.deleteDocument(ticket.token);
    await new Promise((r) => setTimeout(r, 20));
    expect(f.calls).toHaveLength(0);
    g.release();
    await save;
    expect((await deletion).status).toBe("not-trashed");
    expect(await readFile(p, "utf8")).toBe("saved: true\n");
  },
);
it.each(["workflow", "profile"] as const)(
  "serializes %s deletion then save without recreating the deleted document",
  async (kind) => {
    const g = gate();
    const f = await setup(async (p) => {
      g.entered();
      await g.blocked;
      await rename(p, p + ".trashed");
    });
    const p = await f.file(
      `.goga/${kind}s/build.yml`,
      undefined,
      kind === "profile" ? f.home : f.root,
    );
    const source =
      kind === "profile"
        ? ({ scope: "home", kind: "profile", name: "build" } as const)
        : f.source;
    const doc =
      kind === "profile"
        ? await f.settings.readSettings("profile", "build")
        : await f.host.readProjectDocument("p", f.source.target);
    const ticket = await f.host.prepareDocumentDeletion(source);
    const deletion = f.host.deleteDocument(ticket.token);
    await g.reached;
    const save =
      kind === "profile"
        ? f.settings.saveSettings(
            "profile",
            "build",
            "saved: true\n",
            doc.version,
          )
        : f.host.saveProjectDocument(
            "p",
            f.source.target,
            "saved: true\n",
            doc.version,
          );
    const failure = expect(save).rejects.toThrow(/измен/);
    g.release();
    expect((await deletion).status).toBe("trashed");
    await failure;
    await expect(lstat(p)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
it("blocks deletion while launch is pending and then active, without stopping or reconfiguring it", async () => {
  const { runner, command } = fakeRunner();
  const f = await setup(undefined, runner);
  await f.file(".goga/workflows/build.yml");
  const ticket = await f.host.prepareDocumentDeletion(f.source);
  const launch = await launchRequest(f.host);
  const g = gate(),
    original = command.getMockImplementation()!;
  let first = true;
  command.mockImplementation(async (...args) => {
    if (first && args[1].includes("--git-common-dir")) {
      first = false;
      g.entered();
      await g.blocked;
    }
    return original(...args);
  });
  const starting = f.host.launch(launch);
  await g.reached;
  let settled = false;
  const deletion = f.host.deleteDocument(ticket.token).then((r) => {
    settled = true;
    return r;
  });
  await new Promise((r) => setTimeout(r, 20));
  expect(settled).toBe(false);
  expect(f.calls).toHaveLength(0);
  g.release();
  await starting;
  expect(await deletion).toMatchObject({
    status: "not-trashed",
    message: expect.stringMatching(/конвейер/),
  });
  await expect(f.host.prepareDocumentDeletion(f.source)).rejects.toThrow(
    /конвейер/,
  );
  expect(f.host.runs()[0].status).toBe("starting");
  expect(runner.kill).not.toHaveBeenCalled();
  expect(f.calls).toHaveLength(0);
});
it("launch waits behind an in-flight trash operation and rejects its invalidated preview", async () => {
  const { runner } = fakeRunner();
  const g = gate(),
    f = await setup(async (p) => {
      g.entered();
      await g.blocked;
      await rename(p, p + ".trashed");
    }, runner);
  await f.file(".goga/workflows/build.yml");
  const launch = await launchRequest(f.host);
  const ticket = await f.host.prepareDocumentDeletion(f.source);
  const deletion = f.host.deleteDocument(ticket.token);
  await g.reached;
  const pending = f.host.launch(launch);
  const failure = expect(pending).rejects.toThrow(/Предпросмотр устарел/);
  expect(runner.start).not.toHaveBeenCalled();
  g.release();
  await deletion;
  await failure;
  expect(runner.start).not.toHaveBeenCalled();
});
it.each(["preview", "discover", "suggestions"] as const)(
  "rejects pending %s results after possible mutation even when bytes are restored",
  async (operation) => {
    const { runner, command } = fakeRunner();
    const f = await setup(async (p) => {
      await rename(p, p + ".trashed");
      await writeFile(p, "secret: hidden\r\n");
      throw Error("adapter failed");
    }, runner);
    await f.file(".goga/workflows/build.yml");
    const ticket = await f.host.prepareDocumentDeletion(f.source);
    const g = gate(),
      original = command.getMockImplementation()!;
    let first = true;
    command.mockImplementation(async (...args) => {
      if (first && args[0] !== "git" && args[1][0] === "pipeline") {
        first = false;
        g.entered();
        await g.blocked;
      }
      return original(...args);
    });
    const pending =
      operation === "preview"
        ? f.host.preview(request)
        : operation === "discover"
          ? f.host.discover("p")
          : f.host.listWorkflowSuggestions("p");
    const failed = expect(pending).rejects.toThrow(/измен|устарел/i);
    await g.reached;
    expect((await f.host.deleteDocument(ticket.token)).status).toBe(
      "uncertain",
    );
    g.release();
    await failed;
  },
);
it("home profile deletion invalidates all project previews but leaves bindings untouched", async () => {
  const { runner } = fakeRunner();
  const f = await setup(undefined, runner);
  await f.file(".goga/workflows/build.yml");
  await f.file(".goga/profiles/build.yml", undefined, f.home);
  const initial = await f.host.readProjectSettings("p");
  const binding = await f.host.saveProjectSettings(
    "p",
    { ...initial.value, profile: "build" },
    initial.version,
  );
  const launch = await launchRequest(f.host);
  const ticket = await f.host.prepareDocumentDeletion({
    scope: "home",
    kind: "profile",
    name: "build",
  });
  expect((await f.host.deleteDocument(ticket.token)).status).toBe("trashed");
  expect((await f.host.readProjectSettings("p")).value.profile).toBe("build");
  expect((await f.host.readProjectSettings("p")).version).toBe(binding.version);
  await expect(f.host.launch(launch)).rejects.toThrow(/Предпросмотр устарел/);
  expect(runner.start).not.toHaveBeenCalled();
});
it.each(["café", "cafe\u0301", "Σ", "ς"] as const)(
  "rejects Unicode alias target %s instead of retargeting",
  async (alias) => {
    const f = await setup();
    const original =
      alias === "café"
        ? "cafe\u0301"
        : alias === "cafe\u0301"
          ? "café"
          : alias === "Σ"
            ? "ς"
            : "Σ";
    await f.file(`.goga/workflows/${original}.yml`);
    await expect(
      f.host.prepareDocumentDeletion({
        ...f.source,
        target: { kind: "workflow", name: alias },
      }),
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  },
);

it("does not use a ticket that expires while waiting for the shared settings save queue", async () => {
  const f = await setup();
  await f.file(".goga/profiles/build.yml", undefined, f.home);
  await f.file(".goga/profiles/other.yml", undefined, f.home);
  const source = { scope: "home", kind: "profile", name: "build" } as const,
    ticket = await f.host.prepareDocumentDeletion(source),
    other = await f.settings.readSettings("profile", "other");
  const g = gate(),
    actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
  vi.mocked(rename).mockImplementation(async (a, b) => {
    if (String(a).includes(".goga-document-")) {
      g.entered();
      await g.blocked;
    }
    return actual.rename(a, b);
  });
  const save = f.settings.saveSettings(
    "profile",
    "other",
    "value: changed\n",
    other.version,
  );
  await g.reached;
  const deletion = f.host.deleteDocument(ticket.token);
  await new Promise((r) => setTimeout(r, 20));
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60 * 1000);
  g.release();
  await save;
  expect((await deletion).status).toBe("not-trashed");
  expect(f.calls).toHaveLength(0);
});
it("does not retain a usable preview from a snapshot whose project lookup crossed deletion", async () => {
  const { runner } = fakeRunner();
  const f = await setup(async (p) => {
    await rename(p, p + ".trashed");
    await writeFile(p, "secret: hidden\r\n");
    throw Error("failed after moving");
  }, runner);
  await f.file(".goga/workflows/build.yml");
  const ticket = await f.host.prepareDocumentDeletion(f.source);
  const g = gate(),
    original = DesktopStateStore.prototype.listProjects;
  let lookups = 0;
  vi.spyOn(DesktopStateStore.prototype, "listProjects").mockImplementation(
    async function (this: DesktopStateStore) {
      const result = await original.call(this);
      if (++lookups === 2) {
        g.entered();
        await g.blocked;
      }
      return result;
    },
  );
  const pending = f.host.preview(request);
  const failure = expect(pending).rejects.toThrow(/измен|устарел/i);
  await g.reached;
  expect((await f.host.deleteDocument(ticket.token)).status).toBe("uncertain");
  g.release();
  await failure;
  // Capabilities must be invalidated even when the caller never received their token.
  expect((f.host as any).previews.size).toBe(0);
});
it.each(["workflow", "profile"] as const)(
  "preparation for absent %s never creates directories",
  async (kind) => {
    const f = await setup();
    const source =
      kind === "profile"
        ? ({ scope: "home", kind: "profile", name: "build" } as const)
        : f.source;
    const base = kind === "profile" ? f.home : f.root;
    await expect(f.host.prepareDocumentDeletion(source)).rejects.toThrow();
    await expect(
      lstat(path.join(base, ".goga", kind + "s")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.calls).toHaveLength(0);
  },
);
it.each(["profile", "tool"] as const)(
  "rejects exact-byte identity replacement before preparing an open %s editor",
  async (kind) => {
    const f = await setup();
    const source =
      kind === "profile"
        ? ({ scope: "home", kind: "profile", name: "build" } as const)
        : ({
            scope: "project",
            projectId: "p",
            target: { kind: "tool", tool: "demo", path: "build.yml" },
          } as const);
    const p = await f.file(
      kind === "profile"
        ? ".goga/profiles/build.yml"
        : ".goga/tools/demo/build.yml",
      undefined,
      kind === "profile" ? f.home : f.root,
    );
    const original =
      kind === "profile"
        ? await f.settings.readSettings("profile", "build")
        : await f.host.readProjectDocument("p", {
            kind: "tool",
            tool: "demo",
            path: "build.yml",
          });
    await rename(p, p + ".old");
    await writeFile(p, "secret: hidden\r\n");
    await expect(
      f.host.prepareDocumentDeletion(source, original.version),
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  },
);
it("reports uncertain if the adapter moves the file but its parent can no longer be verified", async () => {
  const f = await setup(async (p) => {
    await rename(p, p + ".trashed");
    await rename(path.dirname(p), path.dirname(p) + ".moved");
    await mkdir(path.dirname(p));
  });
  await f.file(".goga/workflows/build.yml");
  const ticket = await f.host.prepareDocumentDeletion(f.source);
  expect((await f.host.deleteDocument(ticket.token)).status).toBe("uncertain");
  expect(f.calls).toHaveLength(1);
});
it("shares the project file save lock with another HostService instance", async () => {
  const g = gate(),
    f = await setup(async (p) => {
      g.entered();
      await g.blocked;
      await rename(p, p + ".trashed");
    });
  const other = new HostService({
    home: f.home,
    dataDir: path.join(f.dir, "data"),
  });
  services.push(other);
  const p = await f.file(".goga/tools/demo/build.yml"),
    target = { kind: "tool", tool: "demo", path: "build.yml" } as const;
  const doc = await other.readProjectDocument("p", target);
  const ticket = await f.host.prepareDocumentDeletion({
    scope: "project",
    projectId: "p",
    target,
  });
  const deletion = f.host.deleteDocument(ticket.token);
  await g.reached;
  const save = other.saveProjectDocument(
    "p",
    target,
    "changed: true\n",
    doc.version,
  );
  const failure = expect(save).rejects.toThrow();
  g.release();
  expect((await deletion).status).toBe("trashed");
  await failure;
  await expect(lstat(p)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["workflow", "pipeline", "profile"] as const)(
  "rejects existing %s ancestor symlink before enumerating outside the trusted root",
  async (kind) => {
    const f = await setup();
    const base = kind === "profile" ? f.home : f.root;
    const outside = path.join(f.dir, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "build.yml"), "private: outside\n");
    await mkdir(path.join(base, ".goga"), { recursive: true });
    const ancestor = path.join(base, ".goga", kind + "s");
    await symlink(outside, ancestor);
    const source =
      kind === "profile"
        ? ({ scope: "home", kind: "profile", name: "build" } as const)
        : ({
            scope: "project",
            projectId: "p",
            target: { kind, name: "build" },
          } as const);
    vi.mocked(opendir).mockClear();
    await expect(f.host.prepareDocumentDeletion(source)).rejects.toThrow();
    expect(
      vi.mocked(opendir).mock.calls.map(([directory]) => String(directory)),
    ).not.toContain(ancestor);
    expect(f.calls).toHaveLength(0);
    expect(await readFile(path.join(outside, "build.yml"), "utf8")).toBe(
      "private: outside\n",
    );
  },
);

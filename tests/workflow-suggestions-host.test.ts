import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
  link,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { HostService } from "../src/host/service";
import { DesktopStateStore } from "../src/host/desktop-state";
import type { Pipeline } from "../src/shared/types";
import type { Runner } from "../src/host/process";

const dirs: string[] = [],
  services: HostService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.dispose()));
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const catalog =
  "* development (project)\n    name: Display title\n    description: Project definition\n* acme:Сборка_β.v2\n    name: Installed title\n    description: Installed definition\n";
const pipeline = (id: string): Pipeline => ({
  id,
  name: "Display title",
  description: "",
  project: false,
});
async function setup() {
  const dir = await mkdtemp("/private/tmp/goga-suggestions-");
  dirs.push(dir);
  const root = path.join(dir, "project"),
    home = path.join(dir, "home"),
    dataDir = path.join(dir, "data");
  await mkdir(root);
  await mkdir(home);
  const state = new DesktopStateStore(home, dataDir);
  await state.addProject({ id: "registered", name: "Synthetic", path: root });
  const command = vi.fn<Runner["command"]>(async () => ({
    stdout: catalog,
    stderr: "",
  }));
  const start = vi.fn(() => {
    throw Error("Never start a pipeline");
  });
  const host = new HostService({
    home,
    dataDir,
    goga: "fake-goga",
    runner: { command, start, kill: vi.fn() },
  });
  services.push(host);
  // Settings are already loaded before this form opens in the application.
  await host.readProjectSettings("registered");
  const file = async (
    relative: string,
    text: string | Buffer = "{% if x %}\nx: [\n{% endif %}",
  ) => {
    const p = path.join(root, relative);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, text);
    return p;
  };
  return {
    root,
    home,
    dataDir,
    host,
    state,
    command,
    start,
    file,
    id: "registered",
  };
}
function gate() {
  let release!: () => void, entered!: () => void;
  return {
    blocked: new Promise<void>((resolve) => {
      release = resolve;
    }),
    reached: new Promise<void>((resolve) => {
      entered = resolve;
    }),
    release: () => release(),
    entered: () => entered(),
  };
}
async function filter() {
  const module = await import("../src/shared/workflow-suggestions");
  expect(typeof module.availableWorkflowPipelines).toBe("function");
  return module.availableWorkflowPipelines;
}
it("returns actual pipeline IDs and both sources with exactly one scoped read-only command", async () => {
  const { host, id, root, command, start, home } = await setup();
  const homeBefore = await readdir(home, { recursive: true });
  expect(typeof host.listWorkflowSuggestions).toBe("function");
  expect(await host.listWorkflowSuggestions(id)).toEqual([
    {
      id: "development",
      name: "Display title",
      description: "Project definition",
      project: true,
    },
    {
      id: "acme:Сборка_β.v2",
      name: "Installed title",
      description: "Installed definition",
      project: false,
    },
  ]);
  expect(command.mock.calls).toEqual([
    ["fake-goga", ["pipeline", "--list", "--info"], root, {}],
  ]);
  expect(start).not.toHaveBeenCalled();
  expect(await readdir(root)).toEqual([]);
  expect(await readdir(home, { recursive: true })).toEqual(homeBefore);
  expect(host.runs()).toEqual([]);
});
it("uses saved executable and environment and does not cache catalog or occupied files", async () => {
  const { host, id, root, command, file } = await setup();
  const settings = await host.readProjectSettings(id);
  await host.saveProjectSettings(
    id,
    {
      ...settings.value,
      executable: "/synthetic/bin/goga",
      env: [
        { key: "TOKEN", value: "private-secret", secret: true, runtime: false },
      ],
    },
    settings.version,
  );
  expect((await host.listWorkflowSuggestions(id)).map((p) => p.id)).toEqual([
    "development",
    "acme:Сборка_β.v2",
  ]);
  await file(".goga/workflows/development.yml");
  expect((await host.listWorkflowSuggestions(id)).map((p) => p.id)).toEqual([
    "acme:Сборка_β.v2",
  ]);
  expect(command.mock.calls).toEqual(
    Array(2).fill([
      "/synthetic/bin/goga",
      ["pipeline", "--list", "--info"],
      root,
      { TOKEN: "private-secret" },
    ]),
  );
});
it("filters original IDs, exact duplicates, invalid basenames and ambiguous case/Unicode groups", async () => {
  const available = await filter();
  const exact = pipeline("acme:Сборка_β.v2");
  const invalid = [
    "",
    "../x",
    "a/b",
    "a\\b",
    "a b",
    "-x",
    "a\u0085",
    "a".repeat(181),
    "é".repeat(126),
    "\ud800",
  ];
  const aliases = [
    "Build",
    "build",
    "café",
    "cafe\u0301",
    "Σ",
    "ς",
    "ß",
    "ss",
    "ﬀ",
    "ff",
  ];
  const input = [
    exact,
    { ...exact },
    ...invalid.map(pipeline),
    ...aliases.map(pipeline),
    pipeline("auto"),
    pipeline("none"),
  ];
  expect(available(input, [])).toEqual([
    exact,
    pipeline("auto"),
    pipeline("none"),
  ]);
  expect(available(input, [])[0]).toBe(exact);
  expect(input).toHaveLength(24);
});
it("blocks actual filename aliases of every occupied entry and draft, not display names", async () => {
  const available = await filter();
  const files = [
    { name: "irrelevant", path: ".goga/workflows/Build.YML", editable: false },
    {
      name: "different",
      path: ".goga/workflows/cafe\u0301.yml",
      editable: false,
    },
    {
      name: "do-not-block",
      path: ".goga/workflows/other.yaml",
      editable: false,
    },
  ];
  expect(
    available(
      ["build", "café", "draft", "acme:Draft", "do-not-block", "other"].map(
        pipeline,
      ),
      files,
      ["Draft", "acme:draft"],
    ),
  ).toEqual([pipeline("do-not-block"), pipeline("other")]);
});
it("excludes unsafe occupied symlinks, hardlinks, FIFO, directories and uppercase extensions without rewriting bytes", async () => {
  const { host, id, root, file, command, start } = await setup();
  const outside = await file("outside.txt", "private");
  await file(".goga/workflows/regular.yml");
  await file(".goga/workflows/upper.YML");
  await file(".goga/workflows/cafe\u0301.yml");
  await file(".goga/workflows/binary.yml", Buffer.from([0xff]));
  await mkdir(path.join(root, ".goga/workflows/directory.yml"));
  await symlink(outside, path.join(root, ".goga/workflows/symlink.yml"));
  await link(outside, path.join(root, ".goga/workflows/hardlink.yml"));
  execFileSync("mkfifo", [path.join(root, ".goga/workflows/fifo.yml")]);
  command.mockResolvedValue({
    stdout: [
      "regular",
      "upper",
      "café",
      "binary",
      "directory",
      "symlink",
      "hardlink",
      "fifo",
      "free",
    ]
      .map((id) => `* ${id}\n`)
      .join(""),
    stderr: "",
  });
  const before = await readdir(path.join(root, ".goga/workflows"));
  expect((await host.listWorkflowSuggestions(id)).map((p) => p.id)).toEqual([
    "free",
  ]);
  expect(await readdir(path.join(root, ".goga/workflows"))).toEqual(before);
  expect(await readFile(outside, "utf8")).toBe("private");
  expect(start).not.toHaveBeenCalled();
  expect(command).toHaveBeenCalledTimes(1);
});
it("rejects unregistered project IDs before commands", async () => {
  const { host, root, command } = await setup();
  for (const id of [root, "unknown", ""])
    await expect(host.listWorkflowSuggestions(id)).rejects.toThrow(/проект/);
  expect(command).not.toHaveBeenCalled();
  expect(await readdir(root)).toEqual([]);
});
it("rejects changed saved settings during the catalog request", async () => {
  const { host, command, id } = await setup();
  const g = gate();
  command.mockImplementation(async () => {
    g.entered();
    await g.blocked;
    return { stdout: catalog, stderr: "" };
  });
  const request = host.listWorkflowSuggestions(id);
  await g.reached;
  const settings = await host.readProjectSettings(id);
  await host.saveProjectSettings(
    id,
    { ...settings.value, executable: "/changed/goga" },
    settings.version,
  );
  const rejected = expect(request).rejects.toThrow(
    /Настройки проекта изменились/,
  );
  g.release();
  await rejected;
});
it.each(["workflow", "pipeline", "config", "tool"] as const)(
  "rejects in-flight catalog after successful %s document save",
  async (kind) => {
    const { host, command, id, file } = await setup();
    const g = gate();
    command.mockImplementation(async () => {
      g.entered();
      await g.blocked;
      return { stdout: catalog, stderr: "" };
    });
    const request = host.listWorkflowSuggestions(id);
    await g.reached;
    const target =
      kind === "config"
        ? { kind }
        : kind === "tool"
          ? { kind, tool: "sample", path: "config.yml" }
          : { kind, name: "new" };
    if (kind === "config") await file(".goga/config.yml", "{}");
    if (kind === "tool") await file(".goga/tools/sample/config.yml", "{}");
    const before = await host.readProjectDocument(id, target);
    await host.saveProjectDocument(id, target, "{}", before.version);
    const rejected = expect(request).rejects.toThrow(/измен|устарел/i);
    g.release();
    await rejected;
  },
);
it("does not invalidate catalog for failed saves or saves of another project", async () => {
  const { host, command, id, root, state } = await setup();
  const g = gate();
  const other = root + "-other";
  await mkdir(other);
  await state.addProject({ id: "other", name: "Other", path: other });
  command.mockImplementation(async () => {
    g.entered();
    await g.blocked;
    return { stdout: catalog, stderr: "" };
  });
  const request = host.listWorkflowSuggestions(id);
  await g.reached;
  await expect(
    host.saveProjectDocument(
      id,
      { kind: "workflow", name: "new" },
      "text",
      "stale",
    ),
  ).rejects.toThrow();
  await host.saveProjectDocument(
    "other",
    { kind: "workflow", name: "new" },
    "text",
    "missing",
  );
  g.release();
  expect(await request).toHaveLength(2);
});
it("redacts executable errors and saved environment values in guarded-list errors", async () => {
  const { host, command, id } = await setup();
  const settings = await host.readProjectSettings(id);
  await host.saveProjectSettings(
    id,
    {
      ...settings.value,
      env: [
        { key: "TOKEN", value: "private-secret", secret: true, runtime: false },
      ],
    },
    settings.version,
  );
  command.mockRejectedValueOnce(
    new Error("private-secret arbitrary child stderr"),
  );
  await expect(host.listWorkflowSuggestions(id)).rejects.toThrow(
    /Значения окружения скрыты/,
  );
  vi.spyOn(host, "listProjectWorkflows").mockRejectedValueOnce(
    new Error("private-secret filesystem failure"),
  );
  await expect(host.listWorkflowSuggestions(id)).rejects.toThrow(
    "[скрыто] filesystem failure",
  );
});

it("rechecks the document revision after the final asynchronous settings verification", async () => {
  const { host, id } = await setup();
  const g = gate();
  const original = DesktopStateStore.prototype.read;
  let reads = 0;
  const spy = vi
    .spyOn(DesktopStateStore.prototype, "read")
    .mockImplementation(async function (this: DesktopStateStore, projectId) {
      const result = await original.call(this, projectId);
      if (++reads === 3) {
        g.entered();
        await g.blocked;
      }
      return result;
    });
  try {
    const request = host.listWorkflowSuggestions(id);
    await g.reached;
    await host.saveProjectDocument(
      id,
      { kind: "workflow", name: "new" },
      "text",
      "missing",
    );
    const rejected = expect(request).rejects.toThrow(/измен|устарел/i);
    g.release();
    await rejected;
  } finally {
    g.release();
    spy.mockRestore();
  }
});
it("fails closed for an unsafe workflow directory without following its symlink", async () => {
  const { host, id, root, home, command } = await setup();
  await mkdir(path.join(root, ".goga"));
  await symlink(home, path.join(root, ".goga/workflows"));
  const before = await readdir(home, { recursive: true });
  await expect(host.listWorkflowSuggestions(id)).rejects.toThrow(
    /Символ|ссылк/,
  );
  expect(await readdir(home, { recursive: true })).toEqual(before);
  expect(command).toHaveBeenCalledTimes(1);
});

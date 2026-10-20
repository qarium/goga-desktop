import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  rename,
  symlink,
  link,
  chmod,
} from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { HostService } from "../src/host/service";
import { DesktopStateStore } from "../src/host/desktop-state";
import * as documents from "../src/shared/project-documents";
import type { ProjectDocumentTarget } from "../src/shared/project-documents";
import type { Runner } from "../src/host/process";
// Gates control scheduling only. All reads/writes still use the real disposable filesystem.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, link: vi.fn(actual.link), rename: vi.fn(actual.rename) };
});
const dirs: string[] = [],
  services: HostService[] = [];
afterEach(async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(link).mockImplementation(actual.link);
  vi.mocked(rename).mockImplementation(actual.rename);
  await Promise.all(services.splice(0).map((s) => s.dispose()));
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const workflow = (name = "Build") =>
  ({ kind: "workflow", name }) as ProjectDocumentTarget;
async function setup() {
  const dir = await mkdtemp("/private/tmp/goga-workflows-");
  dirs.push(dir);
  const root = path.join(dir, "project"),
    home = path.join(dir, "home"),
    dataDir = path.join(dir, "data");
  await mkdir(root);
  await mkdir(home);
  await new DesktopStateStore(home, dataDir).addProject({
    id: "registered",
    name: "Synthetic",
    path: root,
  });
  const start = vi.fn(() => {
    throw Error("Never spawn a pipeline in this test");
  });
  const runner: Runner = {
    start,
    kill: vi.fn(),
    command: vi.fn(async (exe, args) => {
      if (exe === "git")
        return {
          stdout: args.includes("--git-common-dir") ? root : "main\n",
          stderr: "",
        };
      if (args.includes("board")) return { stdout: "[]", stderr: "" };
      if (args.includes("--list"))
        return { stdout: "* build\n    name: Build\n", stderr: "" };
      if (args.includes("--info"))
        return { stdout: "* plan:\n    title: Plan\n", stderr: "" };
      throw Error("Unexpected command");
    }),
  };
  const second = () => {
    const s = new HostService({ home, dataDir, runner, goga: "fake" });
    services.push(s);
    return s;
  };
  const host = second();
  const file = async (relative: string, text: string | Buffer = "{}\n") => {
    const p = path.join(root, relative);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, text);
    return p;
  };
  return { root, home, host, second, file, id: "registered", start, runner };
}
it("reads absent workflows without writes and creates directories only on explicit save", async () => {
  const { root, host, id } = await setup();
  expect(await host.listProjectWorkflows(id)).toEqual([]);
  expect(await host.readProjectDocument(id, workflow())).toEqual({
    text: "",
    version: "missing",
    exists: false,
    relativePath: ".goga/workflows/Build.yml",
  });
  expect(await readdir(root)).toEqual([]);
  const saved = await host.saveProjectDocument(
    id,
    workflow(),
    "{% if enabled %}\nvalue: {{ value }}\n{% endif %}\n",
    "missing",
  );
  expect(saved.exists).toBe(true);
  expect(await host.listProjectWorkflows(id)).toEqual([
    { name: "Build", path: ".goga/workflows/Build.yml", editable: true },
  ]);
});
it("preserves raw Jinja, BOM, CRLF, comments, Unicode and malformed YAML byte-for-byte", async () => {
  const { host, id, root } = await setup();
  const text =
    "\ufeff# комментарий 🙂\r\n{% for item in items %}\r\n{{ item }}: [\r\n{% endfor %}\r\n";
  const saved = await host.saveProjectDocument(
    id,
    workflow("Сборка_β.v2"),
    text,
    "missing",
  );
  expect(
    (await host.readProjectDocument(id, workflow("Сборка_β.v2"))).text,
  ).toBe(text);
  expect(await readFile(path.join(root, saved.relativePath))).toEqual(
    Buffer.from(text),
  );
  expect(
    (
      await host.saveProjectDocument(
        id,
        workflow("Сборка_β.v2"),
        text + "# end\r\n",
        saved.version,
      )
    ).text,
  ).toBe(text + "# end\r\n");
});
it("uses launch-compatible names plus byte, whitespace and control limits", () => {
  const valid = documents.isProjectWorkflowName;
  expect(typeof valid).toBe("function");
  for (const name of [
    "Build",
    "Сборка_β.v2",
    "auto",
    "none",
    "a".repeat(180),
    "é".repeat(125),
  ])
    expect(valid(name)).toBe(true);
  for (const name of [
    null,
    1,
    "",
    "-x",
    "../x",
    "a..b",
    "/x",
    "a/b",
    "a\\b",
    "a b",
    "a\t",
    "a\n",
    "a\u00a0b",
    "a\u007f",
    "a\u0085",
    "a\0",
    "a".repeat(181),
    "é".repeat(126),
    "\ud800",
  ])
    expect(valid(name)).toBe(false);
});
it.each(["../x", "a/b", "-x", "a..b", "a b", "a\u007f", "é".repeat(126)])(
  "rejects unsafe workflow target %j before writes",
  async (name) => {
    const { root, host, id } = await setup();
    await expect(
      host.readProjectDocument(id, workflow(name)),
    ).rejects.toThrow();
    await expect(
      host.saveProjectDocument(id, workflow(name), "text", "missing"),
    ).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  },
);
it("invalid text and stale version never create directories", async () => {
  const { root, host, id } = await setup();
  for (const text of ["a\0", "\ud800", "🙂".repeat(300000)])
    await expect(
      host.saveProjectDocument(id, workflow(), text, "missing"),
    ).rejects.toThrow();
  await expect(
    host.saveProjectDocument(id, workflow(), "text", "stale"),
  ).rejects.toThrow();
  expect(await readdir(root)).toEqual([]);
});
it("catalog is immediate only and unsupported entries are disabled", async () => {
  const { host, id, file, root } = await setup();
  await file(".goga/workflows/Valid.yml", "{% if x %}\nx: [\n{% endif %}");
  for (const name of ["wrong.yaml", "upper.YML", "bad name.yml"])
    await file(".goga/workflows/" + name);
  await file(".goga/workflows/nested/hidden.yml");
  await file(".goga/workflows/invalid.yml", Buffer.from([0xc3, 0x28]));
  await file(".goga/workflows/binary.yml", "\0");
  await file(".goga/workflows/large.yml", Buffer.alloc(1024 * 1024 + 1));
  const external = await file("outside.yml", "private");
  await symlink(external, path.join(root, ".goga/workflows/link.yml"));
  await link(external, path.join(root, ".goga/workflows/hard.yml"));
  execFileSync("mkfifo", [path.join(root, ".goga/workflows/pipe.yml")]);
  const list = await host.listProjectWorkflows(id);
  expect(list.filter((entry: any) => entry.editable)).toEqual([
    { name: "Valid", path: ".goga/workflows/Valid.yml", editable: true },
  ]);
  expect(list.some((entry: any) => entry.path.includes("hidden"))).toBe(false);
  for (const entry of list.filter((entry: any) => !entry.editable))
    expect(entry.reason).toEqual(expect.any(String));
  for (const name of ["invalid", "binary", "large", "link", "hard", "pipe"]) {
    await expect(
      host.readProjectDocument(id, workflow(name)),
    ).rejects.toThrow();
    await expect(
      host.saveProjectDocument(id, workflow(name), "changed", "missing"),
    ).rejects.toThrow();
  }
  expect(await readFile(external, "utf8")).toBe("private");
});
it.each(["", ".goga", ".goga/workflows"])(
  "rejects symlink ancestor %j",
  async (relative) => {
    const { host, root, id, file } = await setup();
    await file(".goga/workflows/Build.yml");
    const original = path.join(root, relative),
      moved = original + "-moved";
    await rename(original, moved);
    await symlink(moved, original);
    await expect(host.listProjectWorkflows(id)).rejects.toThrow();
    await expect(host.readProjectDocument(id, workflow())).rejects.toThrow();
    await expect(
      host.saveProjectDocument(id, workflow("New"), "text", "missing"),
    ).rejects.toThrow();
  },
);
it.each([
  ["Build", "build"],
  ["café", "cafe\u0301"],
])("never overwrites case/NFC alias %s via %s", async (original, alias) => {
  const { host, id, file } = await setup();
  const p = await file(`.goga/workflows/${original}.yml`, "original");
  const before = await host.readProjectDocument(id, workflow(original));
  await expect(
    host.saveProjectDocument(id, workflow(alias), "alias", "missing"),
  ).rejects.toThrow();
  await expect(
    host.saveProjectDocument(id, workflow(alias), "alias", before.version),
  ).rejects.toThrow();
  expect(await readFile(p, "utf8")).toBe("original");
});
it("serializes cross-service alias creates while directories are absent", async () => {
  const { host, second, root, id } = await setup();
  const results = await Promise.allSettled([
    host.saveProjectDocument(id, workflow("Build"), "first", "missing"),
    second().saveProjectDocument(id, workflow("build"), "second", "missing"),
  ]);
  expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((x) => x.status === "rejected")).toHaveLength(1);
  expect(await readdir(path.join(root, ".goga/workflows"))).toHaveLength(1);
});
it("detects concurrent updates, external identical-byte replacements and creates", async () => {
  const { host, second, id, file } = await setup();
  const p = await file(".goga/workflows/Build.yml", "original"),
    before = await host.readProjectDocument(id, workflow());
  const results = await Promise.allSettled([
    host.saveProjectDocument(id, workflow(), "first", before.version),
    second().saveProjectDocument(id, workflow(), "second", before.version),
  ]);
  expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  const current = await host.readProjectDocument(id, workflow());
  await writeFile(p + ".replace", current.text);
  await rename(p + ".replace", p);
  await expect(
    host.saveProjectDocument(id, workflow(), "draft", current.version),
  ).rejects.toThrow(/измен/);
  await expect(
    host.saveProjectDocument(id, workflow(), "draft", "missing"),
  ).rejects.toThrow();
  expect(await readFile(p, "utf8")).toBe(current.text);
});
it("reports permission failures without staged leftovers", async () => {
  const { host, id, file } = await setup();
  const p = await file(".goga/workflows/Build.yml", "original"),
    before = await host.readProjectDocument(id, workflow());
  await chmod(path.dirname(p), 0o500);
  try {
    await expect(
      host.saveProjectDocument(id, workflow(), "draft", before.version),
    ).rejects.toThrow();
  } finally {
    await chmod(path.dirname(p), 0o700);
  }
  expect(await readFile(p, "utf8")).toBe("original");
  expect(await readdir(path.dirname(p))).toEqual(["Build.yml"]);
});
it("resolves registered IDs only and preserves config/tool YAML validation", async () => {
  const { host, id, root, file } = await setup();
  await expect(host.listProjectWorkflows(root)).rejects.toThrow(/проект/);
  await expect(host.readProjectDocument(root, workflow())).rejects.toThrow(
    /проект/,
  );
  for (const [target, p] of [
    [{ kind: "config" }, ".goga/config.yml"],
    [
      { kind: "tool", tool: "sample", path: "config.yml" },
      ".goga/tools/sample/config.yml",
    ],
  ] as const) {
    await file(p);
    const doc = await host.readProjectDocument(id, target);
    await expect(
      host.saveProjectDocument(id, target, "a: [", doc.version),
    ).rejects.toThrow(/YAML/);
  }
});
it("discovers a saved workflow and rejects an old real preview before spawn", async () => {
  const { host, id, start } = await setup();
  const request = {
    projectId: id,
    pipeline: "build",
    workflow: "none",
    profile: "",
    skips: [],
  };
  const preview = await host.preview(request);
  await host.saveProjectDocument(
    id,
    workflow("Created"),
    "{% if enabled %}\nx: [\n{% endif %}",
    "missing",
  );
  expect((await host.discover(id)).workflows).toContain("Created");
  expect((host as any).previews.has(preview.token)).toBe(false);
  await expect(
    host.launch({
      ...request,
      previewToken: preview.token,
      clean: false,
      expectedBranch: "main",
      confirmBranchSwitch: false,
      confirmEmptyTask: true,
      task: "",
      topic: { mode: "new", name: "new", baseRef: "main" },
    }),
  ).rejects.toThrow(/Предпросмотр устарел/);
  expect(start).not.toHaveBeenCalled();
});
it("catalog disables uppercase-extension aliases and does not permit changing their lowercase twin", async () => {
  const { host, id, file } = await setup();
  const p = await file(".goga/workflows/Build.YML", "external");
  await expect(
    host.saveProjectDocument(id, workflow("Build"), "draft", "missing"),
  ).rejects.toThrow(/конфликт/);
  expect(
    (await host.listProjectWorkflows(id)).every(
      (entry) => !entry.editable && entry.reason,
    ),
  ).toBe(true);
  expect(await readFile(p, "utf8")).toBe("external");
});
it("rejects non-directory ancestors before creating workflow directories", async () => {
  const { host, id, root } = await setup();
  await writeFile(path.join(root, ".goga"), "not a directory");
  await expect(host.listProjectWorkflows(id)).rejects.toThrow();
  await expect(host.readProjectDocument(id, workflow())).rejects.toThrow();
  await expect(
    host.saveProjectDocument(id, workflow(), "draft", "missing"),
  ).rejects.toThrow();
  expect(await readFile(path.join(root, ".goga"), "utf8")).toBe(
    "not a directory",
  );
});

it("does not clobber an external file created immediately before the atomic create", async () => {
  const { host, root, id } = await setup();
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(link).mockImplementationOnce(async (source, destination) => {
    await actual.writeFile(destination, "external", { flag: "wx" });
    return actual.link(source, destination);
  });
  await expect(
    host.saveProjectDocument(id, workflow(), "draft", "missing"),
  ).rejects.toMatchObject({ code: "EEXIST" });
  expect(
    await readFile(path.join(root, ".goga/workflows/Build.yml"), "utf8"),
  ).toBe("external");
  expect(await readdir(path.join(root, ".goga/workflows"))).toEqual([
    "Build.yml",
  ]);
});
it("launch waits for a pending save and then rejects its invalidated preview before commands or spawn", async () => {
  const { host, id, file, runner, start } = await setup();
  await file(".goga/workflows/Build.yml", "original");
  const request = {
    projectId: id,
    pipeline: "build",
    workflow: "none",
    profile: "",
    skips: [],
  };
  const preview = await host.preview(request);
  const before = await host.readProjectDocument(id, workflow());
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.mocked(rename).mockImplementationOnce(async (source, destination) => {
    entered();
    await blocked;
    return actual.rename(source, destination);
  });
  const save = host.saveProjectDocument(
    id,
    workflow(),
    "changed",
    before.version,
  );
  await reached;
  const commands = vi.mocked(runner.command).mock.calls.length;
  const launch = host.launch({
    ...request,
    previewToken: preview.token,
    clean: false,
    expectedBranch: "main",
    confirmBranchSwitch: false,
    confirmEmptyTask: true,
    task: "",
    topic: { mode: "new", name: "new", baseRef: "main" },
  });
  const rejected = expect(launch).rejects.toThrow(/Предпросмотр устарел/);
  try {
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(vi.mocked(runner.command).mock.calls).toHaveLength(commands);
    expect(start).not.toHaveBeenCalled();
  } finally {
    release();
  }
  await save;
  await rejected;
  expect(start).not.toHaveBeenCalled();
});
it("leaves no workflow directory when guarded .goga creation is not writable", async () => {
  const { host, root, id } = await setup();
  await mkdir(path.join(root, ".goga"));
  expect((await host.readProjectDocument(id, workflow())).exists).toBe(false);
  await chmod(path.join(root, ".goga"), 0o500);
  try {
    await expect(
      host.saveProjectDocument(id, workflow(), "draft", "missing"),
    ).rejects.toThrow();
  } finally {
    await chmod(path.join(root, ".goga"), 0o700);
  }
  expect(await readdir(path.join(root, ".goga"))).toEqual([]);
});
it.for([
  ["Σ", "ς"],
  ["ß", "ss"],
  ["ﬀ", "ff"],
])(
  "rejects filesystem case-fold aliases beyond JavaScript lowercase: %s / %s",
  async ([original, alias], context) => {
    const { host, id, file, root } = await setup();
    const p = await file(`.goga/workflows/${original}.yml`, "original");
    const { lstat } = await import("node:fs/promises");
    try {
      if (
        (await lstat(p)).ino !==
        (await lstat(path.join(root, `.goga/workflows/${alias}.yml`))).ino
      ) {
        context.skip();
        return;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        context.skip();
        return;
      }
      throw error;
    }
    const before = await host.readProjectDocument(id, workflow(original));
    await expect(host.readProjectDocument(id, workflow(alias))).rejects.toThrow(
      /конфликт/,
    );
    await expect(
      host.saveProjectDocument(id, workflow(alias), "draft", before.version),
    ).rejects.toThrow(/конфликт/);
    expect(await readFile(p, "utf8")).toBe("original");
  },
);
it("shares a conservative Unicode alias key without changing source spelling", () => {
  const aliasKey = documents.projectWorkflowAliasKey;
  expect(typeof aliasKey).toBe("function");
  for (const [a, b] of [
    ["Build", "build"],
    ["café", "cafe\u0301"],
    ["Σ", "ς"],
    ["ß", "ss"],
    ["ﬀ", "ff"],
  ])
    expect(aliasKey(a)).toBe(aliasKey(b));
});

it.each(["\u0080", "\u0085", "\u009b"])(
  "rejects workflow C1 control %j on read and disables the catalog entry",
  async (control) => {
    const { host, id, file } = await setup();
    const text = `{% if enabled %}\n# before${control}after\n{% endif %}\n`;
    const p = await file(".goga/workflows/Build.yml", text);
    await expect(host.readProjectDocument(id, workflow())).rejects.toThrow(
      /управляющ/,
    );
    expect(await host.listProjectWorkflows(id)).toEqual([
      {
        name: "Build",
        path: ".goga/workflows/Build.yml",
        editable: false,
        reason: expect.stringMatching(/управляющ/),
      },
    ]);
    expect(await readFile(p, "utf8")).toBe(text);
  },
);
it.each(["\u0080", "\u0085", "\u009b"])(
  "rejects workflow C1 control %j before creating directories",
  async (control) => {
    const { host, id, root } = await setup();
    await expect(
      host.saveProjectDocument(id, workflow(), `# ${control}\n`, "missing"),
    ).rejects.toThrow(/управляющ/);
    expect(await readdir(root)).toEqual([]);
  },
);
it("preserves existing config/tool NEL YAML behavior while workflow C1 is forbidden", async () => {
  const { host, id, file } = await setup();
  const text = "message: 'before\u0085after'\n";
  for (const [target, p] of [
    [{ kind: "config" }, ".goga/config.yml"],
    [
      { kind: "tool", tool: "sample", path: "config.yml" },
      ".goga/tools/sample/config.yml",
    ],
  ] as const) {
    const source = await file(p, text);
    const before = await host.readProjectDocument(id, target);
    expect(before.text).toBe(text);
    const changed = text + "# unchanged compatibility\n";
    expect(
      (await host.saveProjectDocument(id, target, changed, before.version))
        .text,
    ).toBe(changed);
    expect(await readFile(source, "utf8")).toBe(changed);
  }
});

async function fillWorkflowDirectory(root: string, count: number) {
  const directory = path.join(root, ".goga/workflows");
  await mkdir(directory, { recursive: true });
  await Promise.all(
    Array.from({ length: count }, (_, i) =>
      writeFile(path.join(directory, `flow-${i}.yml`), "original"),
    ),
  );
  return directory;
}
it("edits an existing workflow when the catalog contains exactly 2048 entries", async () => {
  const { host, id, root } = await setup();
  const directory = await fillWorkflowDirectory(root, 2048);
  expect(await host.listProjectWorkflows(id)).toHaveLength(2048);
  const target = workflow("flow-0"),
    before = await host.readProjectDocument(id, target);
  expect(
    (await host.saveProjectDocument(id, target, "updated", before.version))
      .text,
  ).toBe("updated");
  expect(await readFile(path.join(directory, "flow-0.yml"), "utf8")).toBe(
    "updated",
  );
  expect(await readdir(directory)).toHaveLength(2048);
}, 20000);
it("rejects creating a 2049th workflow before publishing it and keeps catalog readable", async () => {
  const { host, id, root } = await setup();
  const directory = await fillWorkflowDirectory(root, 2048);
  expect((await host.readProjectDocument(id, workflow("New"))).version).toBe(
    "missing",
  );
  vi.mocked(link).mockClear();
  await expect(
    host.saveProjectDocument(id, workflow("New"), "draft", "missing"),
  ).rejects.toThrow(/лимит/);
  expect(link).not.toHaveBeenCalled();
  expect(await readdir(directory)).toHaveLength(2048);
  expect(await host.listProjectWorkflows(id)).toHaveLength(2048);
}, 20000);
it("counts untrusted staging-lookalike files towards the workflow entry limit", async () => {
  const { host, id, root } = await setup();
  const directory = await fillWorkflowDirectory(root, 2047);
  const untrusted = ".goga-document-attacker.tmp";
  await writeFile(path.join(directory, untrusted), "external");
  vi.mocked(link).mockClear();
  await expect(
    host.saveProjectDocument(id, workflow("New"), "draft", "missing"),
  ).rejects.toThrow(/лимит/);
  expect(link).not.toHaveBeenCalled();
  expect(await readFile(path.join(directory, untrusted), "utf8")).toBe(
    "external",
  );
  expect(await readdir(directory)).toHaveLength(2048);
});

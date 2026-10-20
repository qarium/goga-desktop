import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
  symlink,
  unlink,
  rename,
  link,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { HostService } from "../src/host/service";
import { DesktopStateStore } from "../src/host/desktop-state";
import type { ProjectDocumentTarget } from "../src/shared/project-documents";
// The rename gate below controls scheduling only; every filesystem operation remains real.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const dirs: string[] = [];
const services: HostService[] = [];
afterEach(async () => {
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
const config = { kind: "config" } as const;
const tool = (
  p = "config.yml",
  name = "sample-tool",
): ProjectDocumentTarget => ({ kind: "tool", tool: name, path: p });
async function setup(goga = true) {
  const dir = await mkdtemp("/private/tmp/goga-project-documents-");
  dirs.push(dir);
  const root = path.join(dir, "project"),
    home = path.join(dir, "home"),
    data = path.join(dir, "data");
  await mkdir(root);
  await mkdir(home);
  const state = new DesktopStateStore(home, data);
  await state.addProject({ id: "registered", name: "Synthetic", path: root });
  if (goga)
    await mkdir(path.join(root, ".goga/tools/sample-tool"), {
      recursive: true,
    });
  const host = new HostService({ home, dataDir: data });
  services.push(host);
  const file = async (relative: string, text: string | Buffer = "{}\n") => {
    const p = path.join(root, relative);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, text);
    return p;
  };
  return { dir, root, home, host, file, id: "registered" };
}
it("roundtrips project config exact BOM, CRLF, comments and Unicode bytes without touching home", async () => {
  const { host, id, file, home } = await setup();
  const text =
    '\ufeff# комментарий 🙂\r\ncustom: "quoted: value"\r\nunknown: [true, 42]\r\n';
  const p = await file(".goga/config.yml", text);
  const before = await host.readProjectDocument(id, config);
  expect(before).toMatchObject({
    text,
    exists: true,
    relativePath: ".goga/config.yml",
  });
  const saved = await host.saveProjectDocument(
    id,
    config,
    text + "# ещё\r\n",
    before.version,
  );
  expect(await readFile(p)).toEqual(Buffer.from(saved.text));
  expect(saved.text).toBe(text + "# ещё\r\n");
  expect(await readdir(path.join(home, ".goga"))).toEqual(["desktop"]);
  expect(await readdir(path.dirname(p))).toEqual(["config.yml", "tools"]);
});
it("lists real nested paths with duplicate basenames and roundtrips tool YAML without a shared schema", async () => {
  const { host, id, file } = await setup();
  await file(".goga/tools/sample-tool/a/common.yml", "- one\n- two\n");
  const p = await file(".goga/tools/sample-tool/b/common.yml", "true\n");
  await file(".goga/tools/other-tool/empty.yml", "# empty is valid YAML\n");
  expect(await host.listProjectTools(id)).toEqual([
    {
      name: "other-tool",
      entries: [{ path: "empty.yml", kind: "file", editable: true }],
    },
    {
      name: "sample-tool",
      entries: [
        { path: "a", kind: "directory", editable: false },
        { path: "a/common.yml", kind: "file", editable: true },
        { path: "b", kind: "directory", editable: false },
        { path: "b/common.yml", kind: "file", editable: true },
      ],
    },
  ]);
  const before = await host.readProjectDocument(id, tool("b/common.yml"));
  const text = "# preserve\r\n- string\r\n- 7\r\n";
  await host.saveProjectDocument(
    id,
    tool("b/common.yml"),
    text,
    before.version,
  );
  expect(await readFile(p, "utf8")).toBe(text);
  expect((await host.readProjectDocument(id, tool("a/common.yml"))).text).toBe(
    "- one\n- two\n",
  );
});
it("reads missing config without creating anything and creates only on explicit save", async () => {
  const { host, id, root } = await setup(false);
  const before = await host.readProjectDocument(id, config);
  expect(before).toMatchObject({
    exists: false,
    version: "missing",
    relativePath: ".goga/config.yml",
  });
  expect(await host.listProjectTools(id)).toEqual([]);
  expect(await readdir(root)).toEqual([]);
  await expect(
    host.saveProjectDocument(id, config, "{}\n", before.version),
  ).rejects.toThrow();
  expect(await readdir(root)).toEqual([]);
  await mkdir(path.join(root, ".goga"));
  const saved = await host.saveProjectDocument(
    id,
    config,
    "{}\n",
    before.version,
  );
  expect(saved.exists).toBe(true);
  expect(await readFile(path.join(root, ".goga/config.yml"), "utf8")).toBe(
    "{}\n",
  );
});
it("never creates missing tool files or nested directories", async () => {
  const { host, id, root } = await setup();
  for (const target of [tool(), tool("missing/child.yml")]) {
    await expect(host.readProjectDocument(id, target)).rejects.toThrow();
    await expect(
      host.saveProjectDocument(id, target, "{}", "missing"),
    ).rejects.toThrow();
  }
  expect(await readdir(path.join(root, ".goga/tools/sample-tool"))).toEqual([]);
});
it.each([
  "../outside.yml",
  "/absolute.yml",
  "a/../../outside.yml",
  "a//b.yml",
  "a/./b.yml",
  "./a.yml",
  "a/",
  "",
  "a\\b.yml",
  "a\u0000.yml",
  "a\n.yml",
  "a\u007f.yml",
])("rejects malicious target path %j", async (p) => {
  const { host, id } = await setup();
  await expect(host.readProjectDocument(id, tool(p))).rejects.toThrow();
  await expect(
    host.saveProjectDocument(id, tool(p), "{}", "missing"),
  ).rejects.toThrow();
});
it.each(["../bad", "Bad", "a_b", "a--b", "-a", "", "a/b"])(
  "rejects invalid tool name %j",
  async (name) => {
    const { host, id } = await setup();
    await expect(
      host.readProjectDocument(id, tool("config.yml", name)),
    ).rejects.toThrow();
    await expect(
      host.saveProjectDocument(id, tool("config.yml", name), "{}", "missing"),
    ).rejects.toThrow();
  },
);
it("resolves only registered IDs, rejects malformed targets and ignores injected root", async () => {
  const { host, id, file, dir } = await setup();
  await file(".goga/config.yml", "actual: true\n");
  await expect(host.listProjectTools(dir)).rejects.toThrow(/проект/);
  await expect(host.readProjectDocument(dir, config)).rejects.toThrow(/проект/);
  await expect(
    host.saveProjectDocument(dir, config, "{}", "missing"),
  ).rejects.toThrow(/проект/);
  expect(
    (await host.readProjectDocument(id, { kind: "config", root: dir } as any))
      .text,
  ).toBe("actual: true\n");
  for (const target of [
    null,
    {},
    { kind: "profile" },
    { kind: "tool", path: 7, tool: "sample-tool" },
  ])
    await expect(host.readProjectDocument(id, target as any)).rejects.toThrow();
});
it("exposes unsupported files with reasons and rejects forged edit attempts", async () => {
  const { host, id, file, root } = await setup();
  await file(".goga/tools/sample-tool/readme.md");
  await file(".goga/tools/sample-tool/invalid.yml", Buffer.from([0xc3, 0x28]));
  await file(".goga/tools/sample-tool/binary.yml", "a: \0\n");
  await file(
    ".goga/tools/sample-tool/large.yaml",
    Buffer.alloc(1024 * 1024 + 1, 32),
  );
  await file(".goga/tools/sample-tool/broken.yml", "a: [\n");
  const outside = await file("outside.yml", "private: true\n");
  await symlink(outside, path.join(root, ".goga/tools/sample-tool/link.yml"));
  execFileSync("mkfifo", [path.join(root, ".goga/tools/sample-tool/pipe.yml")]);
  const entries = (await host.listProjectTools(id))[0]!.entries;
  expect(entries.find((e) => e.path === "broken.yml")).toMatchObject({
    editable: true,
  });
  for (const name of [
    "readme.md",
    "invalid.yml",
    "binary.yml",
    "large.yaml",
    "link.yml",
    "pipe.yml",
  ]) {
    expect(entries.find((e) => e.path === name)).toMatchObject({
      kind: "file",
      editable: false,
      reason: expect.any(String),
    });
    await expect(host.readProjectDocument(id, tool(name))).rejects.toThrow();
    await expect(
      host.saveProjectDocument(id, tool(name), "{}", "missing"),
    ).rejects.toThrow();
  }
  expect(await readFile(outside, "utf8")).toBe("private: true\n");
});
it.each(["root", "goga", "tools", "tool", "nested", "leaf"])(
  "rejects symlinks at %s without following them",
  async (level) => {
    const { host, id, root, file } = await setup();
    await file(".goga/tools/sample-tool/nested/file.yml", "{}\n");
    const relative = {
      root: "",
      goga: ".goga",
      tools: ".goga/tools",
      tool: ".goga/tools/sample-tool",
      nested: ".goga/tools/sample-tool/nested",
      leaf: ".goga/tools/sample-tool/nested/file.yml",
    }[level]!;
    const original = path.join(root, relative),
      moved = original + "-moved";
    await rename(original, moved);
    await symlink(moved, original);
    await expect(
      host.readProjectDocument(id, tool("nested/file.yml")),
    ).rejects.toThrow();
    await expect(
      host.saveProjectDocument(id, tool("nested/file.yml"), "{}", "missing"),
    ).rejects.toThrow();
    if (["root", "goga", "tools", "tool"].includes(level))
      await expect(host.listProjectTools(id)).rejects.toThrow();
    else
      expect(
        (await host.listProjectTools(id))[0]!.entries.some((e) => e.reason),
      ).toBe(true);
  },
);
it("rejects hard linked files", async () => {
  const { host, id, root, file } = await setup();
  const outside = await file("outside.yml");
  await link(outside, path.join(root, ".goga/tools/sample-tool/config.yml"));
  await expect(host.readProjectDocument(id, tool())).rejects.toThrow();
  expect((await host.listProjectTools(id))[0]!.entries[0]).toMatchObject({
    editable: false,
    reason: expect.any(String),
  });
});
it("validates YAML mapping for config but allows tool sequences, scalars and YAML streams", async () => {
  const { host, id, file } = await setup();
  await file(".goga/config.yml");
  await file(".goga/tools/sample-tool/config.yml");
  const before = await host.readProjectDocument(id, config);
  for (const text of [
    "a: [",
    "- x\n",
    "true\n",
    "",
    "{}\n---\n{}\n",
    "a: 1\na: 2\n",
    "a: \0",
    "a: \ud800",
    "#".repeat(1024 * 1024 + 1),
  ])
    await expect(
      host.saveProjectDocument(id, config, text, before.version),
    ).rejects.toThrow();
  for (const text of [
    "true\n",
    "- one\n- two\n",
    "# empty\n",
    "---\ntrue\n---\n- x\n",
  ]) {
    const previous = await host.readProjectDocument(id, tool());
    expect(
      (await host.saveProjectDocument(id, tool(), text, previous.version)).text,
    ).toBe(text);
  }
  const previous = await host.readProjectDocument(id, tool());
  await expect(
    host.saveProjectDocument(id, tool(), "a: [", previous.version),
  ).rejects.toThrow();
});
it.each(["edit", "delete", "replace-same-bytes"])(
  "detects external %s without overwriting or recreating",
  async (change) => {
    const { host, id, file } = await setup();
    const p = await file(".goga/config.yml", "old: true\n"),
      before = await host.readProjectDocument(id, config);
    if (change === "edit") await writeFile(p, "external: true\n");
    if (change === "delete") await unlink(p);
    if (change === "replace-same-bytes") {
      await writeFile(p + ".external", before.text);
      await rename(p + ".external", p);
    }
    await expect(
      host.saveProjectDocument(id, config, "draft: true\n", before.version),
    ).rejects.toThrow(/измен|удал/);
    if (change === "delete")
      await expect(readFile(p)).rejects.toMatchObject({ code: "ENOENT" });
    else
      expect(await readFile(p, "utf8")).toBe(
        change === "edit" ? "external: true\n" : before.text,
      );
  },
);
it("serializes concurrent saves per document and does not leave temporary files", async () => {
  const { host, id, file, root } = await setup();
  await file(".goga/config.yml");
  const before = await host.readProjectDocument(id, config);
  const result = await Promise.allSettled([
    host.saveProjectDocument(id, config, "first: true\n", before.version),
    host.saveProjectDocument(id, config, "second: true\n", before.version),
  ]);
  expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(result.filter((r) => r.status === "rejected")).toHaveLength(1);
  const winner = result.find((r) => r.status === "fulfilled")!;
  if (winner.status === "fulfilled")
    expect(await readFile(path.join(root, ".goga/config.yml"), "utf8")).toBe(
      winner.value.text,
    );
  expect(await readdir(path.join(root, ".goga"))).toEqual([
    "config.yml",
    "tools",
  ]);
});
it("reports traversal depth and entry limits rather than silently truncating", async () => {
  const { host, id, root, file } = await setup();
  await file(".goga/tools/sample-tool/" + "nested/".repeat(17) + "file.yml");
  await expect(host.listProjectTools(id)).rejects.toThrow(/глубин|лимит/);
  await rm(path.join(root, ".goga/tools/sample-tool/nested"), {
    recursive: true,
  });
  for (let i = 0; i < 2050; i++)
    await file(`.goga/tools/sample-tool/file-${i}.md`);
  await expect(host.listProjectTools(id)).rejects.toThrow(/числ|лимит/);
});
it("invalidates this project's prepared launches only after a successful document save", async () => {
  const { host, id, file } = await setup();
  await file(".goga/config.yml");
  const before = await host.readProjectDocument(id, config);
  const previews = (host as any).previews as Map<string, any>;
  previews.set("same", { request: { projectId: id } });
  previews.set("other", { request: { projectId: "other" } });
  await expect(
    host.saveProjectDocument(id, config, "a: [", before.version),
  ).rejects.toThrow();
  expect(previews.has("same")).toBe(true);
  await host.saveProjectDocument(id, config, "{}\n", before.version);
  expect(previews.has("same")).toBe(false);
  expect(previews.has("other")).toBe(true);
});
it.each(["C:/x.yml", "a\u0085.yml"])(
  "rejects non-POSIX or control-containing path even when the file exists: %j",
  async (name) => {
    const { host, id, file } = await setup();
    await file(`.goga/tools/sample-tool/${name}`);
    await expect(host.readProjectDocument(id, tool(name))).rejects.toThrow();
  },
);
it("surfaces real read and write permission errors without changing source or leaving temporary files", async () => {
  const { chmod } = await import("node:fs/promises");
  const { host, id, root, file } = await setup();
  const p = await file(".goga/config.yml", "original: true\n"),
    parent = path.dirname(p);
  const before = await host.readProjectDocument(id, config);
  await chmod(p, 0o000);
  try {
    await expect(host.readProjectDocument(id, config)).rejects.toThrow();
  } finally {
    await chmod(p, 0o600);
  }
  const current = await host.readProjectDocument(id, config);
  await chmod(parent, 0o500);
  try {
    await expect(
      host.saveProjectDocument(id, config, "new: true\n", current.version),
    ).rejects.toThrow();
  } finally {
    await chmod(parent, 0o700);
  }
  expect(await readFile(p, "utf8")).toBe(before.text);
  expect(await readdir(path.join(root, ".goga"))).toEqual([
    "config.yml",
    "tools",
  ]);
});
it("keeps catalog and direct host reads/saves aligned at the 255-character tool-name boundary", async () => {
  const { host, id, file } = await setup();
  const name = "a".repeat(255),
    target = tool("nested/config.yml", name);
  const p = await file(`.goga/tools/${name}/nested/config.yml`);
  expect(
    (await host.listProjectTools(id)).find((entry) => entry.name === name)
      ?.entries,
  ).toEqual([
    { path: "nested", kind: "directory", editable: false },
    { path: "nested/config.yml", kind: "file", editable: true },
  ]);
  const before = await host.readProjectDocument(id, target);
  await host.saveProjectDocument(id, target, "exact: true\r\n", before.version);
  expect(await readFile(p, "utf8")).toBe("exact: true\r\n");
  await expect(
    host.readProjectDocument(id, tool("config.yml", "a".repeat(256))),
  ).rejects.toThrow(/Недопустимый путь/);
});

it.for([
  ["File.yml", "file.yml"],
  ["café.yml", "cafe\u0301.yml"],
  ["Nested/File.yml", "nested/file.yml"],
])(
  "serializes filesystem aliases %s / %s before either replacement",
  async ([original, alias], context) => {
    const { host, id, file } = await setup();
    const p = await file(`.goga/tools/sample-tool/${original}`);
    const before = await host.readProjectDocument(id, tool(original));
    let aliasDocument;
    try {
      aliasDocument = await host.readProjectDocument(id, tool(alias));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        context.skip();
        return;
      }
      throw error;
    }
    expect(aliasDocument.version).toBe(before.version);
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    let release!: () => void, entered!: () => void, second!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const secondEntered = new Promise<void>((resolve) => {
      second = resolve;
    });
    let attempts = 0;
    vi.mocked(rename).mockImplementation(async (source, destination) => {
      if (++attempts === 1) entered();
      else second();
      await blocked;
      return actual.rename(source, destination);
    });
    const flights = Promise.allSettled([
      host.saveProjectDocument(
        id,
        tool(original),
        "first: true\n",
        before.version,
      ),
      host.saveProjectDocument(
        id,
        tool(alias),
        "second: true\n",
        before.version,
      ),
    ]);
    let attemptsBeforeRelease = 0;
    try {
      await Promise.race([
        firstEntered,
        new Promise((_, reject) =>
          setTimeout(() => reject(Error("No rename reached")), 2000),
        ),
      ]);
      await Promise.race([
        secondEntered,
        new Promise((resolve) => setTimeout(resolve, 100)),
      ]);
      attemptsBeforeRelease = attempts;
    } finally {
      release();
    }
    const result = await flights;
    vi.mocked(rename).mockImplementation(actual.rename);
    expect(attemptsBeforeRelease).toBe(1);
    expect(attempts).toBe(1);
    expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(result.filter((item) => item.status === "rejected")).toHaveLength(1);
    const saved = result.find((item) => item.status === "fulfilled")!;
    if (saved.status === "fulfilled")
      expect(await readFile(p, "utf8")).toBe(saved.value.text);
  },
);

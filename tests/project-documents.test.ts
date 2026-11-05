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
  stat,
  lstat,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { saveProjectDocument } from "../src/host/project-documents";
import { HostService } from "../src/host/service";
import { DesktopStateStore } from "../src/host/desktop-state";
import type { ProjectDocumentTarget } from "../src/shared/project-documents";
// Scheduling/race gates delegate to real filesystem operations; no safety checks are mocked away.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    link: vi.fn(actual.link),
    lstat: vi.fn(actual.lstat),
  };
});
const dirs: string[] = [];
const services: HostService[] = [];
afterEach(async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(rename).mockImplementation(actual.rename);
  vi.mocked(link).mockImplementation(actual.link);
  vi.mocked(lstat).mockImplementation(actual.lstat);
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
it("keeps missing tool reads strict and never creates missing parent directories or tools", async () => {
  const { host, id, root } = await setup();
  for (const target of [
    tool("missing/child.yml"),
    tool("config.yml", "absent-tool"),
  ]) {
    await expect(host.readProjectDocument(id, target)).rejects.toThrow();
    await expect(
      host.saveProjectDocument(id, target, "{}", "missing"),
    ).rejects.toThrow();
  }
  expect(await readdir(path.join(root, ".goga/tools/sample-tool"))).toEqual([]);
});
it("creates only an explicitly saved missing tool leaf with exact bytes and private mode", async () => {
  const { host, id, root } = await setup();
  const text = "\ufeff# exact 🙂\r\n- quoted: 'value'\r\n";
  await expect(host.readProjectDocument(id, tool())).rejects.toThrow();
  expect(await readdir(path.join(root, ".goga/tools/sample-tool"))).toEqual([]);
  const saved = await host.saveProjectDocument(id, tool(), text, "missing");
  expect(saved).toMatchObject({
    text,
    exists: true,
    relativePath: ".goga/tools/sample-tool/config.yml",
  });
  expect(saved.version).not.toBe("missing");
  const file = path.join(root, saved.relativePath);
  expect(await readFile(file)).toEqual(Buffer.from(text));
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(await readdir(path.dirname(file))).toEqual(["config.yml"]);
});
it("saves a missing nested leaf only inside existing validated directories", async () => {
  const { host, id, root } = await setup();
  await mkdir(path.join(root, ".goga/tools/sample-tool/nested"));
  const saved = await host.saveProjectDocument(
    id,
    tool("nested/new.yaml"),
    "",
    "missing",
  );
  expect(saved).toMatchObject({ text: "", exists: true });
  expect(await readFile(path.join(root, saved.relativePath), "utf8")).toBe("");
  await expect(
    host.saveProjectDocument(
      id,
      tool("nested/absent/child.yml"),
      "",
      "missing",
    ),
  ).rejects.toThrow();
  expect(
    await readdir(path.join(root, ".goga/tools/sample-tool/nested")),
  ).toEqual(["new.yaml"]);
});
it.each([0, 1, 2])(
  "does not overwrite a tool leaf appearing at save guard %s",
  async (appearance) => {
    const { root, file } = await setup();
    const leaf = path.join(root, ".goga/tools/sample-tool/config.yml");
    if (!appearance)
      await file(".goga/tools/sample-tool/config.yml", "external: true\n");
    let guards = 0;
    await expect(
      saveProjectDocument(
        root,
        tool(),
        "draft: true\n",
        "missing",
        async () => {
          if (++guards === appearance)
            await writeFile(leaf, "external: true\n");
        },
      ),
    ).rejects.toThrow(/Конфликт|измен/);
    expect(await readFile(leaf, "utf8")).toBe("external: true\n");
    expect(await readdir(path.dirname(leaf))).toEqual(["config.yml"]);
  },
);
it.each([1, 2])(
  "honors late authority failure at missing tool save guard %s and leaves no artifact",
  async (failure) => {
    const { root } = await setup();
    let guards = 0;
    await expect(
      saveProjectDocument(root, tool(), "true\n", "missing", async () => {
        if (++guards === failure) throw new Error("owner changed");
      }),
    ).rejects.toThrow("owner changed");
    expect(guards).toBe(failure);
    expect(await readdir(path.join(root, ".goga/tools/sample-tool"))).toEqual(
      [],
    );
  },
);
it("rejects a replaced parent identity during missing tool creation without writing to the replacement", async () => {
  const { root } = await setup();
  const parent = path.join(root, ".goga/tools/sample-tool");
  await expect(
    saveProjectDocument(root, tool(), "true\n", "missing", async () => {
      await rename(parent, parent + "-old");
      await mkdir(parent);
    }),
  ).rejects.toThrow(/измен/);
  expect(await readdir(parent)).toEqual([]);
  expect(await readdir(parent + "-old")).toEqual([]);
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
it("a successful document save changes its file version without a launch capability cache", async () => {
  const { host, id, file } = await setup();
  await file(".goga/config.yml");
  const before = await host.readProjectDocument(id, config);
  await expect(
    host.saveProjectDocument(id, config, "a: [", before.version),
  ).rejects.toThrow();
  expect((await host.readProjectDocument(id, config)).version).toBe(
    before.version,
  );
  const saved = await host.saveProjectDocument(
    id,
    config,
    "updated: true\n",
    before.version,
  );
  expect(saved.text).toBe("updated: true\n");
  expect(saved.version).not.toBe(before.version);
  expect((await host.readProjectDocument(id, config)).version).toBe(
    saved.version,
  );
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
    const destinations = new Set([
      p,
      path.join(p.slice(0, -original.length), alias),
    ]);
    vi.mocked(rename).mockImplementation(async (source, destination) => {
      if (
        !path.basename(String(source)).startsWith(".goga-document-") ||
        !destinations.has(String(destination))
      )
        return actual.rename(source, destination);
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

it("uses atomic no-clobber creation if an external tool file appears after the final snapshot", async () => {
  const { root } = await setup();
  const destination = path.join(root, ".goga/tools/sample-tool/config.yml");
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  let attempted = false;
  vi.mocked(link).mockImplementation(async (from, to) => {
    expect(String(to)).toBe(destination);
    attempted = true;
    await writeFile(destination, "external: true\r\n");
    return actual.link(from, to);
  });
  await expect(
    saveProjectDocument(root, tool(), "draft: true\n", "missing"),
  ).rejects.toMatchObject({ code: "EEXIST" });
  expect(attempted).toBe(true);
  expect(await readFile(destination, "utf8")).toBe("external: true\r\n");
  expect(await readdir(path.dirname(destination))).toEqual(["config.yml"]);
});
it("rechecks a queued missing tool leaf's parent identity before starting its save", async () => {
  const { root } = await setup();
  const parent = path.join(root, ".goga/tools/sample-tool");
  let entered!: () => void, release!: () => void;
  const inside = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = saveProjectDocument(
    root,
    tool(),
    "first: true\n",
    "missing",
    async () => {
      entered();
      await gate;
    },
  );
  await inside;
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  let queued!: () => void;
  const snapshotted = new Promise<void>((resolve) => {
    queued = resolve;
  });
  vi.mocked(lstat).mockImplementation((async (file, options) => {
    const result = await actual.lstat(file, options);
    if (String(file) === parent) queued();
    return result;
  }) as typeof lstat);
  const second = saveProjectDocument(
    root,
    tool("second.yml"),
    "second: true\n",
    "missing",
  );
  const results = Promise.allSettled([first, second]);
  // The second promise has captured its queue parent before the replacement.
  await snapshotted;
  await rename(parent, parent + "-old");
  await mkdir(parent);
  release();
  const finished = await results;
  expect(finished.map((result) => result.status)).toEqual([
    "rejected",
    "rejected",
  ]);
  expect(await readdir(parent)).toEqual([]);
  expect(await readdir(parent + "-old")).toEqual([]);
});
it("allows a missing tool leaf beside a symlink without following or changing its sibling", async () => {
  const { root, file } = await setup();
  const outside = await file("outside.yml", "private: true\n");
  await symlink(
    outside,
    path.join(root, ".goga/tools/sample-tool/sibling.yml"),
  );
  const saved = await saveProjectDocument(
    root,
    tool(),
    "new: true\n",
    "missing",
  );
  expect(saved.exists).toBe(true);
  expect(await readFile(outside, "utf8")).toBe("private: true\n");
  expect(await readdir(path.join(root, ".goga/tools/sample-tool"))).toEqual([
    "config.yml",
    "sibling.yml",
  ]);
});
it.each(["bad: [", "bad: \0", "bad: \ud800", "#".repeat(1024 * 1024 + 1)])(
  "rejects invalid new tool source without creating a leaf %#",
  async (text) => {
    const { root } = await setup();
    await expect(
      saveProjectDocument(root, tool(), text, "missing"),
    ).rejects.toThrow();
    expect(await readdir(path.join(root, ".goga/tools/sample-tool"))).toEqual(
      [],
    );
  },
);

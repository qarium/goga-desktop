import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  chmod,
  writeFile,
  readFile,
  symlink,
  link,
  rm,
  stat,
  readdir,
} from "node:fs/promises";
import * as files from "../src/host/project-overview-files";
const roots: string[] = [];
async function setup() {
  const root = await mkdtemp("/private/tmp/goga-overview-files-");
  roots.push(root);
  return root;
}
afterEach(() =>
  Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  ),
);
it("lists dotfiles and folders lazily, not .git internals or symlink targets", async () => {
  const root = await setup();
  await mkdir(root + "/.git");
  await mkdir(root + "/src");
  await writeFile(root + "/.env", "hidden");
  await symlink("/private/tmp", root + "/outside");
  const d = await files.listOverviewDirectory(root, "");
  expect(d.entries.map((e) => e.path)).toEqual(["src", ".env", "outside"]);
  expect(d.entries.find((e) => e.path === "outside")?.kind).toBe("unsupported");
});
it("roundtrips exact source bytes and executable mode without YAML validation or archives", async () => {
  const root = await setup();
  const text = "\ufeffpackage main\r\n// hi\n";
  await writeFile(root + "/main.go", text, { mode: 0o755 });
  const before = await files.readOverviewFile(root, "main.go");
  const saved = await files.saveOverviewFile(
    root,
    "main.go",
    text + "func main() {}\r\n",
    before.version,
  );
  expect(await readFile(root + "/main.go")).toEqual(Buffer.from(saved.text));
  expect((await stat(root + "/main.go")).mode & 0o777).toBe(0o755);
  expect(await readdir(root)).toEqual(["main.go"]);
});
it("rejects traversal, .git, hardlinks, links and external changes without overwriting", async () => {
  const root = await setup();
  await writeFile(root + "/a", "first");
  for (const p of ["../a", "/etc/passwd", ".git/config", "foo/../a", "a\\b"])
    await expect(files.readOverviewFile(root, p)).rejects.toThrow();
  await symlink(root + "/a", root + "/sym");
  await expect(files.readOverviewFile(root, "sym")).rejects.toThrow();
  await link(root + "/a", root + "/hard");
  await expect(files.readOverviewFile(root, "hard")).rejects.toThrow();
  await writeFile(root + "/b", "one");
  const doc = await files.readOverviewFile(root, "b");
  await writeFile(root + "/b", "two");
  await expect(
    files.saveOverviewFile(root, "b", "three", doc.version),
  ).rejects.toThrow(/измен/);
  expect(await readFile(root + "/b", "utf8")).toBe("two");
});
it("creates only explicitly, does not overwrite or create missing parents, and preserves sibling files", async () => {
  const root = await setup();
  await files.createOverviewEntry(root, "src", "directory");
  const created = await files.createOverviewEntry(
    root,
    "src/CODEMANIFEST",
    "file",
    "not: [valid yaml",
  );
  expect(created).toMatchObject({ text: "not: [valid yaml", exists: true });
  await expect(
    files.createOverviewEntry(root, "src/CODEMANIFEST", "file", "lost"),
  ).rejects.toThrow();
  await expect(
    files.createOverviewEntry(root, "missing/nested.txt", "file"),
  ).rejects.toThrow();
  expect(await readFile(root + "/src/CODEMANIFEST", "utf8")).toBe(
    "not: [valid yaml",
  );
});
it("searches relative names without following symlinks or revealing .git and checks mutation guard", async () => {
  const root = await setup();
  await mkdir(root + "/src");
  await mkdir(root + "/.git");
  await writeFile(root + "/src/main.ts", "hi");
  await writeFile(root + "/.git/main.ts", "private");
  await symlink(root + "/src", root + "/linked");
  const found = await files.searchOverviewFiles(root, "", "main");
  expect(found.entries.map((e) => e.path)).toEqual(["src/main.ts"]);
  const before = await files.readOverviewFile(root, "src/main.ts");
  await expect(
    files.saveOverviewFile(
      root,
      "src/main.ts",
      "changed",
      before.version,
      async () => {
        throw Error("owner changed");
      },
    ),
  ).rejects.toThrow("owner changed");
  expect(await readFile(root + "/src/main.ts", "utf8")).toBe("hi");
});
it("refuses binary and oversized content without corrupting bytes", async () => {
  const root = await setup();
  await writeFile(root + "/bin", Buffer.from([0, 1, 2]));
  await writeFile(root + "/large", "x".repeat(1024 * 1024 + 1));
  await expect(files.readOverviewFile(root, "bin")).rejects.toThrow();
  await expect(files.readOverviewFile(root, "large")).rejects.toThrow(/МиБ/);
});
it("binds Host file methods to a registered primary project and refuses unknown owners", async () => {
  const { HostService } = await import("../src/host/service");
  const { DesktopStateStore } = await import("../src/host/desktop-state");
  const root = await setup();
  await mkdir(root + "/home");
  await mkdir(root + "/project");
  const store = new DesktopStateStore(root + "/home", root + "/data");
  await store.addProject({ id: "p", name: "Fixture", path: root + "/project" });
  const host = new HostService({
    home: root + "/home",
    dataDir: root + "/data",
  });
  try {
    await host.createOverviewEntry("p", "a.txt", "file", "one");
    const d = await host.readOverviewFile("p", "a.txt");
    await host.saveOverviewFile("p", "a.txt", "two", d.version);
    expect(await readFile(root + "/project/a.txt", "utf8")).toBe("two");
    await expect(host.readOverviewFile("unknown", "a.txt")).rejects.toThrow();
    await expect(
      host.readOverviewFile(
        { projectId: "p", contextId: "unknown", revision: 1 } as any,
        "a.txt",
      ),
    ).rejects.toThrow();
  } finally {
    await host.dispose();
  }
});

it("preserves existing permissions even under a restrictive current umask", async () => {
  const root = await setup();
  await writeFile(root + "/script", "one");
  await chmod(root + "/script", 0o770);
  const d = await files.readOverviewFile(root, "script");
  const mask = process.umask(0o077);
  try {
    await files.saveOverviewFile(root, "script", "two", d.version);
    expect((await stat(root + "/script")).mode & 0o777).toBe(0o770);
  } finally {
    process.umask(mask);
  }
});
it("refuses a parent swapped by the writer guard before any file replacement", async () => {
  const root = await setup(),
    outside = await setup();
  await mkdir(root + "/dir");
  await writeFile(root + "/dir/a", "owned");
  await writeFile(outside + "/a", "outside");
  const d = await files.readOverviewFile(root, "dir/a");
  const { rename } = await import("node:fs/promises");
  await expect(
    files.saveOverviewFile(root, "dir/a", "lost", d.version, async () => {
      await rename(root + "/dir", root + "/original");
      await symlink(outside, root + "/dir");
    }),
  ).rejects.toThrow();
  expect(await readFile(outside + "/a", "utf8")).toBe("outside");
  expect(await readFile(root + "/original/a", "utf8")).toBe("owned");
});
it("marks a search incomplete when the total entry budget is exhausted", async () => {
  const root = await setup();
  for (let d = 0; d < 20; d++) {
    await mkdir(root + "/d" + d);
    for (let b = 0; b < 10; b++)
      await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          writeFile(root + "/d" + d + "/f" + (b * 50 + i), ""),
        ),
      );
  }
  const result = await files.searchOverviewFiles(root, "", "does-not-exist");
  expect(result.entries).toEqual([]);
  expect(result.truncated).toBe(true);
});

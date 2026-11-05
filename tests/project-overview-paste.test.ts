import { afterEach, expect, it, vi } from "vitest";
import { constants } from "node:fs";
import { open as fsOpen } from "node:fs/promises";
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  lstat,
  chmod,
  link,
  truncate,
  readdir,
  rename,
} from "node:fs/promises";
import path from "node:path";
import * as paste from "../src/host/overview-paste";
const copy = (paste as any).copyOverviewEntries;
const clean: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of clean.splice(0))
    await rm(d, { recursive: true, force: true });
});
async function fixture() {
  expect(copy).toBeTypeOf("function");
  const dir = await mkdtemp("/private/tmp/overview-paste-");
  clean.push(dir);
  const root = path.join(dir, "project"),
    source = path.join(dir, "source");
  await mkdir(root);
  await mkdir(source);
  return {
    root,
    source,
    dir,
    file: async (name: string, bytes: string | Uint8Array = "contents") => {
      const p = path.join(source, name);
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, bytes);
      return p;
    },
  };
}
it("copies directories, raw binary bytes and executable mode without changing sources", async () => {
  const f = await fixture();
  const bytes = new Uint8Array([0, 255, 128, 10, 13, 0]);
  const p = await f.file("nested/bin", bytes);
  await chmod(p, 0o755);
  await mkdir(path.join(f.source, "empty"));
  const result = await copy(f.root, [f.source], "");
  expect(result).toMatchObject({
    status: "done",
    completedPaths: ["source"],
    touchedPaths: ["source"],
  });
  expect(await readFile(path.join(f.root, "source/nested/bin"))).toEqual(
    Buffer.from(bytes),
  );
  expect(
    (await lstat(path.join(f.root, "source/nested/bin"))).mode & 0o777,
  ).toBe(0o755);
  expect(await readdir(path.join(f.root, "source/empty"))).toEqual([]);
  expect(await readFile(p)).toEqual(Buffer.from(bytes));
});
it("deduplicates parent/child selections and keeps independent top-level files", async () => {
  const f = await fixture();
  const a = await f.file("nested/a"),
    b = await f.file("b");
  expect(await copy(f.root, [path.dirname(a), a, b, b], "")).toMatchObject({
    status: "done",
    completedPaths: ["nested", "b"],
  });
});
it("refuses all writes when any destination already exists instead of overwriting or merging", async () => {
  const f = await fixture();
  const a = await f.file("a"),
    b = await f.file("b");
  await writeFile(path.join(f.root, "b"), "keep");
  await expect(copy(f.root, [a, b], "")).rejects.toThrow(/существует/);
  expect(await readFile(path.join(f.root, "b"), "utf8")).toBe("keep");
  await expect(lstat(path.join(f.root, "a"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
it.each([
  "source-link",
  "child-link",
  "destination-link",
  "hardlink",
  "git-tree",
])(
  "rejects unsafe source/destination before creating entries: %s",
  async (kind) => {
    const f = await fixture();
    const a = await f.file("a");
    let sources = [f.source],
      destination = "";
    if (kind === "source-link") {
      await symlink(f.source, path.join(f.dir, "alias"));
      sources = [path.join(f.dir, "alias")];
    }
    if (kind === "child-link") await symlink(a, path.join(f.source, "alias"));
    if (kind === "destination-link") {
      await symlink(f.source, path.join(f.root, "target"));
      destination = "target";
    }
    if (kind === "hardlink") await link(a, path.join(f.source, "alias"));
    if (kind === "git-tree") {
      await mkdir(path.join(f.source, ".git"));
      await writeFile(path.join(f.source, ".git/config"), "protected");
    }
    await expect(copy(f.root, sources, destination)).rejects.toThrow();
    await expect(lstat(path.join(f.root, "source"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);
it("rejects copying a directory into itself or descendant, and paths outside destination scope", async () => {
  const f = await fixture();
  await mkdir(path.join(f.root, "nested"));
  for (const destination of ["", "nested"])
    await expect(copy(f.root, [f.root], destination)).rejects.toThrow();
  for (const destination of ["../outside", "/tmp", ".git"])
    await expect(copy(f.root, [f.source], destination)).rejects.toThrow();
});
it("enforces total-byte and depth limits before writes", async () => {
  const f = await fixture();
  const big = await f.file("large");
  await truncate(big, 256 * 1024 * 1024 + 1);
  await expect(copy(f.root, [big], "")).rejects.toThrow(
    /предел|слишком|лимит/i,
  );
  let p = f.source;
  for (let i = 0; i < 34; i++) {
    p = path.join(p, "d");
    await mkdir(p);
  }
  await expect(copy(f.root, [f.source], "")).rejects.toThrow(
    /предел|слишком|лимит/i,
  );
  expect(await readdir(f.root)).toEqual([]);
});
it("does not follow a source replaced by a symlink after planning", async () => {
  const f = await fixture();
  const a = await f.file("a");
  const other = path.join(f.dir, "other");
  await writeFile(other, "secret");
  let calls = 0;
  const guard = async () => {
    if (++calls === 2) {
      await rm(a);
      await symlink(other, a);
    }
  };
  const result = await copy(f.root, [a], "", guard);
  expect(result.status).not.toBe("done");
  await expect(lstat(path.join(f.root, "a"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(other, "utf8")).toBe("secret");
});
it("reports a partially reserved directory without deleting it or retrying after guard failure", async () => {
  const f = await fixture();
  await f.file("child/a");
  let seen = false;
  const result = await copy(f.root, [f.source], "", async () => {
    try {
      await lstat(path.join(f.root, "source"));
      seen = true;
    } catch {}
    if (seen) throw Error("owner changed");
  });
  expect(result).toMatchObject({
    status: "partial",
    completedPaths: [],
    touchedPaths: ["source"],
  });
  expect((await lstat(path.join(f.root, "source"))).isDirectory()).toBe(true);
});
it("never clobbers a destination that appears after planning", async () => {
  const f = await fixture();
  const a = await f.file("a", "copy");
  let calls = 0;
  const result = await copy(f.root, [a], "", async () => {
    if (++calls === 2) await writeFile(path.join(f.root, "a"), "keep");
  });
  expect(result).toMatchObject({
    status: "not-done",
    completedPaths: [],
    touchedPaths: [],
  });
  expect(await readFile(path.join(f.root, "a"), "utf8")).toBe("keep");
});
it("does not write through a reserved leaf replaced by an external symlink", async () => {
  const f = await fixture();
  const a = await f.file("a", "copy");
  const outside = path.join(f.dir, "outside");
  await writeFile(outside, "keep");
  let replaced = false;
  const result = await copy(f.root, [a], "", async () => {
    if (replaced) return;
    try {
      await lstat(path.join(f.root, "a"));
    } catch {
      return;
    }
    replaced = true;
    await rm(path.join(f.root, "a"));
    await symlink(outside, path.join(f.root, "a"));
  });
  expect(result).toMatchObject({
    status: "uncertain",
    completedPaths: [],
    touchedPaths: ["a"],
  });
  expect(await readFile(outside, "utf8")).toBe("keep");
});

it("opens planned regular sources nonblocking so replacement by a FIFO cannot hang before fstat", async () => {
  const f = await fixture();
  const a = await f.file("a");
  expect(await copy(f.root, [a], "")).toMatchObject({ status: "done" });
  const calls = vi.mocked(fsOpen).mock.calls.filter(([name]) => name === a);
  expect(calls).toHaveLength(1);
  expect(Number(calls[0][1]) & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
  expect(Number(calls[0][1]) & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
});
it("uses the physical destination when checking case aliases of a source descendant", async () => {
  const f = await fixture();
  const source = path.join(f.root, "Folder");
  await mkdir(source);
  await mkdir(path.join(source, "child"));
  await writeFile(path.join(source, "a"), "copy");
  await expect(copy(f.root, [source], "folder/child")).rejects.toThrow();
  expect(await readdir(path.join(source, "child"))).toEqual([]);
});

const prepare = (paste as any).prepareOverviewPaste;
it("prepares mixed files and folders without writes; merges directories and replaces/skips only decided files", async () => {
  const f = await fixture();
  const a = await f.file("a", "new-a"),
    b = await f.file("b", "new-b");
  await f.file("one/same", "new-same");
  await f.file("one/new", "new-child");
  await f.file("two/nested/file", "two");
  await mkdir(path.join(f.root, "one"));
  await writeFile(path.join(f.root, "one/keep"), "unrelated");
  await writeFile(path.join(f.root, "one/same"), "old-same");
  await writeFile(path.join(f.root, "a"), "old-a");
  const prepared = await prepare(
    f.root,
    [
      a,
      b,
      path.join(f.source, "one"),
      path.join(f.source, "two"),
      path.join(f.source, "one/new"),
    ],
    "",
  );
  expect(prepared.conflicts).toEqual([
    { path: "a", replaceable: true },
    { path: "one/same", replaceable: true },
  ]);
  expect(await readdir(f.root)).toEqual(["a", "one"]);
  expect(await readFile(path.join(f.root, "a"), "utf8")).toBe("old-a");
  const result = await prepared.perform([
    { path: "a", action: "skip" },
    { path: "one/same", action: "replace" },
  ]);
  expect(result).toMatchObject({
    status: "done",
    completedPaths: ["b", "one", "two"],
    touchedPaths: ["b", "one", "two"],
  });
  expect(await readFile(path.join(f.root, "a"), "utf8")).toBe("old-a");
  expect(await readFile(path.join(f.root, "b"), "utf8")).toBe("new-b");
  expect(await readFile(path.join(f.root, "one/same"), "utf8")).toBe(
    "new-same",
  );
  expect(await readFile(path.join(f.root, "one/keep"), "utf8")).toBe(
    "unrelated",
  );
  expect(await readFile(path.join(f.root, "two/nested/file"), "utf8")).toBe(
    "two",
  );
});
it("type collisions are skip-only and invalid/incomplete decisions do no writes", async () => {
  const f = await fixture();
  const a = await f.file("a");
  await mkdir(path.join(f.root, "a"));
  const prepared = await prepare(f.root, [a], "");
  expect(prepared.conflicts).toEqual([{ path: "a", replaceable: false }]);
  for (const decisions of [
    [],
    [{ path: "a", action: "replace" }],
    [{ path: "other", action: "skip" }],
    [
      { path: "a", action: "skip" },
      { path: "a", action: "skip" },
    ],
  ])
    await expect(prepared.perform(decisions)).rejects.toThrow();
  expect((await lstat(path.join(f.root, "a"))).isDirectory()).toBe(true);
  expect(await prepared.perform([{ path: "a", action: "skip" }])).toMatchObject(
    { status: "done", completedPaths: [], touchedPaths: [] },
  );
});
it.each(["source", "destination", "new-target"])(
  "rejects captured %s drift before any writes",
  async (kind) => {
    const f = await fixture();
    const a = await f.file("a", "source");
    await writeFile(path.join(f.root, "a"), "keep");
    const b = await f.file("b");
    const prepared = await prepare(f.root, [b, a], "");
    if (kind === "source") await writeFile(a, "changed source");
    if (kind === "destination")
      await writeFile(path.join(f.root, "a"), "changed target");
    if (kind === "new-target")
      await writeFile(path.join(f.root, "b"), "appeared");
    expect(
      await prepared.perform([{ path: "a", action: "replace" }]),
    ).toMatchObject({
      status: "not-done",
      completedPaths: [],
      touchedPaths: [],
    });
    expect(await readFile(path.join(f.root, "a"), "utf8")).toBe(
      kind === "destination" ? "changed target" : "keep",
    );
    if (kind !== "new-target")
      await expect(lstat(path.join(f.root, "b"))).rejects.toMatchObject({
        code: "ENOENT",
      });
  },
);
it("replacement stages complete bytes before fresh target validation, and preserves a raced target", async () => {
  const f = await fixture();
  const a = await f.file("a", "new".repeat(40000));
  await writeFile(path.join(f.root, "a"), "old");
  const prepared = await prepare(f.root, [a], "");
  let staged = false;
  const result = await prepared.perform(
    [{ path: "a", action: "replace" }],
    async () => {
      if (
        staged ||
        !(await readdir(f.root)).some((name) => name.startsWith(".goga-paste-"))
      )
        return;
      staged = true;
      await writeFile(path.join(f.root, "a"), "foreign");
    },
  );
  expect(staged).toBe(true);
  expect(result).toMatchObject({ status: "not-done", touchedPaths: [] });
  expect(await readdir(f.root)).toEqual(["a"]);
  expect(await readFile(path.join(f.root, "a"), "utf8")).toBe("foreign");
});
it("refuses self files, unsafe merge targets and source links during preparation", async () => {
  const f = await fixture();
  const a = await f.file("a");
  await writeFile(path.join(f.root, "own"), "self");
  await expect(
    prepare(f.root, [path.join(f.root, "own")], ""),
  ).rejects.toThrow();
  await symlink(a, path.join(f.root, "a"));
  await expect(prepare(f.root, [a], "")).rejects.toThrow();
  await rm(path.join(f.root, "a"));
  await link(a, path.join(f.root, "a"));
  await expect(prepare(f.root, [a], "")).rejects.toThrow();
});
it("reports partial mutation after captured guard failure without rollback or copying the next root", async () => {
  const f = await fixture();
  await f.file("folder/a");
  const b = await f.file("b");
  const prepared = await prepare(
    f.root,
    [path.join(f.source, "folder"), b],
    "",
  );
  const result = await prepared.perform([], async () => {
    if ((await readdir(f.root)).includes("folder"))
      throw Error("owner changed");
  });
  expect(result).toMatchObject({
    status: "partial",
    completedPaths: [],
    touchedPaths: ["folder"],
  });
  expect((await lstat(path.join(f.root, "folder"))).isDirectory()).toBe(true);
  await expect(lstat(path.join(f.root, "b"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
it("does not publish staged bytes changed by an external writer after sealing", async () => {
  const f = await fixture();
  const a = await f.file("a", "");
  await writeFile(path.join(f.root, "a"), "keep");
  const prepared = await prepare(f.root, [a], "");
  let tampered = false;
  const result = await prepared.perform(
    [{ path: "a", action: "replace" }],
    async () => {
      const staged = (await readdir(f.root)).find((name) =>
        name.startsWith(".goga-paste-"),
      );
      if (staged && !tampered) {
        tampered = true;
        await writeFile(path.join(f.root, staged), "foreign");
      }
    },
  );
  expect(tampered).toBe(true);
  expect(result.status).not.toBe("done");
  expect(await readFile(path.join(f.root, "a"), "utf8")).toBe("keep");
});
it("does not follow a replaced destination ancestor when executing a captured merge", async () => {
  const f = await fixture();
  await f.file("folder/a");
  await mkdir(path.join(f.root, "folder"));
  const other = path.join(f.dir, "other");
  await mkdir(other);
  const prepared = await prepare(f.root, [path.join(f.source, "folder")], "");
  await rm(path.join(f.root, "folder"), { recursive: true });
  await symlink(other, path.join(f.root, "folder"));
  expect(await prepared.perform([])).toMatchObject({
    status: "not-done",
    touchedPaths: [],
  });
  expect(await readdir(other)).toEqual([]);
});
it("keeps all new-API bounds and rejects service Git paths before any mutation", async () => {
  const f = await fixture();
  const big = await f.file("large");
  await truncate(big, 256 * 1024 * 1024 + 1);
  await expect(prepare(f.root, [big], "")).rejects.toThrow(
    /предел|слишком|лимит/i,
  );
  await expect(prepare(f.root, Array(129).fill(big), "")).rejects.toThrow();
  await mkdir(path.join(f.source, ".git"));
  await writeFile(path.join(f.source, ".git/config"), "keep");
  await expect(prepare(f.root, [f.source], "")).rejects.toThrow();
  expect(await readdir(f.root)).toEqual([]);
});
it.each(["target-root", "merge-directory"])(
  "allows unrelated destination changes during confirmation (%s)",
  async (kind) => {
    const f = await fixture();
    const nested = kind === "merge-directory";
    const a = await f.file(nested ? "folder/a" : "a", "new");
    const parent = nested ? path.join(f.root, "folder") : f.root;
    if (nested) await mkdir(parent);
    await writeFile(path.join(parent, "a"), "old");
    const prepared = await prepare(f.root, [nested ? path.dirname(a) : a], "");
    await writeFile(path.join(parent, "unrelated"), "keep");
    const relative = nested ? "folder/a" : "a";
    expect(
      await prepared.perform([{ path: relative, action: "replace" }]),
    ).toMatchObject({ status: "done" });
    expect(await readFile(path.join(parent, "a"), "utf8")).toBe("new");
    expect(await readFile(path.join(parent, "unrelated"), "utf8")).toBe("keep");
  },
);
it("rejects a changed destination directory mode but not its unrelated contents", async () => {
  const f = await fixture();
  const a = await f.file("a");
  const prepared = await prepare(f.root, [a], "");
  const mode = (await lstat(f.root)).mode & 0o777;
  await chmod(f.root, mode === 0o700 ? 0o755 : 0o700);
  expect(await prepared.perform([])).toMatchObject({
    status: "not-done",
    touchedPaths: [],
  });
  await expect(lstat(path.join(f.root, "a"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
it("reports and retains an unverified partial stage after a mid-write guard failure, without retry", async () => {
  const f = await fixture();
  const a = await f.file("a", "data".repeat(40000));
  await writeFile(path.join(f.root, "a"), "keep");
  const prepared = await prepare(f.root, [a], "");
  let stage = "",
    failures = 0;
  const result = await prepared.perform(
    [{ path: "a", action: "replace" }],
    async () => {
      const name = (await readdir(f.root)).find((name) =>
        name.startsWith(".goga-paste-"),
      );
      if (name && (await lstat(path.join(f.root, name))).size > 0) {
        stage = name;
        failures++;
        throw Error("owner changed");
      }
    },
  );
  expect(failures).toBe(1);
  expect(result).toMatchObject({
    status: "uncertain",
    completedPaths: [],
    touchedPaths: ["a"],
  });
  expect(stage).not.toBe("");
  expect((await lstat(path.join(f.root, stage))).size).toBeGreaterThan(0);
  expect(await readFile(path.join(f.root, "a"), "utf8")).toBe("keep");
  expect(result.message).toContain(stage);
});
it("reports a successfully reserved stage when its first descriptor stat fails, without deleting unknown data", async () => {
  const f = await fixture();
  const a = await f.file("a", "new");
  await writeFile(path.join(f.root, "a"), "keep");
  const prepared = await prepare(f.root, [a], "");
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const previous = vi.mocked(fsOpen).getMockImplementation()!;
  let stage = "";
  vi.mocked(fsOpen).mockImplementation(
    async (...args: Parameters<typeof fsOpen>) => {
      const handle = await actual.open(...args);
      if (String(args[0]).includes(".goga-paste-")) {
        stage = path.basename(String(args[0]));
        vi.spyOn(handle, "stat").mockRejectedValueOnce(
          Error("stat reservation failed"),
        );
      }
      return handle;
    },
  );
  let result;
  try {
    result = await prepared.perform([{ path: "a", action: "replace" }]);
  } finally {
    vi.mocked(fsOpen).mockImplementation(previous);
  }
  expect(result).toMatchObject({
    status: "uncertain",
    completedPaths: [],
    touchedPaths: ["a"],
  });
  expect(stage).not.toBe("");
  expect(result.message).toContain(stage);
  expect((await lstat(path.join(f.root, stage))).isFile()).toBe(true);
  expect(await readFile(path.join(f.root, "a"), "utf8")).toBe("keep");
});

it("does not mistake a vanished stage ancestor for confirmed cleanup after partial mutation", async () => {
  const f = await fixture();
  const a = await f.file("a", "data".repeat(40000));
  const target = path.join(f.root, "target"),
    moved = path.join(f.root, "moved");
  await mkdir(target);
  await writeFile(path.join(target, "a"), "keep");
  const prepared = await prepare(f.root, [a], "target");
  let stage = "";
  const result = await prepared.perform(
    [{ path: "target/a", action: "replace" }],
    async () => {
      const name = (await readdir(target)).find((name) =>
        name.startsWith(".goga-paste-"),
      );
      if (name && (await lstat(path.join(target, name))).size > 0) {
        stage = name;
        await rename(target, moved);
        throw Error("owner changed");
      }
    },
  );
  expect(result).toMatchObject({
    status: "uncertain",
    touchedPaths: ["target/a"],
  });
  expect(stage).not.toBe("");
  expect(result.message).toContain(stage);
  expect((await lstat(path.join(moved, stage))).size).toBeGreaterThan(0);
  expect(await readFile(path.join(moved, "a"), "utf8")).toBe("keep");
});

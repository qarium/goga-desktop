import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readdir,
  symlink,
  link,
  lstat,
  rename,
  open,
} from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { HostService } from "../src/host/service";
import { NodeRunner } from "../src/host/process";
import { DesktopStateStore } from "../src/host/desktop-state";
import { CloneManager } from "../src/host/clones";
import { worktreeContextRef } from "../src/shared/worktrees";
import { withReadScope } from "../src/host/read-scope";
import { withHistoryRead } from "../src/host/history";
import { childEnvironment } from "../src/host/process-environment";
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) };
});
const gitGate = vi.hoisted(() => ({
  after: undefined as undefined | ((args: string[]) => Promise<void>),
  calls: [] as { args: string[]; options: any }[],
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const wrapped = vi.fn(
    (exe: string, args: string[], options: any, callback: Function) => {
      gitGate.calls.push({ args, options });
      return actual.execFile(exe, args, options, (error, stdout, stderr) => {
        Promise.resolve()
          .then(() => gitGate.after?.(args))
          .then(
            () => callback(error, stdout, stderr),
            (failure) => callback(failure, stdout, stderr),
          );
      });
    },
  );
  Object.assign(wrapped, {
    [Symbol.for("nodejs.util.promisify.custom")]: (
      exe: string,
      args: string[],
      options: any,
    ) =>
      new Promise((resolve, reject) =>
        wrapped(
          exe,
          args,
          options,
          (error: unknown, stdout: Buffer, stderr: Buffer) =>
            error ? reject(error) : resolve({ stdout, stderr }),
        ),
      ),
  });
  return { ...actual, execFile: wrapped };
});
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  gitGate.after = undefined;
  gitGate.calls.length = 0;
  const fs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(lstat).mockImplementation(fs.lstat);
  vi.mocked(open).mockImplementation(fs.open);
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const target = { topic: "feature-test", branch: "feature/test", remote: false };
async function fixture(gitRepo = false) {
  const dir = await mkdtemp("/private/tmp/goga-history-");
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "repo"),
    home = path.join(dir, "home"),
    dataDir = path.join(dir, "data");
  await mkdir(root);
  await mkdir(home);
  const state = new DesktopStateStore(home, dataDir);
  const project = { id: "registered", name: "Fixture", path: root };
  await state.addProject(project);
  const env = {
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      env: { ...process.env, ...env },
      encoding: "utf8",
    }).trim();
  const runner = new NodeRunner(30000, env);
  const host = new HostService({
    home,
    dataDir,
    runner,
    goga: "/nonexistent/disabled",
  });
  cleanup.push(() => host.dispose());
  const file = async (relative: string, value: string | Buffer = "text") => {
    const name = path.join(root, relative);
    await mkdir(path.dirname(name), { recursive: true });
    await writeFile(name, value);
    return name;
  };
  if (gitRepo) {
    git("init", "-b", target.branch);
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
  }
  return {
    root,
    home,
    host,
    project,
    file,
    git,
    manager: new CloneManager(home, runner),
    id: project.id,
  };
}
const base = ".goga/history/2026/feature-test";
it("lists absent history without creating directories, then sorted years, entries and nested artifacts", async () => {
  const f = await fixture();
  expect(await f.host.listHistoryYears(f.id)).toEqual([]);
  expect(await readdir(f.root)).toEqual([]);
  await f.file(`${base}/z.txt`, "plain");
  await f.file(`${base}/nested/a.MARKDOWN`, "# report");
  await f.file(".goga/history/2025/older/a.md");
  await f.file(".goga/history/2026/alpha/a.md");
  await f.file(".goga/history/not-year/hidden/a.md");
  expect(await f.host.listHistoryYears(f.id)).toEqual(["2026", "2025"]);
  expect(await f.host.listHistoryEntries(f.id, "2026")).toEqual([
    "alpha",
    "feature-test",
  ]);
  expect(await f.host.listHistoryArtifacts(f.id, "2026", target.topic)).toEqual(
    [
      { path: "nested", kind: "directory", readable: false },
      { path: "nested/a.MARKDOWN", kind: "file", readable: true, size: 8 },
      { path: "z.txt", kind: "file", readable: true, size: 5 },
    ],
  );
  expect(
    await f.host.readHistoryArtifact(
      f.id,
      "2026",
      target.topic,
      "nested/a.MARKDOWN",
    ),
  ).toEqual({
    relativePath: `${base}/nested/a.MARKDOWN`,
    text: "# report",
    format: "markdown",
  });
  expect(
    (await f.host.readHistoryArtifact(f.id, "2026", target.topic, "z.txt"))
      .format,
  ).toBe("text");
  expect(await f.host.listHistoryEntries(f.id, "2024")).toEqual([]);
});
it("rejects unsafe names and traversal at the host boundary", async () => {
  const f = await fixture();
  for (const year of ["../2026", "2026/", "20", "2026\0"])
    await expect(f.host.listHistoryEntries(f.id, year)).rejects.toThrow();
  for (const entry of ["..", ".", "x/y", "x\\y", "x\0", ""])
    await expect(
      f.host.listHistoryArtifacts(f.id, "2026", entry),
    ).rejects.toThrow();
  for (const name of [
    "../x",
    "/etc/passwd",
    "a/../../x",
    "a\\x",
    "./x",
    "a//x",
    "x\0",
    "",
  ])
    await expect(
      f.host.readHistoryArtifact(f.id, "2026", target.topic, name),
    ).rejects.toThrow();
});
it("lists metadata restrictions and validates unknown binary or UTF-8 only on open", async () => {
  const f = await fixture();
  await f.file(`${base}/image.png`, "even if ASCII");
  await f.file(`${base}/binary.txt`, Buffer.from([0]));
  await f.file(`${base}/invalid.txt`, Buffer.from([0xff]));
  await f.file(`${base}/control.txt`, "\u0085");
  await f.file(`${base}/large.txt`, Buffer.alloc(1024 * 1024 + 1, 65));
  const outside = await f.file("outside", "private");
  await link(outside, path.join(f.root, base, "hard.txt"));
  await symlink(outside, path.join(f.root, base, "link.txt"));
  execFileSync("mkfifo", [path.join(f.root, base, "pipe")]);
  const list = await f.host.listHistoryArtifacts(f.id, "2026", target.topic);
  expect(list).toHaveLength(8);
  for (const row of list) {
    const deferred = ["binary.txt", "invalid.txt", "control.txt"].includes(
      row.path,
    );
    expect(row.readable).toBe(deferred);
    if (deferred) expect(row.reason).toBeUndefined();
    else expect(row.reason).toBeTruthy();
    await expect(
      f.host.readHistoryArtifact(f.id, "2026", target.topic, row.path),
    ).rejects.toThrow();
  }
});
it("rejects symlink directories and canonical-root substitution, but lists an empty entry", async () => {
  const f = await fixture();
  await mkdir(path.join(f.root, base), { recursive: true });
  expect(await f.host.listHistoryArtifacts(f.id, "2026", target.topic)).toEqual(
    [],
  );
  await rename(
    path.join(f.root, ".goga/history"),
    path.join(f.root, "elsewhere"),
  );
  await symlink(
    path.join(f.root, "elsewhere"),
    path.join(f.root, ".goga/history"),
  );
  await expect(f.host.listHistoryYears(f.id)).rejects.toThrow();
});
it("rejects a late file replacement and cancellation without publishing stale content", async () => {
  const f = await fixture();
  const name = await f.file(`${base}/todo.md`, "before");
  const fs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  let changed = false;
  vi.mocked(open).mockImplementation(
    async (...args: Parameters<typeof open>) => {
      const handle = await fs.open(...args);
      if (String(args[0]) === name && !changed) {
        changed = true;
        await rename(name, name + ".old");
        await writeFile(name, "after!");
      }
      return handle;
    },
  );
  await expect(
    f.host.readHistoryArtifact(f.id, "2026", target.topic, "todo.md"),
  ).rejects.toThrow(/измен/);
  vi.mocked(open).mockImplementation(fs.open);
  const controller = new AbortController();
  vi.mocked(lstat).mockImplementation(
    async (...args: Parameters<typeof lstat>) => {
      const value = await fs.lstat(...args);
      if (String(args[0]) === name) controller.abort();
      return value;
    },
  );
  await expect(
    withReadScope(controller.signal, () =>
      f.host.readHistoryArtifact(f.id, "2026", target.topic, "todo.md"),
    ),
  ).rejects.toThrow(/отмен/);
});
it("bounds artifact count and depth", async () => {
  const f = await fixture();
  await mkdir(path.join(f.root, base), { recursive: true });
  await Promise.all(
    Array.from({ length: 2049 }, (_, i) => f.file(`${base}/${i}.txt`)),
  );
  await expect(
    f.host.listHistoryArtifacts(f.id, "2026", target.topic),
  ).rejects.toThrow(/лимит|слишком|2048/);
  await rm(path.join(f.root, base), { recursive: true });
  await f.file(`${base}/${Array(17).fill("d").join("/")}/x.txt`);
  await expect(
    f.host.listHistoryArtifacts(f.id, "2026", target.topic),
  ).rejects.toThrow(/глубин|16/);
});
it("reads exact local and remote commits without checkout or clone creation, never primary dirty files", async () => {
  const f = await fixture(true);
  await f.file(`${base}/todo.md`, "committed");
  await f.file(`${base}/sub/report.txt`, "branch artifact");
  f.git("add", ".");
  f.git("commit", "-m", "fixture");
  f.git("update-ref", "refs/remotes/origin/feature/test", "HEAD");
  f.git("switch", "-c", "main");
  await f.file(`${base}/todo.md`, "primary dirty");
  const head = f.git("rev-parse", "HEAD"),
    branch = f.git("branch", "--show-current");
  expect(
    (
      await f.host.readHistoryArtifact(
        f.id,
        "2026",
        target.topic,
        "todo.md",
        target,
      )
    ).text,
  ).toBe("committed");
  expect(
    (await f.host.readHistoryArtifact(f.id, "2026", target.topic, "todo.md"))
      .text,
  ).toBe("primary dirty");
  expect(
    (
      await f.host.listHistoryArtifacts(f.id, "2026", target.topic, {
        ...target,
        branch: "origin/feature/test",
        remote: true,
      })
    ).map((r) => r.path),
  ).toEqual(["sub", "sub/report.txt", "todo.md"]);
  expect(f.git("rev-parse", "HEAD")).toBe(head);
  expect(f.git("branch", "--show-current")).toBe(branch);
  expect(await f.manager.list(f.id)).toEqual([]);
  await expect(
    f.host.listHistoryArtifacts(f.id, "2026", "different", target),
  ).rejects.toThrow();
  await expect(
    f.host.listHistoryArtifacts(f.id, "2026", target.topic, {
      ...target,
      branch: "missing",
    }),
  ).rejects.toThrow();
});
it("isolates clone working history and refuses wrong, stale or missing owners and primary fallback", async () => {
  const f = await fixture(true);
  await f.file(`${base}/todo.md`, "primary");
  f.git("add", ".");
  f.git("commit", "-m", "fixture");
  const owner = await f.manager.ensure(f.project, {
    projectId: f.id,
    year: "2026",
    topic: target.topic,
    branch: target.branch,
  });
  const ref = worktreeContextRef(owner);
  await writeFile(path.join(owner.path, base, "todo.md"), "clone working");
  expect(
    (
      await f.host.readHistoryArtifact(
        ref,
        "2026",
        target.topic,
        "todo.md",
        target,
      )
    ).text,
  ).toBe("clone working");
  expect(
    (await f.host.readHistoryArtifact(ref, "2026", target.topic, "todo.md"))
      .text,
  ).toBe("clone working");
  expect(
    (await f.host.readHistoryArtifact(f.id, "2026", target.topic, "todo.md"))
      .text,
  ).toBe("primary");
  await expect(
    f.host.readHistoryArtifact(f.id, "2026", target.topic, "todo.md", target),
  ).rejects.toThrow(/контекст|копи/);
  await expect(
    f.host.listHistoryArtifacts(ref, "2025", target.topic, target),
  ).rejects.toThrow();
  await expect(
    f.host.listHistoryArtifacts(ref, "2026", target.topic, {
      ...target,
      branch: "wrong",
    }),
  ).rejects.toThrow();
  await expect(
    f.host.listHistoryArtifacts(
      { ...ref, revision: randomUUID() },
      "2026",
      target.topic,
    ),
  ).rejects.toThrow();
  await rm(owner.path, { recursive: true });
  await expect(
    f.host.listHistoryArtifacts(ref, "2026", target.topic, target),
  ).rejects.toThrow();
  await expect(
    f.host.listHistoryArtifacts(f.id, "2026", target.topic, target),
  ).rejects.toThrow();
}, 30000);

it("accepts an empty directory at the maximum depth", async () => {
  const f = await fixture();
  await mkdir(path.join(f.root, base, ...Array(16).fill("d")), {
    recursive: true,
  });
  expect(
    await f.host.listHistoryArtifacts(f.id, "2026", target.topic),
  ).toHaveLength(16);
});
it("counts unsafe hidden names against the whole-tree limit", async () => {
  const f = await fixture();
  await Promise.all(
    Array.from({ length: 2050 }, (_, i) =>
      f.file(`${base}/${i < 1025 ? "a" : "b"}/${i}\n.txt`),
    ),
  );
  await expect(
    f.host.listHistoryArtifacts(f.id, "2026", target.topic),
  ).rejects.toThrow(/лимит|2048/);
});
it.each(["branch", "cancel", "owner"] as const)(
  "rejects committed history after late %s change",
  async (kind) => {
    const f = await fixture(true);
    await f.file(`${base}/todo.md`, "committed");
    f.git("add", ".");
    f.git("commit", "-m", "fixture");
    const controller = new AbortController();
    // A concurrent lifecycle operation is a separate request, not a child of
    // the History read. Register its continuation before entering read scope.
    let startOwner!: () => void;
    const ownerReady =
      kind === "owner"
        ? new Promise<void>((resolve) => {
            startOwner = resolve;
          }).then(() =>
            f.manager.ensure(f.project, {
              projectId: f.id,
              year: "2026",
              topic: target.topic,
              branch: target.branch,
            }),
          )
        : undefined;
    let fired = false;
    gitGate.after = async (args) => {
      if (!fired && args.includes("cat-file")) {
        fired = true;
        if (kind === "branch")
          f.git("commit", "--allow-empty", "-m", "changed");
        else if (kind === "cancel") controller.abort();
        else {
          startOwner();
          await ownerReady;
        }
      }
    };
    await expect(
      withReadScope(controller.signal, () =>
        f.host.readHistoryArtifact(
          f.id,
          "2026",
          target.topic,
          "todo.md",
          target,
        ),
      ),
    ).rejects.toThrow(
      kind === "cancel"
        ? /отмен/
        : kind === "owner"
          ? /контекст|копи/
          : /измен/,
    );
    expect(fired).toBe(true);
    for (const call of gitGate.calls) {
      expect(call.options.timeout).toBe(30000);
      expect(call.options.maxBuffer).toBeLessThanOrEqual(1024 * 1024 + 1);
      expect(call.options.signal).toBeInstanceOf(AbortSignal);
      expect(call.args).not.toEqual(expect.arrayContaining(["checkout"]));
    }
  },
  30000,
);
it("rejects symlink and gitlink blobs in committed history and flags binary/large files", async () => {
  const f = await fixture(true);
  await f.file(`${base}/todo.md`, "committed");
  await f.file(`${base}/image.jpg`, "ascii");
  await f.file(`${base}/raw.txt`, Buffer.from([0xff]));
  await f.file(`${base}/large.txt`, Buffer.alloc(1024 * 1024 + 1, 65));
  await symlink("../../../../secret", path.join(f.root, base, "linked.md"));
  f.git("add", ".");
  f.git("commit", "-m", "fixture");
  f.git(
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${f.git("rev-parse", "HEAD")},${base}/submodule`,
  );
  f.git("commit", "-m", "gitlink");
  const rows = await f.host.listHistoryArtifacts(
    f.id,
    "2026",
    target.topic,
    target,
  );
  expect(rows.find((row) => row.path === "todo.md")?.readable).toBe(true);
  for (const name of [
    "linked.md",
    "submodule",
    "image.jpg",
    "raw.txt",
    "large.txt",
  ]) {
    expect(rows.find((row) => row.path === name)).toMatchObject(
      name === "raw.txt"
        ? { readable: true }
        : { readable: false, reason: expect.any(String) },
    );
    await expect(
      f.host.readHistoryArtifact(f.id, "2026", target.topic, name, target),
    ).rejects.toThrow();
  }
});
it("does not re-stat every earlier sibling for each file in a history tree", async () => {
  const f = await fixture();
  await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      f.file(`${base}/${String(i).padStart(3, "0")}.txt`, "text"),
    ),
  );
  vi.mocked(lstat).mockClear();
  expect(
    await f.host.listHistoryArtifacts(f.id, "2026", target.topic),
  ).toHaveLength(100);
  const first = path.join(f.root, base, "000.txt");
  expect(
    vi.mocked(lstat).mock.calls.filter(([file]) => String(file) === first)
      .length,
  ).toBeLessThanOrEqual(8);
});

it("lists both filesystem and committed trees from metadata without opening files or reading blobs", async () => {
  const f = await fixture(true);
  await f.file(`${base}/todo.md`, "committed");
  await f.file(`${base}/sub/result.txt`, "text");
  f.git("add", ".");
  f.git("commit", "-m", "fixture");
  vi.mocked(open).mockClear();
  gitGate.calls.length = 0;
  expect(
    await f.host.listHistoryArtifacts(f.id, "2026", target.topic),
  ).toHaveLength(3);
  expect(
    vi
      .mocked(open)
      .mock.calls.some(([file]) =>
        String(file).startsWith(path.join(f.root, base)),
      ),
  ).toBe(false);
  expect(
    await f.host.listHistoryArtifacts(f.id, "2026", target.topic, target),
  ).toHaveLength(3);
  expect(gitGate.calls.some((call) => call.args.includes("cat-file"))).toBe(
    false,
  );
});

it("forces offline read-only Git policy over inherited environment for every history command", async () => {
  const f = await fixture(true);
  await f.file(`${base}/todo.md`, "committed");
  f.git("add", ".");
  f.git("commit", "-m", "fixture");
  vi.stubEnv("GIT_NO_LAZY_FETCH", "0");
  vi.stubEnv("GIT_ALLOW_PROTOCOL", "https:ssh:file");
  gitGate.calls.length = 0;
  await f.host.listHistoryArtifacts(f.id, "2026", target.topic, target);
  await f.host.readHistoryArtifact(
    f.id,
    "2026",
    target.topic,
    "todo.md",
    target,
  );
  expect(gitGate.calls.some((call) => call.args.includes("ls-tree"))).toBe(
    true,
  );
  expect(gitGate.calls.some((call) => call.args.includes("cat-file"))).toBe(
    true,
  );
  for (const { options } of gitGate.calls) {
    expect(options.env.GIT_NO_LAZY_FETCH).toBe("1");
    expect(options.env.GIT_ALLOW_PROTOCOL).toBe("");
  }
});

it("keeps the History offline child policy request-local and overrides runner environments", async () => {
  const unsafe = {
    GIT_NO_LAZY_FETCH: "0",
    GIT_ALLOW_PROTOCOL: "file:https:ssh",
  };
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scoped = withHistoryRead(async () => {
    await pending;
    return childEnvironment(unsafe, unsafe, unsafe);
  });
  expect(childEnvironment(unsafe, unsafe, unsafe)).toMatchObject(unsafe);
  release();
  expect(await scoped).toMatchObject({
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "",
  });
  expect(childEnvironment(unsafe, unsafe, unsafe)).toMatchObject(unsafe);
});
it("never lazy-fetches missing managed-clone objects while resolving History ownership", async () => {
  const f = await fixture(true);
  await f.file(`${base}/todo.md`, "fixture");
  f.git("add", ".");
  f.git("commit", "-m", "fixture");
  const owner = await f.manager.ensure(f.project, {
    projectId: f.id,
    year: "2026",
    topic: target.topic,
    branch: target.branch,
  });
  const env = {
    ...process.env,
    HOME: f.home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  execFileSync("git", ["config", "remote.desktop-source.promisor", "true"], {
    cwd: owner.path,
    env,
  });
  execFileSync("git", ["config", "extensions.partialClone", "desktop-source"], {
    cwd: owner.path,
    env,
  });
  const objects = path.join(owner.path, ".git/objects"),
    source = path.join(f.root, ".git/objects");
  const sourceBefore = (await readdir(source)).sort();
  for (const name of await readdir(objects)) {
    if (name === "pack" || /^[a-f0-9]{2}$/.test(name))
      await rm(path.join(objects, name), { recursive: true, force: true });
  }
  await mkdir(path.join(objects, "pack"));
  const before = (await readdir(objects)).sort();
  // No Git call is allowed between deleting fixture objects and this read.
  // Otherwise the fixture itself could fetch and conceal the resolver bug.
  await expect(
    f.host.listHistoryYears(worktreeContextRef(owner)),
  ).rejects.toThrow();
  expect(await readdir(path.join(objects, "pack"))).toEqual([]);
  expect((await readdir(objects)).sort()).toEqual(before);
  expect((await readdir(source)).sort()).toEqual(sourceBefore);
}, 30000);

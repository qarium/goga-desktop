import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  realpath,
  symlink,
  link,
  rename,
  lstat,
  opendir,
  open,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  listProjectSpecifications,
  readProjectSpecification,
} from "../src/host/project-specifications";
import { withReadScope } from "../src/host/read-scope";
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    lstat: vi.fn(fs.lstat),
    opendir: vi.fn(fs.opendir),
    open: vi.fn(fs.open),
  };
});
import { HostService } from "../src/host/service";
import { DesktopStateStore } from "../src/host/desktop-state";
import { NodeRunner } from "../src/host/process";
import { CloneManager } from "../src/host/clones";
import { worktreeContextRef } from "../src/shared/worktrees";
import { randomUUID } from "node:crypto";
const hosts: HostService[] = [];
let temp: string, root: string;
async function put(p: string, text: string | Buffer = "# Usage") {
  const full = path.join(root, p);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, text);
  return full;
}
beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), "goga-specs-"));
  root = await realpath(temp);
});
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.dispose()));
  vi.restoreAllMocks();
  await rm(temp, { recursive: true, force: true });
});
it("does not create missing usages and distinguishes an empty directory", async () => {
  expect(await listProjectSpecifications(root)).toEqual({
    exists: false,
    paths: [],
    skippedUnsupported: 0,
  });
  await expect(lstat(path.join(root, ".goga"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await mkdir(path.join(root, ".goga/usages"), { recursive: true });
  expect(await listProjectSpecifications(root)).toEqual({
    exists: true,
    paths: [],
    skippedUnsupported: 0,
  });
});
it("lists only md names at 40 levels without reading file bodies", async () => {
  const deep = `${"d/".repeat(40)}usage.MD`;
  await put(`.goga/usages/${deep}`);
  await put(".goga/usages/a/usage.md");
  await put(".goga/usages/b/usage.md");
  await put(".goga/usages/other.yml");
  expect((await listProjectSpecifications(root)).paths).toEqual([
    "a/usage.md",
    "b/usage.md",
    deep,
  ]);
  expect(open).not.toHaveBeenCalled();
});
it("reads current disk contents including empty and deleted documents", async () => {
  const full = await put(".goga/usages/readme.md", "");
  expect(await readProjectSpecification(root, "readme.md")).toEqual({
    path: "readme.md",
    exists: true,
    text: "",
  });
  await writeFile(full, "# Changed");
  expect((await readProjectSpecification(root, "readme.md")).text).toBe(
    "# Changed",
  );
  await rm(full);
  expect(await readProjectSpecification(root, "readme.md")).toEqual({
    path: "readme.md",
    exists: false,
    text: "",
  });
  expect(await readProjectSpecification(root, "missing/nested.md")).toEqual({
    path: "missing/nested.md",
    exists: false,
    text: "",
  });
});
it.each(["../secret.md", "/tmp/x.md", "C:/x.md", "a/../../x.md", "x.yml"])(
  "rejects direct host path %s",
  async (p) => {
    await expect(readProjectSpecification(root, p)).rejects.toThrow();
  },
);
it.each([".goga", ".goga/usages"])(
  "rejects a symlink at root component %s",
  async (relative) => {
    const target = path.join(root, "outside");
    await mkdir(target);
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await symlink(target, path.join(root, relative));
    await expect(listProjectSpecifications(root)).rejects.toThrow(/ссылк/);
    await expect(readProjectSpecification(root, "x.md")).rejects.toThrow(
      /ссылк/,
    );
  },
);
it("omits links and special entries without traversing a link loop", async () => {
  await put(".goga/usages/normal.md");
  const dir = path.join(root, ".goga/usages");
  await symlink(dir, path.join(dir, "loop"));
  await symlink(path.join(dir, "normal.md"), path.join(dir, "link.md"));
  execFileSync("mkfifo", [path.join(dir, "pipe.md")]);
  expect(await listProjectSpecifications(root)).toEqual({
    exists: true,
    paths: ["normal.md"],
    skippedUnsupported: 3,
  });
  await expect(readProjectSpecification(root, "link.md")).rejects.toThrow(
    /ссылк/,
  );
  await expect(readProjectSpecification(root, "pipe.md")).rejects.toThrow(
    /обычные/,
  );
});
it("rejects hardlinks and preserves byte, size and encoding guards", async () => {
  const normal = await put(".goga/usages/normal.md");
  await link(normal, path.join(root, ".goga/usages/hard.md"));
  await expect(readProjectSpecification(root, "hard.md")).rejects.toThrow(
    /жёстк/,
  );
  await put(".goga/usages/invalid.md", Buffer.from([0xff]));
  await expect(readProjectSpecification(root, "invalid.md")).rejects.toThrow(
    /UTF-8/,
  );
  await put(".goga/usages/binary.md", Buffer.from([0]));
  await expect(readProjectSpecification(root, "binary.md")).rejects.toThrow(
    /Бинар/,
  );
  await put(".goga/usages/size.md", "a".repeat(1024 * 1024));
  expect((await readProjectSpecification(root, "size.md")).text.length).toBe(
    1024 * 1024,
  );
  await put(".goga/usages/size.md", "a".repeat(1024 * 1024 + 1));
  await expect(readProjectSpecification(root, "size.md")).rejects.toThrow(
    /1 МиБ/,
  );
});
it("does not turn permission errors into an absent directory", async () => {
  await mkdir(path.join(root, ".goga/usages"), { recursive: true });
  vi.mocked(opendir).mockRejectedValueOnce(
    Object.assign(Error("No access"), { code: "EACCES" }),
  );
  await expect(listProjectSpecifications(root)).rejects.toThrow("No access");
});
it("fails explicitly at the volume budget and can retry", async () => {
  await mkdir(path.join(root, ".goga/usages"), { recursive: true });
  vi.mocked(opendir).mockResolvedValueOnce({
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < 10001; i++)
        yield {
          name: `f${i}.txt`,
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
        };
    },
  } as any);
  await expect(listProjectSpecifications(root)).rejects.toThrow(
    /Слишком много/,
  );
  expect((await listProjectSpecifications(root)).paths).toEqual([]);
});
it("cancels a physical traversal instead of returning a partial success", async () => {
  await mkdir(path.join(root, ".goga/usages"), { recursive: true });
  const controller = new AbortController();
  vi.mocked(opendir).mockResolvedValueOnce({
    async *[Symbol.asyncIterator]() {
      controller.abort();
      yield {
        name: "x.md",
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
      };
    },
  } as any);
  await expect(
    withReadScope(controller.signal, () => listProjectSpecifications(root)),
  ).rejects.toThrow(/отменено/);
});
it("rejects a replaced ancestor before returning the catalog", async () => {
  await put(".goga/usages/a/x.md");
  const original = vi.mocked(opendir).getMockImplementation()!;
  let changed = false;
  vi.mocked(opendir).mockImplementation(async (...args: any[]) => {
    const dir = await (original as any)(...args);
    if (!changed && args[0] === path.join(root, ".goga/usages/a")) {
      changed = true;
      await rename(args[0], args[0] + "-old");
      await mkdir(args[0]);
    }
    return dir;
  });
  await expect(listProjectSpecifications(root)).rejects.toThrow(/изменён/);
});
it("rejects leaf replacement during opening and closes the descriptor", async () => {
  const file = await put(".goga/usages/x.md");
  const original = vi.mocked(open).getMockImplementation()!;
  let closed = false;
  vi.mocked(open).mockImplementationOnce(async (...args: any[]) => {
    await rename(file, file + ".old");
    await writeFile(file, "replacement");
    const fd = await (original as any)(...args);
    const close = fd.close.bind(fd);
    fd.close = async () => {
      closed = true;
      return close();
    };
    return fd;
  });
  await expect(readProjectSpecification(root, "x.md")).rejects.toThrow(
    /изменён/,
  );
  expect(closed).toBe(true);
});

async function serviceFixture(gitRepo = false) {
  const home = path.join(root, "home"),
    dataDir = path.join(root, "data"),
    repo = path.join(root, "repo");
  await mkdir(home);
  await mkdir(repo);
  const project = { id: "registered", name: "Fixture", path: repo };
  await new DesktopStateStore(home, dataDir).addProject(project);
  const env = {
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
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
  hosts.push(host);
  await mkdir(path.join(repo, ".goga/usages"), { recursive: true });
  await writeFile(path.join(repo, ".goga/usages/x.md"), "source");
  if (gitRepo) {
    git("init", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("add", ".");
    git("commit", "-m", "fixture");
    git("branch", "feature/test");
  }
  return { host, project, repo, home, runner, git };
}
it("Host reads source while active or unconfirmed payloads exist without invoking Goga", async () => {
  const f = await serviceFixture();
  for (const status of ["running", "starting", "unknown"]) {
    (f.host as any).runList = [
      { id: "synthetic", projectId: f.project.id, status },
    ];
    expect(
      (await f.host.readProjectSpecification(f.project.id, "x.md")).text,
    ).toBe("source");
    expect(
      (await f.host.listProjectSpecifications(f.project.id)).paths,
    ).toEqual(["x.md"]);
  }
  (f.host as any).runList = [];
  await expect(
    f.host.readProjectSpecification(f.project.id, "../x.md"),
  ).rejects.toThrow();
  await expect(
    f.host.listProjectSpecifications({ projectId: f.project.id } as any),
  ).rejects.toThrow();
});
it("Host isolates managed clone owners, rejects stale revisions, and never falls back", async () => {
  const f = await serviceFixture(true);
  const manager = new CloneManager(f.home, f.runner);
  const owner = await manager.ensure(f.project, {
    projectId: f.project.id,
    year: "2026",
    topic: "feature-test",
    branch: "feature/test",
  });
  const ref = worktreeContextRef(owner);
  await writeFile(path.join(owner.path, ".goga/usages/x.md"), "clone");
  expect((await f.host.readProjectSpecification(ref, "x.md")).text).toBe(
    "clone",
  );
  expect(
    (await f.host.readProjectSpecification(f.project.id, "x.md")).text,
  ).toBe("source");
  for (const bad of [
    { ...ref, revision: randomUUID() },
    { ...ref, year: "2025" },
    { ...ref, projectId: "other" },
    { ...ref, contextId: "ctx-" + "b".repeat(64) },
  ])
    await expect(f.host.listProjectSpecifications(bad)).rejects.toThrow();
  await rm(owner.path, { recursive: true });
  await expect(f.host.readProjectSpecification(ref, "x.md")).rejects.toThrow();
  expect(
    (await f.host.readProjectSpecification(f.project.id, "x.md")).text,
  ).toBe("source");
}, 30000);

it("revalidates a clone binding after physical traversal and refuses inherited primary scope", async () => {
  const f = await serviceFixture(true);
  const owner = await new CloneManager(f.home, f.runner).ensure(f.project, {
    projectId: f.project.id,
    year: "2026",
    topic: "feature-test",
    branch: "feature/test",
  });
  const ref = worktreeContextRef(owner);
  await expect(
    (f.host as any).context.run(
      { projectId: f.project.id, binding: owner },
      () => f.host.listProjectSpecifications(f.project.id),
    ),
  ).rejects.toThrow(/точный контекст/);
  const clones = (f.host as any).clones;
  const resolve = clones.resolve.bind(clones);
  let invalidated = false;
  vi.spyOn(clones, "resolve").mockImplementation(async (value: any) => {
    if (invalidated) throw Error("Owner revision changed after traversal");
    return resolve(value);
  });
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(opendir).mockImplementation(async (...args: any[]) => {
    const dir = await (actual.opendir as any)(...args);
    if (args[0] === path.join(owner.path, ".goga/usages")) invalidated = true;
    return dir;
  });
  await expect(f.host.listProjectSpecifications(ref)).rejects.toThrow(
    "Owner revision changed after traversal",
  );
}, 30000);

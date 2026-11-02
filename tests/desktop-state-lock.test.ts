import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { build } from "esbuild";
import { DesktopStateStore } from "../src/host/desktop-state";
import {
  acquireDesktopStateLock,
  recoverLegacyDesktopStateLock,
  LegacyDesktopStateLockError,
} from "../src/host/desktop-state-lock";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
}));

const roots: string[] = [];
const children = new Set<ChildProcess>();
afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, "exit");
      child.kill("SIGKILL");
      await done;
    }
  }
  children.clear();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await fs.mkdtemp("/private/tmp/goga-state-lock-");
  roots.push(root);
  await fs.chmod(root, 0o700);
  return { root, file: path.join(root, ".write.lock") };
}
async function oldOwner(file: string, pid = 12345) {
  const nonce = randomUUID();
  await fs.mkdir(file, { mode: 0o700 });
  const name = `owner.${nonce}.json`;
  await fs.writeFile(
    path.join(file, name),
    JSON.stringify({ schemaVersion: 1, pid, nonce }),
    { mode: 0o600 },
  );
  return name;
}
function dead(pid = 12345) {
  const original = process.kill.bind(process);
  return vi.spyOn(process, "kill").mockImplementation(((
    p: number,
    signal: any,
  ) => {
    if (p === pid && signal === 0)
      throw Object.assign(Error("dead"), { code: "ESRCH" });
    return original(p, signal);
  }) as typeof process.kill);
}
async function legacy(file: string) {
  await fs.writeFile(file, "", { mode: 0o600 });
  try {
    await acquireDesktopStateLock(file, { attempts: 1 });
  } catch (e) {
    expect(e).toBeInstanceOf(LegacyDesktopStateLockError);
    return (e as LegacyDesktopStateLockError).snapshot;
  }
  throw Error("Expected a legacy lock refusal");
}
it("publishes a complete private owner directory and releases only its own identity", async () => {
  const { root, file } = await fixture();
  const lease = await acquireDesktopStateLock(file, { attempts: 1 });
  expect((await fs.stat(file)).isDirectory()).toBe(true);
  const names = await fs.readdir(file);
  expect(names).toHaveLength(1);
  const owner = JSON.parse(
    await fs.readFile(path.join(file, names[0]), "utf8"),
  );
  expect(owner).toMatchObject({ schemaVersion: 1, pid: process.pid });
  expect(names[0]).toBe(`owner.${owner.nonce}.json`);
  expect((await fs.stat(file)).mode & 0o777).toBe(0o700);
  expect((await fs.stat(path.join(file, names[0]))).mode & 0o777).toBe(0o600);
  await lease.release();
  await lease.release();
  expect(await fs.readdir(root)).toEqual([]);
});
it("does not steal a live owner, regardless of old mtime", async () => {
  const { file } = await fixture();
  const lease = await acquireDesktopStateLock(file, { attempts: 1 });
  await fs.utimes(file, 1, 1);
  await expect(acquireDesktopStateLock(file, { attempts: 1 })).rejects.toThrow(
    /занят/i,
  );
  await lease.release();
});
it("recovers only a confirmed dead owner", async () => {
  const { file } = await fixture();
  await oldOwner(file);
  dead();
  const lease = await acquireDesktopStateLock(file, { attempts: 1 });
  expect(
    JSON.parse(
      await fs.readFile(path.join(file, (await fs.readdir(file))[0]), "utf8"),
    ).pid,
  ).toBe(process.pid);
  await lease.release();
});
it("does not reclaim an owner when liveness is unknown", async () => {
  const { file } = await fixture();
  const name = await oldOwner(file);
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(Error("denied"), { code: "EPERM" });
  });
  await expect(acquireDesktopStateLock(file, { attempts: 1 })).rejects.toThrow(
    /занят/i,
  );
  expect(await fs.readdir(file)).toEqual([name]);
});
it("serializes competing reclaimers without late cleanup deleting a new owner's lock", async () => {
  const { file } = await fixture();
  await oldOwner(file);
  dead();
  let active = 0,
    peak = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      const lease = await acquireDesktopStateLock(file, {
        attempts: 100,
        delayMs: 1,
      });
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 3));
      expect(await fs.readdir(file)).toHaveLength(1);
      active--;
      await lease.release();
    }),
  );
  expect(peak).toBe(1);
});
it("retries when another reclaimer unlinks the observed owner before fd.stat", async () => {
  const { file } = await fixture();
  const name = await oldOwner(file);
  dead();
  const originalOpen = fs.open;
  let reclaimed = false,
    observations = 0;
  vi.spyOn(fs, "open").mockImplementation((async (
    ...args: Parameters<typeof fs.open>
  ) => {
    const fd = await originalOpen(...args);
    if (args[0] === path.join(file, name) && ++observations === 2) {
      reclaimed = true;
      await fs.unlink(path.join(file, name));
      await fs.rmdir(file);
    }
    return fd;
  }) as typeof fs.open);
  const lease = await acquireDesktopStateLock(file, { attempts: 1 });
  expect(reclaimed).toBe(true);
  await lease.release();
});
it("late release does not touch a replacement owner", async () => {
  const { file } = await fixture();
  const first = await acquireDesktopStateLock(file, { attempts: 1 });
  await fs.rename(file, `${file}.first`);
  const second = await acquireDesktopStateLock(file, { attempts: 1 });
  const names = await fs.readdir(file);
  await first.release();
  expect(await fs.readdir(file)).toEqual(names);
  await second.release();
});
it("never follows a symlink or consumes unknown files inside the lock", async () => {
  const { root, file } = await fixture();
  const target = path.join(root, "outside");
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, "data"), "untouched");
  await fs.symlink(target, file);
  await expect(
    acquireDesktopStateLock(file, { attempts: 1 }),
  ).rejects.toThrow();
  expect(await fs.readFile(path.join(target, "data"), "utf8")).toBe(
    "untouched",
  );
  await fs.unlink(file);
  await oldOwner(file);
  dead();
  await fs.writeFile(path.join(file, "unknown"), "untouched");
  await expect(
    acquireDesktopStateLock(file, { attempts: 1 }),
  ).rejects.toThrow();
  expect(await fs.readFile(path.join(file, "unknown"), "utf8")).toBe(
    "untouched",
  );
});
it("acquires an empty abandoned directory without a stale-file timeout", async () => {
  const { file } = await fixture();
  await fs.mkdir(file, { mode: 0o700 });
  const lease = await acquireDesktopStateLock(file, { attempts: 1 });
  await lease.release();
});
it("does not replace an empty directory with unsafe permissions", async () => {
  const { root, file } = await fixture();
  await fs.mkdir(file, { mode: 0o700 });
  await fs.chmod(file, 0o777);
  const before = await fs.lstat(file);
  await expect(acquireDesktopStateLock(file, { attempts: 1 })).rejects.toThrow(
    /занят/i,
  );
  const after = await fs.lstat(file);
  expect(after.ino).toBe(before.ino);
  expect(after.mode & 0o777).toBe(0o777);
  expect(await fs.readdir(file)).toEqual([]);
  expect(await fs.readdir(root)).toEqual([".write.lock"]);
});
it("preserves legacy empty locks until explicit recovery", async () => {
  const { file } = await fixture();
  await legacy(file);
  expect((await fs.stat(file)).size).toBe(0);
});
it.each(["busy", "unknown"] as const)(
  "refuses legacy recovery when open-file inspection is %s",
  async (state) => {
    const { root, file } = await fixture();
    const snapshot = await legacy(file);
    await expect(
      recoverLegacyDesktopStateLock(snapshot, async () => state),
    ).rejects.toThrow();
    expect((await fs.stat(file)).isFile()).toBe(true);
    expect(await fs.readdir(root)).toEqual([".write.lock"]);
  },
);
it("backs up an unchanged unused legacy lock before removing it", async () => {
  const { file } = await fixture();
  const snapshot = await legacy(file);
  const inspect = vi.fn(async () => "free" as const);
  const backup = await recoverLegacyDesktopStateLock(snapshot, inspect);
  expect(inspect).toHaveBeenCalledWith(file);
  expect((await fs.stat(backup)).mode & 0o777).toBe(0o600);
  expect(await fs.readFile(backup, "utf8")).toBe("");
  await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
  const lease = await acquireDesktopStateLock(file, { attempts: 1 });
  await lease.release();
  expect(await fs.readFile(backup, "utf8")).toBe("");
});
it("rejects legacy recovery if a live owner directory replaced the file", async () => {
  const { file } = await fixture();
  const snapshot = await legacy(file);
  await fs.unlink(file);
  const lease = await acquireDesktopStateLock(file, { attempts: 1 });
  const names = await fs.readdir(file);
  await expect(
    recoverLegacyDesktopStateLock(snapshot, async () => "free"),
  ).rejects.toThrow();
  expect(await fs.readdir(file)).toEqual(names);
  await lease.release();
});
it("rechecks the legacy snapshot after inspection before changing anything", async () => {
  const { file } = await fixture();
  const snapshot = await legacy(file);
  await expect(
    recoverLegacyDesktopStateLock(snapshot, async () => {
      await fs.unlink(file);
      await fs.writeFile(file, "replacement", { mode: 0o600 });
      return "free";
    }),
  ).rejects.toThrow();
  expect(await fs.readFile(file, "utf8")).toBe("replacement");
});
it("rejects unsafe legacy hardlinks without changing either name", async () => {
  const { root, file } = await fixture();
  const target = path.join(root, "target");
  await fs.writeFile(target, "", { mode: 0o600 });
  await fs.link(target, file);
  await expect(
    acquireDesktopStateLock(file, { attempts: 1 }),
  ).rejects.toThrow();
  expect((await fs.stat(target)).nlink).toBe(2);
});

async function processFixture() {
  const { root, file } = await fixture();
  const home = path.join(root, "home"),
    legacyDir = path.join(root, "legacy");
  await fs.mkdir(home);
  await fs.mkdir(legacyDir);
  const bundle = path.join(root, "store.cjs");
  await build({
    entryPoints: ["src/host/desktop-state.ts"],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
  });
  const store = new DesktopStateStore(home, legacyDir);
  await store.addProject({
    id: "p",
    name: "Fixture",
    path: "/fixture/project",
  });
  const initial = await store.read("p");
  return {
    root,
    file,
    home,
    legacyDir,
    bundle,
    store,
    initial,
    lock: path.join(home, ".goga/desktop/.write.lock"),
  };
}
function childCode(code: string) {
  const child = fork("-e", [code], {
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.add(child);
  return child;
}
function marker(child: ChildProcess, phase: string) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(Error(`Missing synthetic child phase ${phase}`));
    }, 5000);
    const message = (value: any) => {
      if (value?.error) {
        cleanup();
        reject(Error(value.error));
      } else if (value?.phase === phase) {
        cleanup();
        resolve();
      }
    };
    const exited = () => {
      cleanup();
      reject(Error(`Synthetic child exited before ${phase}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", message);
      child.off("exit", exited);
    };
    child.on("message", message);
    child.once("exit", exited);
  });
}
it.each(["before", "after"])(
  "reopens durable settings after a real child crashes %s atomic lock publication",
  async (phase) => {
    const f = await processFixture();
    const child = childCode(`
    const fs=require('node:fs/promises'), original=fs.rename;
    fs.rename=async(from,to)=>{
      if(to===${JSON.stringify(f.lock)}) {
        if(${JSON.stringify(phase)}==='after') await original(from,to);
        process.send({phase:'locked'});await new Promise(()=>{});
      }
      return original(from,to);
    };
    new(require(${JSON.stringify(f.bundle)}).DesktopStateStore)(${JSON.stringify(f.home)},${JSON.stringify(f.legacyDir)}).listProjects().catch(e=>process.send({error:e.message}));
    setInterval(()=>{},1000);
  `);
    await marker(child, "locked");
    if (phase === "after") {
      const owner = JSON.parse(
        await fs.readFile(
          path.join(f.lock, (await fs.readdir(f.lock))[0]),
          "utf8",
        ),
      );
      expect(owner.pid).toBe(child.pid);
    } else
      await expect(fs.lstat(f.lock)).rejects.toMatchObject({ code: "ENOENT" });
    const done = once(child, "exit");
    child.kill("SIGKILL");
    await done;
    expect(await f.store.listProjects()).toEqual([
      { id: "p", name: "Fixture", path: "/fixture/project" },
    ]);
    expect(await f.store.read("p")).toEqual(f.initial);
    await expect(fs.lstat(f.lock)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
it("keeps exact-version conflict protection across separate processes", async () => {
  const f = await processFixture();
  const results: string[] = [];
  const workers = ["alpha", "beta"].map((profile) => {
    const child = childCode(`
      const Store=require(${JSON.stringify(f.bundle)}).DesktopStateStore;
      const store=new Store(${JSON.stringify(f.home)},${JSON.stringify(f.legacyDir)});
      process.on('message',async()=>{
        try{await store.save('p',{executable:'goga',profile:${JSON.stringify(profile)},env:[]},${JSON.stringify(f.initial.version)});process.send({phase:'done',result:'saved'},()=>process.exit(0));}
        catch(e){process.send({phase:'done',result:e.message},()=>process.exit(0));}
      });process.send({phase:'ready'});
    `);
    child.on("message", (m: any) => {
      if (m?.result) results.push(m.result);
    });
    return child;
  });
  await Promise.all(workers.map((child) => marker(child, "ready")));
  const exited = workers.map((child) => once(child, "exit"));
  workers.forEach((child) => child.send("start"));
  await Promise.all(exited);
  expect(results.filter((result) => result === "saved")).toHaveLength(1);
  expect(
    results.filter((result) => /изменены извне/.test(result)),
  ).toHaveLength(1);
  expect(["alpha", "beta"]).toContain((await f.store.read("p")).value.profile);
});
it("does not remove a legacy file if a process opens it during recovery", async () => {
  const { file } = await fixture();
  const snapshot = await legacy(file);
  const inspect = vi
    .fn()
    .mockResolvedValueOnce("free")
    .mockResolvedValueOnce("busy");
  await expect(
    recoverLegacyDesktopStateLock(snapshot, inspect),
  ).rejects.toThrow();
  expect((await fs.stat(file)).size).toBe(0);
});

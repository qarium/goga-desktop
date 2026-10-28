import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import {
  RunRecoveryManager,
  type RunProcessMetadata,
} from "../src/host/run-recovery";

const roots: string[] = [];
const managers: {
  manager: RunRecoveryManager;
  metadata: RunProcessMetadata;
  cwd: string;
}[] = [];
const ownerHash = "a".repeat(64);
async function setup() {
  const root = await fs.mkdtemp(
    "/private/tmp/goga-context-ab-research-20261020-completion-recovery-",
  );
  roots.push(root);
  const home = path.join(root, "home"),
    cwd = path.join(root, "clone");
  await fs.mkdir(home);
  await fs.mkdir(cwd);
  return { root, home, cwd, manager: new RunRecoveryManager(home) };
}
async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  ms = 8000,
): Promise<T> {
  const end = Date.now() + ms;
  let value = await read();
  while (!accept(value) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 30));
    value = await read();
  }
  expect(accept(value)).toBe(true);
  return value;
}
async function launch(
  f: Awaited<ReturnType<typeof setup>>,
  code: string,
  journal = async (_: RunProcessMetadata) => {},
) {
  const launched = await f.manager.launch({
    runId: "r1",
    ownerHash,
    cwd: f.cwd,
    exe: process.execPath,
    args: ["-e", code],
    env: {
      ...process.env,
      TEST_PAYLOAD_SECRET: "payload-secret-not-persisted",
    },
    journal,
  });
  managers.push({
    manager: f.manager,
    metadata: launched.metadata,
    cwd: f.cwd,
  });
  return launched;
}
afterEach(async () => {
  for (const { manager, metadata, cwd } of managers.splice(0))
    await manager.stop(metadata, ownerHash, cwd).catch(() => {});
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
describe("durable run process recovery", () => {
  it("journals an immutable admission before the real payload can start", async () => {
    const f = await setup(),
      marker = path.join(f.cwd, "started");
    let admitted: RunProcessMetadata | undefined;
    const launched = await launch(
      f,
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'yes'); setInterval(()=>{},1000)`,
      async (metadata) => {
        expect(await fs.stat(marker).catch(() => undefined)).toBeUndefined();
        admitted = metadata;
      },
    );
    expect(launched.metadata).toEqual(admitted);
    await eventually(
      () => fs.readFile(marker, "utf8").catch(() => ""),
      (x) => x === "yes",
    );
    expect(
      await new RunRecoveryManager(f.home).reconcile(
        launched.metadata,
        ownerHash,
        f.cwd,
      ),
    ).toMatchObject({ state: "alive" });
  });
  it("never starts a payload when durable admission fails", async () => {
    const f = await setup(),
      marker = path.join(f.cwd, "started");
    await expect(
      launch(
        f,
        `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`,
        async () => {
          throw Error("journal refused");
        },
      ),
    ).rejects.toThrow("journal refused");
    await new Promise((r) => setTimeout(r, 100));
    expect(await fs.stat(marker).catch(() => undefined)).toBeUndefined();
  });
  it("returns terminal only after actual exit, with pending-sync handoff and no command secrets on disk", async () => {
    const f = await setup();
    const launched = await launch(f, "setTimeout(()=>process.exit(0),100)");
    const result = await eventually(
      () => f.manager.reconcile(launched.metadata, ownerHash, f.cwd),
      (x) => x.state === "terminal",
    );
    expect(result).toMatchObject({
      state: "terminal",
      status: "exited",
      syncPending: true,
    });
    const dir = path.join(
      f.home,
      ".goga/desktop/recovery",
      launched.metadata.nonce,
    );
    for (const file of await fs.readdir(dir)) {
      const info = await fs.lstat(path.join(dir, file));
      if (!info.isFile()) continue;
      const raw = await fs.readFile(path.join(dir, file), "utf8");
      expect(raw).not.toContain("payload-secret-not-persisted");
      expect(raw).not.toContain("setTimeout");
      expect(info.mode & 0o777).toBe(0o600);
    }
  });
  it("rejects foreign owner, foreign cwd and foreign root without touching the owned process", async () => {
    const f = await setup(),
      other = await setup(),
      marker = path.join(f.cwd, "owned-payload-pid");
    const launched = await launch(
      f,
      `require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`,
    );
    // launch() returns at admission-ready, before the atomic started-lease rewrite.
    // This ownership test needs a running payload, not a concurrent admission read.
    const pid = Number(
      await eventually(
        () => fs.readFile(marker, "utf8").catch(() => ""),
        (value) => /^\d+$/.test(value),
      ),
    );
    for (const [manager, owner, cwd] of [
      [f.manager, "b".repeat(64), f.cwd],
      [f.manager, ownerHash, other.cwd],
      [other.manager, ownerHash, f.cwd],
    ] as const) {
      expect(
        await manager.reconcile(launched.metadata, owner, cwd),
      ).toMatchObject({ state: "unverified" });
      await expect(
        manager.stop(launched.metadata, owner, cwd),
      ).rejects.toThrow();
    }
    expect(
      await f.manager.reconcile(launched.metadata, ownerHash, f.cwd),
    ).toMatchObject({ state: "alive" });
    expect(process.kill(pid, 0)).toBe(true);
  });
  it("keeps legacy and missing evidence explicit rather than inventing exit", async () => {
    const f = await setup();
    expect(
      await f.manager.reconcile(undefined, ownerHash, f.cwd),
    ).toMatchObject({ state: "unverified", reason: "legacy" });
    let metadata: RunProcessMetadata | undefined;
    await expect(
      launch(f, "", async (m) => {
        metadata = m;
        throw Error("crash before spawn");
      }),
    ).rejects.toThrow();
    expect(await f.manager.reconcile(metadata, ownerHash, f.cwd)).toMatchObject(
      { state: "unverified", reason: "missing-evidence" },
    );
  });
});

describe("recovery process ownership edge cases", () => {
  it("refuses reused PIDs with different start identity and never signals that process", async () => {
    const f = await setup();
    let metadata!: RunProcessMetadata;
    await expect(
      launch(f, "", async (m) => {
        metadata = m;
        throw Error("no spawn");
      }),
    ).rejects.toThrow();
    const dir = path.join(f.home, ".goga/desktop/recovery", metadata.nonce);
    await fs.writeFile(
      path.join(dir, "lease.json"),
      JSON.stringify({
        metadata,
        supervisor: { pid: process.pid, start: "foreign-start" },
        group: { pid: process.pid, start: "foreign-start" },
        phase: "started",
      }),
      { mode: 0o600 },
    );
    expect(await f.manager.reconcile(metadata, ownerHash, f.cwd)).toMatchObject(
      { state: "unverified", reason: "identity-mismatch" },
    );
    await expect(f.manager.stop(metadata, ownerHash, f.cwd)).rejects.toThrow();
    expect(process.kill(process.pid, 0)).toBe(true);
  });
  it("stops actual descendants, including a child that ignores TERM, before terminal receipt", async () => {
    const f = await setup(),
      marker = path.join(f.cwd, "descendant");
    const grandchild = `require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
    const launched = await launch(
      f,
      `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000)`,
    );
    const pid = Number(
      await eventually(
        () => fs.readFile(marker, "utf8").catch(() => ""),
        (v) => /^\d+$/.test(v),
      ),
    );
    const result = await new RunRecoveryManager(f.home).stop(
      launched.metadata,
      ownerHash,
      f.cwd,
    );
    expect(result).toMatchObject({
      state: "terminal",
      status: "stopped",
      syncPending: true,
    });
    await eventually(
      async () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      },
      (x) => x,
    );
  });
  it("cleans its group on supervisor crash without confusing IPC loss with a user stop", async () => {
    const f = await setup(),
      marker = path.join(f.cwd, "payload");
    const launched = await launch(
      f,
      `require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`,
    );
    const pid = Number(
      await eventually(
        () => fs.readFile(marker, "utf8").catch(() => ""),
        (v) => /^\d+$/.test(v),
      ),
    );
    // This is our live ChildProcess handle, not a PID obtained from a stale journal.
    launched.child.kill("SIGKILL");
    const result = await eventually(
      () => f.manager.reconcile(launched.metadata, ownerHash, f.cwd),
      (v) => v.state === "terminal",
    );
    expect(result).toMatchObject({
      state: "terminal",
      status: "failed",
      syncPending: true,
    });
    await eventually(
      async () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      },
      (x) => x,
    );
  });
  it("rejects symlinked evidence and never treats missing lease as a completed payload", async () => {
    const f = await setup();
    let metadata!: RunProcessMetadata;
    await expect(
      launch(f, "", async (m) => {
        metadata = m;
        throw Error("no spawn");
      }),
    ).rejects.toThrow();
    const dir = path.join(f.home, ".goga/desktop/recovery", metadata.nonce),
      foreign = path.join(f.root, "foreign");
    await fs.writeFile(foreign, "{}", { mode: 0o600 });
    await fs.symlink(foreign, path.join(dir, "receipt.json"));
    expect(await f.manager.reconcile(metadata, ownerHash, f.cwd)).toMatchObject(
      { state: "unverified", reason: "identity-mismatch" },
    );
    expect(await fs.readFile(foreign, "utf8")).toBe("{}");
  });
});

describe("crash-like Desktop parent loss", () => {
  it("reattaches through durable evidence after the launching parent is killed", async () => {
    const f = await setup(),
      marker = path.join(f.cwd, "payload-pid"),
      driverFile = path.join(f.root, "driver.cjs");
    const source = `import {RunRecoveryManager} from ${JSON.stringify(path.resolve("src/host/run-recovery.ts"))};
      const fs=require('node:fs');let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',async()=>{
      const {home,cwd,marker}=JSON.parse(input);const manager=new RunRecoveryManager(home);
      await manager.launch({runId:'crash-parent',ownerHash:'${ownerHash}',cwd,exe:process.execPath,
      args:['-e',"require('fs').writeFileSync("+JSON.stringify(marker)+",String(process.pid));setInterval(()=>{},1000)"],env:{HOME:home},
      journal:async metadata=>{fs.writeFileSync(marker+'.metadata',JSON.stringify(metadata),{mode:0o600})}});setInterval(()=>{},1000);});`;
    const bundled = await build({
      stdin: { contents: source, resolveDir: process.cwd() },
      bundle: true,
      platform: "node",
      format: "cjs",
      write: false,
    });
    await fs.writeFile(driverFile, bundled.outputFiles[0].text, {
      mode: 0o600,
    });
    const driver = spawn(process.execPath, [driverFile], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin" },
    });
    driver.stdin.end(JSON.stringify({ home: f.home, cwd: f.cwd, marker }));
    try {
      const pid = Number(
        await eventually(
          () => fs.readFile(marker, "utf8").catch(() => ""),
          (x) => /^\d+$/.test(x),
        ),
      );
      const metadata = JSON.parse(
        await fs.readFile(marker + ".metadata", "utf8"),
      ) as RunProcessMetadata;
      managers.push({ manager: f.manager, metadata, cwd: f.cwd });
      driver.kill("SIGKILL");
      await new Promise((resolve) => driver.once("close", resolve));
      expect(
        await new RunRecoveryManager(f.home).reconcile(
          metadata,
          ownerHash,
          f.cwd,
        ),
      ).toMatchObject({ state: "alive" });
      expect(process.kill(pid, 0)).toBe(true);
      expect(await f.manager.stop(metadata, ownerHash, f.cwd)).toMatchObject({
        state: "terminal",
        status: "stopped",
        syncPending: true,
      });
      await eventually(
        async () => {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            return true;
          }
        },
        (x) => x,
      );
    } finally {
      driver.kill("SIGKILL");
    }
  });
});

describe("private supervisor channel authentication", () => {
  it("rejects an endpoint that echoes metadata but cannot prove its lease identity and challenge", async () => {
    const f = await setup();
    let metadata!: RunProcessMetadata;
    await expect(
      launch(f, "", async (m) => {
        metadata = m;
        throw Error("no spawn");
      }),
    ).rejects.toThrow();
    const dir = path.join(f.home, ".goga/desktop/recovery", metadata.nonce);
    await fs.writeFile(
      path.join(dir, "lease.json"),
      JSON.stringify({
        metadata,
        supervisor: { pid: process.pid, start: "fake-start" },
        group: { pid: process.pid, start: "fake-start" },
        phase: "started",
      }),
      { mode: 0o600 },
    );
    const source = `const net=require('node:net'),fs=require('node:fs');let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{const metadata=JSON.parse(input);net.createServer(s=>{s.on('data',()=>{});s.on('end',()=>s.end(JSON.stringify({metadata,state:'alive'})))}).listen('s',()=>{fs.chmodSync('s',0o600);process.stdout.write('ready')})});`;
    const spoof = spawn(process.execPath, ["-e", source], {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    spoof.stdin.end(JSON.stringify(metadata));
    try {
      await new Promise((resolve) => spoof.stdout.once("data", resolve));
      expect(
        await f.manager.reconcile(metadata, ownerHash, f.cwd),
      ).toMatchObject({ state: "unverified" });
      await expect(
        f.manager.stop(metadata, ownerHash, f.cwd),
      ).rejects.toThrow();
    } finally {
      spoof.kill("SIGKILL");
      await new Promise((resolve) => spoof.once("close", resolve));
    }
  });
});

describe("late durable outcome receipt", () => {
  it("prefers a late success receipt to a provisional supervisor-crash diagnosis", async () => {
    const f = await setup(),
      launched = await launch(f, "setTimeout(()=>process.exit(0),30)");
    await eventually(
      () => f.manager.reconcile(launched.metadata, ownerHash, f.cwd),
      (x) => x.state === "terminal",
    );
    const file = path.join(
      f.home,
      ".goga/desktop/recovery",
      launched.metadata.nonce,
      "receipt.json",
    );
    await fs.rename(file, file + ".saved");
    const result = f.manager.reconcile(launched.metadata, ownerHash, f.cwd);
    const restore = new Promise<void>((resolve, reject) =>
      setTimeout(
        () => void fs.rename(file + ".saved", file).then(resolve, reject),
        10,
      ),
    );
    await expect(result).resolves.toMatchObject({
      state: "terminal",
      status: "exited",
      code: 0,
      syncPending: true,
    });
    await restore;
  });
});

describe("unexpected guardian loss", () => {
  it("does not claim a live controllable run when guardian died but its payload still lives", async () => {
    const f = await setup(),
      marker = path.join(f.cwd, "orphan-pid");
    const launched = await launch(
      f,
      `require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setTimeout(()=>process.kill(process.ppid,'SIGKILL'),50);setTimeout(()=>process.exit(0),1800)`,
    );
    await eventually(
      () => fs.readFile(marker, "utf8").catch(() => ""),
      (x) => /^\d+$/.test(x),
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(
      await f.manager.reconcile(launched.metadata, ownerHash, f.cwd),
    ).toMatchObject({ state: "unverified", reason: "group-unverified" });
    await expect(
      f.manager.stop(launched.metadata, ownerHash, f.cwd),
    ).rejects.toThrow();
    await eventually(
      () => f.manager.reconcile(launched.metadata, ownerHash, f.cwd),
      (x) => x.state === "terminal",
    );
  });
});

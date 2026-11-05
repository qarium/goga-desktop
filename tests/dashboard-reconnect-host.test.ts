import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { HostService } from "../src/host/service";
import { NodeRunner } from "../src/host/process";
import { ContextRunsStore } from "../src/host/context-runs-store";
import {
  RunRecoveryManager,
  type RunRecoveryLaunch,
  type RunRecoveryMetadata,
} from "../src/host/run-recovery";
import type { Run } from "../src/shared/types";

/** Metadata is synthetic; every Git command still executes against this fixture. */
class MetadataRunner extends NodeRunner {
  refuseNextDispose = false;
  override async dispose() {
    if (this.refuseNextDispose) {
      this.refuseNextDispose = false;
      throw Error("synthetic disposal refusal");
    }
    await super.dispose();
  }
  constructor(
    home: string,
    private readonly repo: string,
  ) {
    super(10000, {
      HOME: home,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    });
  }
  override async command(
    exe: string,
    args: string[],
    cwd: string,
    env?: NodeJS.ProcessEnv,
    stdin?: string,
  ) {
    if (exe === "git") {
      if (cwd !== this.repo)
        throw Error("Git escaped the temporary repository");
      return super.command(exe, args, cwd, env, stdin);
    }
    if (exe !== "synthetic-goga") throw Error("Unexpected fixture executable");
    if (args.includes("--list"))
      return {
        stdout:
          "* build\n    name: Synthetic build\n    description: Test only\n",
        stderr: "",
      };
    if (args.includes("--info"))
      return {
        stdout: "name: Synthetic build\n---\n* work:\n    title: Work\n",
        stderr: "",
      };
    if (args.includes("board")) return { stdout: "[]", stderr: "" };
    throw Error("Unexpected synthetic metadata request");
  }
}

/** The real supervisor, guardian, lease and journal remain untouched. Only the
 * executable/argv for the synthetic payload replace Goga; Docker is never used. */
class PayloadRecovery extends RunRecoveryManager {
  readonly admissions: RunRecoveryMetadata[] = [];
  launchCalls = 0;
  constructor(
    home: string,
    private readonly pinFile: string,
    private readonly startedFile: string,
  ) {
    super(home);
  }
  override async launch(options: RunRecoveryLaunch) {
    this.launchCalls++;
    const launched = await super.launch({
      ...options,
      exe: process.execPath,
      args: [
        "-e",
        `const fs=require('node:fs'),http=require('node:http');
fs.appendFileSync(${JSON.stringify(this.startedFile)},String(process.pid)+'\\n');
const server=http.createServer((req,res)=>{
  if(req.method==='POST'&&req.url==='/finish'){
    res.once('finish',()=>setImmediate(()=>process.exit(0)));
    res.end('finished');return;
  }
  if(req.url==='/api/status'){
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({run_id:fs.readFileSync(${JSON.stringify(this.pinFile)},'utf8'),flow_name:'synthetic',stages:[]}));return;
  }
  res.setHeader('content-type','text/html');res.end('<html>Synthetic dashboard</html>');
});
server.listen(0,'127.0.0.1',()=>console.log('dashboard: http://127.0.0.1:'+server.address().port));`,
      ],
    });
    this.admissions.push(launched.metadata);
    return launched;
  }
}

type Fixture = {
  root: string;
  home: string;
  repo: string;
  dataDir: string;
  pinFile: string;
  startedFile: string;
  pin: string;
  services: HostService[];
  finalized: Set<HostService>;
  recoveries: PayloadRecovery[];
};
const fixtures: Fixture[] = [];
async function eventually<T>(
  read: () => Promise<T> | T,
  accept: (value: T) => boolean,
  budget = 8000,
): Promise<T> {
  const deadline = Date.now() + budget;
  let value = await read();
  while (!accept(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    value = await read();
  }
  expect(accept(value), "fixture did not reach the expected state").toBe(true);
  return value;
}
function serviceFor(f: Fixture) {
  const recovery = new PayloadRecovery(f.home, f.pinFile, f.startedFile);
  const runner = new MetadataRunner(f.home, f.repo);
  const service = new HostService({
    home: f.home,
    dataDir: f.dataDir,
    goga: "synthetic-goga",
    runner,
    recovery,
  });
  f.services.push(service);
  f.recoveries.push(recovery);
  return { service, runner, recovery };
}
async function setup(
  options: { rejectFinalize?: boolean; beforeAck?: boolean } = {},
) {
  const root = await mkdtemp("/private/tmp/goga-dashboard-reconnect-host-");
  const f: Fixture = {
    root,
    home: path.join(root, "home"),
    repo: path.join(root, "repo"),
    dataDir: path.join(root, "data"),
    pinFile: path.join(root, "server-pin"),
    startedFile: path.join(root, "payload-starts"),
    pin: `synthetic-afm-${randomUUID()}`,
    services: [],
    finalized: new Set(),
    recoveries: [],
  };
  fixtures.push(f);
  await mkdir(f.home);
  await mkdir(f.repo);
  await writeFile(f.pinFile, f.pin);
  const { service, runner, recovery } = serviceFor(f);
  await runner.command("git", ["init", "-b", "main"], f.repo);
  // This commit exists only inside the disposable fixture. All hooks, signing
  // and global/system Git configuration are disabled for this runner.
  await runner.command(
    "git",
    [
      "-c",
      "user.name=Synthetic fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--allow-empty",
      "-m",
      "synthetic initial fixture",
    ],
    f.repo,
  );
  await mkdir(path.join(f.repo, ".goga/workflows"), { recursive: true });
  await writeFile(
    path.join(f.repo, ".goga/workflows/build.yml"),
    "prompt: synthetic\n",
  );
  await service.initialize();
  const project = await service.addProject(f.repo);
  const request = {
    projectId: project.id,
    pipeline: "build",
    workflow: "auto",
    profile: "",
    skips: [],
  };
  const preview = await service.preview(request);
  const launched = await service.launch({
    ...request,
    previewToken: preview.token,
    topic: { mode: "none" },
    task: "",
    confirmEmptyTask: false,
    expectedBranch: "main",
    confirmBranchSwitch: false,
    clean: false,
  });
  const live = await eventually(
    () => service.runs().find((run) => run.id === launched.id),
    (run) => !!run?.url,
  );
  if (options.beforeAck)
    return { f, service, original: live!, metadata: recovery.admissions[0]! };
  expect(await service.dashboardLoaded(live!.id, live!.url!)).toBe(true);
  const original = service.runs()[0]!;
  expect(original).toMatchObject({
    id: launched.id,
    status: "running",
    dashboardOpened: true,
    dashboardRecoveryVersion: 1,
    dashboardReconnect: true,
    dashboardRunId: f.pin,
  });
  expect(original.process).toBeUndefined();
  const stored = (await new ContextRunsStore(f.home).load())[0]!;
  const metadata = recovery.admissions[0]!;
  expect(stored.process).toEqual(metadata);
  expect(stored.dashboardRecoveryVersion).toBe(1);
  expect(
    await recovery.readDashboard(metadata, metadata.ownerHash, f.repo),
  ).toEqual({ origin: new URL(original.url!).origin, serverRunId: f.pin });
  const lease = await service.prepareShutdown();
  lease.validate();
  await lease.validateKeep!();
  await lease.keep!();
  expect(lease.retained!()).toEqual([`run:${original.id}`]);
  if (options.rejectFinalize) {
    runner.refuseNextDispose = true;
    await expect(service.finalizeShutdown()).rejects.toThrow(
      "synthetic disposal refusal",
    );
  } else {
    await service.finalizeShutdown();
    f.finalized.add(service);
  }
  lease.release();
  // Do not dispose this original Host: doing so is stop, not keep.
  expect(
    await recovery.reconcile(metadata, metadata.ownerHash, f.repo),
  ).toEqual({ state: "alive" });
  return { f, service, original, metadata };
}
async function finishNaturally(
  f: Fixture,
  service: HostService,
  original: Run,
  metadata: RunRecoveryMetadata,
  pollOnly = false,
) {
  const response = await fetch(`${new URL(original.url!).origin}/finish`, {
    method: "POST",
    signal: AbortSignal.timeout(2000),
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("finished");
  const ended = await eventually(
    () =>
      pollOnly
        ? service.runs().find((run) => run.id === original.id)!
        : service.reconcileRun(original.id),
    (run) => ["exited", "failed", "stopped"].includes(run.status),
  );
  expect(ended).toMatchObject({
    id: original.id,
    status: "exited",
    dashboardOpened: false,
  });
  expect(ended.url).toBeUndefined();
  expect(ended.dashboardReconnect).toBeUndefined();
  expect(ended.dashboardMessage).toBeUndefined();
  expect(ended.recovery).toBeUndefined();
  const lease = await service.prepareShutdown();
  expect(lease.items).toEqual([]);
  expect(lease.remaining()).toEqual([]);
  lease.release();
  const receipt = JSON.parse(
    await readFile(
      path.join(
        f.home,
        ".goga/desktop/recovery",
        metadata.nonce,
        "receipt.json",
      ),
      "utf8",
    ),
  );
  expect(receipt).toMatchObject({ metadata, status: "exited", code: 0 });
}
async function expectOnePayload(f: Fixture) {
  expect(
    f.recoveries.reduce((count, recovery) => count + recovery.launchCalls, 0),
  ).toBe(1);
  const starts = (await readFile(f.startedFile, "utf8")).trim().split("\n");
  expect(starts).toHaveLength(1);
  expect(starts[0]).toMatch(/^\d+$/);
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    // Exact metadata from the real launch authorizes emergency fixture cleanup.
    // On the happy path the durable exit receipt makes this a signal-free read.
    for (const recovery of f.recoveries)
      for (const metadata of recovery.admissions)
        await recovery.stop(metadata, metadata.ownerHash, metadata.cwd);
    for (const service of f.services)
      if (!f.finalized.has(service)) await service.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});

it("recovers the same kept Host launch, acknowledges its saved dashboard repeatedly, then observes its natural receipt", async () => {
  const { f, original, metadata } = await setup();
  const { service: reopened, recovery } = serviceFor(f);
  await reopened.initialize();
  expect(reopened.runs()).toHaveLength(1);
  const restored = reopened.runs()[0]!;
  expect(restored).toMatchObject({
    id: original.id,
    projectId: original.projectId,
    startedAt: original.startedAt,
    pipeline: original.pipeline,
    branch: "main",
    topic: "",
    status: "running",
    url: new URL(original.url!).origin,
    recovery: "confirmed",
    dashboardRecoveryVersion: 1,
    dashboardReconnect: true,
    dashboardRunId: f.pin,
  });
  expect(restored.process).toBeUndefined();
  expect(recovery.launchCalls).toBe(0);
  expect(await reopened.dashboardLoaded(restored.id, restored.url!)).toBe(true);
  expect(await reopened.dashboardLoaded(restored.id, restored.url!)).toBe(true);
  expect(await reopened.prepareDashboardReconnect(restored.id)).toBe(
    restored.url,
  );
  await expectOnePayload(f);
  await finishNaturally(f, reopened, original, metadata);
  await expectOnePayload(f);
}, 30000);

it("does not restore a changed AFM server pin while the exact supervised process remains alive", async () => {
  const { f, original, metadata } = await setup();
  await writeFile(f.pinFile, "replacement-synthetic-afm");
  const { service: reopened, recovery } = serviceFor(f);
  await reopened.initialize();
  const restored = reopened.runs()[0]!;
  expect(restored).toMatchObject({
    id: original.id,
    startedAt: original.startedAt,
    pipeline: original.pipeline,
    status: "running",
    recovery: "confirmed",
    dashboardRecoveryVersion: 1,
  });
  expect(restored.url).toBeUndefined();
  expect(restored.dashboardReconnect).toBeUndefined();
  expect(restored.dashboardRunId).toBeUndefined();
  expect(restored.dashboardMessage).toContain("источник изменился");
  await expect(reopened.prepareDashboardReconnect(restored.id)).rejects.toThrow(
    /Источник панели изменился/,
  );
  expect(await reopened.dashboardLoaded(restored.id, original.url!)).toBe(
    false,
  );
  expect(
    await recovery.reconcile(metadata, metadata.ownerHash, f.repo),
  ).toEqual({ state: "alive" });
  await expectOnePayload(f);
  await finishNaturally(f, reopened, original, metadata);
}, 30000);

function missingTopic(original: Run) {
  return {
    projectId: original.projectId,
    year: String(new Date().getFullYear()),
    topic: "synthetic-missing-topic",
    branch: "main",
  };
}
async function launchAfterTerminal(service: HostService, original: Run) {
  // This is a real Host admission and real supervisor launch, not a private
  // activeKeys assertion or a mocked acceptance result.
  const request = {
    projectId: original.projectId,
    pipeline: "build",
    workflow: "auto",
    profile: "",
    skips: [],
  };
  const preview = await service.preview(request);
  const next = await service.launch({
    ...request,
    previewToken: preview.token,
    topic: { mode: "none" },
    task: "",
    confirmEmptyTask: false,
    expectedBranch: "main",
    confirmBranchSwitch: false,
    clean: false,
  });
  expect(next.id).not.toBe(original.id);
  await eventually(
    () => service.runs().find((run) => run.id === next.id),
    (run) => !!run?.url,
  );
  await service.stop(next.id);
  expect(service.runs().find((run) => run.id === next.id)?.status).toBe(
    "stopped",
  );
}

it("keeps polling after keep finalization fails and releases terminal membership only after a natural receipt", async () => {
  const { f, service, original, metadata } = await setup({
    rejectFinalize: true,
  });
  await expect(
    service.ensureTopicContext(missingTopic(original)),
  ).rejects.toThrow(/недоступна во время активного запуска/);
  await expectOnePayload(f);
  // Only runs() is read while waiting: the original Host's surviving interval
  // must reconcile the actual receipt after finalize's runner refusal.
  await finishNaturally(f, service, original, metadata, true);
  await expect(
    service.ensureTopicContext(missingTopic(original)),
  ).rejects.toThrow(/Топик отсутствует/);
  await launchAfterTerminal(service, original);
  expect(f.recoveries[0]!.launchCalls).toBe(2);
}, 30000);

it("releases a kept run's terminal membership after explicit stop when finalization failed", async () => {
  const { f, service, original } = await setup({ rejectFinalize: true });
  await expect(
    service.ensureTopicContext(missingTopic(original)),
  ).rejects.toThrow(/недоступна во время активного запуска/);
  await service.stop(original.id);
  expect(service.runs().find((run) => run.id === original.id)).toMatchObject({
    id: original.id,
    status: "stopped",
  });
  await expect(
    service.ensureTopicContext(missingTopic(original)),
  ).rejects.toThrow(/Топик отсутствует/);
  await launchAfterTerminal(service, original);
  expect(f.recoveries[0]!.launchCalls).toBe(2);
}, 30000);

it("does not let a late dashboard check overwrite an authoritative terminal receipt", async () => {
  const { f, original, metadata } = await setup();
  const { service: reopened, recovery } = serviceFor(f);
  await reopened.initialize();
  const originalFetch = globalThis.fetch;
  const { vi } = await import("vitest");
  let release!: (response: Response) => void,
    requested = false;
  const pendingResponse = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input, init) => {
      if (!requested && String(input).endsWith("/api/status")) {
        requested = true;
        return pendingResponse;
      }
      return originalFetch(input, init);
    });
  try {
    const pending = reopened.reconcileRun(original.id);
    await eventually(
      () => requested,
      (value) => value,
    );
    const response = await originalFetch(
      `${new URL(original.url!).origin}/finish`,
      { method: "POST", signal: AbortSignal.timeout(2000) },
    );
    expect(response.status).toBe(200);
    await response.text();
    await eventually(
      () => recovery.reconcile(metadata, metadata.ownerHash, f.repo),
      (value) => value.state === "terminal",
    );
    expect((await reopened.reconcileRun(original.id)).status).toBe("exited");
    release(new Response(JSON.stringify({ run_id: f.pin, stages: [] })));
    await pending;
    const ended = reopened.runs()[0]!;
    expect(ended.status).toBe("exited");
    expect(ended.recovery).toBeUndefined();
    expect(ended.dashboardMessage).toBeUndefined();
    expect(ended.url).toBeUndefined();
    expect(ended.dashboardReconnect).toBeUndefined();
  } finally {
    release?.(new Response("{}"));
    fetcher.mockRestore();
  }
}, 30000);

it("does not publish a late initial dashboard failure after its process exited", async () => {
  const { f, service, original } = await setup({ beforeAck: true });
  const { vi } = await import("vitest");
  const originalFetch = globalThis.fetch;
  let reject!: (error: Error) => void,
    requested = false;
  const response = new Promise<Response>((_, fail) => {
    reject = fail;
  });
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input, init) => {
      if (!requested && String(input).endsWith("/api/status")) {
        requested = true;
        return response;
      }
      return originalFetch(input, init);
    });
  try {
    const pending = service.dashboardLoaded(original.id, original.url!);
    await eventually(
      () => requested,
      (value) => value,
    );
    const finish = await originalFetch(
      `${new URL(original.url!).origin}/finish`,
      { method: "POST", signal: AbortSignal.timeout(2000) },
    );
    await finish.text();
    await eventually(
      () => service.runs()[0]?.status,
      (value) => value === "exited",
    );
    reject(Error("late fixture response failure"));
    expect(await pending).toBe(false);
    expect(service.runs()[0].dashboardMessage).toBeUndefined();
    await expectOnePayload(f);
  } finally {
    reject?.(Error("fixture cleanup"));
    fetcher.mockRestore();
  }
}, 30000);

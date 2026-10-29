import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Dynamic imports make the initial RED about missing behavior, not test discovery.
const cdp = () => import("../smoke-cdp.mjs");
const controller = () => import("../packaged-app-smoke.mjs");
const scenario = () => import("../release-smoke-scenario.mjs");

class Socket extends EventTarget {
  readyState = 1;
  sent = [];
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.dispatchEvent(new Event("close"));
  }
  reply(value) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(value) }),
    );
  }
}

test("CDP accepts only assigned IPv4 loopback endpoints and exact renderer paths", async () => {
  const { validateEndpoint, selectTarget, parseActivePort } = await cdp();
  assert.deepEqual(parseActivePort("49152\n/devtools/browser/abc-123\n"), {
    port: 49152,
    browserPath: "/devtools/browser/abc-123",
  });
  for (const value of [
    "0\n/devtools/browser/a",
    "49152\nhttp://evil/",
    "49152\n/devtools/browser/a\nextra",
    "65536\n/devtools/browser/a",
  ])
    assert.throws(() => parseActivePort(value));
  assert.equal(
    validateEndpoint("ws://127.0.0.1:49152/devtools/page/abc", 49152).hostname,
    "127.0.0.1",
  );
  for (const value of [
    "ws://localhost:49152/devtools/page/a",
    "ws://127.0.0.1:49153/devtools/page/a",
    "ws://evil:49152/devtools/page/a",
    "ws://user@127.0.0.1:49152/devtools/page/a",
    "ws://127.0.0.1:49152/devtools/page/a?q=1",
    "wss://127.0.0.1:49152/devtools/page/a",
  ])
    assert.throws(() => validateEndpoint(value, 49152));
  const url = pathToFileURL("/private/tmp/app.asar/dist/index.html").href;
  const target = {
    type: "page",
    url,
    webSocketDebuggerUrl: "ws://127.0.0.1:49152/devtools/page/a",
  };
  assert.equal(selectTarget([target], url, 49152), target);
  assert.equal(
    selectTarget([{ ...target, url: `${url}?other` }], url, 49152),
    undefined,
  );
  assert.throws(() => selectTarget([target, target], url, 49152));
});

test("CDP propagates protocol rejection, finite timeout and disconnect", async () => {
  const { CDPConnection } = await cdp();
  const socket = new Socket(),
    client = new CDPConnection(socket, { timeout: 30 });
  const good = client.send("Runtime.enable");
  socket.reply({ id: socket.sent.at(-1).id, result: { ok: true } });
  assert.deepEqual(await good, { ok: true });
  const rejected = client.send("No.suchMethod");
  socket.reply({
    id: socket.sent.at(-1).id,
    error: { message: "unsupported" },
  });
  await assert.rejects(rejected, /protocol rejected/);
  await assert.rejects(client.send("Hang"), /timed out/);
  const disconnected = client.send("Pending");
  socket.close();
  await assert.rejects(disconnected, /disconnected/);
  await assert.rejects(client.send("After.close"), /disconnected/);
});

test("renderer exceptions fail the scenario and evaluation rejection is never success", async () => {
  const { CDPConnection } = await cdp();
  const socket = new Socket(),
    client = new CDPConnection(socket);
  const pending = client.evaluate("1");
  socket.reply({
    id: socket.sent.at(-1).id,
    result: { exceptionDetails: { text: "bad renderer" } },
  });
  await assert.rejects(pending, /evaluation failed/);
  socket.reply({
    method: "Runtime.exceptionThrown",
    params: { exceptionDetails: { text: "fatal" } },
  });
  await assert.rejects(client.evaluate("2"), /renderer exception/);
  client.close();
});

test("app environment is allowlisted and child uses the controller process group", async () => {
  const { isolatedEnvironment, appLaunchOptions } = await controller();
  const env = isolatedEnvironment("/private/tmp/root", {
    NODE_OPTIONS: "--require=evil",
    NODE_PATH: "evil",
    ELECTRON_RUN_AS_NODE: "1",
    SSH_AUTH_SOCK: "secret",
    GH_TOKEN: "secret",
    GIT_CONFIG_GLOBAL: "/user/.gitconfig",
    PATH: "/user/bin",
    HOME: "/user",
  });
  assert.equal(env.HOME, "/private/tmp/root/app-home");
  assert.equal(env.GOGA_DESKTOP_DATA_DIR, "/private/tmp/root/app-data");
  for (const name of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "ELECTRON_RUN_AS_NODE",
    "SSH_AUTH_SOCK",
    "GH_TOKEN",
  ])
    assert.equal(env[name], undefined);
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(appLaunchOptions("/private/tmp/root").detached, false);
});

test("child early exit and failed normal quit cannot be reported successful", async () => {
  const { observeChild } = await controller();
  const child = new EventEmitter(),
    owned = observeChild(child);
  child.emit("close", 7, null);
  await assert.rejects(owned.assertAlive(), /exited before shutdown/);
  await assert.rejects(owned.waitForNormalExit(20), /normal app exit/);
  const hung = observeChild(new EventEmitter());
  await assert.rejects(hung.waitForNormalExit(20), /normal app exit timed out/);
});

test("bounded receipt requires every real phase and successful normal process exit", async () => {
  const { receiptFor, assertReceipt } = await controller();
  const phases = Object.fromEntries(
    ["startup", "settings", "git", "terminal", "shutdown"].map((name) => [
      name,
      { outcome: "passed", elapsedMs: 1 },
    ]),
  );
  const good = receiptFor({
    version: "1.2.3",
    arch: "arm64",
    phases,
    exit: { code: 0, signal: null },
    elapsedMs: 8,
  });
  assert.equal(good.outcome, "passed");
  assert.doesNotThrow(() => assertReceipt(good, "1.2.3", "arm64"));
  for (const phase of Object.keys(phases)) {
    const missing = structuredClone(good);
    delete missing.phases[phase];
    assert.throws(() => assertReceipt(missing, "1.2.3", "arm64"), /phase/);
    const failed = structuredClone(good);
    failed.phases[phase].outcome = "failed";
    assert.throws(() => assertReceipt(failed, "1.2.3", "arm64"), /phase/);
  }
  assert.throws(() => assertReceipt(good, "9.9.9", "arm64"), /version/);
  assert.throws(
    () =>
      assertReceipt(
        { ...good, exit: { code: null, signal: "SIGKILL" } },
        "1.2.3",
        "arm64",
      ),
    /normal app exit/,
  );
});

test("phase runner records settings, Git and terminal failures without completing later phases", async () => {
  const { runPhases } = await scenario();
  for (const failing of [
    "startup",
    "settings",
    "git",
    "terminal",
    "shutdown",
  ]) {
    const phases = {},
      visited = [];
    const tasks = Object.fromEntries(
      ["startup", "settings", "git", "terminal", "shutdown"].map((name) => [
        name,
        async () => {
          visited.push(name);
          if (name === failing) throw Error("fixture failure");
        },
      ]),
    );
    await assert.rejects(runPhases(tasks, phases), /fixture failure/);
    assert.equal(phases[failing].outcome, "failed");
    assert.equal(visited.at(-1), failing);
    assert.equal(
      Object.values(phases).filter((p) => p.outcome === "failed").length,
      1,
    );
  }
});

test("synthetic repo has no remote, hooks or signing and private registry points only inside root", async () => {
  const { createFixture } = await scenario();
  const dir = await mkdtemp(path.join(tmpdir(), "goga-packaged-unit-"));
  try {
    await mkdir(path.join(dir, "app-home"));
    const fixture = await createFixture(dir);
    const registry = JSON.parse(
      await readFile(
        path.join(dir, "app-home/.goga/desktop/projects.json"),
        "utf8",
      ),
    );
    assert.equal(registry.schemaVersion, 1);
    assert.deepEqual(registry.projects, [
      {
        id: fixture.projectId,
        name: "Packaged smoke fixture",
        path: fixture.repo,
      },
    ]);
    assert.equal(await fixture.git(["remote"]), "");
    assert.equal(
      await fixture.git(["config", "--get", "commit.gpgSign"]),
      "false",
    );
    assert.equal(await fixture.git(["show", "HEAD:smoke.txt"]), "before");
    assert.equal(
      await readFile(path.join(fixture.repo, "smoke.txt"), "utf8"),
      "after\n",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("startup wrong version produces failed startup phase before any settings mutation", async () => {
  const { runScenario } = await scenario();
  const phases = {};
  const shell = {
    evaluate: async () => ({ version: "v9.9.9", projects: [], runs: [] }),
  };
  await assert.rejects(
    runScenario({
      root: "/unused",
      version: "1.2.3",
      asar: "/unused/app.asar",
      shell,
      port: 49152,
      owned: { assertAlive: async () => {} },
      phases,
      clients: [],
    }),
    /Wrong packaged renderer version/,
  );
  assert.deepEqual(Object.keys(phases), ["startup"]);
  assert.equal(phases.startup.outcome, "failed");
});

test("disposable root guard rejects home, temporary base and symlink aliases", async () => {
  const { assertDisposableRoot } = await controller();
  const { realpath, symlink } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const temp = await realpath(tmpdir());
  const dir = await mkdtemp(path.join(temp, "goga-packaged-guard-"));
  const alias = `${dir}-alias`;
  try {
    await assert.doesNotReject(assertDisposableRoot(dir));
    await assert.rejects(assertDisposableRoot(homedir()), /disposable/);
    await assert.rejects(assertDisposableRoot(temp), /disposable/);
    await symlink(dir, alias);
    await assert.rejects(assertDisposableRoot(alias), /canonical/);
  } finally {
    await rm(alias, { force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("fatal renderer exception remains visible even after expected shutdown disconnect", async () => {
  const { CDPConnection } = await cdp();
  const socket = new Socket(),
    client = new CDPConnection(socket);
  socket.reply({ method: "Runtime.exceptionThrown", params: {} });
  socket.close();
  assert.throws(() => client.assertNoRendererFailure(), /renderer exception/);
  const healthy = new CDPConnection(new Socket());
  healthy.close();
  assert.doesNotThrow(() => healthy.assertNoRendererFailure());
});

test("normal child exit drains late renderer fatal event before accepting shutdown", async () => {
  const { CDPConnection } = await cdp();
  const { completeShutdown } = await scenario();
  const { observeChild } = await controller();
  const socket = new Socket(),
    client = new CDPConnection(socket);
  const child = new EventEmitter(),
    owned = observeChild(child);
  const finished = completeShutdown(owned, [client], 100);
  child.emit("close", 0, null);
  setTimeout(() => {
    socket.reply({ method: "Runtime.exceptionThrown", params: {} });
    socket.close();
  }, 10);
  await assert.rejects(finished, /renderer exception/);
});

test("shutdown drain accepts only closed healthy transport and has a finite deadline", async () => {
  const { CDPConnection } = await cdp();
  const { completeShutdown } = await scenario();
  const owned = { waitForNormalExit: async () => ({ code: 0, signal: null }) };
  const goodSocket = new Socket(),
    good = new CDPConnection(goodSocket);
  const goodResult = completeShutdown(owned, [good], 100);
  setTimeout(() => goodSocket.close(), 5);
  await goodResult;
  const hanging = new CDPConnection(new Socket());
  await assert.rejects(
    completeShutdown(owned, [hanging], 20),
    /CDP closure timed out/,
  );
  hanging.close();
});

test("shutdown never hides invalid, oversized protocol or transport errors as normal disconnect", async () => {
  const { CDPConnection } = await cdp();
  for (const data of ["{broken", "x".repeat(4 * 1024 * 1024 + 1)]) {
    const socket = new Socket(),
      client = new CDPConnection(socket);
    socket.dispatchEvent(new MessageEvent("message", { data }));
    socket.close();
    assert.throws(
      () => client.assertNoRendererFailure(),
      /Invalid CDP protocol message/,
    );
  }
  const socket = new Socket(),
    client = new CDPConnection(socket);
  socket.dispatchEvent(new Event("error"));
  socket.close();
  assert.throws(() => client.assertNoRendererFailure(), /transport error/);
});

test("preload IPC expression preserves explicit undefined optional arguments", async () => {
  const { bridgeExpression } = await scenario();
  const expression = bridgeExpression("saveSettings", [
    "config",
    undefined,
    "{}\n",
    "missing",
  ]);
  const calls = [];
  const window = {
    goga: {
      saveSettings: (...args) => {
        calls.push(args);
        return true;
      },
    },
  };
  assert.equal(Function("window", `return ${expression}`)(window), true);
  assert.deepEqual(calls, [["config", undefined, "{}\n", "missing"]]);
});

test("normal application quit sends only Browser.close without waiting for a nonexistent reply", async () => {
  const { CDPConnection } = await cdp();
  const socket = new Socket(),
    client = new CDPConnection(socket, { timeout: 10 });
  assert.equal(client.requestQuit(), undefined);
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].method, "Browser.close");
  assert.deepEqual(socket.sent[0].params, {});
  assert.ok(Number.isSafeInteger(socket.sent[0].id));
  assert.equal(client.pending.size, 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.doesNotThrow(() => client.assertHealthy());
  socket.close();
  await client.waitForClosure(20);
});

test("fire-and-forget quit still rejects protocol errors and retains late fatal events", async () => {
  const { CDPConnection } = await cdp();
  const rejectedSocket = new Socket(),
    rejected = new CDPConnection(rejectedSocket);
  rejected.requestQuit();
  rejectedSocket.reply({
    id: rejectedSocket.sent[0].id,
    error: { message: "unsupported" },
  });
  assert.throws(() => rejected.assertHealthy(), /quit protocol rejected/);
  rejectedSocket.close();
  await assert.rejects(rejected.waitForClosure(20), /quit protocol rejected/);
  const socket = new Socket(),
    client = new CDPConnection(socket);
  client.requestQuit();
  socket.reply({ method: "Runtime.exceptionThrown", params: {} });
  socket.close();
  await assert.rejects(client.waitForClosure(20), /renderer exception/);
  assert.throws(() => client.requestQuit(), /renderer exception/);
});

test("armed shutdown tolerates abrupt CDP EOF only after normal main exit and closed sockets", async () => {
  const { CDPConnection } = await cdp();
  const { completeShutdown } = await scenario();
  const { observeChild } = await controller();
  const socket = new Socket(),
    client = new CDPConnection(socket);
  const child = new EventEmitter(),
    owned = observeChild(child);
  client.beginShutdown();
  client.requestQuit();
  const finished = completeShutdown(owned, [client], 100);
  socket.dispatchEvent(new Event("error"));
  assert.throws(() => client.assertNoRendererFailure(), /transport error/);
  child.emit("close", 0, null);
  socket.close();
  await finished;
});

test("shutdown cannot arm a damaged transport or pending requests and never accepts nonzero main exit", async () => {
  const { CDPConnection } = await cdp();
  const { completeShutdown } = await scenario();
  const { observeChild } = await controller();
  const badSocket = new Socket(),
    bad = new CDPConnection(badSocket);
  badSocket.dispatchEvent(new Event("error"));
  assert.throws(() => bad.beginShutdown(), /transport error/);
  badSocket.close();
  const pendingSocket = new Socket(),
    pending = new CDPConnection(pendingSocket);
  const request = pending.send("Runtime.evaluate");
  assert.throws(() => pending.beginShutdown(), /pending CDP requests/);
  pendingSocket.close();
  await assert.rejects(request);
  const socket = new Socket(),
    client = new CDPConnection(socket);
  client.beginShutdown();
  client.requestQuit();
  const child = new EventEmitter(),
    owned = observeChild(child);
  socket.dispatchEvent(new Event("error"));
  socket.close();
  const finished = completeShutdown(owned, [client], 100);
  child.emit("close", 1, null);
  await assert.rejects(finished, /normal app exit/);
});

test("expected EOF cannot mask malformed protocol, oversized messages or fatal events", async () => {
  const { CDPConnection } = await cdp();
  const { completeShutdown } = await scenario();
  for (const event of ["malformed", "oversized", "fatal"]) {
    const socket = new Socket(),
      client = new CDPConnection(socket);
    client.beginShutdown();
    client.requestQuit();
    socket.dispatchEvent(new Event("error"));
    if (event === "fatal")
      socket.reply({ method: "Runtime.exceptionThrown", params: {} });
    else
      socket.dispatchEvent(
        new MessageEvent("message", {
          data:
            event === "malformed" ? "{bad" : "x".repeat(4 * 1024 * 1024 + 1),
        }),
      );
    socket.close();
    await assert.rejects(
      completeShutdown(
        { waitForNormalExit: async () => ({ code: 0, signal: null }) },
        [client],
        100,
      ),
      event === "fatal" ? /renderer exception/ : /Invalid CDP protocol message/,
    );
  }
});


test("cold packaged renderer discovery uses its existing shared deadline, not a shorter request timeout", async () => {
  const { findTarget } = await cdp();
  const expectedURL = pathToFileURL("/private/tmp/fixture/app.asar/dist/index.html").href;
  let port;
  const timers = new Set();
  const server = createServer((_request, response) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{
        type: "page", url: expectedURL,
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/fixture`,
      }]));
    }, 2300);
    timers.add(timer);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = server.address().port;
  try {
    const target = await findTarget(port, expectedURL, async () => {}, 6000);
    assert.equal(target.url, expectedURL);
    assert.equal(target.webSocketDebuggerUrl, `ws://127.0.0.1:${port}/devtools/page/fixture`);
    // A stalled discovery still has the same finite total budget and must fail.
    await assert.rejects(findTarget(port, expectedURL, async () => {}, 20), /timeout|timed out/i);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

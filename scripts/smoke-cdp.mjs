// External controller transport: never changes Electron security preferences.
import { readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export function parseActivePort(text) {
  const match =
    /^(\d{1,5})\r?\n(\/devtools\/browser\/[A-Za-z0-9-]+)\r?\n?$/.exec(text);
  const port = Number(match?.[1]);
  if (!match || port < 1024 || port > 65535)
    throw Error("Invalid disposable DevToolsActivePort");
  return { port, browserPath: match[2] };
}
export function validateEndpoint(value, port) {
  if (
    typeof value !== "string" ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    !new RegExp(
      `^ws://127\\.0\\.0\\.1:${port}/devtools/page/[A-Za-z0-9-]+$`,
    ).test(value)
  )
    throw Error("CDP endpoint must use assigned IPv4 loopback port");
  return new URL(value);
}
export function selectTarget(targets, expectedURL, port) {
  if (!Array.isArray(targets) || targets.length > 64)
    throw Error("Invalid CDP target inventory");
  const matches = targets.filter(
    (t) => t.type === "page" && t.url === expectedURL,
  );
  if (matches.length > 1) throw Error("Ambiguous packaged renderer target");
  if (matches[0]) validateEndpoint(matches[0].webSocketDebuggerUrl, port);
  return matches[0];
}
export async function activePort(userData, assertAlive, timeout = 15000) {
  const deadline = performance.now() + timeout;
  const file = path.join(userData, "DevToolsActivePort");
  while (performance.now() < deadline) {
    await assertAlive();
    try {
      const stat = await lstat(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size > 256
      )
        throw Error("Invalid disposable CDP port file");
      return parseActivePort(await readFile(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(100);
  }
  throw Error(
    "Packaged app did not expose disposable CDP port (devTools policy is not relaxed)",
  );
}
export async function findTarget(
  port,
  expectedURL,
  assertAlive,
  timeout = 15000,
) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    await assertAlive();
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      redirect: "error",
      // The first inventory may wait for Chromium's cold renderer startup.
      // Keep one discovery deadline instead of aborting a healthy slow reply at 2s.
      signal: AbortSignal.timeout(
        Math.max(1, Math.ceil(deadline - performance.now())),
      ),
    });
    if (!response.ok) throw Error("CDP inventory request rejected");
    const reader = response.body.getReader();
    let size = 0;
    const parts = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 256 * 1024) throw Error("CDP inventory exceeds limit");
        parts.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const target = selectTarget(
      JSON.parse(Buffer.concat(parts).toString("utf8")),
      expectedURL,
      port,
    );
    if (target) return target;
    await delay(100);
  }
  throw Error(
    "Exact packaged ASAR renderer unavailable over CDP (devTools policy is not relaxed)",
  );
}
export class CDPConnection {
  constructor(socket, { timeout = 10000 } = {}) {
    if (!Number.isFinite(timeout) || timeout <= 0)
      throw Error("Invalid CDP timeout");
    this.socket = socket;
    this.timeout = timeout;
    this.pending = new Map();
    this.sequence = 0;
    this.failure = null;
    this.closed = false;
    socket.addEventListener("message", (event) => {
      try {
        if (
          typeof event.data !== "string" ||
          event.data.length > 4 * 1024 * 1024
        )
          throw Error("CDP message exceeds limit");
        const message = JSON.parse(event.data);
        if (message.id) {
          if (message.id === this.quitID && message.error) {
            this.protocolFailure = Error("CDP quit protocol rejected");
            this.fail(this.protocolFailure);
            return;
          }
          const waiter = this.pending.get(message.id);
          if (!waiter) return;
          this.pending.delete(message.id);
          clearTimeout(waiter.timer);
          if (message.error)
            waiter.reject(Error("CDP protocol rejected command"));
          else waiter.resolve(message.result);
        } else if (
          [
            "Runtime.exceptionThrown",
            "Inspector.targetCrashed",
            "Target.targetCrashed",
          ].includes(message.method)
        ) {
          this.rendererFailure = Error("Fatal renderer exception or crash");
          this.fail(this.rendererFailure);
        }
      } catch {
        this.protocolFailure = Error("Invalid CDP protocol message");
        this.fail(this.protocolFailure);
      }
    });
    socket.addEventListener("close", () => {
      this.closed = true;
      this.disconnectFailure = Error("CDP disconnected");
      this.fail(this.disconnectFailure);
    });
    socket.addEventListener("error", () => {
      this.transportFailure ??= Error("CDP transport error");
      this.fail(this.transportFailure);
    });
  }
  fail(error) {
    this.failure ??= error;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(this.failure);
    }
    this.pending.clear();
  }
  assertHealthy() {
    if (this.failure) throw this.failure;
  }
  beginShutdown() {
    this.assertHealthy();
    if (this.pending.size) throw Error("Cannot quit with pending CDP requests");
    this.expectedShutdown = true;
  }
  assertNoRendererFailure({ normalExit = false } = {}) {
    if (this.rendererFailure) throw this.rendererFailure;
    if (this.protocolFailure) throw this.protocolFailure;
    // Electron may terminate CDP without a WebSocket close frame during Quit.
    // Only an explicitly armed, drained shutdown AFTER verified main exit 0
    // may accept that EOF; every other transport/protocol failure stays fatal.
    const expectedEOF =
      this.expectedShutdown &&
      normalExit &&
      this.closed &&
      this.failure === this.transportFailure;
    if (this.failure && this.failure !== this.disconnectFailure && !expectedEOF)
      throw this.failure;
  }
  async waitForClosure(timeout = 3000, { normalExit = false } = {}) {
    if (!Number.isFinite(timeout) || timeout <= 0)
      throw Error("Invalid CDP closure timeout");
    if (!this.closed)
      await new Promise((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          this.socket.removeEventListener("close", done);
          resolve();
        };
        const timer = setTimeout(() => {
          this.socket.removeEventListener("close", done);
          reject(Error("CDP closure timed out"));
        }, timeout);
        this.socket.addEventListener("close", done, { once: true });
        if (this.closed) done();
      });
    this.assertNoRendererFailure({ normalExit });
  }
  async send(method, params = {}, timeout = this.timeout) {
    this.assertHealthy();
    if (!Number.isFinite(timeout) || timeout <= 0)
      throw Error("Invalid CDP timeout");
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error(`CDP ${method} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch {
        this.fail(Error("CDP disconnected"));
      }
    });
  }
  async evaluate(expression, timeout = this.timeout) {
    const value = await this.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
      timeout,
    );
    if (value.exceptionDetails || value.result?.subtype === "error")
      throw Error("Packaged renderer evaluation failed");
    this.assertHealthy();
    return value.result?.value;
  }
  requestQuit() {
    this.assertHealthy();
    // Electron 44's DevToolsManagerDelegate routes this fixed method to
    // Browser::Quit (before-quit + normal window close), deliberately without
    // a protocol reply. Never substitute app.exit or page/window destruction.
    this.quitID = ++this.sequence;
    try {
      this.socket.send(
        JSON.stringify({
          id: this.quitID,
          method: "Browser.close",
          params: {},
        }),
      );
    } catch {
      this.fail(Error("CDP quit transport error"));
      throw this.failure;
    }
  }
  close() {
    this.socket.close();
  }
}
export async function connectTarget(target, port) {
  validateEndpoint(target.webSocketDebuggerUrl, port);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(Error("CDP connection timed out"));
    }, 5000);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(Error("CDP connection rejected"));
      },
      { once: true },
    );
  });
  const client = new CDPConnection(socket);
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  return client;
}
export async function waitUntil(
  check,
  { timeout = 10000, assertAlive = async () => {} } = {},
) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    await assertAlive();
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  throw Error("Packaged scenario readiness timed out");
}

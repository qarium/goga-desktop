"use strict";
const { text: t } = require("./messages.cjs");

// A dedicated Chromium process per show, with NO debugging
// TCP listener. The browser's fd3/fd4 carry NUL-delimited DevTools messages.
const http = require("node:http");
const { readSelection } = require("./selection.cjs");
const { randomBytes } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { WebSocketServer } = require("ws");

const LIMIT = 16 * 1024 * 1024;
const openPipe = new WeakMap(); // only trusted, in-process targets are routable
const reject = (message, code = -32000) =>
  Object.assign(new Error(message), { protocol: { code, message } });

function createPipeTarget(child, onLost, control) {
  const input = child.stdio[3],
    output = child.stdio[4];
  if (!input?.write || !output?.on)
    throw new TypeError("Missing Chromium debugging pipe");
  const bus = new EventEmitter();
  const waiting = new Map();
  const hostPageTargets = new Map(),
    rootFrames = new Map();
  let serial = 0,
    ended = false,
    pageActivated;
  function lost() {
    if (ended) return;
    ended = true;
    for (const p of waiting.values()) {
      clearTimeout(p.timer);
      p.fail(reject("Browser disconnected"));
    }
    waiting.clear();
    bus.emit("lost");
    onLost?.();
  }
  for (const [source, event] of [
    [child, "exit"],
    [child, "error"],
    [output, "end"],
    [output, "close"],
    [output, "error"],
    [input, "close"],
    [input, "error"],
  ])
    source.once(event, lost);
  let parts = [],
    length = 0;
  output.on("data", (chunk) => {
    if (ended) return;
    for (let pos = 0; pos < chunk.length;) {
      const end = chunk.indexOf(0, pos);
      const part = chunk.subarray(pos, end === -1 ? chunk.length : end);
      length += part.length;
      if (length > LIMIT) {
        lost();
        return;
      }
      parts.push(part);
      if (end === -1) return;
      let frame;
      try {
        frame = JSON.parse(Buffer.concat(parts, length).toString("utf8"));
      } catch {
        lost();
        return;
      }
      const frameBytes = length;
      parts = [];
      length = 0;
      pos = end + 1;
      if (control) control.forward(frame, frameBytes, receive, lost);
      else receive(frame);
    }
  });
  function receive(frame) {
    if (
      frame?.method === "Page.frameNavigated" &&
      !frame.params?.frame?.parentId
    ) {
      const page = hostPageTargets.get(frame.sessionId);
      if (page && frame.params?.frame?.id)
        rootFrames.set(page, frame.params.frame.id);
    }
    if (frame?.id !== undefined) {
      const p = waiting.get(frame.id);
      if (!p) return;
      waiting.delete(frame.id);
      clearTimeout(p.timer);
      if (frame.error)
        p.fail(
          Object.assign(new Error(frame.error.message), {
            protocol: frame.error,
          }),
        );
      else p.ok(frame.result || {});
    } else if (frame?.method) bus.emit("event", frame);
  }
  // Deliver WS responses synchronously at their exact wire position, just as
  // for unsolicited events. A Promise hop here reorders frames from one pipe
  // read: Playwright must handle Page.getFrameTree before Runtime context events.
  function request(method, params, sessionId, ok, fail, track) {
    if (ended) return fail(reject("Browser disconnected"));
    if (waiting.size >= 512 || input.writableLength > LIMIT)
      return fail(reject("Too many pending commands"));
    if (control?.handles(method, params)) {
      const operation = control.call(method, params).then(ok, fail);
      if (track) track(operation);
      return;
    }
    const id = ++serial;
    const timer = setTimeout(() => {
      waiting.delete(id);
      fail(reject("DevTools command timed out"));
    }, 30000);
    timer.unref();
    waiting.set(id, { ok, fail, timer, sessionId });
    try {
      input.write(JSON.stringify({ id, method, params, sessionId }) + "\0");
    } catch {
      lost();
    }
  }
  function command(method, params = {}, sessionId) {
    return new Promise((ok, fail) =>
      request(method, params, sessionId, ok, fail),
    );
  }
  function cancelHostCommands(sessionId) {
    // Closing a private host session must not leave its screenshot/navigation
    // promises and 30-second timers alive. Agent and sibling sessions are disjoint.
    for (const [id, pending] of waiting) {
      if (pending.sessionId !== sessionId) continue;
      waiting.delete(id);
      clearTimeout(pending.timer);
      pending.fail(reject("Preview session closed"));
    }
  }
  // Host-only capability. The browser/UI never receives this object or
  // the host session ID; broker clients retain their own disjoint session tree.
  const previewMethods = new Set([
    "Page.captureScreenshot",
    "Page.startScreencast",
    "Page.stopScreencast",
    "Page.screencastFrameAck",
    "Page.getLayoutMetrics",
    "Page.reload",
    "Page.enable",
    "Page.getFrameTree",
    "Page.navigate",
    "Page.bringToFront",
    "Input.dispatchMouseEvent",
    "Input.dispatchKeyEvent",
    "Input.insertText",
  ]);
  async function attachHostPage(targetId) {
    if (typeof targetId !== "string" || !targetId) throw reject("Missing page");
    const { sessionId } = await command("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    if (!sessionId) throw reject("No host page session");
    hostPageTargets.set(sessionId, targetId);
    let detached = false,
      unwatch;
    return Object.freeze({
      // Host-only; deliver only navigation events for this exact page session.
      onNavigation(callback) {
        if (detached || unwatch) throw reject("Unavailable page subscription");
        const lost = () => callback("lost");
        const event = (frame) => {
          if (
            frame.method === "Target.detachedFromTarget" &&
            frame.params?.sessionId === sessionId
          )
            lost();
          else if (
            frame.sessionId === sessionId &&
            (frame.method === "Page.frameNavigated" ||
              frame.method === "Page.navigatedWithinDocument")
          )
            callback(frame.method, frame.params);
        };
        bus.on("event", event);
        bus.on("lost", lost);
        unwatch = () => {
          bus.off("event", event);
          bus.off("lost", lost);
        };
      },
      // Never subscribe to the page target globally: an attached agent and
      // every other tab/session can independently start their own stream.
      onScreencastFrame(callback, onLoss, onVisibility) {
        if (detached || unwatch) throw reject("Unavailable page subscription");
        const event = (frame) => {
          if (
            frame.method === "Target.detachedFromTarget" &&
            frame.params?.sessionId === sessionId
          )
            onLoss();
          else if (
            frame.sessionId === sessionId &&
            frame.method === "Page.screencastFrame"
          )
            callback(frame.params);
          else if (
            frame.sessionId === sessionId &&
            frame.method === "Page.screencastVisibilityChanged"
          )
            onVisibility(frame.params?.visible === true);
        };
        bus.on("event", event);
        bus.on("lost", onLoss);
        unwatch = () => {
          bus.off("event", event);
          bus.off("lost", onLoss);
        };
      },
      async selection() {
        if (detached || ended) throw reject("Unavailable selection");
        let version = 0;
        const changed = (frame) => {
          if (
            frame.sessionId === sessionId &&
            [
              "Page.frameNavigated",
              "Runtime.executionContextsCleared",
            ].includes(frame.method)
          )
            version++;
        };
        bus.on("event", changed);
        try {
          const initial = version;
          return await readSelection(
            (method, params) => command(method, params, sessionId),
            () => !detached && !ended && version === initial,
          );
        } finally {
          bus.off("event", changed);
        }
      },
      async command(method, params) {
        if (detached || !previewMethods.has(method))
          throw reject("Unavailable preview command");
        const result = await command(method, params, sessionId);
        if (method === "Page.getFrameTree" && result.frameTree?.frame?.id)
          rootFrames.set(targetId, result.frameTree.frame.id);
        return result;
      },
      async close() {
        if (detached) return;
        detached = true;
        hostPageTargets.delete(sessionId);
        unwatch?.();
        cancelHostCommands(sessionId);
        // The page/process may already be gone. No other session is detached.
        await command("Target.detachFromTarget", { sessionId }).catch(() => {});
      },
    });
  }
  const target = Object.freeze({
    command: (method, params) => command(method, params),
    attachHostPage,
    onDocumentChanged(targetId, callback) {
      const event = (frame) => {
        if (hostPageTargets.get(frame.sessionId) !== targetId) return;
        if (
          frame.method === "Page.frameNavigated" &&
          !frame.params?.frame?.parentId
        )
          callback(true);
        else if (
          ["Page.frameStartedNavigating", "Page.frameStartedLoading"].includes(
            frame.method,
          ) &&
          rootFrames.get(targetId) === frame.params?.frameId
        )
          callback(false);
      };
      bus.on("event", event);
      return () => bus.off("event", event);
    },
    // Private host observer: the client can choose only a target in this
    // isolated browser, never an upstream address or the Desktop renderer.
    onPageActivated(callback) {
      if (pageActivated) throw reject("Page observer already installed");
      pageActivated = callback;
      return () => {
        if (pageActivated === callback) pageActivated = undefined;
      };
    },
  });
  // Native commands are scoped to Chromium's agent root. Helper RPCs are
  // instead scoped to the child, so detach alone cannot cancel accepted RPCs.
  let leaseFence = Promise.resolve();
  openPipe.set(target, async (send, onLoss) => {
    if (control) {
      let previous;
      do {
        previous = leaseFence;
        await previous;
      } while (previous !== leaseFence);
      if (ended) throw reject("Browser disconnected");
    }
    // Chromium owns the isolation boundary between browser target sessions. The
    // caller never becomes the pipe root and never chooses an upstream address.
    const { sessionId: root } = await command("Target.attachToBrowserTarget");
    if (!root || ended) throw reject("No browser session");
    const parents = new Map([[root, null]]);
    const pages = new Map(); // target IDs belong only to this client's sessions
    const autoDispose = new Set(),
      accepted = new Set();
    const track =
      control &&
      ((operation) => {
        // Rejected commands are completed too. Returned nested work (policy
        // installation/selection) belongs to the original lease until settled.
        const done = Promise.resolve(operation).catch(() => {});
        accepted.add(done);
        void done.then(() => accepted.delete(done));
      });
    let active = true;
    function forget(id) {
      if (!parents.delete(id)) return;
      pages.delete(id);
      for (const [childId, parentId] of parents)
        if (parentId === id) forget(childId);
    }
    function received(frame) {
      if (
        frame.method === "Target.detachedFromTarget" &&
        frame.params.sessionId === root
      ) {
        onLoss();
        return;
      }
      if (!parents.has(frame.sessionId)) return; // unsolicited host or retired session event
      if (frame.method === "Target.attachedToTarget") {
        parents.set(frame.params.sessionId, frame.sessionId);
        if (frame.params.targetInfo?.type === "page")
          pages.set(frame.params.sessionId, frame.params.targetInfo.targetId);
      }
      if (frame.method === "Target.detachedFromTarget")
        forget(frame.params.sessionId);
      send({
        ...frame,
        sessionId: frame.sessionId === root ? undefined : frame.sessionId,
      });
    }
    bus.on("event", received);
    bus.on("lost", onLoss);
    return {
      dispatch(req) {
        const { id, method, params = {}, sessionId } = req;
        const sid = sessionId === undefined ? root : sessionId;
        const fail = (error) => {
          if (active)
            send({
              id,
              error: error.protocol || {
                code: -32000,
                message: "Command failed",
              },
              sessionId,
            });
        };
        try {
          if (!parents.has(sid)) throw reject("Unknown session");
          if (
            control &&
            (method === "DOM.setFileInputFiles" ||
              (method === "Input.dispatchDragEvent" &&
                params.data?.files?.length) ||
              method === "Browser.grantPermissions" ||
              method === "Browser.setPermission")
          )
            throw reject(
              "Local files and permission overrides are unavailable",
            );
          if (
            control &&
            ["Page.navigate", "Network.loadNetworkResource"].includes(method) &&
            typeof params.url === "string" &&
            !/^(https?:|data:|blob:|about:blank$)/i.test(params.url.trim())
          )
            throw reject("Unsupported demonstration URL");
          if (
            method === "Browser.setDownloadBehavior" ||
            method === "Page.setDownloadBehavior"
          ) {
            // Playwright sends this on connect. Acknowledge without applying
            // client-selected paths or weakening the host's deny policy.
            send({ id, result: {}, sessionId });
            return;
          }
          // Originating a new browser root or bypassing flat session routing
          // breaks handoff; browser process lifetime belongs to the host.
          if (
            [
              "Target.attachToBrowserTarget",
              "Target.sendMessageToTarget",
              "Target.exposeDevToolsProtocol",
              "Target.setRemoteLocations",
              "Browser.close",
              "Browser.crash",
              "Browser.crashGpuProcess",
            ].includes(method) ||
            method.startsWith("Tethering.") ||
            (method === "Target.detachFromTarget" &&
              parents.get(params.sessionId) !== sid) ||
            (method === "Target.attachToTarget" && params.flatten !== true)
          )
            throw reject("Command unavailable in this lease");
          request(
            method,
            params,
            sid,
            (result) => {
              if (
                method === "Target.createBrowserContext" &&
                result.browserContextId
              ) {
                // A regular Playwright newContext is supported too. Install
                // the policy in the new context before handing out its id.
                const context = { browserContextId: result.browserContextId };
                if (control && params.disposeOnDetach === true)
                  autoDispose.add(context.browserContextId);
                if (control && !active) return; // close() disposes after all accepted creates finish
                return command("Browser.setDownloadBehavior", {
                  behavior: "deny",
                  ...context,
                }).then(
                  () => {
                    if (active) send({ id, result, sessionId });
                  },
                  async () => {
                    try {
                      await command("Target.disposeBrowserContext", context);
                      autoDispose.delete(context.browserContextId);
                    } catch {
                      if (control) lost();
                    }
                    fail(reject("Cannot secure browser context"));
                  },
                );
              }
              if (method === "Target.disposeBrowserContext")
                autoDispose.delete(params.browserContextId);
              if (!active) return;
              const activatedPage =
                method === "Target.activateTarget"
                  ? params.targetId
                  : method === "Page.bringToFront"
                    ? pages.get(sid)
                    : undefined;
              if (activatedPage && pageActivated) {
                // Acknowledge activation only after frame/input/address all
                // refer to the selected page. Failed browser commands never
                // reach this observer. Closing the agent leaves the page shown.
                const notify = pageActivated;
                const following = notify(activatedPage).then(
                  () => {
                    if (active) send({ id, result, sessionId });
                  },
                  () => fail(reject("Cannot display the activated page")),
                );
                if (track) track(following);
                return;
              }
              if (method === "Target.attachToTarget" && result.sessionId) {
                parents.set(result.sessionId, sid);
                pages.set(result.sessionId, params.targetId);
              }
              send({ id, result, sessionId });
            },
            fail,
            track,
          );
        } catch (error) {
          fail(error);
        }
      },
      close() {
        if (!active) return control ? leaseFence : undefined;
        active = false;
        bus.off("event", received);
        bus.off("lost", onLoss);
        parents.clear();
        pages.clear();

        // Never close/reload the page or browser during handoff.
        void command("Target.detachFromTarget", { sessionId: root }).catch(
          () => {},
        );
        if (control) {
          let timer;
          const work = async () => {
            await Promise.all([...accepted]);
            // The entire helper queue has drained for this lease. Only
            // contexts explicitly requested to die on detach are disposable.
            await Promise.all(
              [...autoDispose].map((browserContextId) =>
                command("Target.disposeBrowserContext", { browserContextId }),
              ),
            );
            autoDispose.clear();
          };
          const timeout = new Promise((_, rejectTimeout) => {
            timer = setTimeout(
              () => rejectTimeout(Error("Lease drain timed out")),
              10000,
            );
            timer.unref();
          });
          const drained = Promise.race([work(), timeout])
            .catch(() => {
              // The outcome is unknown. Revoke this child's pipe; its owner's
              // normal teardown stops this show, not the shell or any neighbor.
              lost();
            })
            .finally(() => clearTimeout(timer));
          leaseFence = Promise.all([leaseFence, drained]).then(() => {});
          return leaseFence;
        }
      },
    };
  });
  return target;
}

// The fixed loopback port is the only listener; all upstream communication is over private FDs.
const WS_PATH = "/devtools/browser";
const stale = () =>
  Object.assign(Error(t("hostTerminal.requestStale")), {
    status: 409,
  });
const conflict = (text) => Object.assign(Error(text), { status: 409 });
function refuse(socket, code) {
  if (socket.destroyed) return;
  socket.end(
    "HTTP/1.1 " +
      code +
      " Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
  );
  socket.destroySoon(); // also release upgraded sockets whose peer never sends FIN
}
function allowed(req, port) {
  const h = req.headers,
    authority = h.host;
  // Never reflect forwarded headers or accept a DNS name controlled by a caller.
  const hosts = ["127.0.0.1", "localhost", "host.docker.internal"];
  if (
    !hosts.some(
      (name) =>
        authority === name + ":" + port || (port === 80 && authority === name),
    )
  )
    return false;
  if (
    req.headersDistinct.host?.length !== 1 ||
    h.origin !== undefined ||
    h["sec-websocket-origin"] !== undefined ||
    (h["sec-fetch-site"] !== undefined &&
      !["none", "same-origin"].includes(h["sec-fetch-site"]))
  )
    return false;
  if (h.referer !== undefined) {
    try {
      if (new URL(h.referer).origin !== new URL("http://" + authority).origin)
        return false;
    } catch {
      return false;
    }
  }
  return true;
}
function createAgentBroker({ resolveUpstream, attachTimeoutMs = 10000 } = {}) {
  if (typeof resolveUpstream !== "function")
    throw TypeError(t("hostTerminal.browserMissing"));
  if (
    !Number.isSafeInteger(attachTimeoutMs) ||
    attachTimeoutMs < 1 ||
    attachTimeoutMs > 2147483647
  )
    throw RangeError(t("hostTerminal.attachmentTimeoutInvalid"));
  const upgrades = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    maxPayload: LIMIT,
    perMessageDeflate: false,
  });
  let current = null,
    closed = false;
  const alive = (l) => current === l && !l.dead;
  const state = () => {
    const l = current && !current.dead ? current : null;
    return {
      phase: l?.client
        ? l.client.ws
          ? "connected"
          : "connecting"
        : l?.phase || "idle",
      slotId: l?.slotId ?? null,
      port: l?.port ?? null,
      connectionId: l?.client?.id ?? null,
    };
  };
  // Server ownership lasts for the entire show; a connection is disposable.
  // Every delayed callback is tied to that exact connection, not its slot or port.
  const owns = (l, c) => alive(l) && l.client === c;
  function drop(l, c, code = 0) {
    if (l.client !== c) return;
    l.client = null;
    clearTimeout(c.timer);
    const drain = c.channel?.close();
    if (drain) l.drain = drain;
    if (c.ws) c.ws.terminate();
    else if (code) refuse(c.socket, code);
    else c.socket.destroy();
  }
  function retire(l, code = 0) {
    if (l.dead) return l.stopped;
    l.dead = true;
    if (l.client) drop(l, l.client, code);
    // A release can arrive during listen(host) DNS resolution; wait for that
    // specific server's bind before closing it, even if we never became armed.
    l.stopped = (async () => {
      await l.binding.catch(() => {});
      if (l.server.listening) {
        const done = new Promise((r) => l.server.close(r));
        l.server.closeAllConnections();
        await done;
      }
      if (current === l) current = null;
    })();
    return l.stopped;
  }
  function request(l, req, res) {
    const send = (code, body = "", type = "text/plain") => {
      res.writeHead(code, {
        "content-type": type + "; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
        "cross-origin-resource-policy": "same-origin",
      });
      res.end(body);
    };
    if (!alive(l) || !allowed(req, l.port)) return send(403);
    if (req.method !== "GET") return send(405);
    if (req.url === "/")
      return send(
        200,
        t("hostTerminal.agentPort"),
      );
    if (req.url !== "/json/version" && req.url !== "/json/version/")
      return send(404);
    // No page URL, browser/slot IDs, connection IDs or claim tokens in discovery.
    send(
      200,
      JSON.stringify({
        Browser: "Goga Desktop",
        "Protocol-Version": "1.3",
        webSocketDebuggerUrl: "ws://" + req.headers.host + WS_PATH,
      }),
      "application/json",
    );
  }
  function incoming(l, req, socket, head) {
    // Install a listener even on rejected upgrades: a peer may reset before a refusal flushes.
    let c;
    socket.on("error", () => {
      if (c) drop(l, c);
    });
    if (!alive(l) || !allowed(req, l.port)) return refuse(socket, 403);
    if (req.url !== WS_PATH) return refuse(socket, 404);
    if (
      req.method !== "GET" ||
      req.headers.upgrade?.toLowerCase() !== "websocket" ||
      req.headers["sec-websocket-version"] !== "13" ||
      req.headersDistinct["sec-websocket-key"]?.length !== 1 ||
      !/^[A-Za-z0-9+/]{22}==$/.test(req.headers["sec-websocket-key"] || "") ||
      req.headers["sec-websocket-protocol"] !== undefined ||
      head.length
    )
      return refuse(socket, 400);
    if (l.phase !== "armed" || l.client) return refuse(socket, 409);
    // Reserve before calling ANY async code, including the upstream resolver.
    // Discovery alone cannot reserve the show. No approval or waiting timer.
    c = { id: randomBytes(16).toString("hex"), slotId: l.slotId, socket };
    l.client = c;
    socket.once("close", () => drop(l, c));
    socket.once("end", () => drop(l, c));
    const early = () => drop(l, c, 400);
    socket.once("data", early);
    socket.resume();
    c.timer = setTimeout(() => drop(l, c, 504), attachTimeoutMs).unref();
    void attach(l, c, req, early).catch(() => drop(l, c, 502));
  }
  async function arm(slotId, port) {
    if (typeof slotId !== "string" || !slotId)
      throw TypeError(t("hostTerminal.contextMissing"));
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw RangeError(t("hostTerminal.fullPortRange"));
    const draining = current?.dead ? current.stopped : null;
    if (closed) throw conflict(t("hostTerminal.panelClosed"));
    if (current && !current.dead)
      throw conflict(t("hostTerminal.releasePort"));
    const l = { phase: "arming", slotId, port };
    current = l;
    const server = (l.server = http.createServer((req, res) =>
      request(l, req, res),
    ));
    server.maxConnections = 64;
    server.headersTimeout = 10000;
    server.on("connect", (_req, socket) => {
      socket.on("error", () => {});
      refuse(socket, 403);
    });
    server.on("upgrade", (req, socket, head) => incoming(l, req, socket, head));
    // Reserve the next arm synchronously even if an earlier listener is
    // draining. An immediate release(slotId) must see and cancel THIS arm.
    l.binding = (async () => {
      if (draining) await draining;
      if (!alive(l)) throw stale();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
    })();
    try {
      await l.binding;
      if (!alive(l)) throw stale();
      l.phase = "armed";
      return state();
    } catch (e) {
      await retire(l);
      if (e.code === "EADDRINUSE")
        throw Object.assign(
          conflict(t("hostTerminal.portBusy")),
          { code: e.code },
        );
      throw e;
    }
  }
  async function attach(l, c, req, early) {
    const target = await resolveUpstream(c.slotId);
    if (!owns(l, c)) return;
    const open = openPipe.get(target);
    if (!open) throw Error(t("hostTerminal.privateConnectionMissing"));
    const channel = await open(
      (frame) => {
        if (!owns(l, c) || !c.ws) return;
        if (c.ws.bufferedAmount > LIMIT) {
          drop(l, c);
          return;
        }
        c.ws.send(JSON.stringify(frame), (err) => {
          if (err) drop(l, c);
        });
      },
      () => drop(l, c),
    );
    // Release, timeout, transport loss or handoff may have happened during
    // attach. Never install this root on a newer connection (even in the same show).
    if (!owns(l, c)) {
      channel.close();
      return;
    }
    c.channel = channel;
    if (!c.socket.readable || !c.socket.writable || c.socket.destroyed)
      throw stale();
    c.socket.off("data", early);
    upgrades.handleUpgrade(req, c.socket, Buffer.alloc(0), (ws) => {
      c.ws = ws;
      clearTimeout(c.timer);
      ws.on("error", () => drop(l, c));
      ws.once("close", () => drop(l, c));
      ws.on("message", (data, binary) => {
        if (!owns(l, c)) return;
        try {
          if (binary) throw Error();
          const cmd = JSON.parse(data.toString());
          if (
            !Number.isSafeInteger(cmd?.id) ||
            typeof cmd.method !== "string" ||
            (cmd.params !== undefined &&
              (!cmd.params ||
                typeof cmd.params !== "object" ||
                Array.isArray(cmd.params)))
          )
            throw Error();
          channel.dispatch(cmd);
        } catch {
          drop(l, c);
        }
      });
    });
    if (!c.ws) throw stale();
  }
  async function handoff(fromSlotId, toSlotId) {
    const l = current;
    if (!l || !alive(l) || l.phase !== "armed" || l.slotId !== fromSlotId)
      throw stale();
    if (typeof toSlotId !== "string" || !toSlotId)
      throw TypeError(t("hostTerminal.contextMissing"));
    if (l.client) drop(l, l.client, 410);
    // Forget pre-handoff HTTP keepalives/partial handshakes as well. Keep the
    // listening socket bound throughout so another process cannot steal the port.
    l.server.closeAllConnections();
    if (l.drain) {
      // Reject new handshakes during explicit transfer. On an ordinary
      // disconnect openPipe's own fence waits before exposing another root.
      l.phase = "arming";
      await l.drain;
      if (!alive(l)) throw stale();
      l.phase = "armed";
      l.drain = null;
    }
    l.slotId = toSlotId;
    return state();
  }
  return {
    state,
    arm,
    handoff,
    release: async (slotId) => {
      if (current?.slotId === slotId) await retire(current, 410);
    },
    close: async () => {
      closed = true;
      if (current) await retire(current, 410);
    },
  };
}
module.exports = { createPipeTarget, createAgentBroker, installDemoFormatter: require("./messages.cjs").install };

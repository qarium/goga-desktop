// Private per-child RPC for Electron-only target lifecycle. Page CDP and its
// strict event/response order remain unchanged on the real Chromium pipe.
const { createInterface } = require("node:readline");
const LIMIT = 16 * 1024 * 1024;
const supported = new Set([
  "Target.createTarget", "Target.closeTarget", "Target.activateTarget",
  "Target.createBrowserContext", "Target.getBrowserContexts", "Target.disposeBrowserContext",
  "Browser.setDownloadBehavior", "Storage.getCookies", "Storage.setCookies", "Storage.clearCookies",
]);
function createEmbeddedControl(proc) {
  const pending = new Map(), hidden = new Set(), hiddenSessions = new Set();
  // A temporary WebContents is required to discover an Electron Session's
  // native context ID or run native cookie commands before its first page.
  // Hold native delivery during these private RPCs; never publish that target
  // or its transient auto-attached sessions, even to a concurrent observer.
  let gates=0, size=0, buffered=[];
  function filtered(frame, accept) {
    const p=frame.params||{};
    const hiddenTarget=hidden.has(p.targetInfo?.targetId)||hidden.has(p.targetId);
    if (frame.method==="Target.attachedToTarget" && (hiddenTarget||hiddenSessions.has(frame.sessionId)))
      hiddenSessions.add(p.sessionId);
    if (frame.method==="Target.detachedFromTarget" && hiddenSessions.delete(p.sessionId)) return;
    if (hiddenTarget||hiddenSessions.has(frame.sessionId)) return;
    if (frame.result?.targetInfos) frame.result.targetInfos=frame.result.targetInfos.filter(t=>!hidden.has(t.targetId));
    accept(frame);
  }
  function endGate() {
    if (--gates || closed) return;
    const saved=buffered; buffered=[];size=0;
    for (const [frame,accept] of saved) filtered(frame,accept);
  }
  let serial = 0, pendingBytes = 0, closed = false;
  function close() {
    if (closed) return;
    closed = true;buffered=[];size=0;pendingBytes=0;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error("Браузер демонстрации отключён."));
    }
    pending.clear();
  }
  const lines = createInterface({ input: proc.stdout });
  lines.on("line", line => {
    if (!line.startsWith("goga-demo:")) return;
    let msg;
    try { msg = JSON.parse(line.slice(10)); } catch { close(); return; }
    if (typeof msg.hide==="string") {
      hidden.add(msg.hide);
      // Closed targets are never reused. Bound metadata for a long-lived show.
      if(hidden.size>1024) hidden.delete(hidden.values().next().value);
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(msg.id); pendingBytes -= p.bytes;
    if(p.gated) endGate();
    msg.error ? p.reject(Error(msg.error)) : p.resolve(msg.result);
  });
  lines.once("close", close);
  proc.stdin.on("error", close);
  proc.once("exit", close);
  return {
    handles: (m,p) => supported.has(m) && (!m.startsWith("Storage.") || typeof p.browserContextId==="string"),
    forward(frame, n, accept, fail) {
      if(closed) return fail();
      if(gates) {
        size+=n;
        if(size>LIMIT || buffered.length>=1024) {close();fail();return;}
        buffered.push([frame,accept]);
      } else filtered(frame,accept);
    },
    call(method, params) {
      return new Promise((resolve, reject) => {
        if (!supported.has(method) || closed || pending.size >= 128)
          throw Error("Команда показа недоступна.");
        const id = ++serial, data = JSON.stringify({id, method, params});
        const bytes=Buffer.byteLength(data)+1;
        if (pendingBytes + bytes > LIMIT) throw Error("Слишком большая команда показа.");
        const gated=method==="Target.createBrowserContext" || method.startsWith("Storage.");
        if(gated) gates++;
        pendingBytes += bytes;
        const timer = setTimeout(() => {
          // If the parent cannot prove whether a mutation ran, no later client
          // may reuse the child. Abandon all RPCs, not just gated ones.
          close(); proc.kill();
        }, 10000);
        timer.unref();
        pending.set(id, { resolve, reject, timer, gated, bytes });
        proc.stdin.write(data + "\n");
      });
    },
  };
}
module.exports = { createEmbeddedControl };

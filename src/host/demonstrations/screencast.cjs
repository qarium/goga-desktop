"use strict";
const { text: t } = require("./messages.cjs");

const { randomUUID } = require("node:crypto");

// One private CDP subscription per selected page, shared by its Desktop and
// browser viewers. Demand is a bounded long poll; images are not a FIFO.
function createScreencast(connect, snapshot) {
  const unavailable = () => Error(t("hostTerminal.streamUnavailable"));
  const WAIT_MS = 800,
    IDLE_MS = 1600,
    FIRST_MS = 3500;
  let active,
    closed = false,
    releasing = Promise.resolve();

  function settle(s, frame, error) {
    for (const w of s.waiters) {
      clearTimeout(w.timer);
      if (error) w.reject(error);
      else w.resolve(frame);
    }
    s.waiters.clear();
  }
  function retire(s) {
    if (active !== s) return;
    active = undefined;
    clearTimeout(s.idle);
    clearTimeout(s.first);
    clearTimeout(s.snapshotTimer);
    s.latest = undefined;
    settle(s, null, unavailable());
    releasing = s.attaching.then(
      async (session) => {
        // Send stop before detach, but never wait on an unresponsive encoder.
        // close() cancels only requests of this private session.
        if (s.started)
          void session.command("Page.stopScreencast").catch(() => {});
        await session.close();
      },
      () => {},
    );
  }
  function publish(s, pixels) {
    s.latest = { cursor: randomUUID(), pixels };
    settle(s, s.latest);
  }
  // Compatibility only: older Chromium or a background target may not emit
  // compositor frames. Never bring a page to front or use a different target.
  function fallback(s) {
    if (
      active !== s ||
      !s.fallback ||
      !s.session ||
      !s.waiters.size ||
      s.taking ||
      s.snapshotTimer
    )
      return;
    const delay = Math.max(0, 650 - (Date.now() - (s.lastShot || 0)));
    s.snapshotTimer = setTimeout(async () => {
      s.snapshotTimer = undefined;
      if (active !== s || !s.fallback || !s.waiters.size) return;
      s.taking = true;
      s.lastShot = Date.now();
      const previous = s.latest;
      try {
        const pixels = await snapshot(s.session);
        if (active === s && s.fallback && s.latest === previous)
          publish(s, pixels);
      } catch {
        if (active === s && s.fallback) retire(s);
      } finally {
        s.taking = false;
        fallback(s);
      }
    }, delay);
    s.snapshotTimer.unref?.();
  }
  function begin() {
    const s = { waiters: new Set(), latest: undefined, started: false };
    active = s;
    s.attaching = releasing.then(() => {
      if (s !== active) throw unavailable();
      return connect();
    });
    void s.attaching
      .then(async (session) => {
        if (active !== s) return;
        s.session = session;
        session.onScreencastFrame(
          (payload) => {
            if (active !== s) return;
            if (
              !payload ||
              !Number.isSafeInteger(payload.sessionId) ||
              typeof payload.data !== "string" ||
              !payload.data.length ||
              payload.data.length > 15 * 1024 * 1024
            ) {
              retire(s);
              return;
            }
            void session
              .command("Page.screencastFrameAck", {
                sessionId: payload.sessionId,
              })
              .catch(() => retire(s));
            // A buffered last frame may arrive after Chromium reports hidden.
            // Ack it to release Chrome's buffer, but it cannot replace a newer
            // fallback image or cancel compatibility capture.
            if (s.hidden) return;
            clearTimeout(s.first);
            s.fallback = false;
            publish(s, Buffer.from(payload.data, "base64"));
          },
          () => retire(s),
          (visible) => {
            if (active !== s) return;
            s.hidden = !visible;
            // Keep fallback on until real frames resume (visibility is not a frame).
            if (!visible) {
              s.fallback = true;
              fallback(s);
            }
          },
        );
        s.started = true;
        try {
          await session.command("Page.startScreencast", {
            // Full native default Retina viewport (2200×1156) fits. The cap
            // bounds even an incompressible PNG/base64 event on the 16 MiB pipe.
            format: "png",
            maxWidth: 2250,
            maxHeight: 1300,
            everyNthFrame: 1,
          });
        } catch (error) {
          if (error?.protocol?.code !== -32601) throw error;
          clearTimeout(s.first);
          s.started = false;
          s.fallback = true;
          fallback(s);
        }
      })
      .catch(() => retire(s));
    // Chromium may accept start but never supply a frame (e.g. a lost tab).
    // Demand-driven snapshots preserve access until real frames start.
    s.first = setTimeout(() => {
      s.fallback = true;
      fallback(s);
    }, FIRST_MS);
    s.first.unref?.();
    return s;
  }
  async function nextFrame(after) {
    if (closed) throw unavailable();
    const s = active || begin();
    if (s.waiters.size >= 8) throw Error(t("hostTerminal.tooManyFrameRequests"));
    clearTimeout(s.idle);
    s.idle = setTimeout(() => retire(s), IDLE_MS);
    s.idle.unref?.();
    if (s.latest && s.latest.cursor !== after) return s.latest;
    return new Promise((resolve, reject) => {
      const w = {
        resolve,
        reject,
        timer: setTimeout(() => {
          s.waiters.delete(w);
          resolve(null);
        }, WAIT_MS),
      };
      w.timer.unref?.();
      s.waiters.add(w);
      fallback(s);
    });
  }
  function close() {
    closed = true;
    if (active) retire(active);
    return releasing;
  }
  return { nextFrame, close };
}
module.exports = { createScreencast };

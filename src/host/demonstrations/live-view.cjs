"use strict";

// Host-only view of the already-open page in one dedicated Chrome process.
// No URLs, CDP sessions, arbitrary methods or runtime evaluation cross the UI boundary.
const { createScreencast } = require("./screencast.cjs");
const keys = new Map(
  Object.entries({
    Enter: 13,
    Tab: 9,
    Backspace: 8,
    Delete: 46,
    Escape: 27,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
  }),
);
const normalized = (n) => Number.isFinite(n) && n >= 0 && n <= 1;

function createLiveView(pipeTarget, { targetId, ownsPage = () => true } = {}) {
  if (!pipeTarget || typeof pipeTarget.attachHostPage !== "function")
    throw new TypeError(
      "Для показа нужна закрытая связь с браузером этого контекста.",
    );
  let closed = false,
    attaching,
    captureAttaching,
    capturing,
    cancelCapture,
    closing,
    tail = Promise.resolve(),
    pending = 0,
    drag,
    dragTimer,
    documentEpoch = 0;
  const retiredGestures = new Set();
  const unwatchDocument =
    targetId &&
    pipeTarget.onDocumentChanged?.(targetId, (committed) => {
      ++documentEpoch;
      const prior = drag;
      if (!prior) return;
      retireGesture(prior.id);
      clearTimeout(dragTimer);
      if (committed) {
        // The renderer document has already been replaced. The old selection is
        // gone; never synthesize a release/click in the replacement document.
        drag = undefined;
      } else {
        const cleanup = tail.then(() => releaseDrag(prior));
        tail = cleanup.catch(() => {});
      }
    });
  const requireOpen = () => {
    if (closed || !ownsPage()) throw Error("Показ закрыт.");
  };
  async function connect() {
    requireOpen();
    if (targetId === undefined) {
      const { targetInfos } = await pipeTarget.command("Target.getTargets");
      const pages = targetInfos.filter((p) => p.type === "page");
      if (pages.length !== 1)
        throw Error("Не удалось однозначно определить страницу показа.");
      targetId = pages[0].targetId;
    }
    requireOpen();
    return pipeTarget.attachHostPage(targetId);
  }
  const stream = createScreencast(connect, snapshot);
  // Serialize host gestures so a second click/key cannot split a press and release.
  // This queue is private to the view; it never waits for a broker lease.
  function run(fn) {
    if (closed) return Promise.reject(Error("Показ закрыт."));
    if (pending >= 48)
      return Promise.reject(Error("Слишком много действий показа."));
    ++pending;
    const task = tail.then(async () => {
      requireOpen();
      const session = await (attaching ||= connect());
      requireOpen();
      return fn(session);
    });
    tail = task.then(
      () => {
        --pending;
      },
      () => {
        --pending;
      },
    );
    return task;
  }
  function runInput(fn) {
    return run(async (session) => {
      // Screenshots work for background tabs too, but Chromium may never ack
      // wheel/key input there. An explicit user gesture belongs to the shown
      // page, even if an unselected sibling has acquired browser focus.
      await session.command("Page.bringToFront");
      requireOpen();
      if (drag?.releaseFailed)
        throw Error(
          "Не удалось подтвердить отпускание мыши. Отмените жест или переоткройте показ.",
        );
      return fn(session);
    });
  }
  async function viewport(session) {
    const { cssVisualViewport: v } = await session.command(
      "Page.getLayoutMetrics",
    );
    if (!(
      Number.isFinite(v?.clientWidth) &&
      v.clientWidth >= 1 &&
      Number.isFinite(v.clientHeight) &&
      v.clientHeight >= 1 &&
      Number.isFinite(v.pageX) &&
      Number.isFinite(v.pageY)
    ))
      throw Error("Не удалось определить размеры страницы показа.");
    return v;
  }
  async function point(session, x, y) {
    const v = await viewport(session);
    // Input expects coordinates relative to the visible main frame, not the
    // scrolled document or the shell thumbnail. Right/bottom edges are exclusive.
    return {
      x: Math.min(v.clientWidth - 1, x * v.clientWidth),
      y: Math.min(v.clientHeight - 1, y * v.clientHeight),
    };
  }
  async function snapshot(session) {
    const v = await viewport(session);
    requireOpen();
    const { data } = await session.command("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip: {
        x: v.pageX,
        y: v.pageY,
        width: v.clientWidth,
        height: v.clientHeight,
        scale: 1,
      },
    });
    requireOpen();
    if (!data) throw Error("Браузер не вернул кадр.");
    return Buffer.from(data, "base64");
  }
  function frame() {
    if (closed) return Promise.reject(Error("Показ закрыт."));
    if (!capturing) {
      let cancel;
      const canceled = new Promise((_, reject) => {
        cancel = () => reject(Error("Показ закрыт."));
      });
      cancelCapture = cancel;
      const capture = (async () => {
        // Capture has its own private session/lane. Detaching it can cancel a
        // background screenshot without splitting a mouse/key press and release.
        const session = await (captureAttaching ||= connect());
        requireOpen();
        return snapshot(session);
      })();
      capturing = Promise.race([capture, canceled]).finally(() => {
        capturing = undefined;
        if (cancelCapture === cancel) cancelCapture = undefined;
      });
    }
    return capturing;
  }
  function retireGesture(id) {
    retiredGestures.add(id);
    if (retiredGestures.size > 1024)
      retiredGestures.delete(retiredGestures.values().next().value);
  }
  async function releaseDrag(expected = drag) {
    if (!expected || drag !== expected) return;
    clearTimeout(dragTimer);
    retireGesture(expected.id);
    try {
      await expected.session.command("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...expected.xy,
        button: "left",
        buttons: 0,
        clickCount: expected.clickCount,
      });
      if (drag === expected) drag = undefined;
    } catch (error) {
      // Unknown delivery is not proof of release. Keep the exact old session
      // and fence new input until cancel/close retries the acknowledgement.
      if (drag === expected) expected.releaseFailed = true;
      throw error;
    }
  }
  function refreshDragTimer(expected) {
    clearTimeout(dragTimer);
    dragTimer = setTimeout(() => {
      // Cleanup uses the old page's exact session, not whatever tab is active
      // now. It must remain possible after losing display/renderer ownership.
      const task = tail.then(() => releaseDrag(expected));
      tail = task.catch(() => {});
    }, 10000);
    dragTimer.unref?.();
  }
  async function pointer(input) {
    const { phase, gestureId, x, y, clickCount = 1 } = input || {};
    if (
      !["down", "move", "up", "cancel"].includes(phase) ||
      typeof gestureId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(gestureId) ||
      !normalized(x) ||
      !normalized(y) ||
      !Number.isInteger(clickCount) ||
      clickCount < 1 ||
      clickCount > 3
    )
      throw TypeError("Неверный жест выделения.");
    if (phase === "cancel") {
      // Cancellation can arrive while down awaits connection, metrics or its
      // press acknowledgement. Tombstone immediately, not after that queue.
      retireGesture(gestureId);
      return run(async () => {
        if (drag?.id === gestureId) await releaseDrag();
      });
    }
    const epoch = documentEpoch;
    const requireGesture = () => {
      requireOpen();
      if (epoch !== documentEpoch || retiredGestures.has(gestureId))
        throw Error("Жест уже завершён или заменён.");
    };
    const execute = phase === "down" ? runInput : run;
    return execute(async (session) => {
      if (phase === "down") {
        if (drag || retiredGestures.has(gestureId))
          throw Error("Жест уже завершён или заменён.");
        const xy = await point(session, x, y);
        requireGesture();
        await session.command("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          ...xy,
        });
        requireGesture();
        const current = { id: gestureId, session, xy, clickCount };
        drag = current;
        try {
          await session.command("Input.dispatchMouseEvent", {
            type: "mousePressed",
            ...xy,
            button: "left",
            buttons: 1,
            clickCount,
          });
          requireGesture();
          refreshDragTimer(current);
        } catch (error) {
          await releaseDrag(current).catch(() => {});
          throw error;
        }
      } else {
        const current = drag;
        if (!current || current.id !== gestureId)
          throw Error("Жест уже завершён или заменён.");
        try {
          const xy = await point(session, x, y);
          requireGesture();
          current.xy = xy;
          if (phase === "up") await releaseDrag(current);
          else {
            await session.command("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              ...xy,
              button: "left",
              buttons: 1,
            });
            requireGesture();
            refreshDragTimer(current);
          }
        } catch (error) {
          await releaseDrag(current).catch(() => {});
          throw error;
        }
      }
    });
  }
  function selection() {
    return runInput(async (session) => {
      // A keyboard copy follows all accepted pointer packets on this private
      // lane. It never invokes the remote page's clipboard handlers.
      await releaseDrag();
      requireOpen();
      const text = await session.selection();
      requireOpen();
      if (
        typeof text !== "string" ||
        Buffer.byteLength(text, "utf8") > 1024 * 1024
      )
        throw Error("Выделенный текст слишком большой для копирования.");
      return text;
    });
  }
  async function click(x, y) {
    if (!normalized(x) || !normalized(y))
      throw TypeError("Неверные координаты.");
    return runInput(async (session) => {
      const xy = await point(session, x, y);
      requireOpen();
      await session.command("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...xy,
      });
      requireOpen();
      await session.command("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...xy,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await session.command("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...xy,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
    });
  }
  async function scroll(x, y, deltaY) {
    if (
      !normalized(x) ||
      !normalized(y) ||
      !Number.isFinite(deltaY) ||
      Math.abs(deltaY) > 2000
    )
      throw TypeError("Неверная прокрутка.");
    return runInput(async (session) => {
      const xy = await point(session, x, y);
      requireOpen();
      return session.command("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        ...xy,
        deltaX: 0,
        deltaY,
      });
    });
  }
  async function key(key) {
    if (!keys.has(key)) throw TypeError("Эта клавиша не поддерживается.");
    return runInput(async (session) => {
      const vk = keys.get(key),
        args = { key, code: key, windowsVirtualKeyCode: vk };
      await session.command("Input.dispatchKeyEvent", {
        ...args,
        type: key === "Enter" ? "keyDown" : "rawKeyDown",
        ...(key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}),
      });
      await session.command("Input.dispatchKeyEvent", {
        ...args,
        type: "keyUp",
      });
    });
  }
  async function text(text) {
    if (
      typeof text !== "string" ||
      !text.length ||
      text.length > 2048 ||
      /[\x00-\x1f\x7f-\x9f]/u.test(text)
    )
      throw TypeError("Недопустимый текст.");
    return runInput((session) => session.command("Input.insertText", { text }));
  }
  function close() {
    if (!closing) {
      closed = true;
      clearTimeout(dragTimer);
      cancelCapture?.();
      const releaseCapture = (async () => {
        // Do not await capture: a background tab may never acknowledge it.
        // The exact host session is detached, canceling only its own commands.
        const session = await captureAttaching?.catch(() => undefined);
        await session?.close();
      })();
      const releaseGestures = tail.then(async () => {
        // Finish the in-flight gesture and release any drag before detaching
        // its exact private session. Queued gestures see the closed fence.
        const session = await attaching?.catch(() => undefined);
        try {
          try {
            await releaseDrag();
          } catch {
            await releaseDrag();
          }
        } finally {
          try {
            await session?.close();
          } finally {
            unwatchDocument?.();
          }
        }
      });
      closing = Promise.allSettled([
        releaseCapture,
        releaseGestures,
        stream.close(),
      ]).then((results) => {
        const failure = results.find((result) => result.status === "rejected");
        if (failure) throw failure.reason;
      });
    }
    return closing;
  }

  return Object.freeze({
    frame,
    nextFrame: stream.nextFrame,
    click,
    pointer,
    hasInputActivity: () => pending > 0 || !!drag,
    selection,
    text,
    key,
    scroll,
    close,
  });
}

module.exports = { createLiveView };

import { t } from "../../shared/i18n";
import { useLocale } from "../useLocale";
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import type { DemoInput } from "../../shared/demonstrations";
import { demoError } from "./directory";
import { Copy } from "lucide-react";
import "../ProjectListMenu.css";

function point(canvas: HTMLCanvasElement, x: number, y: number, clamp = false) {
  const r = canvas.getBoundingClientRect();
  if (!canvas.width || !canvas.height || !r.width || !r.height) return null;
  const scale = Math.min(r.width / canvas.width, r.height / canvas.height);
  const w = canvas.width * scale,
    h = canvas.height * scale,
    nx = (x - r.x - (r.width - w) / 2) / w,
    ny = (y - r.y - (r.height - h) / 2) / h;
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;
  return clamp
    ? { x: Math.max(0, Math.min(1, nx)), y: Math.max(0, Math.min(1, ny)) }
    : nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1
      ? { x: nx, y: ny }
      : null;
}
type FrameProps = {
  showId: string;
  tabId?: string | null;
  disabled: boolean;
  onError: (m: string) => void;
};
export function DemoFrame(props: FrameProps) {
  return (
    <Surface
      key={JSON.stringify([props.showId, props.tabId ?? null])}
      {...props}
    />
  );
}
type Owner = { showId: string; tabId?: string };
type Gesture = {
  id: string;
  pointerId: number;
  owner: Owner;
  x: number;
  y: number;
  clickCount: number;
};
type PendingCopy = { id: string; owner: Owner; started: boolean };
type Task =
  { owner: Owner; input: DemoInput } | { owner: Owner; copy: PendingCopy };
function Surface({ showId, tabId, disabled, onError }: FrameProps) {
  useLocale();
  const ref = useRef<HTMLCanvasElement>(null),
    live = useRef(false),
    painted = useRef<Owner | null>(null),
    queue = useRef<Task[]>([]),
    draining = useRef(false),
    drag = useRef<Gesture | null>(null),
    gestures = useRef(new Map<string, Gesture>()),
    pendingCopy = useRef<PendingCopy | null>(null),
    suppressClick = useRef(false),
    shortcut = useRef(false),
    copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    clicks = useRef<{
      x: number;
      y: number;
      time: number;
      count: number;
    } | null>(null);
  const [health, setHealth] = useState<"loading" | "ready" | "failed">(
    "loading",
  );
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    owner: Owner;
  } | null>(null);
  const [feedback, setFeedback] = useState("");
  const latest = useRef({ disabled, onError, health });
  latest.current = { disabled, onError, health };
  function ready() {
    return (
      live.current &&
      painted.current &&
      !document.hidden &&
      !latest.current.disabled &&
      latest.current.health === "ready"
    );
  }
  function cancelCopy() {
    const copy = pendingCopy.current;
    pendingCopy.current = null;
    if (copy?.started)
      void window.goga.demoCancelSelectionCopy?.(copy.id).catch(() => {});
    clearTimeout(copyTimer.current);
    if (live.current) setFeedback("");
  }
  function cancelDrags() {
    const canvas = ref.current;
    const local = drag.current;
    drag.current = null;
    if (local) {
      try {
        canvas?.releasePointerCapture(local.pointerId);
      } catch {}
    }
    // Even a queued mouse-up can be withdrawn by navigation. Release every
    // accepted gesture against its original page, never the new painted page.
    for (const gesture of gestures.current.values()) {
      void window.goga
        .demoExecute({
          action: "input",
          ...gesture.owner,
          input: {
            action: "pointer",
            phase: "cancel",
            gestureId: gesture.id,
            x: gesture.x,
            y: gesture.y,
          },
        })
        .catch(() => {});
    }
    gestures.current.clear();
    queue.current = queue.current.filter(
      (task) => !("input" in task && task.input.action === "pointer"),
    );
  }
  function retire() {
    queue.current.length = 0;
    cancelDrags();
    cancelCopy();
    if (live.current) setMenu(null);
  }
  useEffect(() => {
    if (disabled) retire();
  }, [disabled]);
  function drain() {
    if (draining.current) return;
    draining.current = true;
    void (async () => {
      try {
        while (ready() && queue.current.length) {
          const task = queue.current.shift()!;
          if (task.owner !== painted.current) continue;
          try {
            if ("copy" in task) {
              const copy = task.copy;
              if (pendingCopy.current !== copy || !copy.owner.tabId) continue;
              copy.started = true;
              const copied = await window.goga.demoCopySelection(
                copy.owner.showId,
                copy.owner.tabId,
                copy.id,
              );
              if (
                !ready() ||
                painted.current !== copy.owner ||
                pendingCopy.current !== copy
              )
                continue;
              setFeedback(copied ? t("general.copied") : t("general.noTextSelected"));
              clearTimeout(copyTimer.current);
              copyTimer.current = setTimeout(() => setFeedback(""), 1800);
            } else {
              await window.goga.demoExecute({
                action: "input",
                ...task.owner,
                input: task.input,
              });
              if (
                task.input.action === "pointer" &&
                (task.input.phase === "up" || task.input.phase === "cancel")
              )
                gestures.current.delete(task.input.gestureId);
            }
          } catch (error) {
            if (ready() && task.owner === painted.current)
              latest.current.onError(demoError(error));
            queue.current.length = 0;
            cancelDrags();
            cancelCopy();
          } finally {
            if ("copy" in task && pendingCopy.current === task.copy)
              pendingCopy.current = null;
          }
        }
      } finally {
        draining.current = false;
      }
    })();
  }
  function input(value: DemoInput) {
    if (!ready()) return;
    const items = queue.current,
      last = items.at(-1),
      owner = painted.current!;
    if (last?.owner === owner && "input" in last) {
      if (last.input.action === "scroll" && value.action === "scroll") {
        last.input = {
          ...value,
          deltaY: Math.max(
            -2000,
            Math.min(2000, value.deltaY + last.input.deltaY),
          ),
        };
        return;
      }
      if (
        last.input.action === "pointer" &&
        value.action === "pointer" &&
        value.phase === "move" &&
        last.input.phase === "move" &&
        last.input.gestureId === value.gestureId
      ) {
        last.input = value;
        return;
      }
    }
    if (items.length >= 80) {
      cancelDrags();
      latest.current.onError(
        t("general.tooManyCommandsWaitForThePageToUpdate"),
      );
      return;
    }
    items.push({ owner, input: value });
    drain();
  }
  function copySelection() {
    if (!ready() || !painted.current?.tabId || pendingCopy.current) return;
    finishDrag();
    const copy = {
      id: crypto.randomUUID(),
      owner: painted.current,
      started: false,
    };
    pendingCopy.current = copy;
    if (menu) ref.current?.focus({ preventScroll: true });
    setMenu(null);
    setFeedback("");
    queue.current.push({ owner: copy.owner, copy });
    drain();
  }
  useEffect(() => {
    const canvas = ref.current!;
    let stopped = false,
      busy = false,
      generation = 0,
      after: string | null = null,
      displayedHealth: typeof health = "loading",
      timer: ReturnType<typeof setTimeout> | undefined;
    live.current = true;
    const streamed = typeof window.goga.demoNextFrame === "function";
    const updateHealth = (next: typeof health) => {
      if (displayedHealth !== next) {
        displayedHealth = next;
        setHealth(next);
      }
    };
    async function paint() {
      if (stopped || document.hidden || busy) return;
      // A stream-capable host only serves frames bound to an explicit page.
      if (streamed && !tabId) return;
      clearTimeout(timer);
      busy = true;
      const epoch = generation;
      const current = () =>
        !stopped && !document.hidden && epoch === generation;
      let delay = streamed ? 0 : 650,
        bitmap: ImageBitmap | undefined;
      try {
        let png: Uint8Array;
        if (streamed && tabId) {
          const packet = await window.goga.demoNextFrame(showId, tabId, after);
          if (!current()) return;
          // A static page sends no new pixels. Keep the canvas and cursor.
          if (!packet) {
            delay = 16;
            return;
          }
          after = packet.cursor;
          png = packet.pixels;
        } else {
          // Only legacy bridges lack the tab-bound API. Never downgrade an
          // authorization failure or retired tab to a show-only screenshot.
          png = await window.goga.demoFrame(showId);
          if (!current()) return;
        }
        if (
          !png ||
          png.length < 24 ||
          png.length > 32 * 1024 * 1024 ||
          ![137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82].every(
            (v, i) => png[i] === v,
          )
        )
          throw Error();
        const bytes =
            png.buffer instanceof ArrayBuffer
              ? new Uint8Array(png.buffer, png.byteOffset, png.byteLength)
              : Uint8Array.from(png),
          view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
          width = view.getUint32(16),
          height = view.getUint32(20);
        if (
          !width ||
          !height ||
          width > 8192 ||
          height > 8192 ||
          width * height > 16_777_216
        )
          throw Error();
        bitmap = await createImageBitmap(
          new Blob([bytes], { type: "image/png" }),
        );
        if (!current()) return;
        if (bitmap.width !== width || bitmap.height !== height) throw Error();
        if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
        if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw Error();
        ctx.drawImage(bitmap, 0, 0);
        // The host must validate the exact page the user actually saw, even
        // when an agent activates another page before this gesture arrives.
        painted.current ??= streamed && tabId ? { showId, tabId } : { showId };
        updateHealth("ready");
      } catch {
        if (current()) {
          delay = 1700;
          after = null;
          retire();
          painted.current = null;
          updateHealth("failed");
        }
      } finally {
        bitmap?.close();
        busy = false;
        if (!stopped && !document.hidden) timer = setTimeout(paint, delay);
      }
    }
    const visible = () => {
      generation++;
      after = null;
      retire();
      painted.current = null;
      clearTimeout(timer);
      if (!document.hidden) void paint();
    };
    const wheel = (e: WheelEvent) => {
      if (
        latest.current.disabled ||
        latest.current.health !== "ready" ||
        e.ctrlKey ||
        e.metaKey ||
        !e.deltaY
      )
        return;
      const p = point(canvas, e.clientX, e.clientY);
      if (!p) return;
      e.preventDefault();
      input({
        action: "scroll",
        ...p,
        deltaY: Math.max(
          -1000,
          Math.min(
            1000,
            e.deltaY *
              (e.deltaMode === 1
                ? 16
                : e.deltaMode === 2
                  ? canvas.clientHeight
                  : 1),
          ),
        ),
      });
    };
    const blur = () => {
      queue.current.length = 0;
      cancelDrags();
      cancelCopy();
      setMenu(null);
      shortcut.current = false;
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visible);
    void paint();
    return () => {
      stopped = true;
      live.current = false;
      retire();
      painted.current = null;
      clearTimeout(timer);
      canvas.removeEventListener("wheel", wheel);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [showId, tabId]);
  function down(e: PointerEvent<HTMLCanvasElement>) {
    if (
      e.button !== 0 ||
      (e.pointerType && e.pointerType !== "mouse") ||
      !ready()
    )
      return;
    const p = point(e.currentTarget, e.clientX, e.clientY);
    if (!p) return;
    e.preventDefault();
    if (drag.current) cancelDrags();
    setMenu(null);
    const before = clicks.current,
      time = e.timeStamp;
    const count =
      e.detail >= 1 && e.detail <= 3
        ? e.detail
        : before &&
            time - before.time < 500 &&
            Math.hypot(e.clientX - before.x, e.clientY - before.y) < 5
          ? (before.count % 3) + 1
          : 1;
    clicks.current = { x: e.clientX, y: e.clientY, time, count };
    const gesture = {
      id: crypto.randomUUID(),
      pointerId: e.pointerId,
      owner: painted.current!,
      ...p,
      clickCount: count,
    };
    drag.current = gesture;
    gestures.current.set(gesture.id, gesture);
    suppressClick.current = true;
    e.currentTarget.focus({ preventScroll: true });
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    input({
      action: "pointer",
      phase: "down",
      gestureId: gesture.id,
      ...p,
      clickCount: count,
    });
  }
  function resetClickSequenceAfterDrag(x: number, y: number) {
    const start = clicks.current;
    if (start && Math.hypot(x - start.x, y - start.y) > 5)
      clicks.current = null;
  }
  function move(e: PointerEvent<HTMLCanvasElement>) {
    const gesture = drag.current;
    if (!gesture || gesture.pointerId !== e.pointerId) return;
    if (!(e.buttons & 1)) {
      cancelDrags();
      return;
    }
    const p = point(e.currentTarget, e.clientX, e.clientY, true);
    if (!p) return;
    resetClickSequenceAfterDrag(e.clientX, e.clientY);
    gesture.x = p.x;
    gesture.y = p.y;
    input({ action: "pointer", phase: "move", gestureId: gesture.id, ...p });
  }
  function up(e: PointerEvent<HTMLCanvasElement>) {
    const gesture = drag.current;
    if (!gesture || gesture.pointerId !== e.pointerId) return;
    resetClickSequenceAfterDrag(e.clientX, e.clientY);
    const p = point(e.currentTarget, e.clientX, e.clientY, true) ?? {
      x: gesture.x,
      y: gesture.y,
    };
    gesture.x = p.x;
    gesture.y = p.y;
    drag.current = null;
    input({ action: "pointer", phase: "up", gestureId: gesture.id, ...p });
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
  }
  function finishDrag() {
    const gesture = drag.current;
    if (!gesture) return;
    drag.current = null;
    input({
      action: "pointer",
      phase: "up",
      gestureId: gesture.id,
      x: gesture.x,
      y: gesture.y,
    });
    try {
      ref.current?.releasePointerCapture(gesture.pointerId);
    } catch {}
  }
  function click(e: MouseEvent<HTMLCanvasElement>) {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    // Accessibility/legacy synthetic click has no pointer sequence. Real mouse
    // clicks are already sent by down/up and must not collapse a new selection.
    const p = point(e.currentTarget, e.clientX, e.clientY);
    if (p) {
      e.currentTarget.focus({ preventScroll: true });
      input({ action: "click", ...p });
    }
  }
  function contextMenu(e: MouseEvent<HTMLCanvasElement>) {
    e.preventDefault();
    if (!ready()) return;
    finishDrag();
    const r = e.currentTarget.parentElement!.getBoundingClientRect();
    setMenu({
      owner: painted.current!,
      x: Math.max(6, Math.min(e.clientX - r.left, r.width - 190)),
      y: Math.max(6, Math.min(e.clientY - r.top, r.height - 48)),
    });
  }
  function copyShortcut(e: KeyboardEvent) {
    if (
      (e.metaKey || e.ctrlKey) &&
      !e.altKey &&
      !e.shiftKey &&
      e.key.toLowerCase() === "c" &&
      !e.nativeEvent.isComposing
    ) {
      e.preventDefault();
      shortcut.current = true;
      if (!e.repeat) copySelection();
      return true;
    }
    return false;
  }
  function key(e: KeyboardEvent) {
    if (copyShortcut(e)) return;
    if (
      disabled ||
      health !== "ready" ||
      e.ctrlKey ||
      e.altKey ||
      e.metaKey ||
      e.nativeEvent.isComposing ||
      (e.key === "Tab" && e.shiftKey)
    )
      return;
    if (
      [
        "Enter",
        "Backspace",
        "Tab",
        "Delete",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
      ].includes(e.key)
    ) {
      e.preventDefault();
      input({
        action: "key",
        key: e.key as Extract<DemoInput, { action: "key" }>["key"],
      });
    } else if (Array.from(e.key).length === 1) {
      e.preventDefault();
      input({ action: "text", text: e.key });
    }
  }
  function paste(e: ClipboardEvent) {
    const raw = e.clipboardData.getData("text/plain");
    if (!raw || disabled || health !== "ready") return;
    e.preventDefault();
    const lines = raw.replace(/\r\n?/g, "\n").split("\n");
    if (
      raw.length > 2048 ||
      lines.length > 16 ||
      lines.some((l) => /[\x00-\x1f\x7f-\x9f]/u.test(l))
    )
      return onError(
        t("general.pasteTextWithoutControlCharactersUpTo2048"),
      );
    lines.forEach((text, i) => {
      if (i) input({ action: "key", key: "Enter" });
      if (text) input({ action: "text", text });
    });
  }
  return (
    <div
      className="demo-frame-area"
      onKeyDown={(e) => {
        if (e.target !== ref.current) copyShortcut(e);
      }}
      onKeyUp={(e) => {
        if (
          e.key.toLowerCase() === "c" ||
          e.key === "Meta" ||
          e.key === "Control"
        )
          shortcut.current = false;
      }}
      onCopy={(e) => {
        e.preventDefault();
        if (!shortcut.current) copySelection();
      }}
    >
      <canvas
        ref={ref}
        className={"demo-frame is-" + health}
        role="img"
        aria-label={t("general.interactiveDemonstrationForTheSelectedContext")}
        tabIndex={0}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={cancelDrags}
        onLostPointerCapture={() => {
          if (drag.current) cancelDrags();
        }}
        onBlur={() => {
          if (drag.current) cancelDrags();
        }}
        onContextMenu={contextMenu}
        onClick={click}
        onKeyDown={key}
        onPaste={paste}
      />
      {feedback && (
        <span className="demo-selection-feedback" role="status">
          {feedback}
        </span>
      )}
      {menu && ready() && menu.owner === painted.current && (
        <SelectionMenu
          x={menu.x}
          y={menu.y}
          close={() => {
            setMenu(null);
            ref.current?.focus({ preventScroll: true });
          }}
          copy={copySelection}
        />
      )}
      {health !== "ready" && (
        <div className="demo-frame-wait" role="status">
          {health === "loading"
            ? t("general.openingPage")
            : t("general.noImageReconnecting")}
        </div>
      )}
    </div>
  );
}

function SelectionMenu({
  x,
  y,
  copy,
  close,
}: {
  x: number;
  y: number;
  copy: () => void;
  close: () => void;
}) {
  useLocale();
  const ref = useRef<HTMLDivElement>(null),
    latest = useRef({ copy, close });
  latest.current = { copy, close };
  useEffect(() => {
    const menu = ref.current!;
    menu.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (e: Event) => {
      if (!menu.contains(e.target as Node)) latest.current.close();
    };
    const dismiss = () => latest.current.close();
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", dismiss);
    };
  }, []);
  return (
    <div
      ref={ref}
      className="project-list-menu demo-selection-menu"
      role="menu"
      aria-label={t("general.pageActions")}
      style={{ left: x, top: y }}
      onKeyDown={(e) => {
        if (e.key === "Escape" || e.key === "Tab") {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
          }
          close();
        }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
          e.preventDefault();
          ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
        }
      }}
    >
      <button type="button" role="menuitem" onClick={copy}>
        <Copy size={15} aria-hidden />{t("general.copy")}</button>
    </div>
  );
}

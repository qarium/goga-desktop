import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import "./TopicPickerPopup.css";

let activePopup: { close: () => void; release: () => Promise<void> } | null =
  null;
/** Electron admits one native overlay. Wait for its host acknowledgement, not
 * just React unmount, before replacing a selector with an operation error. */
export async function dismissActiveTopicPopup() {
  const active = activePopup;
  if (!active) return;
  active.close();
  await active.release();
}

export function hasNativeTopicPopup() {
  return (
    typeof window.goga?.setTopicPopupBounds === "function" &&
    typeof window.goga?.closeTopicPopup === "function" &&
    typeof window.goga?.onTopicPopupClosed === "function"
  );
}
const failureMessage =
  "Не удалось открыть меню поверх панели. Закройте меню и попробуйте снова.";

/** Only presentation moves into the same-origin native layer. React state and
 * every privileged call remain in the original, authenticated shell renderer. */
export function TopicPickerPopup({
  anchor,
  onClose,
  children,
  label = "Выбор топика",
  width: preferredWidth = 436,
}: {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  label?: string;
  width?: number;
}) {
  const native = hasNativeTopicPopup();
  const close = useRef(onClose);
  close.current = onClose;
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [styled, setStyled] = useState(false);
  const [error, setError] = useState("");
  const layer = useRef<{ id: string; alive: boolean; fail: () => void } | null>(
    null,
  );
  const position = () => {
    const rect = anchor.current?.getBoundingClientRect();
    const width = Math.max(1, Math.min(preferredWidth, window.innerWidth - 16));
    const x = Math.max(
      0,
      Math.min(
        Math.round((rect?.left ?? 8) - 8),
        window.innerWidth - width - 8,
      ),
    );
    const y = Math.max(
      0,
      Math.min(Math.round(rect?.bottom ?? 8), window.innerHeight - 48),
    );
    return { x, y, width, height: Math.max(1, window.innerHeight - y - 8) };
  };
  useLayoutEffect(() => {
    if (!native) return;
    const api = window.goga;
    const id = crypto.randomUUID();
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listeners: (() => void)[] = [];
    const off = api.onTopicPopupClosed!((closedId) => {
      if (!disposed && closedId === id) close.current();
    });
    let released: Promise<void> | null = null;
    const release = () =>
      (released ??= api.closeTopicPopup!(id).finally(() => {
        if (activePopup === active) activePopup = null;
      }));
    const active = {
      close: () => {
        if (!disposed) close.current();
      },
      release,
    };
    activePopup = active;
    const state = {
      id,
      alive: true,
      fail: () => {
        if (disposed || !state.alive) return;
        state.alive = false;
        off();
        void release().catch(() => {});
        setContainer(null);
        setError(failureMessage);
      },
    };
    layer.current = state;
    try {
      const bounds = position();
      const popup = window.open(
        "about:blank",
        `goga-topic-picker:${id}`,
        Object.entries(bounds)
          .map(([key, value]) => `${key}=${value}`)
          .join(","),
      );
      if (!popup) throw Error("Native popup denied");
      const doc = popup.document;
      doc.documentElement.lang = document.documentElement.lang || "ru";
      doc.documentElement.classList.add("topic-popup-document");
      doc.title = label;
      const links = [
        ...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
      ];
      let remaining = links.length;
      if (!remaining) setStyled(true);
      else timer = setTimeout(state.fail, 5000);
      for (const source of links) {
        const link = doc.createElement("link");
        link.rel = "stylesheet";
        link.href = source.href;
        const loaded = () => {
          if (disposed || !state.alive) return;
          if (--remaining === 0) {
            clearTimeout(timer);
            setStyled(true);
          }
        };
        link.addEventListener("load", loaded, { once: true });
        link.addEventListener("error", state.fail, { once: true });
        listeners.push(() => {
          link.removeEventListener("load", loaded);
          link.removeEventListener("error", state.fail);
        });
        doc.head.append(link);
      }
      const root = doc.createElement("div");
      root.className = "topic-context-native-root";
      root.style.setProperty(
        "--topic-popup-max-height",
        `${Math.max(1, bounds.height - 16)}px`,
      );
      doc.body.append(root);
      setContainer(root);
    } catch {
      state.fail();
    }
    return () => {
      disposed = true;
      state.alive = false;
      if (layer.current === state) layer.current = null;
      clearTimeout(timer);
      for (const remove of listeners) remove();
      off();
      void release().catch(() => {});
    };
  }, [native, anchor]);

  useLayoutEffect(() => {
    const state = layer.current;
    if (!container || !styled || !state?.alive) return;
    let last = "",
      ready = false,
      disposed = false,
      frame = 0;
    const readyDeadline = setTimeout(state.fail, 5000);
    const measure = () => {
      if (!state.alive || !ready || disposed) return;
      const bounds = position();
      bounds.height = Math.min(
        bounds.height,
        Math.max(1, Math.ceil(container.scrollHeight)),
      );
      const key = JSON.stringify(bounds);
      if (key === last) return;
      last = key;
      void window.goga.setTopicPopupBounds!(state.id, bounds).catch(state.fail);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    // Style load alone precedes layout/font settlement. Keep the native layer
    // hidden until the complete portal has its final first-frame geometry.
    container.getBoundingClientRect();
    Promise.resolve(container.ownerDocument.fonts?.ready)
      .then(() => {
        if (disposed || !state.alive) return;
        frame = window.requestAnimationFrame(() => {
          frame = window.requestAnimationFrame(() => {
            if (disposed || !state.alive) return;
            clearTimeout(readyDeadline);
            ready = true;
            measure();
            container
              .querySelector<HTMLElement>(
                '[role="combobox"], [role="menuitem"]:not(:disabled)',
              )
              ?.focus();
          });
        });
      })
      .catch(state.fail);
    return () => {
      disposed = true;
      clearTimeout(readyDeadline);
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [container, styled]);

  if (!native) return children;
  if (error)
    return (
      <div className="topic-popup-error" role="alert">
        {error}
        <button type="button" onClick={onClose}>
          Закрыть меню
        </button>
      </div>
    );
  return container ? createPortal(children, container) : null;
}

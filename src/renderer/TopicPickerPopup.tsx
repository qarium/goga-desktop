import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import "./TopicPickerPopup.css";

export function hasNativeTopicPopup() {
  return (
    typeof window.goga.setTopicPopupBounds === "function" &&
    typeof window.goga.closeTopicPopup === "function" &&
    typeof window.goga.onTopicPopupClosed === "function"
  );
}
const failureMessage =
  "Не удалось открыть меню топиков поверх панели. Закройте меню и попробуйте снова.";

/** Only presentation moves into the same-origin native layer. React state and
 * every privileged call remain in the original, authenticated shell renderer. */
export function TopicPickerPopup({
  anchor,
  onClose,
  children,
}: {
  anchor: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  children: ReactNode;
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
    const width = Math.max(1, Math.min(436, window.innerWidth - 16));
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
    const release = () => {
      void api.closeTopicPopup!(id).catch(() => {});
    };
    const state = {
      id,
      alive: true,
      fail: () => {
        if (disposed || !state.alive) return;
        state.alive = false;
        off();
        release();
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
      doc.title = "Выбор топика";
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
      release();
    };
  }, [native, anchor]);

  useLayoutEffect(() => {
    const state = layer.current;
    if (!container || !styled || !state?.alive) return;
    let last = "";
    const measure = () => {
      if (!state.alive) return;
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
    measure();
    container.querySelector<HTMLInputElement>('[role="combobox"]')?.focus();
    return () => observer.disconnect();
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

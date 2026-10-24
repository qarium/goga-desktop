import { useLayoutEffect, useRef } from "react";
import type { ScopeRef } from "../shared/context";
import type { TerminalAPI } from "../shared/terminal-control";
import type { TerminalSessionRef } from "../shared/terminal";
/** Placeholder geometry only. The live xterm belongs to a separate native renderer. */
export function TerminalSurface(props: {
  api: TerminalAPI;
  enabled?: boolean;
  visible?: boolean;
  scope: ScopeRef;
  revision: string;
  tabId: string;
  session: TerminalSessionRef;
  onError(message: string): void;
}) {
  const root = useRef<HTMLDivElement>(null),
    report = useRef(props.onError);
  report.current = props.onError;
  const revision = useRef(props.revision);
  revision.current = props.revision;
  const scopeKey = JSON.stringify(props.scope);
  // Hiding belongs to the owning context/visibility lifetime. A tab swap uses
  // the existing host-granted screen atomically, including its input lease.
  useLayoutEffect(() => {
    if (props.visible === false) return;
    return () => {
      void props.api.request({ kind: "hide" }).catch(() => {});
    };
  }, [props.api, props.visible, scopeKey]);
  useLayoutEffect(() => {
    if (props.visible === false) return;
    let live = true,
      previous = "",
      measurement = 0;
    const hide = () => props.api.request({ kind: "hide" }).catch(() => {});
    const measure = () => {
      if (!live || !root.current) return;
      const box = root.current.getBoundingClientRect();
      const x = Math.max(0, Math.ceil(box.x)),
        y = Math.max(0, Math.ceil(box.y));
      const width = Math.min(Math.floor(box.width), window.innerWidth - x),
        height = Math.min(Math.floor(box.height), window.innerHeight - y);
      if (width <= 0 || height <= 0) {
        ++measurement;
        previous = "";
        void hide();
        return;
      }
      const bounds = { x, y, width, height },
        key = JSON.stringify(bounds);
      if (key === previous) return;
      previous = key;
      const order = ++measurement;
      const target = {
        scope: props.scope,
        revision: revision.current,
        tabId: props.tabId,
        ref: {
          sessionId: props.session.sessionId,
          generation: props.session.generation,
        },
        bounds,
      };
      void props.api
        .request({ kind: "activate", ...target })
        .then((activated) => {
          if (
            !activated &&
            live &&
            order === measurement &&
            props.enabled !== false
          )
            return props.api.request({ kind: "show", ...target });
        })
        .catch(() => {
          if (live && order === measurement) {
            void hide();
            report.current(
              "Не удалось показать терминал. Переключите вкладку или обновите сессию.",
            );
          }
        });
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    // A centered max-width surface can move without changing its own size
    // (e.g. sidebar collapse). Ancestor resizes must update the native bounds too.
    for (
      let node: HTMLElement | null = root.current;
      node;
      node = node.parentElement
    )
      observer?.observe(node);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    measure();
    return () => {
      live = false;
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [
    props.api,
    props.enabled,
    props.visible,
    scopeKey,
    props.tabId,
    props.session.sessionId,
    props.session.generation,
  ]);
  return (
    <div className="terminal-surface" ref={root} aria-label="Экран терминала" />
  );
}

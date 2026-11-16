import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { MonitorPlay } from "lucide-react";
import { DemoConfirm } from "./DemoConfirm";
import { demoError, type DemoDirectory } from "./directory";

function tabKey(e: KeyboardEvent<HTMLButtonElement>) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
  const tabs = Array.from(
    e.currentTarget
      .closest("[role=tablist]")
      ?.querySelectorAll<HTMLButtonElement>("[role=tab]:not(:disabled)") ?? [],
  );
  if (!tabs.length) return;
  e.preventDefault();
  const next =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? tabs.length - 1
        : (tabs.indexOf(e.currentTarget) +
            (e.key === "ArrowRight" ? 1 : -1) +
            tabs.length) %
          tabs.length;
  tabs[next].focus();
  tabs[next].click();
}

// Key this component by the show instance, not just the topic. A confirmation
// for a closed/replaced page can never be reused for its successor.
export function DemoRunTab({
  store,
  showId,
  selected,
  disabled,
  onSelect,
  onModalChange,
  onError,
}: {
  store: DemoDirectory;
  showId: string;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  onModalChange: (open: boolean) => void;
  onError: (error: string) => void;
}) {
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false);
  const flight = useRef(false),
    alive = useRef(false),
    group = useRef<HTMLDivElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // An open run can put a native dashboard above React. Tell the owning
  // shell to hide that surface while closing a tab from the background.
  useEffect(() => {
    if (!confirm) return;
    onModalChange(true);
    return () => onModalChange(false);
  }, [confirm, onModalChange]);
  async function stop() {
    if (!alive.current || flight.current || !confirm || disabled) return;
    const list = group.current?.closest("[role=tablist]");
    flight.current = true;
    setBusy(true);
    setConfirm(false);
    try {
      await store.execute({ action: "stop", showId });
      requestAnimationFrame(() => {
        if (list?.isConnected && document.activeElement === document.body) {
          list
            .querySelector<HTMLButtonElement>(
              "button[aria-selected=true],button[aria-pressed=true]",
            )
            ?.focus();
        }
      });
    } catch (e) {
      if (alive.current) onError(demoError(e));
    } finally {
      flight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <>
      <div ref={group} className="run-tab-group" role="presentation">
        <button
          type="button"
          role="tab"
          id="cdp-demo-tab"
          className={"run-tab" + (selected ? " active" : "")}
          aria-selected={selected}
          aria-controls="cdp-demo-section"
          disabled={disabled}
          onKeyDown={tabKey}
          onClick={onSelect}
        >
          <MonitorPlay size={16} aria-hidden="true" />
          <span>Демонстрация</span>
        </button>
        <button
          type="button"
          className="close-tab"
          aria-label="Закрыть вкладку Демонстрация"
          title="Закрыть вкладку"
          aria-busy={busy}
          disabled={disabled || busy}
          onClick={() => setConfirm(true)}
        >
          ×
        </button>
      </div>
      {confirm &&
        createPortal(
          <DemoConfirm
            q={{
              action: "stop",
              title: "Завершить показ?",
              detail:
                "Страница закроется вместе с несохранёнными изменениями. Агент потеряет доступ.",
              submit: "Завершить показ",
            }}
            cancel={() => setConfirm(false)}
            submit={() => void stop()}
          />,
          document.body,
        )}
    </>
  );
}

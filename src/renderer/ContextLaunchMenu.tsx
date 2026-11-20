import { t } from "../shared/i18n";
import { useLocale } from "./useLocale";
import { useEffect, useId, useRef, useState } from "react";
import {
  contextKey,
  type RunKind,
  type RunWithContext,
  type TopicContextIdentity,
} from "./topic-context";
import { workspaceLaunchBlockReason } from "./workspace-context";
import { TopicPickerPopup, useNativeTopicPopup } from "./TopicPickerPopup";
import "./ContextRuns.css";

export interface ContextLaunchMenuProps {
  runs: RunWithContext[];
  context: TopicContextIdentity | null;
  onPrepare: (kind: RunKind) => void;
  disabled?: boolean;
  blockedReason?: string;
  prepareWithoutContext?: boolean;
  demoItem?: (close: () => void) => import("react").ReactNode;
  primaryProjectId?: string;
}

/** Opens preparation only; writer guards remain enforced by the host as well. */
export function ContextLaunchMenu({
  runs,
  context,
  onPrepare,
  disabled = false,
  blockedReason,
  prepareWithoutContext = false,
  demoItem,
  primaryProjectId,
}: ContextLaunchMenuProps) {
  useLocale();
  const nativePopup = useNativeTopicPopup();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<HTMLDivElement | null>(null);
  const nativeFocusPending = useRef(false);
  const focusEdge = useRef<"first" | "last">("first");
  const id = useId();
  const key = context ? contextKey(context) : null;
  const projectId = context?.projectId ?? primaryProjectId ?? "";
  const pipelineReason = workspaceLaunchBlockReason(
    runs,
    projectId,
    context,
    "pipeline",
  );
  const buildReason = workspaceLaunchBlockReason(
    runs,
    projectId,
    context,
    "build",
  );
  const activeBuild = !!buildReason && !pipelineReason;
  const inactive = disabled;
  const reason =
    blockedReason ||
    pipelineReason ||
    (!context && !prepareWithoutContext
      ? t("general.selectATopicAndAVerifiedWorkingCopyTo")
      : "");
  const blocked = Boolean(reason);
  const reasonId = `${id}-reason`;
  const buildHintId = `${id}-build-hint`;
  const describedBy =
    [reason ? reasonId : "", activeBuild ? buildHintId : ""]
      .filter(Boolean)
      .join(" ") || undefined;

  useEffect(() => setOpen(false), [key, projectId, inactive]);
  useEffect(() => {
    if (!open || !menu) return;
    // Native presentation mounts asynchronously and receives focus only after
    // its layout/host handshake. The ordinary DOM menu can focus immediately.
    if (!nativePopup) {
      const items = menu.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      );
      const item =
        focusEdge.current === "last" ? items[items.length - 1] : items[0];
      (item ?? menu).focus();
    }
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !menu.contains(target))
        setOpen(false);
    };
    const documents = new Set([document, menu.ownerDocument]);
    for (const doc of documents) doc.addEventListener("pointerdown", outside);
    const nativeKeys = (event: KeyboardEvent) => {
      // A fully blocked menu has no enabled item for the popup's ready focus.
      // Its body still needs keyboard dismissal, without stealing focus early.
      if (event.defaultPrevented || menu.contains(event.target as Node)) return;
      if (event.key !== "Escape" && event.key !== "Tab") return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
      setOpen(false);
      trigger.current?.focus();
    };
    if (nativePopup) menu.ownerDocument.addEventListener("keydown", nativeKeys);
    return () => {
      for (const doc of documents)
        doc.removeEventListener("pointerdown", outside);
      menu.ownerDocument.removeEventListener("keydown", nativeKeys);
    };
  }, [open, menu, nativePopup]);

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  const prepare = (kind: RunKind) => {
    if (inactive || blocked || (kind === "build" && activeBuild)) return;
    close(true);
    onPrepare(kind);
  };
  return (
    <div
      className="context-launch"
      ref={root}
      onBlur={(event) => {
        if (
          !nativePopup &&
          !event.currentTarget.contains(event.relatedTarget as Node) &&
          !menu?.contains(event.relatedTarget as Node)
        )
          close();
      }}
    >
      <button
        className="primary context-launch-trigger"
        type="button"
        ref={trigger}
        disabled={inactive}
        aria-haspopup="menu"
        aria-expanded={open && !inactive}
        aria-controls={open && !inactive ? id : undefined}
        onClick={() => {
          focusEdge.current = "first";
          nativeFocusPending.current = true;
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            focusEdge.current = event.key === "ArrowUp" ? "last" : "first";
            nativeFocusPending.current = true;
            setOpen(true);
          } else if (event.key === "Escape") {
            event.preventDefault();
            close(true);
          }
        }}
      >{t("general.launch")}<span className="context-select-chevron" aria-hidden="true" />
      </button>
      {open && !inactive && (
        <TopicPickerPopup
          anchor={trigger}
          width={296}
          label={t("general.prepareANewRun")}
          onClose={() => close()}
        >
          <div
            id={id}
            className="context-launch-menu"
            ref={setMenu}
            role="menu"
            tabIndex={-1}
            aria-label={t("general.prepareANewRun")}
            aria-describedby={describedBy}
            onFocusCapture={(event) => {
              if (!nativePopup || !nativeFocusPending.current) return;
              nativeFocusPending.current = false;
              // TopicPickerPopup focuses its first item when the native layer is
              // ready. Preserve ArrowUp's last-item intent at that exact handoff.
              if (focusEdge.current === "last") {
                const items =
                  event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    "button:not(:disabled)",
                  );
                items[items.length - 1]?.focus();
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close(true);
              } else if (event.key === "Tab") {
                // Leave from the trigger's position in the normal tab order.
                trigger.current?.focus();
                close();
              } else if (
                ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
              ) {
                event.preventDefault();
                const items = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    "button:not(:disabled)",
                  ),
                );
                if (!items.length) return;
                const current = items.indexOf(
                  event.currentTarget.ownerDocument
                    .activeElement as HTMLButtonElement,
                );
                const index =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : (current +
                          (event.key === "ArrowDown" ? 1 : -1) +
                          items.length) %
                        items.length;
                items[index].focus();
              }
            }}
          >
            {reason && (
              <p className="context-launch-reason" id={reasonId}>
                {reason}
              </p>
            )}
            <button
              type="button"
              role="menuitem"
              disabled={blocked}
              aria-describedby={reason ? reasonId : undefined}
              onClick={() => prepare("pipeline")}
            >{t("general.pipeline")}<small>{t("general.describeTheTaskAndConfigureTheRun")}</small>
            </button>
            {activeBuild ? (
              <div className="context-launch-hint" id={buildHintId}>
                <p>{t("general.aBuildIsAlreadyRunning")}</p>
                <small>{t("general.openItFromRuns")}</small>
              </div>
            ) : (
              <button
                type="button"
                role="menuitem"
                disabled={blocked}
                aria-describedby={describedBy}
                onClick={() => prepare("build")}
              >{t("general.build")}<small>{t("general.chooseAPlanAndConfigureTheRun")}</small>
              </button>
            )}
            {demoItem?.(() => close(true))}
          </div>
        </TopicPickerPopup>
      )}
    </div>
  );
}

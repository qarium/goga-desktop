import { t as msg } from "../shared/i18n";
import { useLocale } from "./useLocale";
import { useEffect, useRef, useState } from "react";
import { FolderOpen, FolderPlus } from "lucide-react";
import { TopicPickerPopup, dismissActiveTopicPopup } from "./TopicPickerPopup";
import "./ProjectListMenu.css";
export interface ProjectAddTarget {
  x: number;
  y: number;
  trigger: HTMLElement;
}
export function ProjectAddMenu({
  target,
  onClose,
  onAction,
  onError,
}: {
  target: ProjectAddTarget;
  onClose: (restoreFocus?: boolean) => void;
  onAction: (action: "open" | "create") => void;
  onError: (error: unknown) => void;
}) {
  useLocale();
  const anchor = useRef<HTMLSpanElement>(null),
    callbacks = useRef({ onClose, onAction, onError });
  callbacks.current = { onClose, onAction, onError };
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const acting = useRef(false);
  useEffect(() => {
    if (!root) return;
    root.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: Event) => {
      if (!root.contains(event.target as Node)) callbacks.current.onClose();
    };
    const dismiss = () => callbacks.current.onClose();
    const docs = new Set([document, root.ownerDocument]);
    for (const doc of docs) doc.addEventListener("pointerdown", outside);
    if (root.ownerDocument === document) {
      document.addEventListener("focusin", outside);
      window.addEventListener("blur", dismiss);
      window.addEventListener("resize", dismiss);
    }
    return () => {
      for (const doc of docs) doc.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
    };
  }, [root]);
  async function choose(action: "open" | "create") {
    if (acting.current) return;
    acting.current = true;
    try {
      await dismissActiveTopicPopup();
      callbacks.current.onClose(true);
      callbacks.current.onAction(action);
    } catch (error) {
      callbacks.current.onClose(true);
      callbacks.current.onError(error);
    }
  }
  return (
    <>
      <span
        ref={anchor}
        aria-hidden="true"
        className="project-menu-anchor"
        style={{
          left: Math.max(8, target.x),
          top: Math.max(8, Math.min(target.y, window.innerHeight - 130)),
        }}
      />
      <TopicPickerPopup
        anchor={anchor}
        width={270}
        label={msg("shell.addProject")}
        domPortal
        onClose={() => onClose(true)}
      >
        <div
          ref={setRoot}
          className="project-list-menu"
          role="menu"
          aria-label={msg("shell.addProject")}
          onKeyDown={(event) => {
            if (event.key === "Escape" || event.key === "Tab") {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
              }
              onClose(true);
            } else if (
              ["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
            ) {
              event.preventDefault();
              const buttons = [
                  ...root!.querySelectorAll<HTMLButtonElement>("button"),
                ],
                index = buttons.indexOf(
                  root!.ownerDocument.activeElement as HTMLButtonElement,
                );
              buttons[
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? buttons.length - 1
                    : (index +
                        (event.key === "ArrowUp" ? -1 : 1) +
                        buttons.length) %
                      buttons.length
              ]?.focus();
            }
          }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => void choose("open")}
          >
            <FolderOpen size={16} aria-hidden="true" />{msg("shell.openExisting")}</button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void choose("create")}
          >
            <FolderPlus size={16} aria-hidden="true" />{msg("shell.createNew")}</button>
        </div>
      </TopicPickerPopup>
    </>
  );
}

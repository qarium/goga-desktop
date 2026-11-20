import { t as msg } from "../shared/i18n";
import { useLocale } from "./useLocale";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ListX } from "lucide-react";
import type { Project } from "../shared/types";
import { TopicPickerPopup, dismissActiveTopicPopup } from "./TopicPickerPopup";
import { TopicModal } from "./TopicsCommon";
import "./ProjectListMenu.css";

export interface ProjectMenuTarget {
  project: Project;
  x: number;
  y: number;
  trigger: HTMLElement;
}

export type SidebarMenuAction = {
  key: string;
  label: string;
  disabled?: boolean;
  icon?: ReactNode;
  run: () => void;
};
export type SidebarMenuAnchor = Pick<ProjectMenuTarget, "x" | "y" | "trigger">;

/** Presentation may be native, ownership and all actions stay in the shell. */
export function SidebarActionMenu({
  target,
  onClose,
  onError,
  actions,
  label,
}: {
  target: SidebarMenuAnchor;
  actions: SidebarMenuAction[];
  label: string;
  onClose: (restoreFocus?: boolean) => void;
  onError: (error: unknown) => void;
}) {
  useLocale();
  const anchor = useRef<HTMLSpanElement>(null),
    [root, setRoot] = useState<HTMLDivElement | null>(null);
  const callbacks = useRef({ onClose, onError });
  callbacks.current = { onClose, onError };
  const executing = useRef(false);
  useEffect(() => {
    if (!root) return;
    root.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const outside = (event: Event) => {
      if (!root.contains(event.target as Node)) callbacks.current.onClose();
    };
    const dismiss = () => callbacks.current.onClose();
    const docs = new Set([document, root.ownerDocument]);
    for (const doc of docs) doc.addEventListener("pointerdown", outside);
    const dom = root.ownerDocument === document;
    if (dom) {
      document.addEventListener("focusin", outside);
      window.addEventListener("blur", dismiss);
      window.addEventListener("resize", dismiss);
    }
    return () => {
      for (const doc of docs) doc.removeEventListener("pointerdown", outside);
      if (dom) {
        document.removeEventListener("focusin", outside);
        window.removeEventListener("blur", dismiss);
        window.removeEventListener("resize", dismiss);
      }
    };
  }, [root]);
  async function activate(item: SidebarMenuAction) {
    if (item.disabled || executing.current) return;
    executing.current = true;
    try {
      await dismissActiveTopicPopup();
      callbacks.current.onClose(true);
      item.run();
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
          top: Math.max(
            8,
            Math.min(
              target.y,
              window.innerHeight - Math.min(360, actions.length * 38 + 28),
            ),
          ),
        }}
      />
      <TopicPickerPopup
        anchor={anchor}
        width={270}
        label={label}
        domPortal
        onClose={() => onClose(true)}
      >
        <div
          ref={setRoot}
          className="project-list-menu"
          role="menu"
          aria-label={label}
          onKeyDown={(e) => {
            if (e.key === "Escape" || e.key === "Tab") {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
              }
              onClose(true);
              return;
            }
            if (
              !root ||
              !["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)
            )
              return;
            e.preventDefault();
            const list = Array.from(
              root.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
            );
            const i = list.indexOf(
              root.ownerDocument.activeElement as HTMLButtonElement,
            );
            list[
              e.key === "Home"
                ? 0
                : e.key === "End"
                  ? list.length - 1
                  : (i + (e.key === "ArrowUp" ? -1 : 1) + list.length) %
                    list.length
            ]?.focus();
          }}
        >
          {actions.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => void activate(item)}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      </TopicPickerPopup>
    </>
  );
}
export function ProjectListMenu({
  target,
  onClose,
  onRemove,
  onError,
  actions = [],
}: {
  target: ProjectMenuTarget;
  onClose: (restoreFocus?: boolean) => void;
  onRemove: (project: Project) => void;
  onError: (error: unknown) => void;
  actions?: SidebarMenuAction[];
}) {
  useLocale();
  return (
    <SidebarActionMenu
      target={target}
      label={msg("shell.projectActions")}
      onClose={onClose}
      onError={onError}
      actions={[
        ...actions,
        {
          key: "remove",
          label: msg("shell.removeFromList"),
          icon: <ListX size={16} aria-hidden="true" />,
          run: () => onRemove(target.project),
        },
      ]}
    />
  );
}

export function ProjectRemovalDialog({
  project,
  busy,
  error,
  dirty,
  blocked,
  onClose,
  onConfirm,
}: {
  project: Project;
  busy: boolean;
  error: string;
  dirty: string[];
  blocked?: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  useLocale();
  return (
    <TopicModal
      title={msg("shell.removeProjectFromList")}
      className="project-removal-dialog"
      busy={busy}
      closeLabel={msg("shell.closeConfirmation")}
      onClose={onClose}
    >
      <div className="project-removal-copy">
        <div className="project-removal-target">
          <strong>{project.name}</strong>
          <code>{project.path}</code>
        </div>
        <p>{msg("shell.filesSettingsTopicWorkingCopiesAndRunHistoryWillStay")}</p>
        {!!dirty.length && (
          <div className="project-removal-warning" role="note">
            <p>{msg("shell.unsavedFilesInOverviewWillBeClosedWithoutSaving")}</p>
            <ul>
              {dirty.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
            <p>{msg("shell.returnToTheEditorIfYouWantToSaveYour")}</p>
          </div>
        )}
        {blocked && (
          <p className="project-removal-warning" role="note">
            {blocked}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {busy && <p role="status">{msg("shell.removingProjectFromList")}</p>}
      </div>
      <div className="form-actions">
        <button type="button" disabled={busy} onClick={onClose}>{msg("shell.cancel")}</button>
        <button
          type="button"
          className="primary"
          disabled={busy || !!blocked}
          onClick={onConfirm}
        >
          {busy ? msg("shell.removing") : msg("shell.removeFromList2")}
        </button>
      </div>
    </TopicModal>
  );
}

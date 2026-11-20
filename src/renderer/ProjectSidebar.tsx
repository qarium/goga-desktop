import { HintButton } from "./ActionHint";
import { t as msg } from "../shared/i18n";
import { useLocale } from "./useLocale";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  GripVertical,
  House,
  Layers,
  MoreHorizontal,
  Pencil,
  Plus,
  Ungroup,
} from "lucide-react";
import type { Project } from "../shared/types";
import { TooltipButton } from "./RepositoryActions";
import {
  ProjectListMenu,
  SidebarActionMenu,
  type SidebarMenuAnchor,
  type SidebarMenuAction,
} from "./ProjectListMenu";
import { TopicModal } from "./TopicsCommon";
import { useProjectDrag } from "./useProjectDrag";
import {
  orderedProjectIds,
  type OrganizationCommand,
  type ProjectGroup,
} from "./project-organization-model";
import type { ProjectOrganizationController } from "./useProjectOrganization";
import "./ProjectSidebar.css";

type Menu = SidebarMenuAnchor & { kind: "group" | "project"; id: string };
type Dialog =
  | { kind: "create" }
  | { kind: "rename" | "dissolve"; id: string }
  | { kind: "recover" };
export interface ProjectSidebarProps {
  projects: readonly Project[];
  controller: ProjectOrganizationController;
  activeProjectId: string | null;
  collapsed: boolean;
  disabled: boolean;
  homeActive: boolean;
  onHome: () => void;
  onOpen: (p: Project) => void;
  onAdd: (trigger: HTMLElement) => void;
  addMenuOpen: boolean;
  onRemove: (p: Project) => void;
  canOpenMenu: () => boolean;
  unreadByProject: Readonly<Record<string, number>>;
  onNotifications: () => void;
  onError: (error: unknown) => void;
  onModalChange?: (open: boolean) => void;
}
export function ProjectSidebar({
  projects,
  controller,
  activeProjectId,
  collapsed,
  disabled,
  homeActive,
  onHome,
  onOpen,
  onAdd,
  addMenuOpen,
  onRemove,
  canOpenMenu,
  unreadByProject,
  onNotifications,
  onError,
  onModalChange,
}: ProjectSidebarProps) {
  useLocale();
  const org = controller.organization,
    byId = new Map(projects.map((p) => [p.id, p]));
  const nav = useRef<HTMLElement>(null),
    newGroupButton = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<Menu | null>(null),
    [dialog, setDialog] = useState<Dialog | null>(null);
  const [name, setName] = useState(""),
    [dialogError, setDialogError] = useState("");
  const showDialog = (next: Dialog, initial = "") => {
    setName(initial);
    setDialogError("");
    setDialog(next);
  };
  const closeMenu = (restore = false) => {
    if (restore) menu?.trigger.focus();
    setMenu(null);
  };
  const menuProject = menu?.kind === "project" ? byId.get(menu.id) : undefined;
  const menuGroup =
    menu?.kind === "group"
      ? org.groups.find((g) => g.id === menu.id)
      : undefined;
  const dialogGroup =
    dialog && "id" in dialog
      ? org.groups.find((g) => g.id === dialog.id)
      : undefined;
  const modal = dialog !== null;
  useLayoutEffect(() => {
    onModalChange?.(modal);
    return () => onModalChange?.(false);
  }, [onModalChange, modal]);
  useEffect(() => {
    if (menu && !menuGroup && !menuProject) setMenu(null);
    if (dialog && "id" in dialog && !dialogGroup) setDialog(null);
  }, [menu, menuGroup, menuProject, dialog, dialogGroup]);
  const dispatch = (c: OrganizationCommand) => {
    try {
      controller.dispatch(c);
    } catch (e) {
      onError(e);
    }
  };
  const reorderBlocked = !controller.ready || disabled;
  const drag = useProjectDrag(
    nav,
    (cmd) => {
      if (!reorderBlocked) dispatch(cmd);
    },
    JSON.stringify([collapsed, reorderBlocked, org]),
  );
  const target = drag.view?.target;
  function launchMenu(
    kind: Menu["kind"],
    id: string,
    trigger: HTMLElement,
    x?: number,
    y?: number,
  ) {
    if (disabled || !canOpenMenu()) return;
    const box = trigger.getBoundingClientRect();
    setMenu({ kind, id, trigger, x: x ?? box.left + 12, y: y ?? box.bottom });
  }
  function context(
    kind: Menu["kind"],
    id: string,
    e: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>,
  ) {
    if (
      "key" in e &&
      e.key !== "ContextMenu" &&
      !(e.shiftKey && e.key === "F10")
    )
      return;
    e.preventDefault();
    e.stopPropagation();
    const trigger = e.currentTarget.querySelector<HTMLElement>(
      kind === "project" ? ".project-button" : ".ps-group-toggle",
    );
    if (trigger)
      launchMenu(
        kind,
        id,
        trigger,
        "clientX" in e ? e.clientX : undefined,
        "clientY" in e ? e.clientY : undefined,
      );
  }
  const requestedFocus = useRef<{ kind: Menu["kind"]; id: string } | null>(
    null,
  );
  useLayoutEffect(() => {
    const request = requestedFocus.current;
    requestedFocus.current = null;
    if (!request) return;
    const { kind, id } = request;
    // A project changing group is remounted. Focus its new instance, not the
    // detached menu anchor. Use data equality (IDs are data, not selectors).
    const attr =
      kind === "project" ? "data-project-target" : "data-group-target";
    const row = Array.from(
      nav.current?.querySelectorAll<HTMLElement>("[" + attr + "]") ?? [],
    ).find((e) => e.getAttribute(attr) === id);
    row
      ?.querySelector<HTMLElement>(
        kind === "project" ? ".project-button" : ".ps-group-toggle",
      )
      ?.focus();
  }, [org]);
  const menuCommand = (c: OrganizationCommand) => () => {
    if (!reorderBlocked) {
      requestedFocus.current = {
        kind: c.type === "moveProject" ? "project" : "group",
        id: c.id,
      };
      dispatch(c);
    }
  };
  const sortActions = (
    id: string,
    groupId: string | null,
    items: string[],
    kind: "group" | "project",
  ): SidebarMenuAction[] => {
    const i = items.indexOf(id);
    return ([-1, 1] as const).map((d) => {
      const anchor = items[i + d],
        side = d === -1 ? "before" : "after";
      return {
        key: "sort" + d,
        label: d === -1 ? msg("shell.moveUp") : msg("shell.moveDown"),
        icon: d === -1 ? <ArrowUp size={16} /> : <ArrowDown size={16} />,
        disabled: !anchor || reorderBlocked,
        run: menuCommand(
          kind === "project"
            ? { type: "moveProject", id, groupId, anchor, side }
            : { type: "moveGroup", id, anchor, side },
        ),
      };
    });
  };
  function projectActions(id: string) {
    const owner = org.groups.find((g) => g.projectIds.includes(id));
    return [
      ...sortActions(
        id,
        owner?.id ?? null,
        owner?.projectIds ?? org.ungroupedProjectIds,
        "project",
      ),
      ...org.groups
        .filter((g) => g !== owner)
        .map((g) => ({
          key: "to:" + g.id,
          label: msg("shell.moveIntoGroup", {group: g.name}),
          disabled: reorderBlocked,
          icon: <Folder size={16} />,
          run: menuCommand({ type: "moveProject", id, groupId: g.id }),
        })),
      ...(owner
        ? [
            {
              key: "ungroup",
              label: msg("shell.ungrouped"),
              disabled: reorderBlocked,
              icon: <Layers size={16} />,
              run: menuCommand({ type: "moveProject", id, groupId: null }),
            },
          ]
        : []),
    ];
  }
  function groupActions(g: ProjectGroup): SidebarMenuAction[] {
    return [
      ...sortActions(
        g.id,
        null,
        org.groups.map((k) => k.id),
        "group",
      ),
      {
        key: "rename",
        label: msg("shell.renameGroup"),
        disabled: reorderBlocked,
        icon: <Pencil size={16} />,
        run: () => showDialog({ kind: "rename", id: g.id }, g.name),
      },
      {
        key: "dissolve",
        label: msg("shell.ungroup"),
        disabled: reorderBlocked,
        icon: <Ungroup size={16} />,
        run: () => showDialog({ kind: "dissolve", id: g.id }),
      },
    ];
  }
  function row(id: string, groupId: string | null) {
    const p = byId.get(id);
    if (!p) return null;
    const selected = activeProjectId === id,
      unread = unreadByProject[id] ?? 0;
    const mark =
      target?.type === "moveProject" && target.anchor === id
        ? target.side
        : null;
    return (
      <div
        key={id}
        className={
          "ps-row project-notification-row" +
          (selected ? " ps-selected" : "") +
          (drag.view?.item.kind === "project" && drag.view.item.id === id
            ? " ps-drag-source"
            : "")
        }
        data-project-target={id}
        data-owner={groupId ?? ""}
        data-insert={mark}
        onContextMenu={(e) => context("project", id, e)}
        onKeyDown={(e) => context("project", id, e)}
      >
        {!collapsed && (
          <HintButton
            className="ps-grip"
            tabIndex={-1}
            disabled={reorderBlocked}
            type="button"
            hint={msg("shell.dragProject")}
            aria-label={msg("shell.dragProject2Named", { name: p.name })}
            onPointerDown={(e) =>
              drag.start(e, { kind: "project", id, label: p.name })
            }
          >
            <GripVertical size={14} />
          </HintButton>
        )}
        <TooltipButton
          label={p.name}
          tooltipLabel={p.name}
          description={p.path}
          sidebar
          tooltipEnabled={collapsed}
          busy={false}
          buttonClassName={"project-button" + (selected ? " active" : "")}
          disabled={disabled}
          onClick={() => onOpen(p)}
        >
          {selected ? (
            <FolderOpen className="folder-icon" size={17} />
          ) : (
            <Folder className="folder-icon" size={17} />
          )}
          <span className="ps-label">
            {p.name}
            <small>{p.path.split("/").slice(-2).join("/")}</small>
          </span>
        </TooltipButton>
        {unread > 0 && (
          <HintButton
            type="button"
            className="project-notification-badge"
            aria-label={msg("shell.projectUnreadLabel", { project: p.name, unread })}
            hint={msg("shell.notifications")}
            onClick={onNotifications}
          >
            <span className="notification-count">
              {unread > 99 ? "99+" : unread}
            </span>
          </HintButton>
        )}
        {!collapsed && (
          <HintButton
            className="ps-more"
            disabled={disabled}
            type="button"
            hint={msg("shell.projectActions")}
            aria-label={msg("shell.projectActions2Named", { name: p.name })}
            aria-haspopup="menu"
            onClick={(e) => launchMenu("project", id, e.currentTarget)}
          >
            <MoreHorizontal size={15} />
          </HintButton>
        )}
      </div>
    );
  }
  const saveDialog = () => {
    if (!dialog || !controller.ready) return;
    try {
      if (dialog.kind === "recover") controller.recover();
      else if (dialog.kind === "create")
        controller.dispatch({
          type: "createGroup",
          id: crypto.randomUUID(),
          name,
        });
      else if (dialog.kind === "rename")
        controller.dispatch({ type: "renameGroup", id: dialog.id, name });
      else controller.dispatch({ type: "dissolveGroup", id: dialog.id });
      setDialog(null);
      if (dialog.kind === "dissolve")
        requestAnimationFrame(() => newGroupButton.current?.focus());
    } catch (e) {
      setDialogError(e instanceof Error ? e.message : String(e));
    }
  };
  const title =
    dialog?.kind === "create"
      ? msg("shell.createGroup")
      : dialog?.kind === "rename"
        ? msg("shell.renameGroup2")
        : dialog?.kind === "dissolve"
          ? msg("shell.ungroupProjects")
          : msg("shell.replaceSavedLayout");
  return (
    <>
      <HintButton
        type="button"
        className={"ps-home" + (homeActive ? " ps-home-active" : "")}
        aria-current={homeActive ? "page" : undefined}
        aria-label={msg("shell.home")}
        hint={msg("shell.home")}
        disabled={disabled}
        onClick={onHome}
      >
        <House size={18} />
        {!collapsed && <span>{msg("shell.home")}</span>}
      </HintButton>
      <div className="sidebar-heading ps-heading">
        <span className="eyebrow">{msg("shell.projects")}</span>
        <div>
          {!collapsed && (
            <HintButton
              type="button"
              ref={newGroupButton}
              className="icon-button"
              aria-label={msg("shell.createGroup")}
              hint={msg("shell.createGroup")}
              disabled={reorderBlocked}
              onClick={() => {
                if (canOpenMenu()) showDialog({ kind: "create" });
              }}
            >
              <FolderPlus size={16} />
            </HintButton>
          )}
          <HintButton
            type="button"
            className="icon-button"
            hint={msg("shell.addProject")}
            aria-label={msg("shell.addProject")}
            aria-haspopup="menu"
            aria-expanded={addMenuOpen}
            onClick={(e) => onAdd(e.currentTarget)}
          >
            <Plus size={18} />
          </HintButton>
        </div>
      </div>
      <nav
        className="project-list ps-list"
        ref={nav}
        aria-label={msg("shell.projectList")}
      >
        {controller.issue && (
          <div className="ps-warning" role="status">
            {!collapsed && controller.issue.message}
            <HintButton
              type="button"
              hint={controller.issue.message}
              aria-label={
                controller.issue.kind === "protected"
                  ? msg("shell.restoreLayout")
                  : msg("shell.retrySaving")
              }
              onClick={() => {
                if (controller.issue?.kind === "protected") {
                  if (canOpenMenu()) showDialog({ kind: "recover" });
                } else controller.retry();
              }}
            >
              {collapsed
                ? "!"
                : controller.issue.kind === "protected"
                  ? msg("shell.restore")
                  : msg("shell.retry")}
            </HintButton>
          </div>
        )}
        {collapsed ? (
          orderedProjectIds(org).map((id) => row(id, null))
        ) : (
          <>
            {org.groups.map((g) => (
              <section
                key={g.id}
                role="group"
                aria-label={g.name}
                className="ps-group"
                data-group-target={g.id}
                data-insert={
                  target?.type === "moveGroup" && target.anchor === g.id
                    ? target.side
                    : null
                }
              >
                <div
                  className="ps-group-heading"
                  data-drop-group={g.id}
                  data-inside={
                    (target?.type === "moveProject" &&
                      !target.anchor &&
                      target.groupId === g.id) ||
                    undefined
                  }
                  onContextMenu={(e) => context("group", g.id, e)}
                  onKeyDown={(e) => context("group", g.id, e)}
                >
                  <HintButton
                    type="button"
                    tabIndex={-1}
                    className="ps-grip"
                    disabled={reorderBlocked}
                    hint={msg("shell.dragGroup")}
                    aria-label={msg("shell.dragGroup2Named", { name: g.name })}
                    onPointerDown={(e) =>
                      drag.start(e, { kind: "group", id: g.id, label: g.name })
                    }
                  >
                    <GripVertical size={14} />
                  </HintButton>
                  <button
                    type="button"
                    className="ps-group-toggle"
                    aria-label={msg("shell.groupNamed", { name: g.name })}
                    title={g.name}
                    aria-expanded={!g.collapsed}
                    disabled={!controller.ready}
                    onClick={() =>
                      dispatch({
                        type: "setCollapsed",
                        id: g.id,
                        collapsed: !g.collapsed,
                      })
                    }
                  >
                    {g.collapsed ? (
                      <ChevronRight size={15} />
                    ) : (
                      <ChevronDown size={15} />
                    )}
                    <Layers
                      size={13}
                      className="ps-group-icon"
                      aria-hidden="true"
                    />
                    <span>{g.name}</span>
                    <small>{g.projectIds.length}</small>
                  </button>
                  <button
                    type="button"
                    className="ps-more"
                    aria-label={msg("shell.groupActionsNamed", { name: g.name })}
                    aria-haspopup="menu"
                    onClick={(e) => launchMenu("group", g.id, e.currentTarget)}
                  >
                    <MoreHorizontal size={15} />
                  </button>
                </div>
                {!g.collapsed && (
                  <div className="ps-members" data-drop-group={g.id}>
                    {g.projectIds.map((id) => row(id, g.id))}
                    {!g.projectIds.length && (
                      <p className="ps-empty">{msg("shell.dropAProjectHere")}</p>
                    )}
                  </div>
                )}
              </section>
            ))}
            <section
              className="ps-loose"
              data-drop-group=""
              aria-label={msg("shell.ungrouped")}
            >
              <div
                className="ps-loose-heading"
                data-inside={
                  (target?.type === "moveProject" &&
                    !target.anchor &&
                    target.groupId === null) ||
                  undefined
                }
              >
                <Layers size={13} />
                <span>{msg("shell.ungrouped")}</span>
                <small>{org.ungroupedProjectIds.length}</small>
              </div>
              {org.ungroupedProjectIds.map((id) => row(id, null))}
              {!org.ungroupedProjectIds.length && controller.ready && (
                <p className="ps-empty">
                  {projects.length
                    ? msg("shell.dropAProjectHere")
                    : msg("shell.addYourFirstProject")}
                </p>
              )}
            </section>
          </>
        )}
      </nav>
      {!collapsed && projects.length > 0 && (
        <small className="ps-help">
          <GripVertical size={12} />{msg("shell.dragTheHandleToReorder")}</small>
      )}
      {menuProject && menu && (
        <ProjectListMenu
          key={menu.kind + menu.id}
          target={{ ...menu, project: menuProject }}
          actions={projectActions(menu.id)}
          onClose={closeMenu}
          onRemove={onRemove}
          onError={onError}
        />
      )}
      {menuGroup && menu && (
        <SidebarActionMenu
          key={menu.kind + menu.id}
          target={menu}
          label={msg("shell.groupActions2")}
          actions={groupActions(menuGroup)}
          onClose={closeMenu}
          onError={onError}
        />
      )}
      {dialog &&
        createPortal(
          <TopicModal
            title={title}
            className="ps-dialog"
            closeLabel={msg("shell.close")}
            onClose={() => setDialog(null)}
          >
            <form
              onSubmit={(e) => {
                e.preventDefault();
                saveDialog();
              }}
            >
              {dialog.kind === "create" || dialog.kind === "rename" ? (
                <label>{msg("shell.groupName")}<input
                    autoFocus
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      setDialogError("");
                    }}
                    maxLength={40}
                  />
                </label>
              ) : dialog.kind === "dissolve" ? (
                <p>{msg("shell.ungroupProjects", { group: dialogGroup?.name ?? "" })}</p>
              ) : (
                <p>{msg("shell.replaceTheSavedLayoutWithThisWindowSLayoutGroup")}</p>
              )}
              {dialogError && (
                <p role="alert" className="error">
                  {dialogError}
                </p>
              )}
              <footer className="form-actions">
                <button type="button" onClick={() => setDialog(null)}>{msg("shell.cancel")}</button>
                <button
                  type="submit"
                  className="primary"
                  disabled={
                    (dialog.kind === "create" || dialog.kind === "rename") &&
                    !name.trim()
                  }
                >
                  {dialog.kind === "create"
                    ? msg("shell.create")
                    : dialog.kind === "rename"
                      ? msg("shell.save")
                      : dialog.kind === "dissolve"
                        ? msg("shell.ungroup2")
                        : msg("shell.replace")}
                </button>
              </footer>
            </form>
          </TopicModal>,
          document.body,
        )}
      {drag.view &&
        createPortal(
          <div
            className="ps-drag-ghost"
            style={{ left: drag.view.x + 12, top: drag.view.y + 10 }}
            aria-hidden="true"
          >
            <GripVertical size={14} />
            {drag.view.item.label}
          </div>,
          document.body,
        )}
    </>
  );
}

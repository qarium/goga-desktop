import { Boxes, FolderOpen, SquareTerminal, Layers } from "lucide-react";
import { ProjectOverview } from "./overview/ProjectOverview";
import { GitHistory } from "./GitHistory";
import { GitUpdateHandoff } from "./GitUpdateHandoff";
import { useGitUpdateHandoff } from "./useGitUpdateHandoff";
import type { GitUpdateHandoffCandidate } from "../shared/git-update-handoff";
import { GitWorkspace } from "./GitWorkspace";
import { scopeProjectId } from "../shared/context";
import { flushSync } from "react-dom";
import {
  ContextDeletionProvider,
  ContextDeletionPopup,
  useContextDeletionController,
} from "./ContextDeletionController";
import { TopicOverview } from "./TopicOverview";
import { RetainedViews } from "./RetainedViews";
import { TerminalWorkspace } from "./TerminalWorkspace";
import {
  readCatalogCache,
  writeCatalogCache,
  readWorkspaceSelection,
  writeWorkspaceSelection,
  persistDeletedWorkspaceSelection,
  type DisplayCatalog,
} from "./topic-display-cache";
import {
  matchesWorkspace,
  runMatchesWorkspace,
  workspacePath,
  workspaceLaunchBlockReason,
} from "./workspace-context";
import { dismissActiveTopicPopup } from "./TopicPickerPopup";
import { topicError, TopicModal } from "./TopicsCommon";
import { preparationErrorMessage } from "./preparation-error";
import {
  buildRepeatPreparationSchema,
  type BuildRepeatPreparation,
} from "../shared/build-repeat";
import { ContextMigration } from "./ContextMigration";
import { readRequest, useReadScope } from "./read-request";
import {
  useEffect,
  useState,
  useRef,
  useSyncExternalStore,
  useCallback,
} from "react";
import type { Project, Run } from "../shared/types";
import "../shared/bridge";
import { createDraftStore } from "./task-drafts";
import {
  BuildForm,
  BuildCleanConfirmation,
  createBuildDrafts,
} from "./BuildForm";
import { LaunchForm } from "./LaunchForm";
import { LoadingState } from "./LoadingBoundary";
import { RunOutput, TerminalIcon, dashboardReady } from "./RunOutput";
import { Settings } from "./Settings";
import { createSettingsDocuments, documentScopeId } from "./settings-documents";
import {
  ProjectSettings,
  ProjectSettingsConfirmation,
  type ProjectSettingsGuard,
} from "./ProjectSettings";
import { TopicContextPicker } from "./TopicContextPicker";
import {
  RepositoryActions,
  TooltipButton,
  RepositoryOperationPopup,
} from "./RepositoryActions";
import { useRepositoryActionController } from "./repository-action-controller";
import { ContextRuns } from "./ContextRuns";
import { ContextLaunchMenu } from "./ContextLaunchMenu";
import {
  contextRunActivity,
  contextRef,
  contextKey,
  draftKey,
  type RunWithContext,
  type RunKind,
} from "./topic-context";
import type { TopicContextIdentity, WorktreeRecord } from "../shared/worktrees";
import {
  topicContextRefSchema,
  worktreeRecordSchema,
} from "../shared/worktrees";
import { TOPIC_CONTEXT_PREPARE_TIMEOUT_MS } from "../shared/worktree-capabilities";

import { TopicsWorkspace } from "./TopicsWorkspace";
import { TopicCard, type TopicCardContext } from "./TopicCard";
import { createTopicsStore } from "./topics-model";
import type {
  TopicBoardSnapshot,
  TopicBoardRecord,
  TopicTarget,
} from "../shared/topics";
import { version } from "../../package.json";
const labels: Record<string, string> = {
  starting: "Запускается",
  running: "Работает",
  exited: "Процесс завершён",
  failed: "Ошибка",
  stopped: "Остановлен",
};
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Read-only initial display ownership never becomes an execution selection. */
function initialOwnerFor(
  records: WorktreeRecord[],
  identity: TopicContextIdentity | null,
) {
  if (!identity) return { owner: null, ambiguous: false };
  const exact = records.filter(
    (record) =>
      !record.deletedAt &&
      record.projectId === identity.projectId &&
      record.year === identity.year &&
      record.topic === identity.topic &&
      record.branch === identity.branch,
  );
  const distinct = new Map(
    exact.map((record) => [
      JSON.stringify([contextKey(record), record.revision]),
      record,
    ]),
  );
  return {
    owner: distinct.size === 1 ? distinct.values().next().value! : null,
    ambiguous: distinct.size > 1,
  };
}
const ambiguousContextReason =
  "Несколько рабочих копий соответствуют этому топику. Выберите конкретную проверенную копию в шапке; запуск не будет назначен автоматически.";

/** Independent retained contexts may report pending work for one project. */
function gitOwnerFlag(
  previous: ReadonlyMap<string, string>,
  projectId: string,
  owner: string,
  enabled: boolean,
): ReadonlyMap<string, string> {
  const key = JSON.stringify([projectId, owner]);
  if (previous.has(key) === enabled) return previous;
  const next = new Map(previous);
  if (enabled) next.set(key, projectId);
  else next.delete(key);
  return next;
}

export function App() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem("goga.desktop.sidebarCollapsed") === "true";
    } catch {
      return false;
    }
  });
  const toggleSidebar = () =>
    setSidebarCollapsed((value) => {
      try {
        localStorage.setItem("goga.desktop.sidebarCollapsed", String(!value));
      } catch {
        /* UI remains usable without storage. */
      }
      return !value;
    });
  const repositoryPopupAnchor = useRef<HTMLDivElement>(null);
  const repositoryActions = useRepositoryActionController();
  const overviewCloseStates = useRef(
    new Map<string, { paths: string[]; busy: boolean }>(),
  );
  const [gitRevision, setGitRevision] = useState<Record<string, number>>({});
  const [gitModals, setGitModals] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [gitBranchBusy, setGitBranchBusy] = useState<
    ReadonlyMap<string, string>
  >(new Map());
  useEffect(() => {
    if (repositoryActions.revision) topicsChanged();
  }, [repositoryActions.revision]);
  const draftStore = useRef(createDraftStore());
  const buildDrafts = useRef(createBuildDrafts());
  const [repeatPending, setRepeatPending] = useState<Run | null>(null);
  const [repeatBusy, setRepeatBusy] = useState(false);
  const [reconcilingRun, setReconcilingRun] = useState<string | null>(null);
  const [repeatSeeds, setRepeatSeeds] = useState<
    Record<string, { preparation: BuildRepeatPreparation; nonce: number }>
  >({});
  const repeatNonce = useRef(0);
  const repeatFlight = useRef(false);
  const [settingsDocuments] = useState(createSettingsDocuments);
  const documentsBusy = useSyncExternalStore(
    settingsDocuments.subscribe,
    settingsDocuments.busy,
  );
  const [projects, setProjects] = useState<Project[]>([]),
    [projectId, setProjectId] = useState(""),
    [runs, setRuns] = useState<Run[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [page, setPage] = useState<
      | "overview"
      | "project"
      | "launch"
      | "settings"
      | "project-settings"
      | "topics"
      | "terminal"
      | "build"
      | "context-runs"
      | "context-preparation"
      | "changes"
      | "commits"
    >("overview"),
    [error, setError] = useState(""),
    [viewErrors, setViewErrors] = useState<Record<string, string>>({});
  const [gitStage, setGitStage] = useState<HTMLDivElement | null>(null);
  const gitReturnPages = useRef(new Map<string, typeof page>());
  const contextsEnabled = typeof window.goga.ensureTopicContext === "function";
  const [contextSelections, setContextSelections] = useState<
    Record<string, WorktreeRecord | null>
  >({});
  const restoration = useRef(new Map<string, WorktreeRecord>());
  const contextSelectionsRef = useRef(contextSelections);
  contextSelectionsRef.current = contextSelections;
  const selectedContext = contextSelections[projectId] ?? null;
  const selectedContextRef = useRef(selectedContext);
  selectedContextRef.current = selectedContext;
  const [knownContexts, setKnownContexts] = useState<WorktreeRecord[]>([]);
  const [contextsError, setContextsError] = useState("");
  const [contextsLoading, setContextsLoading] = useState(false);
  const [initialPreparation, setInitialPreparation] = useState<{
    identity: TopicContextIdentity;
    owner?: WorktreeRecord;
    kind: RunKind;
    nonce: number;
  } | null>(null);
  const initialFlights = useRef(new Map<string, Promise<WorktreeRecord>>());
  const initialPreparationNonce = useRef(0);
  useEffect(() => {
    if (typeof window.goga.selectTopicContext !== "function") return;
    void window.goga
      .selectTopicContext(
        selectedContext?.state === "ready" &&
          selectedContext.storageKind === "clone" &&
          selectedContext.ownership === "managed" &&
          selectedContext.compatibility !== "legacy-linked" &&
          !selectedContext.preparation &&
          !selectedContext.deletedAt &&
          topicContextRefSchema.safeParse(contextRef(selectedContext)).success
          ? contextRef(selectedContext)
          : null,
      )
      .catch((e) => setError(message(e)));
  }, [
    selectedContext?.contextId,
    selectedContext?.revision,
    selectedContext?.state,
    selectedContext?.storageKind,
    selectedContext?.ownership,
    selectedContext?.compatibility,
    selectedContext?.preparation,
    selectedContext?.deletedAt,
  ]);
  const [draftOwners, setDraftOwners] = useState<
    Record<string, WorktreeRecord>
  >({});
  const [activeDraft, setActiveDraft] = useState("");
  const projectNavigation = useRef(
    new Map<
      string,
      { page: typeof page; selected: string | null; activeDraft: string }
    >(),
  );
  useEffect(() => {
    if (projectId && page !== "settings")
      projectNavigation.current.set(projectId, {
        // Preparation is a captured mutation intent, not a browsable section.
        // Its in-flight result remains in initialFlights; navigation must never
        // automatically repeat/consume that intent.
        page: page === "context-preparation" ? "context-runs" : page,
        selected,
        activeDraft,
      });
  }, [projectId, page, selected, activeDraft]);
  const [contextOpenRuns, setContextOpenRuns] = useState(
    () => new Set<string>(),
  );
  function openContextRun(target: Run) {
    const ref = (target as RunWithContext).context;
    if (ref) {
      const owner = [
        ...knownContexts,
        ...Object.values(contextSelections),
      ].find(
        (record) => record != null && contextKey(record) === contextKey(ref),
      );
      // History remains viewable even if its clone has disappeared. Never ensure
      // or recreate a working copy merely to show recorded output.
      const recordedOwner: WorktreeRecord = owner ?? {
        ...ref,
        repositoryKey: ref.repositoryKey ?? "",
        projectPath: "",
        gitCommonDir: "",
        path: ref.path ?? "",
        ownership: "managed",
        storageKind: "clone",
        state: "missing",
      };
      setContextSelections((values) => ({
        ...values,
        [target.projectId]: recordedOwner,
      }));
      setContextOpenRuns((values) => new Set(values).add(target.id));
    } else {
      setContextSelections((values) => ({
        ...values,
        [target.projectId]: null,
      }));
    }
    setContextOpenRuns((values) => new Set(values).add(target.id));
    setProjectId(target.projectId);
    setSelected(target.id);
    setPage("project");
    setError("");
  }
  const openRunRef = useRef(openContextRun);
  openRunRef.current = openContextRun;
  const pageRef = useRef(page);
  pageRef.current = page;
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const [showLogs, setShowLogs] = useState<Record<string, boolean>>({});
  const settingsGuard = useRef<ProjectSettingsGuard | null>(null);
  const [launchSettingsBusy, setSettingsBusy] = useState(false);
  const [topicsBusy, setTopicsBusy] = useState(false);
  const settingsBusy =
    launchSettingsBusy || documentsBusy || topicsBusy || repeatBusy;
  const topicsStore = useRef(createTopicsStore());
  const [topicsRevision, setTopicsRevision] = useState(0);
  const [currentTopics, setCurrentTopics] = useState<DisplayCatalog | null>(
    null,
  );
  const [currentTopicsError, setCurrentTopicsError] = useState("");
  const [tableTopicSelection, setTableTopicSelection] = useState<{
    identity: TopicContextIdentity;
    nonce: number;
  } | null>(null);
  const [topicCard, setTopicCard] = useState<{
    project: Project;
    year: string;
    target: TopicTarget;
    board: TopicBoardSnapshot | null;
    context: TopicCardContext;
    host?: TopicBoardRecord;
    showArtifacts?: boolean;
  } | null>(null);
  const matchingCardOwners = topicCard
    ? [
        ...new Map(
          [...(selectedContext ? [selectedContext] : []), ...knownContexts]
            .filter(
              (record) =>
                record.projectId === topicCard.project.id &&
                record.year === topicCard.year &&
                record.topic === topicCard.target.topic &&
                record.branch === topicCard.target.branch,
            )
            .map((record) => [record.contextId, record]),
        ).values(),
      ]
    : [];
  const deletionOwner =
    matchingCardOwners.length === 1 ? matchingCardOwners[0] : undefined;
  const cardOwner =
    matchingCardOwners
      .filter((record) => !record.deletedAt)
      .find((record) => record.contextId === selectedContext?.contextId) ??
    (matchingCardOwners.length === 1 && !matchingCardOwners[0].deletedAt
      ? matchingCardOwners[0]
      : undefined);
  const cardOwnerError =
    !cardOwner && matchingCardOwners.length > 1
      ? "У топика несколько рабочих контекстов. Выберите нужный в селекторе топиков."
      : contextsError;
  const TopicCardComponent =
    topicCard?.context.kind === "topic" || topicCard?.context.kind === "current"
      ? TopicOverview
      : TopicCard;
  const [preparedTopic, setPreparedTopic] = useState<
    | { projectId: string; target: TopicTarget; text?: string; nonce: number }
    | undefined
  >();
  const [openLaunches, setOpenLaunches] = useState(() => new Set<string>());
  const [launchBusy, setLaunchBusy] = useState<Record<string, boolean>>({});
  const onLaunchBusy = useCallback((id: string, busy: boolean) => {
    setLaunchBusy((previous) =>
      previous[id] === busy ? previous : { ...previous, [id]: busy },
    );
  }, []);
  function showLaunch(projectId: string, owner?: WorktreeRecord) {
    const id = owner ? draftKey(owner, "pipeline") : projectId;
    if (owner)
      setDraftOwners((values) =>
        values[id] ? values : { ...values, [id]: owner },
      );
    setActiveDraft(id);
    setOpenLaunches((previous) =>
      previous.has(id) ? previous : new Set(previous).add(id),
    );
    setPage("launch");
  }
  function closeLaunch(id: string) {
    if (launchBusy[id]) return;
    navigate(() => {
      setOpenLaunches((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
      if (pageRef.current === "launch") setPage("project-settings");
      // Keep the existing memory task/form drafts on explicit close, as before.
      // Closing a preparation is never consent to discard an unsaved task.
    });
  }
  const [openBuilds, setOpenBuilds] = useState(() => new Set<string>());
  const [buildBusy, setBuildBusy] = useState<Record<string, boolean>>({});
  const onBuildBusy = useCallback((id: string, busy: boolean) => {
    setBuildBusy((previous) =>
      previous[id] === busy ? previous : { ...previous, [id]: busy },
    );
  }, []);
  function showBuild(projectId: string, owner?: WorktreeRecord) {
    const id = owner ? draftKey(owner, "build") : projectId;
    if (owner)
      setDraftOwners((values) =>
        values[id] ? values : { ...values, [id]: owner },
      );
    setOpenBuilds((values) => new Set(values).add(id));
    setActiveDraft(id);
    setPage("build");
  }
  function showContextPreparation(kind: RunKind, owner: WorktreeRecord) {
    if (
      owner.state !== "ready" ||
      owner.storageKind !== "clone" ||
      owner.compatibility === "legacy-linked" ||
      owner.ownership !== "managed" ||
      owner.preparation ||
      owner.deletedAt ||
      workspaceLaunchBlockReason(runsRef.current, owner.projectId, owner, kind)
    )
      return;
    // A selected ready owner already has an exact identity. Opening a form is
    // read-only; its scoped host reads and the final launch enforce authority.
    if (kind === "build") showBuild(owner.projectId, owner);
    else showLaunch(owner.projectId, owner);
  }
  function returnToDraft(id: string, kind: RunKind) {
    const owner = draftOwners[id];
    setContextSelections((values) => ({
      ...values,
      [projectId]: owner ?? null,
    }));
    setActiveDraft(id);
    setSelected(null);
    setPage(kind === "build" ? "build" : "launch");
  }
  const preparationEntries = (ids: Set<string>) =>
    [...ids].flatMap((id) => {
      const owner = draftOwners[id];
      const project = projects.find(
        (item) =>
          item.id ===
          (owner?.projectId ?? repeatSeeds[id]?.preparation.projectId ?? id),
      );
      return project ? [{ id, owner, project }] : [];
    });
  function closeBuild(id: string) {
    if (buildBusy[id]) return;
    navigate(() => {
      setOpenBuilds((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
      buildDrafts.current.delete(id);
      setRepeatSeeds((previous) => {
        const next = { ...previous };
        delete next[id];
        return next;
      });
      if (pageRef.current === "build") setPage("project-settings");
    });
  }
  function topicsChanged() {
    setTopicsRevision((n) => n + 1);
  }

  const [settingsRevision, setSettingsRevision] = useState<
    Record<string, string>
  >({});
  const homeDocumentRevision = useSyncExternalStore(
    settingsDocuments.subscribe,
    settingsDocuments.homeRevision,
  );
  const workflowRevision = useSyncExternalStore(
    settingsDocuments.subscribe,
    () => settingsDocuments.projectRevision(projectId),
  );
  const [pendingNavigation, setPendingNavigation] = useState<
    (() => void) | null
  >(null);
  const navigateRef = useRef<(action: () => void) => void>(() => {});
  function navigate(action: () => void, preserveProjectDraft = false) {
    if (
      topicsBusy ||
      deletion.busy ||
      repeatPending ||
      repeatBusy ||
      topicCard ||
      settingsDocuments.busy() ||
      settingsGuard.current?.busy ||
      pendingNavigation
    )
      return;
    if (settingsGuard.current?.dirty && !preserveProjectDraft)
      setPendingNavigation(() => action);
    else action();
  }
  navigateRef.current = navigate;
  const runsRef = useRef<Run[]>([]),
    selectedRef = useRef<string | null>(null);
  const closing = useRef(new Set<string>());
  const restoreTabFocus = useRef<string | null>(null);
  const [closingIds, setClosingIds] = useState<string[]>([]);
  selectedRef.current = selected;
  function applyRuns(next: Run[]) {
    const focusedRun = (document.activeElement as HTMLElement | null)?.dataset
      .closeRun;
    if (focusedRun && !next.some((r) => r.id === focusedRun))
      restoreTabFocus.current = focusedRun;
    const previous = runsRef.current;
    runsRef.current = next;
    setRuns(next);
    const id = selectedRef.current;
    if (id && !next.some((r) => r.id === id)) {
      const old = previous.find((r) => r.id === id);
      if ((old as RunWithContext | undefined)?.context) {
        selectedRef.current = null;
        setSelected(null);
        if (pageRef.current === "project")
          setPage(
            selectedContextRef.current ? "context-runs" : "project-settings",
          );
        return;
      }
      const inCurrentWorkspace = (r: Run) =>
        runMatchesWorkspace(
          r,
          projectIdRef.current,
          selectedContextRef.current,
        );
      const siblings = previous.filter(inCurrentWorkspace);
      const index = siblings.findIndex((r) => r.id === id);
      const order = [
        ...siblings.slice(index + 1),
        ...siblings.slice(0, index).reverse(),
      ];
      const neighbour =
        order.find((r) => next.some((n) => n.id === r.id))?.id ??
        next.find(inCurrentWorkspace)?.id ??
        null;
      selectedRef.current = neighbour;
      setSelected(neighbour);
      if (!neighbour && pageRef.current === "project")
        setPage("project-settings");
    }
    setShowLogs((values) =>
      Object.fromEntries(
        Object.entries(values).filter(([id]) => next.some((r) => r.id === id)),
      ),
    );
    setViewErrors((errors) =>
      Object.fromEntries(
        Object.entries(errors).filter(([id]) => next.some((r) => r.id === id)),
      ),
    );
  }
  async function closeTab(id: string) {
    if (
      contextOpenRuns.has(id) &&
      (runs.find((record) => record.id === id) as RunWithContext | undefined)
        ?.context
    ) {
      setContextOpenRuns((values) => {
        const next = new Set(values);
        next.delete(id);
        return next;
      });
      if (selected === id) {
        setSelected(null);
        if (pageRef.current === "project")
          setPage(selectedContext ? "context-runs" : "project-settings");
      }
      return;
    }
    if (closing.current.has(id)) return;
    if ((document.activeElement as HTMLElement | null)?.dataset.closeRun === id)
      restoreTabFocus.current = id;
    closing.current.add(id);
    setClosingIds([...closing.current]);
    setError("");
    try {
      const closed = await window.goga.closeRun(id);
      if (!closed && restoreTabFocus.current === id)
        restoreTabFocus.current = null;
    } catch (e) {
      if (restoreTabFocus.current === id) restoreTabFocus.current = null;
      setError(message(e));
    } finally {
      closing.current.delete(id);
      setClosingIds([...closing.current]);
    }
  }
  const read = useReadScope(projectId);
  const project = projects.find((p) => p.id === projectId),
    run = runs.find(
      (r) =>
        r.id === selected && runMatchesWorkspace(r, projectId, selectedContext),
    );
  const handoff = useGitUpdateHandoff({
    scope: project
      ? selectedContext
        ? contextRef(selectedContext)
        : project.id
      : null,
    onError: setError,
    onChanged: (scope) => {
      const owner = documentScopeId(scope);
      setGitRevision((previous) => ({
        ...previous,
        [owner]: (previous[owner] ?? 0) + 1,
      }));
      topicsChanged();
      void settingsDocuments.refreshProject(scope);
      navigate(() => {
        const current = selectedContextRef.current
          ? contextRef(selectedContextRef.current)
          : projectIdRef.current;
        if (documentScopeId(current) !== owner) return;
        setPage("changes");
      }, true);
    },
  });
  const openHandoff = (candidate: GitUpdateHandoffCandidate) => {
    setTopicCard(null);
    void handoff.open(candidate);
  };

  const displayedPath = workspacePath(project, selectedContext);
  useEffect(() => {
    let alive = true;
    readRequest("listProjects").then(
      (p) => {
        if (alive) {
          const saved: Record<string, WorktreeRecord | null> = {};
          for (const project of p) {
            const record = readWorkspaceSelection(project);
            if (record !== undefined) {
              saved[project.id] = record;
              if (record) restoration.current.set(project.id, record);
            }
          }
          setContextSelections((previous) => ({ ...saved, ...previous }));
          setProjects(p);
          setProjectId(p[0]?.id ?? "");
        }
      },
      (e) => {
        if (alive) setError(message(e));
      },
    );
    let receivedRuns = false;
    readRequest("runs").then(
      (r) => {
        if (alive && !receivedRuns) applyRuns(r);
      },
      (e) => {
        if (alive) setError(message(e));
      },
    );
    const off = window.goga.onRuns((next) => {
        receivedRuns = true;
        if (alive) applyRuns(next);
      }),
      focus = window.goga.onFocusRun((id) => {
        if (!runsRef.current.some((r) => r.id === id)) return;
        navigateRef.current(() => {
          const target = runsRef.current.find((r) => r.id === id);
          if (!target) return;
          openRunRef.current(target);
        });
      }),
      failed = window.goga.onViewError(({ id, error }) => {
        if (runsRef.current.some((r) => r.id === id))
          setViewErrors((v) => ({ ...v, [id]: error }));
      });
    return () => {
      alive = false;
      off();
      focus();
      failed();
    };
  }, []);
  useEffect(() => {
    for (const project of projects) {
      if (Object.prototype.hasOwnProperty.call(contextSelections, project.id))
        writeWorkspaceSelection(project, contextSelections[project.id]);
    }
  }, [projects, contextSelections]);
  useEffect(() => {
    const saved = restoration.current.get(projectId);
    if (!saved || contextSelectionsRef.current[projectId] !== saved) return;
    let alive = true;
    const fail = (e: unknown) => {
      if (!alive || contextSelectionsRef.current[projectId] !== saved) return;
      restoration.current.delete(projectId);
      setContextSelections((previous) =>
        previous[projectId] === saved
          ? { ...previous, [projectId]: { ...saved, preparation: undefined } }
          : previous,
      );
      setError(
        `Не удалось восстановить выбранный топик «${saved.topic}»: ${message(e)}. Основная папка не выбрана вместо него.`,
      );
    };
    void readRequest("resolveTopicContext", contextRef(saved))
      .then((value) => {
        const record = worktreeRecordSchema.parse(value);
        if (
          contextKey(record) !== contextKey(saved) ||
          record.revision !== saved.revision ||
          record.projectPath !== saved.projectPath ||
          record.state !== "ready" ||
          record.storageKind !== "clone" ||
          record.ownership !== "managed" ||
          record.preparation ||
          record.deletedAt
        )
          throw Error("Сохранённая копия недоступна или изменилась");
        if (!alive || contextSelectionsRef.current[projectId] !== saved) return;
        restoration.current.delete(projectId);
        setContextSelections((previous) =>
          previous[projectId] === saved
            ? { ...previous, [projectId]: record }
            : previous,
        );
      })
      .catch(fail);
    return () => {
      alive = false;
    };
  }, [projectId]);
  useEffect(() => {
    if (page === "project" && run) setProjectId(run.projectId);
  }, [selected]);
  useEffect(() => {
    // Never await presentation cleanup to enable the error's close controls.
    if (error) void dismissActiveTopicPopup().catch(() => {});
  }, [error]);
  const canShowDashboard =
    !!run && dashboardReady(run) && !run.error && !viewErrors[run.id];
  const visibleRun =
    !handoff.candidate &&
    !gitModals.size &&
    !error &&
    !topicCard &&
    page === "project" &&
    run &&
    canShowDashboard &&
    !showLogs[run.id]
      ? run.id
      : null;
  useEffect(() => {
    window.goga.selectRun(visibleRun).catch((e) => {
      if (visibleRun)
        setViewErrors((previous) => ({
          ...previous,
          [visibleRun]: message(e),
        }));
      setError(message(e));
    });
  }, [visibleRun]);
  useEffect(() => {
    if (
      !restoreTabFocus.current ||
      runs.some((r) => r.id === restoreTabFocus.current)
    )
      return;
    restoreTabFocus.current = null;
    if (document.activeElement !== document.body) return;
    const target =
      document.querySelector<HTMLButtonElement>(
        '[role="tab"][aria-selected="true"]',
      ) ??
      document.querySelector<HTMLButtonElement>('[role="tab"]') ??
      document.querySelector<HTMLButtonElement>(
        ".project-bar button:not(:disabled)",
      );
    target?.focus();
  }, [runs, selected]);
  async function add() {
    setError("");
    try {
      const p = await window.goga.chooseProject();
      if (!p) return;
      setProjects((items) =>
        items.some((i) => i.id === p.id) ? items : [...items, p],
      );
      // The native picker may finish after settings edits or a save begin.
      // Keep the added project, but let the current guard decide navigation.
      navigateRef.current(() => {
        const saved = projectNavigation.current.get(p.id);
        setProjectId(p.id);
        setSelected(saved?.selected ?? null);
        setPage(saved?.page ?? "overview");
        setActiveDraft(saved?.activeDraft ?? "");
      });
    } catch (e) {
      setError(message(e));
    }
  }
  async function stop() {
    if (!run || run.recovery === "unverified") return;
    try {
      await window.goga.stopRun(run.id);
    } catch (e) {
      setError(message(e));
    }
  }
  async function reconcileRun(target: Run) {
    if (reconcilingRun || typeof window.goga.reconcileRun !== "function")
      return;
    setReconcilingRun(target.id);
    setError("");
    try {
      const reconciled = await window.goga.reconcileRun(target.id);
      if (runsRef.current.some((entry) => entry.id === target.id))
        applyRuns(
          runsRef.current.map((entry) =>
            entry.id === target.id ? reconciled : entry,
          ),
        );
    } catch (error) {
      setError(message(error));
    } finally {
      setReconcilingRun(null);
    }
  }
  async function repeatBuild(target: Run, confirmClean = false) {
    if (repeatFlight.current) return;
    if (
      typeof window.goga.prepareBuildRepeat !== "function" &&
      target.build?.clean &&
      !confirmClean
    ) {
      setRepeatPending(target);
      return;
    }
    repeatFlight.current = true;
    setRepeatBusy(true);
    setRepeatPending(null);
    setError("");
    try {
      if (typeof window.goga.prepareBuildRepeat === "function") {
        const preparation = buildRepeatPreparationSchema.parse(
          await window.goga.prepareBuildRepeat(target.id),
        );
        if (
          preparation.sourceRunId !== target.id ||
          preparation.projectId !== target.projectId
        )
          throw Error(
            "Параметры повторной сборки не соответствуют выбранному запуску.",
          );
        let owner: WorktreeRecord | undefined;
        if (preparation.context) {
          if (typeof window.goga.resolveTopicContext !== "function")
            throw Error("Не удалось проверить рабочую копию повторной сборки.");
          owner = await window.goga.resolveTopicContext(preparation.context);
          if (
            contextKey(owner) !== contextKey(preparation.context) ||
            owner.revision !== preparation.context.revision ||
            owner.state !== "ready" ||
            owner.storageKind !== "clone"
          )
            throw Error(
              "Рабочая копия повторной сборки недоступна. Подготовьте повтор заново.",
            );
        }
        const ownerDraftId = owner
          ? draftKey(owner, "build")
          : preparation.projectId;
        if (buildBusy[ownerDraftId])
          throw Error("Дождитесь завершения подготовки текущего запуска.");
        // A repeat is its own preparation, never a replacement for an unsaved
        // owner draft (including another repeat). Cancellation only closes it.
        const nonce = ++repeatNonce.current;
        const id = JSON.stringify([
          "build-repeat",
          preparation.sourceRunId,
          nonce,
        ]);
        if (owner)
          setDraftOwners((previous) => ({ ...previous, [id]: owner! }));
        setRepeatSeeds((previous) => ({
          ...previous,
          [id]: { preparation, nonce },
        }));
        setContextSelections((previous) => ({
          ...previous,
          [preparation.projectId]: owner ?? null,
        }));
        setProjectId(preparation.projectId);
        setSelected(null);
        setOpenBuilds((previous) => new Set(previous).add(id));
        setActiveDraft(id);
        setPage("build");
        return;
      }
      // Compatibility with older hosts: retain their in-session repeat contract.
      const next = await window.goga.repeatBuild(target.id, confirmClean);
      if (!runsRef.current.some((r) => r.id === next.id))
        applyRuns([...runsRef.current, next]);
      openRunRef.current(next);
    } catch (e) {
      setError(message(e));
    } finally {
      repeatFlight.current = false;
      setRepeatBusy(false);
    }
  }
  const active = runs.some(
    (r) =>
      r.projectId === projectId &&
      (r.status === "starting" || r.status === "running"),
  );
  const topicScope = JSON.stringify([
    projectId,
    settingsRevision[projectId],
    workflowRevision,
    homeDocumentRevision,
    topicsRevision,
    active,
  ]);
  useEffect(() => {
    let alive = true;
    const year = String(new Date().getFullYear());
    setCurrentTopics(project ? readCatalogCache(project, year) : null);
    setCurrentTopicsError("");
    if (!project) return;
    const request =
      typeof window.goga.readTopicCatalog === "function"
        ? read("readTopicCatalog", project.id, year)
        : typeof window.goga.readTopicBoard === "function"
          ? read("readTopicBoard", project.id, year)
          : null;
    if (!request) return;
    request.then(
      (b) => {
        if (!alive) return;
        if (b.projectId !== project.id || b.year !== year) {
          setCurrentTopicsError(
            "Список топиков относится к другому проекту или году.",
          );
          return;
        }
        writeCatalogCache(project, b);
        setCurrentTopics(b);
      },
      (e) => {
        if (alive) setCurrentTopicsError(topicError(e));
      },
    );
    return () => {
      alive = false;
    };
  }, [topicScope]);
  useEffect(() => {
    let alive = true;
    setKnownContexts([]);
    setContextsError("");
    setContextsLoading(contextsEnabled && Boolean(projectId));
    if (contextsEnabled && projectId)
      read("listTopicContexts", projectId).then(
        (records) => {
          if (alive) {
            setKnownContexts(records);
            setContextsLoading(false);
          }
        },
        (failure) => {
          if (alive) {
            setContextsError(message(failure));
            setContextsLoading(false);
          }
        },
      );
    return () => {
      alive = false;
    };
  }, [read, projectId, topicsRevision, contextsEnabled]);
  // Only an explicit selection owns clone actions. Null is the original folder.
  const displayOwner = selectedContext;

  const headerTopic = selectedContext?.topic ?? "Без топика";
  const primaryRuns = runs.filter(
    (value) =>
      value.projectId === projectId && !(value as RunWithContext).context,
  );
  const primaryActive = primaryRuns.filter(
    (value) => value.status === "starting" || value.status === "running",
  );
  const contextActivity = selectedContext
    ? contextRunActivity(runs as RunWithContext[], selectedContext)
    : { activeCount: primaryActive.length };
  const contextUnavailable = displayOwner
    ? displayOwner.state !== "ready"
      ? "Рабочая копия недоступна. История запусков сохранена."
      : displayOwner.storageKind !== "clone" ||
          displayOwner.compatibility === "legacy-linked"
        ? "Прежняя linked-worktree копия доступна только для просмотра. Для запуска требуется автономный клон."
        : displayOwner.ownership !== "managed" ||
            displayOwner.preparation ||
            displayOwner.deletedAt ||
            !topicContextRefSchema.safeParse(contextRef(displayOwner)).success
          ? "Рабочая копия не готова к запуску. Выберите проверенный автономный клон."
          : ""
    : "";
  const launchUnavailable =
    contextUnavailable ||
    workspaceLaunchBlockReason(runs, projectId, selectedContext, "pipeline");
  function prepareFromHeader(kind: RunKind) {
    if (
      contextUnavailable ||
      workspaceLaunchBlockReason(
        runsRef.current,
        projectId,
        selectedContext,
        kind,
      )
    )
      return;
    if (selectedContext) showContextPreparation(kind, selectedContext);
    else if (kind === "build") showBuild(projectId);
    else showLaunch(projectId);
    setError("");
  }
  // Owner-local drafts are App-owned. Switching scope preserves them rather
  // than forcing a discard/save dialog for an unrelated context.
  function navigateContext(action: () => void) {
    if (
      settingsBusy ||
      deletion.busy ||
      settingsGuard.current?.busy ||
      topicCard ||
      pendingNavigation
    )
      return;
    action();
  }
  // Native Dashboard bounds are fixed. Keep errors outside its column while
  // it is visible; once the run ends the message can use normal main flow.
  // Logical ownership is stable across metadata revisions; host checks still use
  // fresh props. Removing a project explicitly disposes its retained UI only.
  const sectionKey = (kind: string, owner = selectedContext) =>
    project
      ? JSON.stringify([
          project.id,
          project.path,
          kind,
          owner ? contextKey(owner) : "primary",
        ])
      : null;
  const openGitView = (target: "changes" | "commits") =>
    navigate(() => {
      const key = sectionKey("git");
      if (key && page !== "changes" && page !== "commits")
        gitReturnPages.current.set(key, page);
      setPage(target);
    }, true);
  const closeGitView = () =>
    navigate(() => {
      const previous =
        gitReturnPages.current.get(sectionKey("git") ?? "") ??
        "project-settings";
      setPage(previous === "project" && !run ? "project-settings" : previous);
    }, true);
  const retainProjectView = (key: string) => {
    const [id, path] = JSON.parse(key);
    return projects.some(
      (project) => project.id === id && project.path === path,
    );
  };
  const deletion = useContextDeletionController(async (owner) => {
    const saved = contextSelectionsRef.current[owner.projectId];
    const matches = saved && contextKey(saved) === contextKey(owner);
    const deletingProject = projects.find(
      (item) => item.id === owner.projectId,
    );
    // The operation outlives the card. Commit and persist navigation before Goga.
    flushSync(() => {
      if (matches) {
        const next = {
          ...contextSelectionsRef.current,
          [owner.projectId]: null,
        };
        contextSelectionsRef.current = next;
        setContextSelections(next);
        restoration.current.delete(owner.projectId);
        if (projectId === owner.projectId) {
          selectedContextRef.current = null;
          selectedRef.current = null;
          setSelected(null);
          setPage(
            pageRef.current === "terminal"
              ? "terminal"
              : pageRef.current === "topics"
                ? "topics"
                : "project-settings",
          );
        }
      }
      setKnownContexts((values) =>
        values.map((record) =>
          record.contextId === owner.contextId
            ? {
                ...record,
                state: "missing",
                deletedAt: new Date().toISOString(),
              }
            : record,
        ),
      );
      setTopicCard((value) =>
        value?.project.id === owner.projectId &&
        value.year === owner.year &&
        value.target.topic === owner.topic &&
        value.target.branch === owner.branch
          ? null
          : value,
      );
    });
    const current = contextSelectionsRef.current[projectId];
    await window.goga.selectTopicContext(
      current?.state === "ready" &&
        current.storageKind === "clone" &&
        current.ownership === "managed" &&
        !current.preparation &&
        !current.deletedAt &&
        current.compatibility !== "legacy-linked" &&
        topicContextRefSchema.safeParse(contextRef(current)).success
        ? contextRef(current)
        : null,
    );
    if (!deletingProject)
      throw Error("Не удалось сохранить выбор: проект недоступен.");
    persistDeletedWorkspaceSelection(deletingProject, owner);
  }, topicsChanged);
  const content = (
    <div className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <header className="titlebar">
        <div className="wordmark">
          <b>Go</b>ga <small>DESKTOP</small>
        </div>
      </header>
      <aside className="sidebar" aria-label="Боковая панель">
        <label className="eyebrow" htmlFor="workspace">
          РАБОЧАЯ ОБЛАСТЬ
        </label>
        <select id="workspace" aria-label="Рабочая область" disabled>
          <option>Мой компьютер</option>
        </select>
        <div className="local-label">
          <i /> Только локальная рабочая область
        </div>
        <div className="sidebar-heading">
          <span className="eyebrow">ПРОЕКТЫ</span>
          <button
            aria-label="Добавить проект"
            onClick={() => navigate(() => void add())}
            className="icon-button"
          >
            ＋
          </button>
        </div>
        <nav className="project-list">
          {projects.map((p) => (
            <TooltipButton
              label={p.name}
              tooltipLabel={p.name}
              description={p.path}
              sidebar
              tooltipEnabled={sidebarCollapsed}
              busy={false}
              key={p.id}
              buttonClassName={`project-button ${page !== "settings" && p.id === projectId ? "active" : ""}`}
              disabled={settingsBusy}
              onClick={() =>
                navigate(() => {
                  const saved = projectNavigation.current.get(p.id);
                  setProjectId(p.id);
                  setPage(saved?.page ?? "overview");
                  setSelected(saved?.selected ?? null);
                  setActiveDraft(saved?.activeDraft ?? "");
                  setError("");
                })
              }
            >
              <span className="folder-icon">▱</span>
              <span>
                {p.name}
                <small>{p.path.split("/").slice(-2).join("/")}</small>
              </span>
            </TooltipButton>
          ))}
        </nav>
        <button
          aria-label="Настройки"
          className={`settings-button ${page === "settings" ? "active" : ""}`}
          disabled={settingsBusy}
          onClick={() =>
            navigate(() => {
              setPage("settings");
              setError("");
            })
          }
        >
          ⚙ <span>Настройки</span>
        </button>
        <small className="sidebar-footer">
          <span>© Goga 2026</span>
          <span className="app-version">v{version}</span>
          <button
            className="icon-button sidebar-toggle"
            aria-label={
              sidebarCollapsed
                ? "Развернуть боковую панель"
                : "Свернуть боковую панель"
            }
            aria-expanded={!sidebarCollapsed}
            onClick={toggleSidebar}
            title={
              sidebarCollapsed
                ? "Развернуть боковую панель"
                : "Свернуть боковую панель"
            }
          >
            <span aria-hidden="true">{sidebarCollapsed ? "»" : "«"}</span>
          </button>
        </small>
      </aside>
      <main className="main-area">
        <div className="project-bar" ref={repositoryPopupAnchor}>
          <div className="project-heading">
            <span className="eyebrow">
              Мой компьютер / {page === "settings" ? "НАСТРОЙКИ" : "ПРОЕКТ"}
            </span>
            <h1 title={page === "settings" ? "Настройки" : project?.name}>
              {page === "settings"
                ? "Настройки"
                : (project?.name ?? "Goga Desktop")}
            </h1>
          </div>
          <div className="project-heading-context">
            {page !== "settings" && project && (
              <TopicContextPicker
                key={project.id}
                project={project}
                requestedSelection={tableTopicSelection}
                onSelectionRequestHandled={() => setTableTopicSelection(null)}
                board={currentTopics}
                catalogError={currentTopicsError}
                onRetryCatalog={() => setTopicsRevision((value) => value + 1)}
                selected={selectedContext}
                knownContexts={knownContexts}
                runs={runs as RunWithContext[]}
                disabled={settingsBusy}
                onTransitionIntent={() => {
                  if (pageRef.current !== "context-preparation") return;
                  // A new explicit topic transition owns continuation even
                  // while its verification is pending. Retain A's flight
                  // for reconciliation, but never publish its late result.
                  initialPreparationNonce.current++;
                  setInitialPreparation(null);
                  setPage("context-runs");
                }}
                onCreated={(record) =>
                  navigateContext(() => {
                    setContextSelections((values) => ({
                      ...values,
                      [projectId]: record,
                    }));
                    setKnownContexts((values) => [
                      ...values.filter(
                        (value) => value.contextId !== record.contextId,
                      ),
                      record,
                    ]);
                    topicsChanged();
                    showContextPreparation("pipeline", record);
                  })
                }
                onSelect={(record) =>
                  navigateContext(() => {
                    setContextSelections((values) => ({
                      ...values,
                      [projectId]: record,
                    }));
                    setKnownContexts((values) => [
                      ...values.filter(
                        (value) => value.contextId !== record.contextId,
                      ),
                      record,
                    ]);
                    selectedRef.current = null;
                    selectedContextRef.current = record;
                    setSelected(null);
                    setPage(
                      pageRef.current === "overview" ||
                        pageRef.current === "project-settings" ||
                        pageRef.current === "topics" ||
                        pageRef.current === "changes" ||
                        pageRef.current === "commits"
                        ? pageRef.current
                        : pageRef.current === "terminal"
                          ? "terminal"
                          : "context-runs",
                    );
                    setError("");
                  })
                }
                onClear={() =>
                  navigateContext(() => {
                    setContextSelections((values) => ({
                      ...values,
                      [projectId]: null,
                    }));
                    selectedRef.current = null;
                    selectedContextRef.current = null;
                    setSelected(null);
                    setPage(
                      pageRef.current === "overview" ||
                        pageRef.current === "project-settings" ||
                        pageRef.current === "topics" ||
                        pageRef.current === "changes" ||
                        pageRef.current === "commits"
                        ? pageRef.current
                        : pageRef.current === "terminal"
                          ? "terminal"
                          : "project-settings",
                    );
                  })
                }
                onOpenCard={(target, year) =>
                  navigate(() =>
                    setTopicCard({
                      project,
                      year,
                      target,
                      board: null,
                      context: { kind: "topic" },
                      showArtifacts: true,
                    }),
                  )
                }
              />
            )}
            {page !== "settings" && project && (
              <RepositoryActions
                project={project}
                selected={selectedContext}
                disabled={
                  settingsBusy ||
                  [...gitBranchBusy.values()].includes(project.id)
                }
              />
            )}
          </div>
          {page !== "settings" && project && (
            <div className="project-actions">
              <button
                className="quiet"
                aria-label="Запуски"
                aria-pressed={page === "context-runs"}
                title={`Активных запусков выбранного топика: ${contextActivity.activeCount}`}
                disabled={settingsBusy}
                onClick={() =>
                  navigate(() => {
                    setSelected(null);
                    setPage("context-runs");
                  })
                }
              >
                Запуски
                <span
                  className="context-active-count"
                  aria-label={`Активных: ${contextActivity.activeCount}`}
                >
                  {contextActivity.activeCount}
                </span>
              </button>
              <ContextLaunchMenu
                context={displayOwner}
                runs={runs as RunWithContext[]}
                disabled={settingsBusy}
                blockedReason={launchUnavailable}
                prepareWithoutContext={!selectedContext}
                primaryProjectId={projectId}
                onPrepare={(kind) => navigate(() => prepareFromHeader(kind))}
              />
            </div>
          )}
          <RepositoryOperationPopup
            anchor={repositoryPopupAnchor}
            onHandoff={openHandoff}
          />
        </div>
        {handoff.candidate && (
          <GitUpdateHandoff
            candidate={handoff.candidate}
            autoPrepare
            onClose={handoff.close}
            onChanged={handoff.changed}
          />
        )}
        {error && (
          <TopicModal
            title="Не удалось выполнить операцию"
            closeLabel="Закрыть сообщение"
            className="app-error-dialog"
            onClose={() => setError("")}
          >
            <pre role="alert">{error}</pre>
          </TopicModal>
        )}
        <RetainedViews activeKey={page === "settings" ? "settings" : null}>
          <div className="scroll-area global-settings-scroll-area">
            <Settings
              documents={settingsDocuments}
              onBack={() => navigate(() => setPage("project-settings"))}
            />
          </div>
        </RetainedViews>
        <div className="project-page" hidden={page === "settings"}>
          <div className="tabs" role="tablist" aria-label="Разделы проекта">
            {project && (
              <button
                type="button"
                className="topics-nav"
                aria-pressed={page === "overview"}
                disabled={settingsBusy}
                onClick={() => navigate(() => setPage("overview"))}
              >
                <Boxes size={16} aria-hidden="true" />
                Обзор
              </button>
            )}
            {project && (
              <button
                type="button"
                className="topics-nav"
                aria-pressed={page === "project-settings"}
                disabled={settingsBusy}
                onClick={() => navigate(() => setPage("project-settings"))}
              >
                <FolderOpen size={16} aria-hidden="true" />
                Проект
              </button>
            )}
            {project && window.goga.terminal && (
              <button
                type="button"
                className="topics-nav"
                aria-pressed={page === "terminal"}
                disabled={settingsBusy}
                onClick={() => navigate(() => setPage("terminal"))}
              >
                <SquareTerminal size={16} aria-hidden="true" />
                Терминал
              </button>
            )}
            {project && (
              <button
                type="button"
                className="topics-nav"
                aria-pressed={page === "topics"}
                disabled={settingsBusy}
                onClick={() => navigate(() => setPage("topics"))}
              >
                <Layers size={16} aria-hidden="true" />
                Топики
              </button>
            )}
            {(
              [
                [openBuilds, "build"],
                [openLaunches, "pipeline"],
              ] as const
            ).flatMap(([ids, kind]) =>
              preparationEntries(ids)
                .filter(({ project: ownerProject, owner }) =>
                  matchesWorkspace(
                    ownerProject.id,
                    owner,
                    projectId,
                    selectedContext,
                  ),
                )
                .map(({ id, owner }) => {
                  const label =
                    kind === "build" && repeatSeeds[id]
                      ? `Повтор сборки ${repeatSeeds[id].nonce}${owner ? ` · ${owner.topic}` : ""}`
                      : owner
                        ? `${kind === "build" ? "Новая сборка" : "Новый конвейер"} · ${owner.topic}`
                        : kind === "build"
                          ? "Новая сборка"
                          : "Новый запуск";
                  const visible =
                    activeDraft === id &&
                    page === (kind === "build" ? "build" : "launch");
                  return (
                    <div
                      key={`${kind}:${id}`}
                      className="run-tab-group"
                      role="presentation"
                    >
                      <button
                        type="button"
                        role="tab"
                        id={`${kind}-draft-tab-${encodeURIComponent(id)}`}
                        aria-controls={`${kind}-draft-panel-${encodeURIComponent(id)}`}
                        aria-selected={visible}
                        className={`run-tab ${visible ? "active" : ""}`}
                        disabled={settingsBusy}
                        onClick={() => navigate(() => returnToDraft(id, kind))}
                        onKeyDown={(event) => {
                          if (
                            ![
                              "ArrowLeft",
                              "ArrowRight",
                              "Home",
                              "End",
                            ].includes(event.key)
                          )
                            return;
                          event.preventDefault();
                          const tabs = Array.from(
                            event.currentTarget
                              .closest('[role="tablist"]')!
                              .querySelectorAll<HTMLButtonElement>(
                                '[role="tab"]',
                              ),
                          );
                          const index = tabs.indexOf(event.currentTarget);
                          const next =
                            event.key === "Home"
                              ? 0
                              : event.key === "End"
                                ? tabs.length - 1
                                : (index +
                                    (event.key === "ArrowRight" ? 1 : -1) +
                                    tabs.length) %
                                  tabs.length;
                          tabs[next]?.focus();
                          tabs[next]?.click();
                        }}
                      >
                        {label}
                      </button>
                      <button
                        type="button"
                        className="close-tab"
                        aria-label={`Закрыть вкладку ${label}`}
                        title="Закрыть вкладку"
                        disabled={
                          settingsBusy ||
                          (kind === "build" ? buildBusy[id] : launchBusy[id])
                        }
                        onClick={() =>
                          kind === "build" ? closeBuild(id) : closeLaunch(id)
                        }
                      >
                        ×
                      </button>
                    </div>
                  );
                }),
            )}
            {runs
              .filter(
                (r) =>
                  runMatchesWorkspace(r, projectId, selectedContext) &&
                  ((r as RunWithContext).context
                    ? contextOpenRuns.has(r.id)
                    : contextsEnabled
                      ? contextOpenRuns.has(r.id)
                      : !selectedContext),
              )
              .map((r, index) => (
                <div className="run-tab-group" role="presentation" key={r.id}>
                  <button
                    role="tab"
                    aria-label={`${r.kind === "build" ? "Сборка" : r.pipeline} · ${r.topic} · ${r.branch}`}
                    aria-selected={selected === r.id && page === "project"}
                    tabIndex={
                      selected === r.id || (!selected && index === 0) ? 0 : -1
                    }
                    onKeyDown={(event) => {
                      const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
                      if (!keys.includes(event.key)) return;
                      event.preventDefault();
                      const tabs = Array.from(
                        event.currentTarget
                          .closest('[role="tablist"]')!
                          .querySelectorAll<HTMLButtonElement>('[role="tab"]'),
                      );
                      const currentIndex = tabs.indexOf(event.currentTarget);
                      const next =
                        event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? tabs.length - 1
                            : (currentIndex +
                                (event.key === "ArrowRight" ? 1 : -1) +
                                tabs.length) %
                              tabs.length;
                      tabs[next]?.focus();
                      tabs[next]?.click();
                    }}
                    onClick={() =>
                      navigate(() => {
                        openContextRun(r);
                      })
                    }
                    className={`run-tab ${selected === r.id && page === "project" ? "active" : ""}`}
                  >
                    <i className={`status-dot ${r.status}`} />
                    <span>
                      {r.kind === "build" ? "Сборка" : r.pipeline}
                      <small>
                        {r.kind === "build"
                          ? r.build?.planPath.split("/").at(-1)
                          : r.topic}{" "}
                        · {r.branch}
                      </small>
                    </span>
                  </button>
                  <button
                    className="close-tab"
                    data-close-run={r.id}
                    aria-label={`Закрыть вкладку ${r.kind === "build" ? "Сборка" : r.pipeline} · ${r.topic}`}
                    title="Закрыть вкладку"
                    disabled={closingIds.includes(r.id)}
                    onClick={() => navigate(() => void closeTab(r.id))}
                  >
                    ×
                  </button>
                </div>
              ))}
          </div>
          <div className="run-context">
            <span
              className="workspace-path"
              aria-label="Путь выбранного контекста"
              title={displayedPath.full}
            >
              {displayedPath.display}
            </span>
            {run && page === "project" ? (
              <>
                {run.kind === "build" ? (
                  <span>
                    Сборка <strong>{run.build?.planPath}</strong>
                  </span>
                ) : (
                  <span>
                    Топик{" "}
                    <button
                      type="button"
                      className="topic-link"
                      aria-label={`Топик запуска ${run.topic}`}
                      onClick={() =>
                        setTopicCard({
                          project: project!,
                          year:
                            run.taskSnapshot?.year ?? run.startedAt.slice(0, 4),
                          target: {
                            topic: run.topic,
                            branch: run.branch,
                            remote: false,
                          },
                          board: null,
                          context: { kind: "run", run },
                        })
                      }
                    >
                      {run.topic}
                    </button>
                  </span>
                )}
                <span>
                  Ветка <strong>{run.branch}</strong>
                </span>
                {canShowDashboard ? (
                  <button
                    type="button"
                    className="run-state run-output-toggle"
                    aria-label="Работает — показ журнала вывода"
                    aria-pressed={!!showLogs[run.id]}
                    aria-controls={
                      showLogs[run.id] ? "run-output-journal" : undefined
                    }
                    title={
                      showLogs[run.id]
                        ? "Скрыть журнал и вернуться к конвейеру"
                        : "Показать журнал вывода"
                    }
                    onClick={() =>
                      setShowLogs((values) => ({
                        ...values,
                        [run.id]: !values[run.id],
                      }))
                    }
                  >
                    <TerminalIcon />
                    <span>Работает</span>
                  </button>
                ) : (
                  <span className="run-state">
                    {run.recovery === "unverified"
                      ? "Состояние процесса не подтверждено после перезапуска"
                      : labels[run.status]}
                  </span>
                )}
                {run.recovery && (
                  <button
                    type="button"
                    disabled={
                      !!reconcilingRun ||
                      typeof window.goga.reconcileRun !== "function"
                    }
                    onClick={() => void reconcileRun(run)}
                  >
                    {reconcilingRun === run.id
                      ? "Проверяем состояние процесса…"
                      : "Проверить состояние процесса"}
                  </button>
                )}
                {run.kind === "build" &&
                  !(run.status === "starting" || run.status === "running") && (
                    <button
                      disabled={
                        repeatBusy ||
                        !!contextUnavailable ||
                        !!workspaceLaunchBlockReason(
                          runs,
                          run.projectId,
                          run.context ?? null,
                          "build",
                        )
                      }
                      onClick={() => void repeatBuild(run)}
                    >
                      Повторить сборку
                    </button>
                  )}
                {(run.status === "starting" || run.status === "running") && (
                  <button
                    onClick={stop}
                    className="stop-button"
                    disabled={
                      run.recovery === "unverified" || reconcilingRun === run.id
                    }
                    title={
                      run.recovery === "unverified"
                        ? "Невозможно безопасно остановить процесс без подтверждённого владения после перезапуска."
                        : undefined
                    }
                  >
                    Остановить
                  </button>
                )}
              </>
            ) : page === "context-runs" && displayOwner ? (
              <span>
                Рабочая копия{" "}
                {displayOwner.state === "ready" ? "готова" : "недоступна"}
              </span>
            ) : null}
            {project && typeof window.goga.readGitWorkspace === "function" && (
              <div className="git-workspace-controls-host">
                <RetainedViews
                  activeKey={page !== "settings" ? sectionKey("git") : null}
                  retain={retainProjectView}
                >
                  <>
                    <GitWorkspace
                      scope={
                        displayOwner ? contextRef(displayOwner) : project.id
                      }
                      open={page === "changes"}
                      historyOpen={page === "commits"}
                      onHistoryOpen={() => openGitView("commits")}
                      onHistoryClose={closeGitView}
                      bodyContainer={gitStage}
                      revision={
                        repositoryActions.revision +
                        (gitRevision[
                          documentScopeId(
                            displayOwner
                              ? contextRef(displayOwner)
                              : project.id,
                          )
                        ] ?? 0)
                      }
                      onBranchBusyChange={(
                        id,
                        busy,
                        owner = documentScopeId(id),
                      ) =>
                        setGitBranchBusy((previous) =>
                          gitOwnerFlag(previous, id, owner, busy),
                        )
                      }
                      onOverlayChange={(
                        id,
                        visible,
                        owner = documentScopeId(id),
                      ) =>
                        setGitModals((previous) =>
                          gitOwnerFlag(previous, id, owner, visible),
                        )
                      }
                      onCurrentBranchChanged={(issuedScope) => {
                        const owner = documentScopeId(issuedScope);
                        setGitRevision((previous) => ({
                          ...previous,
                          [owner]: (previous[owner] ?? 0) + 1,
                        }));
                      }}
                      onChanged={(id, issuedScope = id) => {
                        if (scopeProjectId(issuedScope) !== id) return;
                        const owner = documentScopeId(issuedScope);
                        setGitRevision((previous) => ({
                          ...previous,
                          [owner]: (previous[owner] ?? 0) + 1,
                        }));
                        topicsChanged();
                        void settingsDocuments.refreshProject(issuedScope);
                      }}
                      disabled={
                        !!contextUnavailable || contextsLoading || settingsBusy
                      }
                      onOpen={() => openGitView("changes")}
                      onClose={closeGitView}
                    />
                    <GitHistory
                      scope={
                        displayOwner ? contextRef(displayOwner) : project.id
                      }
                      open={page === "commits"}
                      bodyContainer={gitStage}
                      revision={
                        repositoryActions.revision +
                        (gitRevision[
                          documentScopeId(
                            displayOwner
                              ? contextRef(displayOwner)
                              : project.id,
                          )
                        ] ?? 0)
                      }
                      disabled={
                        !!contextUnavailable || contextsLoading || settingsBusy
                      }
                      onClose={closeGitView}
                      onOverlayChange={(visible) =>
                        setGitModals((previous) =>
                          gitOwnerFlag(
                            previous,
                            project.id,
                            `${documentScopeId(displayOwner ? contextRef(displayOwner) : project.id)}:history`,
                            visible,
                          ),
                        )
                      }
                    />
                  </>
                </RetainedViews>
              </div>
            )}
          </div>
          <div
            className="git-workspace-stage"
            ref={setGitStage}
            hidden={page !== "changes" && page !== "commits"}
          />
          <div
            className="scroll-area"
            hidden={page === "changes" || page === "commits"}
          >
            <RetainedViews
              activeKey={page === "overview" ? sectionKey("overview") : null}
              retain={retainProjectView}
            >
              {project && (
                <ProjectOverview
                  scope={displayOwner ? contextRef(displayOwner) : project.id}
                  workspacePath={
                    displayOwner ? displayOwner.path : project.path
                  }
                  onMutation={() => {
                    const owner = documentScopeId(
                      displayOwner ? contextRef(displayOwner) : project.id,
                    );
                    setGitRevision((v) => ({
                      ...v,
                      [owner]: (v[owner] ?? 0) + 1,
                    }));
                  }}
                  onCloseState={(paths, busy) => {
                    const key = sectionKey("overview")!;
                    overviewCloseStates.current.set(key, {
                      paths: paths.map(
                        (p) =>
                          project.name +
                          " · " +
                          (displayOwner?.topic ?? "Без топика") +
                          " · " +
                          p,
                      ),
                      busy,
                    });
                    const entries = [...overviewCloseStates.current.values()];
                    void window.goga
                      .reportOverviewCloseState?.(
                        entries.flatMap((e) => e.paths).length > 500
                          ? [
                              ...entries.flatMap((e) => e.paths).slice(0, 499),
                              "И другие несохранённые файлы",
                            ]
                          : entries.flatMap((e) => e.paths),
                        entries.some((e) => e.busy),
                      )
                      .catch(() => {});
                  }}
                />
              )}
            </RetainedViews>
            {page === "project" && run?.recoveryMessage && (
              <p className="hint" role="status">
                {run.recoveryMessage}
              </p>
            )}
            <RetainedViews
              activeKey={
                page === "context-runs"
                  ? sectionKey("runs", displayOwner)
                  : null
              }
              retain={retainProjectView}
            >
              <section className="context-stage">
                {displayOwner && displayOwner.storageKind !== "clone" && (
                  <ContextMigration
                    key={contextKey(displayOwner)}
                    record={displayOwner}
                    onMigrated={(record) => {
                      setKnownContexts((values) => [
                        ...values.filter(
                          (item) => item.contextId !== record.contextId,
                        ),
                        record,
                      ]);
                      setContextSelections((values) => ({
                        ...values,
                        [record.projectId]: record,
                      }));
                      topicsChanged();
                    }}
                  />
                )}
                {contextsError && <p role="alert">{contextsError}</p>}
                <ContextRuns
                  context={displayOwner}
                  contextLabel={headerTopic}
                  primaryProjectId={selectedContext ? undefined : projectId}
                  unavailableReason={
                    (displayOwner
                      ? displayOwner.state !== "ready"
                        ? "Рабочая копия этого топика сейчас недоступна. Здесь сохранена её история."
                        : displayOwner.storageKind !== "clone" ||
                            displayOwner.compatibility === "legacy-linked"
                          ? "История прежней linked-worktree копии. Новые запуски доступны только в автономном клоне."
                          : ""
                      : "") || undefined
                  }
                  runs={runs as RunWithContext[]}
                  onOpen={(id) => {
                    const target = runs.find((value) => value.id === id);
                    if (target) navigate(() => openContextRun(target));
                  }}
                />
                {selectedContext && (
                  <>
                    <p className="muted">
                      Старые записи без контекста не назначаются выбранному
                      топику.
                    </p>
                    <details>
                      <summary>Технические сведения рабочей копии</summary>
                      <dl>
                        <dt>Состояние</dt>
                        <dd>{selectedContext.state}</dd>
                        <dt>Владение</dt>
                        <dd>{selectedContext.ownership}</dd>
                        <dt>Путь</dt>
                        <dd>{selectedContext.path}</dd>
                        <dt>Контекст</dt>
                        <dd>{selectedContext.contextId}</dd>
                      </dl>
                    </details>
                  </>
                )}
              </section>
            </RetainedViews>
            {page === "context-preparation" &&
              project &&
              initialPreparation &&
              initialPreparation.identity.projectId === project.id && (
                <InitialContextPreparation
                  key={JSON.stringify([project.id, initialPreparation.nonce])}
                  identity={initialPreparation.identity}
                  kind={initialPreparation.kind}
                  explicitOwner={initialPreparation.owner}
                  knownContexts={knownContexts}
                  loading={contextsLoading}
                  inventoryError={contextsError}
                  onRetryInventory={topicsChanged}
                  flights={initialFlights.current}
                  onCancel={() => navigate(() => setPage("context-runs"))}
                  onPrepared={(record) => {
                    if (
                      pageRef.current !== "context-preparation" ||
                      projectIdRef.current !==
                        initialPreparation.identity.projectId ||
                      initialPreparationNonce.current !==
                        initialPreparation.nonce
                    )
                      return;
                    setContextSelections((values) => ({
                      ...values,
                      [record.projectId]: record,
                    }));
                    setKnownContexts((values) => [
                      ...values.filter(
                        (value) => value.contextId !== record.contextId,
                      ),
                      record,
                    ]);
                    if (
                      workspaceLaunchBlockReason(
                        runsRef.current,
                        record.projectId,
                        record,
                        initialPreparation.kind,
                      )
                    )
                      setPage("context-runs");
                    else
                      showContextPreparation(initialPreparation.kind, record);
                  }}
                />
              )}
            {page === "project-settings" && contextUnavailable && (
              <section
                className="context-stage"
                aria-label="Контекст недоступен"
              >
                <p role="status">{contextUnavailable}</p>
              </section>
            )}
            <RetainedViews
              activeKey={
                page === "project-settings" && !contextUnavailable
                  ? sectionKey("settings")
                  : null
              }
              retain={retainProjectView}
            >
              {project && (
                <ProjectSettings
                  embedded
                  documents={settingsDocuments}
                  key={documentScopeId(
                    selectedContext ? contextRef(selectedContext) : project.id,
                  )}
                  project={project}
                  owner={
                    selectedContext ? contextRef(selectedContext) : undefined
                  }
                  guard={settingsGuard}
                  onBusy={setSettingsBusy}
                  onBack={() => navigate(() => setPage("project-settings"))}
                  onSaved={(revision) =>
                    setSettingsRevision((values) => ({
                      ...values,
                      [project.id]: revision,
                    }))
                  }
                />
              )}
            </RetainedViews>
            {preparationEntries(openBuilds).map(
              ({ id, owner, project: buildProject }) => (
                <div
                  key={id}
                  hidden={
                    page !== "build" ||
                    activeDraft !== id ||
                    !matchesWorkspace(
                      buildProject.id,
                      owner,
                      projectId,
                      selectedContext,
                    )
                  }
                  id={`build-draft-panel-${encodeURIComponent(id)}`}
                  role="tabpanel"
                  aria-labelledby={`build-draft-tab-${encodeURIComponent(id)}`}
                >
                  <BuildForm
                    key={`${id}:${repeatSeeds[id]?.nonce ?? "new"}`}
                    seed={repeatSeeds[id]?.preparation}
                    project={buildProject}
                    owner={owner ? contextRef(owner) : undefined}
                    drafts={buildDrafts.current}
                    draftId={id}
                    suspended={
                      page !== "build" ||
                      activeDraft !== id ||
                      !matchesWorkspace(
                        buildProject.id,
                        owner,
                        projectId,
                        selectedContext,
                      )
                    }
                    blocked={workspaceLaunchBlockReason(
                      runs,
                      buildProject.id,
                      owner ?? null,
                      "build",
                    )}
                    revision={JSON.stringify([
                      settingsRevision[buildProject.id],
                      settingsDocuments.projectRevision(
                        owner ? contextRef(owner) : buildProject.id,
                      ),
                      homeDocumentRevision,
                      topicsRevision,
                    ])}
                    onBusyChange={onBuildBusy}
                    onCancel={() => closeBuild(id)}
                    onLaunched={(r, stale) => {
                      if (!runsRef.current.some((i) => i.id === r.id))
                        applyRuns([...runsRef.current, r]);
                      if (
                        stale ||
                        !matchesWorkspace(
                          buildProject.id,
                          owner,
                          projectIdRef.current,
                          selectedContextRef.current,
                        )
                      )
                        return;
                      if (owner || repeatSeeds[id])
                        setOpenBuilds((values) => {
                          const next = new Set(values);
                          next.delete(id);
                          return next;
                        });
                      if (repeatSeeds[id]) {
                        buildDrafts.current.delete(id);
                        setRepeatSeeds((previous) => {
                          const next = { ...previous };
                          delete next[id];
                          return next;
                        });
                      }
                      navigateRef.current(() => {
                        openRunRef.current(r);
                      });
                    }}
                  />
                </div>
              ),
            )}
            {preparationEntries(openLaunches).map(
              ({ id, owner, project: launchProject }) => (
                <div
                  key={id}
                  hidden={
                    page !== "launch" ||
                    activeDraft !== id ||
                    !matchesWorkspace(
                      launchProject.id,
                      owner,
                      projectId,
                      selectedContext,
                    )
                  }
                  id={`pipeline-draft-panel-${encodeURIComponent(id)}`}
                  role="tabpanel"
                  aria-labelledby={`pipeline-draft-tab-${encodeURIComponent(id)}`}
                >
                  <LaunchForm
                    settingsRevision={JSON.stringify([
                      settingsRevision[launchProject.id],
                      settingsDocuments.projectRevision(
                        owner ? contextRef(owner) : launchProject.id,
                      ),
                      homeDocumentRevision,
                      topicsRevision,
                    ])}
                    suspended={
                      page !== "launch" ||
                      activeDraft !== id ||
                      !matchesWorkspace(
                        launchProject.id,
                        owner,
                        projectId,
                        selectedContext,
                      ) ||
                      !!topicCard
                    }
                    preparedTopic={
                      preparedTopic?.projectId === launchProject.id
                        ? preparedTopic
                        : undefined
                    }
                    onPrepared={(nonce) =>
                      setPreparedTopic((previous) =>
                        previous?.nonce === nonce ? undefined : previous,
                      )
                    }
                    onOpenTopic={(target, text, isNew, edit) =>
                      setTopicCard({
                        project: launchProject,
                        year: String(new Date().getFullYear()),
                        target,
                        board:
                          isNew || projectId !== launchProject.id ? null : null,
                        context: {
                          kind: "preparation",
                          text,
                          newTopic: isNew,
                          edit,
                        },
                      })
                    }
                    key={id}
                    owner={owner ? contextRef(owner) : undefined}
                    blocked={workspaceLaunchBlockReason(
                      runs,
                      launchProject.id,
                      owner ?? null,
                      "pipeline",
                    )}
                    draftStore={draftStore.current}
                    project={launchProject}
                    onCancel={() => closeLaunch(id)}
                    onBusyChange={onLaunchBusy}
                    onLaunched={(r, stale) => {
                      // Register the completed launch even when settings navigation
                      // is blocked. Only the current guard may leave the editor.
                      if (r && !runsRef.current.some((i) => i.id === r.id))
                        applyRuns([...runsRef.current, r]);
                      if (
                        !matchesWorkspace(
                          launchProject.id,
                          owner,
                          projectIdRef.current,
                          selectedContextRef.current,
                        )
                      )
                        return;
                      if (stale && pageRef.current !== "project-settings")
                        return;
                      if (owner)
                        setOpenLaunches((values) => {
                          const next = new Set(values);
                          next.delete(id);
                          return next;
                        });
                      navigateRef.current(() => {
                        if (r) {
                          if (!runsRef.current.some((i) => i.id === r.id))
                            return;
                          openRunRef.current(r);
                        }
                        setPage("project");
                      });
                    }}
                  />
                </div>
              ),
            )}
            <RetainedViews
              activeKey={
                page === "terminal" && window.goga.terminal
                  ? sectionKey("terminal", displayOwner)
                  : null
              }
              retain={retainProjectView}
            >
              {project && window.goga.terminal && (
                <TerminalWorkspace
                  suspendOpen={deletion.busy}
                  api={window.goga.terminal}
                  scope={displayOwner ? contextRef(displayOwner) : project.id}
                  blocked={contextUnavailable || undefined}
                  obscured={Boolean(
                    error ||
                    handoff.candidate ||
                    topicCard ||
                    pendingNavigation ||
                    repeatPending ||
                    repositoryActions.failures.length ||
                    gitModals.size ||
                    deletion.operation,
                  )}
                />
              )}
            </RetainedViews>
            <RetainedViews
              activeKey={
                page === "topics" && project
                  ? JSON.stringify([project.id, project.path, "topics"])
                  : null
              }
              retain={retainProjectView}
            >
              {project && (
                <TopicsWorkspace
                  key={project.id}
                  project={project}
                  store={topicsStore.current}
                  revision={topicScope}
                  onChanged={topicsChanged}
                  onBusy={setTopicsBusy}
                  runs={runs as RunWithContext[]}
                  knownContexts={knownContexts}
                  selectedContext={displayOwner}
                  disabled={settingsBusy}
                  ownerReadState={
                    contextsLoading
                      ? "loading"
                      : contextsError
                        ? "error"
                        : "confirmed"
                  }
                  ownerReadError={contextsError}
                  onSelectTopic={(identity) =>
                    navigateContext(() =>
                      setTableTopicSelection({ identity, nonce: Date.now() }),
                    )
                  }
                  onOpenRun={(id) => {
                    const target = runs.find((value) => value.id === id);
                    if (target) navigate(() => openContextRun(target));
                  }}
                  onOpenTopic={(target, year, board, host) =>
                    setTopicCard({
                      project,
                      target,
                      year,
                      board,
                      host,
                      context: { kind: "topic" },
                    })
                  }
                />
              )}
            </RetainedViews>
            {(page === "overview" && project) ||
            page === "launch" ||
            page === "terminal" ||
            page === "topics" ||
            (project &&
              (page === "project-settings" ||
                page === "build")) ? null : !project ? (
              <div className="empty-state">
                <div className="empty-symbol">⌘</div>
                <h2>Добавьте локальный проект</h2>
                <p>
                  Выберите реальную папку Git-проекта с конфигурацией Goga.
                  <br />
                  Конвейеры и стадии загрузятся из его каталога.
                </p>
                <button
                  onClick={() => navigate(() => void add())}
                  className="primary"
                >
                  Выбрать папку проекта
                </button>
                <small>Для запуска нужны установленные Goga и Docker.</small>
              </div>
            ) : page === "context-runs" ||
              page === "context-preparation" ? null : !run ? (
              <div className="empty-state">
                <div className="empty-symbol">↗</div>
                <h2>Откройте новый запуск</h2>
                <p>
                  Выберите конвейер, топик и параметры запуска.
                  <br />
                  Здесь откроется панель конвейера.
                </p>
                <button
                  className="primary"
                  disabled={!!launchUnavailable || settingsBusy}
                  onClick={() => navigate(() => prepareFromHeader("pipeline"))}
                >
                  Создать запуск
                </button>
              </div>
            ) : !canShowDashboard || showLogs[run.id] ? null : (
              <div
                className="afm-placeholder"
                aria-label="Встроенная панель конвейера"
              />
            )}
            <RetainedViews
              activeKey={
                page === "project" &&
                run &&
                (!canShowDashboard || showLogs[run.id])
                  ? JSON.stringify([
                      run.projectId,
                      projects.find((p) => p.id === run.projectId)?.path,
                      run.id,
                    ])
                  : null
              }
              retain={(key) =>
                retainProjectView(key) &&
                runs.some((run) => run.id === JSON.parse(key)[2])
              }
            >
              {run && <RunOutput run={run} viewError={viewErrors[run.id]} />}
            </RetainedViews>
          </div>
        </div>
      </main>
      {topicCard && (
        <TopicCardComponent
          key={JSON.stringify([
            topicCard.project.id,
            topicCard.year,
            topicCard.target,
            topicCard.context.kind,
            topicCard.showArtifacts,
          ])}
          {...topicCard}
          minimal={contextsEnabled}
          contextRequired={contextsEnabled}
          ownerReadState={
            contextsLoading ? "loading" : cardOwnerError ? "error" : "confirmed"
          }
          ownerReadError={cardOwnerError}
          onContextPrepared={(record) =>
            setKnownContexts((values) => [
              ...values.filter((item) => item.contextId !== record.contextId),
              record,
            ])
          }
          owner={cardOwner}
          deletionOwner={deletionOwner}
          selectedContextId={selectedContext?.contextId}
          runs={runs as RunWithContext[]}
          store={topicsStore.current}
          onClose={() => setTopicCard(null)}
          onBusy={setTopicsBusy}
          onChanged={topicsChanged}
          onHandoff={openHandoff}
          onPrepare={(target, year, text) => {
            if (year !== String(new Date().getFullYear()) || target.remote)
              return;
            setPreparedTopic({
              projectId: topicCard.project.id,
              target,
              text,
              nonce: Date.now(),
            });
            if (
              !contextsEnabled ||
              typeof window.goga.listTopicContexts !== "function" ||
              typeof window.goga.resolveTopicContext !== "function"
            ) {
              setError(
                "API рабочих копий недоступен. Подготовка запуска из основной папки проекта не выполняется.",
              );
              setTopicCard(null);
              return;
            }
            setProjectId(topicCard.project.id);
            setInitialPreparation({
              identity: {
                projectId: topicCard.project.id,
                year,
                topic: target.topic,
                branch: target.branch,
              },
              kind: "pipeline",
              nonce: ++initialPreparationNonce.current,
            });
            setSelected(null);
            setPage("context-preparation");
            setTopicCard(null);
          }}
        />
      )}
      {repeatPending && (
        <BuildCleanConfirmation
          busy={repeatBusy}
          onCancel={() => setRepeatPending(null)}
          onConfirm={() => void repeatBuild(repeatPending, true)}
        />
      )}
      {pendingNavigation && (
        <ProjectSettingsConfirmation
          busy={settingsBusy}
          onCancel={() => setPendingNavigation(null)}
          onDiscard={() => {
            const action = pendingNavigation;
            settingsGuard.current?.discard();
            setPendingNavigation(null);
            action();
          }}
          onSave={() => {
            const action = pendingNavigation;
            void settingsGuard.current?.save().then((saved) => {
              setPendingNavigation(null);
              if (saved) action();
            });
          }}
        />
      )}
      <ContextDeletionPopup controller={deletion} />
    </div>
  );
  return (
    <ContextDeletionProvider value={deletion.execute}>
      {content}
    </ContextDeletionProvider>
  );
}

/** Explicit topic-card/clone preparation only; no-topic uses the original forms. */
function InitialContextPreparation({
  identity,
  kind,
  knownContexts,
  explicitOwner,
  loading,
  inventoryError,
  onRetryInventory,
  flights,
  onPrepared,
  onCancel,
}: {
  identity: TopicContextIdentity;
  kind: RunKind;
  knownContexts: WorktreeRecord[];
  explicitOwner?: WorktreeRecord;
  loading: boolean;
  inventoryError: string;
  onRetryInventory: () => void;
  flights: Map<string, Promise<WorktreeRecord>>;
  onPrepared: (record: WorktreeRecord) => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const readinessRead = useReadScope(JSON.stringify(identity));
  const flight = useRef(false);
  const attempted = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const discovered = initialOwnerFor(knownContexts, identity);
  const existing = explicitOwner ?? discovered.owner;
  const ambiguous = !explicitOwner && discovered.ambiguous;
  const restriction =
    inventoryError ||
    (ambiguous ? ambiguousContextReason : "") ||
    (existing &&
      (existing.state !== "ready"
        ? "Рабочая копия недоступна. История запусков сохранена. Выберите другую проверенную копию в шапке."
        : existing.storageKind !== "clone" ||
            existing.compatibility === "legacy-linked"
          ? "Прежняя linked-worktree копия доступна только для просмотра. Для запуска требуется автономный клон."
          : existing.ownership !== "managed" ||
              existing.preparation ||
              existing.deletedAt ||
              !topicContextRefSchema.safeParse(contextRef(existing)).success
            ? "Рабочая копия не готова к запуску. Выберите проверенный автономный клон."
            : ""));
  useEffect(() => {
    // This component exists only for an explicit captured preparation intent.
    // Inventory completion continues that intent; failures need an explicit retry.
    if (!attempted.current && !loading && !restriction) {
      attempted.current = true;
      void prepare();
    }
  }, [loading, restriction]);
  async function prepare() {
    if (flight.current || loading || restriction) return;
    flight.current = true;
    setBusy(true);
    setError("");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const key = JSON.stringify(identity);
      let pending = flights.get(key);
      const reused = Boolean(pending);
      if (!pending) {
        // A cancellable read is not a physical preparation flight. A later Build
        // intent must not inherit a cancelled task preflight or start A's write.
        if (kind === "pipeline" && !existing)
          await readinessRead("checkTopicContextReadiness", identity);
        if (!mounted.current) return;
        pending = existing
          ? window.goga.resolveTopicContext(contextRef(existing))
          : window.goga.ensureTopicContext(identity);
        flights.set(key, pending);
        const clearFlight = () => {
          if (flights.get(key) === pending) flights.delete(key);
        };
        // Keep completed writes after a UI timeout/navigation until explicitly
        // consumed. A retry reconciles the result instead of issuing a new write.
        void pending.then(undefined, clearFlight);
      }
      const verified = pending
        .then(async (record) => {
          if (
            !reused ||
            record.projectId !== identity.projectId ||
            record.year !== identity.year ||
            record.topic !== identity.topic ||
            record.branch !== identity.branch
          )
            return record;
          if (!topicContextRefSchema.safeParse(contextRef(record)).success)
            throw Error(
              "Рабочая копия не готова к запуску. Получена некорректная ссылка владельца.",
            );
          const resolved = await window.goga.resolveTopicContext(
            contextRef(record),
          );
          if (
            contextKey(resolved) !== contextKey(record) ||
            resolved.revision !== record.revision
          )
            throw Error(
              "Полученная рабочая копия не соответствует выбранному топику. Выберите копию заново.",
            );
          return resolved;
        })
        .then(async (record) => {
          if (
            kind !== "pipeline" ||
            !mounted.current ||
            record.projectId !== identity.projectId ||
            record.year !== identity.year ||
            record.topic !== identity.topic ||
            record.branch !== identity.branch
          )
            return record;
          if (
            record.state !== "ready" ||
            record.storageKind !== "clone" ||
            record.compatibility === "legacy-linked" ||
            record.ownership !== "managed" ||
            record.preparation ||
            record.deletedAt ||
            !topicContextRefSchema.safeParse(contextRef(record)).success
          )
            return record;
          const ready = await readinessRead(
            "checkTopicContextReadiness",
            contextRef(record),
          );
          if (
            !ready ||
            contextKey(ready) !== contextKey(record) ||
            ready.revision !== record.revision
          )
            throw Error(
              "Ответ проверки готовности не соответствует выбранной рабочей копии.",
            );
          return ready;
        });
      const record = await Promise.race([
        verified,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Error(
                  "Подготовка заняла больше 300 с. Она ещё может завершиться. Повтор сначала дождётся результата, не создавая вторую копию.",
                ),
              ),
            TOPIC_CONTEXT_PREPARE_TIMEOUT_MS,
          );
        }),
      ]);
      if (!mounted.current) return;
      if (
        record.projectId !== identity.projectId ||
        record.year !== identity.year ||
        record.topic !== identity.topic ||
        record.branch !== identity.branch ||
        (existing &&
          (record.contextId !== existing.contextId ||
            record.revision !== existing.revision))
      )
        throw Error(
          "Полученная рабочая копия не соответствует выбранному топику. Выберите копию заново.",
        );
      if (
        record.state !== "ready" ||
        record.storageKind !== "clone" ||
        record.compatibility === "legacy-linked" ||
        record.ownership !== "managed" ||
        record.preparation ||
        record.deletedAt ||
        !topicContextRefSchema.safeParse(contextRef(record)).success
      )
        throw Error(
          "Рабочая копия не готова к запуску. Основная папка проекта не будет использована вместо неё.",
        );
      if (flights.get(key) === pending) flights.delete(key);
      onPrepared(record);
    } catch (failure) {
      if (mounted.current) setError(preparationErrorMessage(failure));
    } finally {
      clearTimeout(timer);
      flight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  // Errors take precedence even if another preparation read is still pending.
  // Reads and the physical preparation already have bounded deadlines above.
  if (!error && !restriction && (busy || loading || !attempted.current))
    return (
      <section className="context-stage" aria-label="Подготовка запуска">
        <LoadingState label="Подготовка запуска" />
      </section>
    );
  return (
    <section className="context-stage" aria-label="Подготовка рабочей копии">
      <h2>{kind === "build" ? "Подготовка сборки" : "Подготовка конвейера"}</h2>
      <p className="context-run-hint">
        Топик: {identity.topic} · {identity.year} · {identity.branch}
      </p>
      {restriction && (
        <p className="context-run-hint" role="alert">
          {restriction}
        </p>
      )}
      {inventoryError && (
        <button type="button" onClick={onRetryInventory}>
          Повторить проверку рабочих копий
        </button>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {error && (
        <button
          type="button"
          className="primary"
          disabled={busy || loading || Boolean(restriction)}
          onClick={() => void prepare()}
        >
          Повторить подготовку
        </button>
      )}
      <button type="button" onClick={onCancel}>
        К запускам топика
      </button>
    </section>
  );
}

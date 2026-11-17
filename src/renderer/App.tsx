import {RunActionButton} from "./RunActionButton";
import {Activity, Cable, RotateCcw, Square} from "lucide-react";
import {AttachPanelDialog,PanelRefreshButton,useAttachedPanels} from "./AttachedPanels";
import {sameDashboardOwner,type AttachedDashboard} from "../shared/attached-dashboard";
import {demoScopeKey, DEMO_EMBEDDED_START_ERROR} from "../shared/demonstrations";
import {demoDirectory,demoError,useDemoMonitor,useDemoValue} from "./demonstrations/directory";
import {DemoPanel} from "./demonstrations/DemoPanel";
import {DemoRunTab} from "./demonstrations/DemoRunTab";
import {DemoLaunchItem} from "./demonstrations/DemoLaunchItem";
import { ProjectRemovalDialog } from "./ProjectListMenu";
import { ProjectSidebar } from "./ProjectSidebar";
import { useProjectOrganization } from "./useProjectOrganization";
import { HomePage } from "./home/HomePage";
import { createHomeVisits } from "./home/visits-store";
import { resolveHomeOwner } from "./home/navigation";
import { useHomeSessions } from "./home/session-summary";
import { SessionBuffer } from "./home/SessionBuffer";
import type { HomeSection, HomeTarget, SessionEntry, WorkspaceAddress } from "./home/types";
import { gitSummaryCacheFor } from "./git-summary-cache";
import { TopicRepositoryNotice, useTopicRepository } from "./topic-repository";
import { ProjectAddMenu, type ProjectAddTarget } from "./ProjectAddMenu";
import { ProjectCreationDialog } from "./ProjectCreation";
import { createSpecificationsState } from "./project-specifications-state";
import {canRestoreRunDashboard} from "./run-dashboard-state";
import {dashboardRecoveryAllowed} from "../shared/dashboard-connection";
import { TopicRemovalProvider, TopicRemovalPopup, useTopicRemovalController } from "./TopicRemovalController";
import { useDashboardViewport } from "./useDashboardViewport";
import { Boxes, FolderOpen, SquareTerminal, Layers } from "lucide-react";
import { NotificationBell } from "./notifications/Notifications";
import { useNotifications } from "./notifications/useNotifications";
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
import { ProjectDocumentStatusOutlet } from "./ProjectDocumentStatus";
import { RetainedViews } from "./RetainedViews";
import { ProjectSaveGuardShell } from "./ProjectSaveGuardShell";
import { useWorkspaceLeave } from "./workspace-leave";
import { WorkspaceLeaveDialog } from "./WorkspaceLeaveDialog";
import { getOverviewLeaveFiles } from "./overview-leave-drafts";
import { getProjectLeaveFiles } from "./project-leave-drafts";
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
import {
  dismissActiveTopicPopup,
  NativeTopicPopupProvider,
} from "./TopicPickerPopup";
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
  useLayoutEffect,
  useState,
  useRef,
  useSyncExternalStore,
  useCallback,
  useMemo,
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
import { LoadingBoundary, LoadingState } from "./LoadingBoundary";
import { RunOutput, dashboardReady } from "./RunOutput";
import { Settings } from "./Settings";
import { createSettingsDocuments, documentScopeId } from "./settings-documents";
import {
  ProjectSettings,
  ProjectSettingsConfirmation,
  type ProjectSettingsGuard,
} from "./ProjectSettings";
import {
  TopicContextPicker,
  TopicCreationFeedback,
  type TopicCreationProgress,
} from "./TopicContextPicker";
import {
  RepositoryActions,
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
type FileTransition = "section" | "workspace" | "pipeline" | "build" | "stay";

/** History is viewable without claiming that its recorded working copy is ready. */
function recordedRunOwner(
  ref: NonNullable<RunWithContext["context"]>,
): WorktreeRecord {
  return {
    ...ref,
    repositoryKey: ref.repositoryKey ?? "",
    projectPath: "",
    gitCommonDir: "",
    path: ref.path ?? "",
    ownership: "managed",
    storageKind: "clone",
    state: "missing",
  };
}

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
  const notifications = useNotifications();
  const notificationIntent = useRef(0);
  const [notificationOpen, setNotificationOpen] = useState<{ticket:string;runId:string;nonce:number}|null>(null);
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
  const [, refreshOverviewCloseState] = useState(0);
  const [organizationModal, setOrganizationModal] = useState(false);
  const [sessionBuffer, setSessionBuffer] = useState<Extract<
    HomeTarget,
    { kind: "document" }
  > | null>(null);
  const [visitsStore] = useState(() => createHomeVisits());
  const visits = useSyncExternalStore(
    visitsStore.subscribe,
    visitsStore.getSnapshot,
  );
  const [catalogReady, setCatalogReady] = useState(false),
    [catalogError, setCatalogError] = useState(""),
    [catalogAttempt, retryCatalog] = useState(0);
  const [runsReady, setRunsReady] = useState(false),
    [runsError, setRunsError] = useState(""),
    [runsAttempt, retryRuns] = useState(0);
  const runStreamVersion = useRef(0);
  const settingsBack = useRef<"home" | "project-settings" | "terminal" | "demonstration">("home");
  const [demoCloseOpen, setDemoCloseOpen] = useState(false);
  const settingsTerminalOwner = useRef<string | null>(null);
  const [globalSettingsTab, setGlobalSettingsTab] = useState("config");
  const [projectRemoval, setProjectRemoval] = useState<{
    project: Project;
    busy: boolean;
    error: string;
  } | null>(null);
  const projectRemovalFlight = useRef(false);
  const [projectAddMenu, setProjectAddMenu] = useState<ProjectAddTarget | null>(
    null,
  );
  const [projectCreationOpen, setProjectCreationOpen] = useState(false);
  const [createdProject, setCreatedProject] = useState<Project | null>(null);
  const [openAfterCreation, setOpenAfterCreation] = useState(false);
  const [projectCreationNotice, setProjectCreationNotice] = useState("");
  const initialProjectsPending = useRef(true);
  const initialProjectChanges = useRef(new Map<string, Project | null>());
  const [gitRevision, setGitRevision] = useState<Record<string, number>>({});
  const [gitRepositories, setGitRepositories] = useState<
    ReadonlyMap<string, "missing" | "ready">
  >(new Map());
  const [gitModals, setGitModals] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [gitBranchBusy, setGitBranchBusy] = useState<
    ReadonlyMap<string, string>
  >(new Map());
  useEffect(() => {
    if (repositoryActions.revision) { gitSummaryCacheFor(window.goga).invalidateAll(); topicsChanged(); }
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
  const pipelineRepeatFlights = useRef(new Set<string>());
  const [repeatingPipelines, setRepeatingPipelines] = useState(new Set<string>());
  const [settingsDocuments] = useState(createSettingsDocuments);
  const [specificationsState] = useState(createSpecificationsState);
  const [projectSettingsTabs, setProjectSettingsTabs] = useState<Record<string, string>>({});
  const documentActivity = useSyncExternalStore(
    settingsDocuments.subscribe,
    settingsDocuments.writeActivity,
  );
  const [projects, setProjects] = useState<Project[]>([]),
    [projectId, setProjectId] = useState(""),
    [runs, setRuns] = useState<Run[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [page, setPage] = useState<
      | "home"
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
      | "demonstration"
      | "changes"
      | "commits"
    >("home"),
    [error, setError] = useState(""),
    [viewErrors, setViewErrors] = useState<Record<string, string>>({});
  const attachedPanels=useAttachedPanels();
  const attachedRef=useRef(attachedPanels);attachedRef.current=attachedPanels;
  const [attachDialog,setAttachDialog]=useState<string|null>(null);
  const refreshFlights=useRef(new Set<string>());
  const [refreshingIds,setRefreshingIds]=useState<string[]>([]);
  const projectPageVisible=page!=="home" && page!=="settings";
  const organization=useProjectOrganization(projects,catalogReady);
  const sessionStore=useHomeSessions(settingsDocuments,projects);
  const documentEntries=useSyncExternalStore(sessionStore.subscribe,sessionStore.getSnapshot);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const launchOwnerErrors = useRef(new Map<string, string>());
  const viewportError = useCallback(
    (error: unknown) => setError(message(error)),
    [],
  );
  const dashboardViewport = useDashboardViewport(viewportError);
  const [documentStatusOutlet, setDocumentStatusOutlet] = useState<HTMLDivElement | null>(null);
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
    creation?: boolean;
  } | null>(null);
  const initialFlights = useRef(new Map<string, Promise<WorktreeRecord>>());
  const initialPreparationNonce = useRef(0);
  const [topicCreation, setTopicCreation] =
    useState<TopicCreationProgress | null>(null);
  const [createdTopic, setCreatedTopic] = useState<WorktreeRecord | null>(null);
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
  const activeDraftRef = useRef(activeDraft);
  activeDraftRef.current = activeDraft;
  // A pending topic selection is already navigation intent, before its host
  // verification can change the visible owner. It must win over a late launch.
  const topicTransitionEpochs = useRef(new Map<string, number>());
  const launchTopicEpochs = useRef(new Map<string, number>());
  const projectNavigation = useRef(
    new Map<
      string,
      { page: typeof page; selected: string | null; activeDraft: string }
    >(),
  );
  useEffect(() => {
    if (projectId && projectPageVisible)
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
  function openContextRun(target: Run, verifiedOwner?: WorktreeRecord) {
    if (!projectsRef.current.some(project => project.id === target.projectId)) {
      setError("Проект убран из списка. Добавьте его папку обратно, чтобы открыть запуск. История запусков сохранена.");
      return false;
    }
    const ref = (target as RunWithContext).context;
    if (ref) {
      const owner = [
        ...(verifiedOwner ? [verifiedOwner] : []),
        ...knownContexts,
        ...Object.values(contextSelections),
      ].find(
        (record) => record != null && contextKey(record) === contextKey(ref),
      );
      // History remains viewable even if its clone has disappeared. Never ensure
      // or recreate a working copy merely to show recorded output.
      const recordedOwner = owner ?? recordedRunOwner(ref);
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
    setError(launchOwnerErrors.current.get(target.id) ?? "");
    return true;
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
  const otherSettingsBusy = launchSettingsBusy || topicsBusy || repeatBusy || !!projectRemoval?.busy;
  const settingsBusy = otherSettingsBusy || documentActivity !== "idle";
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
  const pendingLaunchPresentations = useRef(
    new Map<
      string,
      { canActivate: () => boolean; complete: (activate: boolean) => void }
    >(),
  );
  const [, refreshLaunchPresentations] = useState(0);
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
    },false,"stay");
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
  function showTopicCreation(identity: TopicContextIdentity) {
    const nonce = ++initialPreparationNonce.current;
    setCreatedTopic(null);
    setInitialPreparation({ identity, kind: "pipeline", nonce, creation: true });
    setSelected(null);
    setPage("context-preparation");
    setError("");
  }
  function returnToDraft(id: string, kind: RunKind) {
    const owner = draftOwners[id];
    if (kind === "pipeline" && launchBusy[id])
      launchTopicEpochs.current.set(
        id,
        topicTransitionEpochs.current.get(projectId) ?? 0,
      );
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
    },false,"stay");
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
  const leave = useWorkspaceLeave();
  const navigateRef = useRef<(action: () => void, preserveProjectDraft?: boolean, transition?: FileTransition) => void>(() => {});
  function navigationBlocked() {
    return Boolean(
      topicsBusy ||
      deletion.busy ||
      topicRemoval.busy ||
      repeatPending ||
      repeatBusy ||
      topicCard ||
      settingsDocuments.busy() ||
      settingsGuard.current?.busy ||
      leave.blocked() ||
      pendingNavigation || projectRemoval || projectCreationOpen || organizationModal || sessionBuffer || demoCloseOpen,
    );
  }
  const outgoingOwner = () =>
    selectedContextRef.current
      ? contextRef(selectedContextRef.current)
      : projectIdRef.current;
  function fileIntent(transition: FileTransition) {
    const from = pageRef.current,
      id = projectIdRef.current,
      scope = outgoingOwner(),
      all = transition !== "section";
    const current = () =>
      pageRef.current === from &&
      projectIdRef.current === id &&
      documentScopeId(scope) === documentScopeId(outgoingOwner());
    return {
      current,
      collect: () => [
        ...(all || from === "project-settings"
          ? getProjectLeaveFiles(settingsDocuments, scope, (tab) => {
              setProjectSettingsTabs((t) => ({ ...t, [id]: tab }));
              setPage("project-settings");
            })
          : []),
        ...(all || from === "overview"
          ? getOverviewLeaveFiles(sessionStore, scope).map((file) => ({
              ...file,
              reveal: () => {
                file.reveal?.();
                setPage("overview");
              },
            }))
          : []),
      ],
    };
  }
  function guardFileTransition(action: () => void, transition: FileTransition) {
    const from = pageRef.current;
    if (
      transition === "stay" ||
      from === "home" ||
      from === "settings" ||
      !projectIdRef.current
    ) {
      action();
      return;
    }
    leave.request({
      ...fileIntent(transition),
      launching: transition === "pipeline",
      go: action,
    });
  }
  // Preparing a clone can take time. A previous choice is valid only for the
  // same editor contents and owner, not for new edits made while Git was busy.
  function beforeTopicPrepare(
    start: (approved: () => boolean) => void,
    creating: boolean,
  ) {
    navigateContext(
      () => {
        const { current, collect } = fileIntent("workspace");
        const snapshot = () =>
          collect().map((f) => [f.path, f.readText?.()] as const);
        const accepted = snapshot();
        start(() => {
          if (!current()) return false;
          const now = snapshot();
          return (
            now.length === accepted.length &&
            now.every(
              ([path, text], i) =>
                path === accepted[i][0] && text === accepted[i][1],
            )
          );
        });
      },
      creating ? "pipeline" : "workspace",
    );
  }
  function navigate(
    action: () => void,
    preserveProjectDraft = false,
    transition: FileTransition = "section",
  ) {
    if (navigationBlocked()) return;
    notificationIntent.current++;
    guardFileTransition(() => {
      if (settingsGuard.current?.dirty && !preserveProjectDraft)
        setPendingNavigation(() => action);
      else action();
    }, transition);
  }
  navigateRef.current = navigate;
  useEffect(() => {
    if (projectCreationOpen || navigationBlocked()) return;
    if (createdProject) {
      const created = createdProject;
      setCreatedProject(null);
      navigateRef.current(() => {
        setProjectId(created.id); setSelected(null); setPage("overview"); setActiveDraft("");
      },false,"workspace");
    } else if (openAfterCreation) {
      setOpenAfterCreation(false);
      navigateRef.current(() => void add(),false,"stay");
    }
  });
  useEffect(() => {
    // Accepted mutations finish independently from presentation admission. Keep
    // the original preparation loader while a modal/editor guard owns the UI,
    // then replace that exact slot; leaving it instead performs cleanup only.
    for (const pending of [...pendingLaunchPresentations.current.values()]) {
      if (!pending.canActivate()) pending.complete(false);
      else if (
        !navigationBlocked() &&
        !settingsGuard.current?.dirty &&
        !error &&
        !gitModals.size &&
        !handoff.candidate
      )
        navigateRef.current(() => pending.complete(pending.canActivate()));
    }
  });
  async function openNotification(id:string) {
    const request = ++notificationIntent.current;
    await dismissActiveTopicPopup();
    const target = await window.goga.prepareNotificationOpen(id);
    if(request!==notificationIntent.current)return;
    const nonce=request+1;
    navigateRef.current(()=>{
      if(notificationIntent.current!==nonce)return;
      notifications.setOpen(false);
      setShowLogs(previous=>({...previous,[target.run.id]:false}));
      if (!openRunRef.current(target.run)) return;
      setNotificationOpen({ticket:target.ticket,runId:target.run.id,nonce});
    },false,"workspace");
  }
  const openNotificationRef=useRef(openNotification);
  openNotificationRef.current=openNotification;
  useEffect(()=>{
    if(typeof window.goga.onOpenNotification!=="function")return;
    return window.goga.onOpenNotification(id=>{void openNotificationRef.current(id).catch(e=>setError(message(e)));});
  },[]);
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
    for (const id of launchOwnerErrors.current.keys())
      if (!next.some((run) => run.id === id)) launchOwnerErrors.current.delete(id);
    const id = selectedRef.current;
    if (id && !id.startsWith("attached:") && !next.some((r) => r.id === id)) {
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
        Object.entries(errors).filter(([id]) => id.startsWith("attached:") || next.some((r) => r.id === id)),
      ),
    );
  }
  async function closeTab(id: string) {
    if (pipelineRepeatFlights.current.has(id)) return;
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
  const read = useReadScope(projectPageVisible ? projectId : "");
  useEffect(() => { specificationsState.retainProjects(projects.map(project => project.id)); }, [projects, specificationsState]);
  const project = projects.find((p) => p.id === projectId),
    run = runs.find(
      (r) =>
        r.id === selected && runMatchesWorkspace(r, projectId, selectedContext),
    );
  const panelOwner={projectId,context:selectedContext?contextRef(selectedContext):undefined};
  const workspacePanels=attachedPanels.filter(v=>sameDashboardOwner(v.owner,panelOwner));
  const attached=workspacePanels.find(v=>v.id===selected);
  const activePanelScope=selectedContext?contextRef(selectedContext):projectId;
  const attachmentKey=JSON.stringify([projectId,selectedContext?contextKey(selectedContext):null,selectedContext?.revision]);
  const dialogVisible=!!project && page==="context-runs"&&attachDialog===attachmentKey;
  useEffect(()=>{if(attachDialog&&!dialogVisible)setAttachDialog(null)},[attachDialog,dialogVisible]);
  const handoff = useGitUpdateHandoff({
    scope: project && projectPageVisible
      ? selectedContext
        ? contextRef(selectedContext)
        : project.id
      : null,
    onError: setError,
    onChanged: (scope) => {
      gitSummaryCacheFor(window.goga).invalidate(scope);
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
          // Catalogue loading is not an admission lock. Reconcile additions and
          // removals accepted while it was in flight, never reset their selection.
          const merged = new Map(p.map(project => [project.id, project]));
          for (const [id, value] of initialProjectChanges.current) {
            if (value) merged.set(id, value); else merged.delete(id);
          }
          const loaded = [...merged.values()];
          initialProjectsPending.current = false;
          initialProjectChanges.current.clear();
          const saved: Record<string, WorktreeRecord | null> = {};
          for (const project of loaded) {
            const record = readWorkspaceSelection(project);
            if (record !== undefined) {
              saved[project.id] = record;
              if (record) restoration.current.set(project.id, record);
            }
          }
          setContextSelections((previous) => ({ ...saved, ...previous }));
          setProjects(loaded);
          setCatalogError(""); setCatalogReady(true);
        }
      },
      (e) => { if (alive) setCatalogError(preparationErrorMessage(e)); },
    );
    return ()=>{alive=false;};
  },[catalogAttempt]);
  useEffect(() => {
    let alive = true;
    const version = runStreamVersion.current;
    readRequest("runs").then(
      (next) => {
        if (alive && version === runStreamVersion.current) {
          applyRuns(next);
          setRunsReady(true);
          setRunsError("");
        }
      },
      (e) => {
        if (alive && version === runStreamVersion.current) {
          setRunsError(preparationErrorMessage(e));
          if (pageRef.current !== "home") setError(preparationErrorMessage(e));
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [runsAttempt]);
  useEffect(() => {
    if (catalogReady) visitsStore.retain(projects.map((p) => p.id));
  }, [catalogReady, projects, visitsStore]);
  useEffect(() => {
    let alive = true;
    const off = window.goga.onRuns((next) => {
        if (!alive) return;
        runStreamVersion.current++;
        applyRuns(next);
        setRunsReady(true);
        setRunsError("");
      }),
      focus = window.goga.onFocusRun((id) => {
        if (!runsRef.current.some((r) => r.id === id)) return;
        navigateRef.current(() => {
          const target = runsRef.current.find((r) => r.id === id);
          if (!target) return;
          openRunRef.current(target);
        },false,"workspace");
      }),
      failed = window.goga.onViewError(({ id, error }) => {
        if (id.startsWith("attached:") || runsRef.current.some((r) => r.id === id))
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
    if(!projectPageVisible)return;
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
  }, [projectId, selectedContext, projectPageVisible]);
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
    !handoff.candidate && !dialogVisible &&
    !projectRemoval &&
    !demoCloseOpen && !projectCreationOpen && !organizationModal &&
    !pendingNavigation && !leave.view &&
    !gitModals.size &&
    !error &&
    !topicCard &&
    page === "project" &&
    (!attached || (!projectAddMenu && !sessionBuffer))
      ? attached ? attached.id : run && canShowDashboard && !showLogs[run.id] ? run.id : null
      : null;
  const notificationView =
    page === "project" &&
    run &&
    dashboardRecoveryAllowed(run) &&
    !error &&
    !topicCard &&
    !gitModals.size &&
    !handoff.candidate && !demoCloseOpen &&
    !pendingNavigation && !leave.view &&
    !notifications.open &&
    !notificationOpen &&
    !projectRemoval &&
    !projectCreationOpen && !organizationModal &&
    (visibleRun === run.id ||
      ["exited", "failed", "stopped"].includes(run.status))
      ? run.id
      : null;
  const notificationOwner = run
    ? JSON.stringify([
        run.id,
        run.projectId,
        run.pipeline,
        run.startedAt,
        run.context ?? null,
        run.topic,
        run.branch,
      ])
    : null;
  useEffect(() => {
    let alive = true;
    const api = window.goga;
    const reportView = (id: string | null) => {
      if (typeof api.setNotificationView === "function")
        void api.setNotificationView(id).catch(() => {});
    };
    // Revoke the previous screen before waiting for native selection. A late
    // acknowledgement cannot claim a run after navigation or an overlay.
    reportView(null);
    const currentAttachment=attachedRef.current.find(v=>v.id===visibleRun);
    const selection=currentAttachment&&api.selectAttachedDashboard
      ? api.selectAttachedDashboard(currentAttachment.owner.context??currentAttachment.owner.projectId,currentAttachment.id)
      : api.selectRun(visibleRun);
    void selection.then(
      () => {
        if (alive) reportView(notificationView);
      },
      (e) => {
        if (!alive) return;
        if (visibleRun)
          setViewErrors((previous) => ({
            ...previous,
            [visibleRun]: message(e),
          }));
        setError(message(e));
      },
    );
    return () => {
      alive = false;
      reportView(null);
    };
  }, [visibleRun, notificationView, notificationOwner, run?.dashboardOpened]);
  useEffect(()=>{
    if(!notificationOpen||notificationOpen.nonce!==notificationIntent.current||page!=="project"||selected!==notificationOpen.runId||run?.id!==notificationOpen.runId)return;
    let alive=true;
    // This effect runs after the target run/history is mounted. Native selection
    // acknowledgement precedes the stage acknowledgement and durable read.
    void window.goga.selectRun(visibleRun).then(async()=>{
      if(!alive||notificationOpen.nonce!==notificationIntent.current)return;
      await window.goga.completeNotificationOpen(notificationOpen.ticket);
      if(alive)setNotificationOpen(null);
    }).catch(e=>{if(alive){setNotificationOpen(null);setError(message(e));}});
    return()=>{alive=false;};
  },[notificationOpen,page,selected,visibleRun,run?.id]);
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
  const refreshAction=useRef<(id:string)=>void>(()=>{});
  refreshAction.current=(id)=>{
    if(!window.goga.refreshDashboard||!id||id!==visibleRun||refreshFlights.current.has(id))return;
    const key=notificationIntent.current;
    refreshFlights.current.add(id);setRefreshingIds([...refreshFlights.current]);
    const req=window.goga.refreshDashboard(id,attached?activePanelScope:undefined,attached?!!viewErrors[id]:undefined);
    void req.then(()=>setViewErrors(v=>{const next={...v};delete next[id];return next}))
      .catch(e=>{if(pageRef.current==="project"&&selectedRef.current===id&&key===notificationIntent.current)setViewErrors(v=>({...v,[id]:preparationErrorMessage(e)}))})
      .finally(()=>{refreshFlights.current.delete(id);setRefreshingIds([...refreshFlights.current])});
  };
  useEffect(()=>window.goga.onDashboardRefresh?.(id=>refreshAction.current(id)),[]);
  useEffect(()=>{
    if(!visibleRun||!window.goga.refreshDashboard)return;
    const key=(e:KeyboardEvent)=>{
      if((e.key==="F5"||((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="r"))&&!e.altKey&&!e.shiftKey&&!e.isComposing&&!document.querySelector("dialog[open]")){
        e.preventDefault();if(!e.repeat)refreshAction.current(visibleRun)
      }
    };
    window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key)
  },[visibleRun]);
  function openAttachedPanel(id:string){setSelected(id);setPage("project");setError("")}
  async function detachPanel(row:AttachedDashboard){
    try{
      await window.goga.detachDashboard!(row.owner.context??row.owner.projectId,row.id);
      setViewErrors(v=>{const next={...v};delete next[row.id];return next});
      if(selectedRef.current===row.id){setSelected(null);if(pageRef.current==="project")setPage("context-runs")}
    }catch(e){setError(preparationErrorMessage(e))}
  }
  async function add() {
    setError("");
    try {
      const p = await window.goga.chooseProject();
      if (!p) return;
      if (initialProjectsPending.current) initialProjectChanges.current.set(p.id, p);
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
      },false,"workspace");
    } catch (e) {
      setError(preparationErrorMessage(e));
    }
  }
  const projectOverviewStates = (id: string) =>
    [...overviewCloseStates.current]
      .filter(([key]) => JSON.parse(key)[0] === id)
      .map(([, state]) => state);
  const projectRemovalBlocked = (id: string) => {
    if (projectOverviewStates(id).some((state) => state.busy))
      return "Дождитесь завершения файловой операции в Обзоре этого проекта.";
    if (
      runsRef.current.some(
        (run) =>
          run.projectId === id &&
          (["starting", "running"].includes(run.status) ||
            run.recovery === "unverified"),
      )
    )
      return "Сначала завершите запуск этого проекта или проверьте его состояние. Никакие процессы не будут остановлены автоматически.";
    return undefined;
  };
  function requestProjectRemoval(target: Project) {
    const open = () =>
      setProjectRemoval({ project: target, busy: false, error: "" });
    if (target.id === projectIdRef.current) navigateRef.current(open,false,"stay");
    else if (!navigationBlocked()) open();
  }
  async function removeSelectedProject() {
    const target = projectRemoval?.project;
    if (
      !target ||
      projectRemovalFlight.current ||
      projectRemovalBlocked(target.id)
    )
      return;
    projectRemovalFlight.current = true;
    setProjectRemoval({ project: target, busy: true, error: "" });
    try {
      await window.goga.removeProject({ id: target.id, path: target.path });
      if (initialProjectsPending.current) initialProjectChanges.current.set(target.id, null);
      const remaining = projectsRef.current.filter(
        (item) => item.id !== target.id || item.path !== target.path,
      );
      // Apply the captured binding only; a late reply cannot erase other additions.
      setProjects((items) =>
        items.filter(
          (item) => item.id !== target.id || item.path !== target.path,
        ),
      );
      projectNavigation.current.delete(target.id);
      visitsStore.forget(target.id);
      restoration.current.delete(target.id);
      setContextSelections((values) => {
        const next = { ...values };
        delete next[target.id];
        return next;
      });
      setKnownContexts((values) =>
        values.filter((item) => item.projectId !== target.id),
      );
      if (projectIdRef.current === target.id) {
        const next = remaining[0];
        const saved = next ? projectNavigation.current.get(next.id) : undefined;
        setProjectId(next?.id ?? "");
        setSelected(saved?.selected ?? null);
        setActiveDraft(saved?.activeDraft ?? "");
        setPage(!next || pageRef.current==="home" ? "home" : saved?.page ?? "overview");
        setError(
          saved?.page === "project" && saved.selected
            ? (launchOwnerErrors.current.get(saved.selected) ?? "")
            : "",
        );
      }
      setProjectRemoval(null);
    } catch (error) {
      setProjectRemoval({
        project: target,
        busy: false,
        error: preparationErrorMessage(error),
      });
    } finally {
      projectRemovalFlight.current = false;
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
  async function repeatPipeline(target: Run) {
    if (pipelineRepeatFlights.current.has(target.id) || typeof window.goga.repeatPipeline !== "function") return;
    pipelineRepeatFlights.current.add(target.id);
    setRepeatingPipelines(new Set(pipelineRepeatFlights.current));
    setError("");
    try {
      const next = await window.goga.repeatPipeline(target.id);
      if (next.id === target.id || next.kind === "build" || next.pipeline !== target.pipeline || next.branch !== target.branch || !runMatchesWorkspace(next, target.projectId, target.context ?? null))
        throw Error("Повторный запуск не соответствует исходному контексту.");
      if (!runsRef.current.some((run) => run.id === next.id)) applyRuns([...runsRef.current, next]);
      setContextOpenRuns((previous) => new Set(previous).add(next.id));
      // A late launch result owns its own tab, never the user's new section.
      if (pageRef.current === "project" && selectedRef.current === target.id && runMatchesWorkspace(target, projectIdRef.current, selectedContextRef.current))
        navigateRef.current(() => openRunRef.current(next));
    } catch (error) {
      setError(preparationErrorMessage(error));
    } finally {
      pipelineRepeatFlights.current.delete(target.id);
      setRepeatingPipelines(new Set(pipelineRepeatFlights.current));
    }
  }
  const active = runs.some(
    (r) =>
      r.projectId === projectId &&
      (r.status === "starting" || r.status === "running"),
  );
  const topicRepository = useTopicRepository(projectPageVisible && project ? project.id : null);
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
    if (!projectPageVisible) return;
    const year = String(new Date().getFullYear());
    setCurrentTopics(project && topicRepository === "available" ? readCatalogCache(project, year) : null);
    setCurrentTopicsError("");
    if (!project || topicRepository !== "available") return;
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
  }, [topicScope, projectPageVisible, topicRepository]);
  // A contextual history/run still needs its exact owners if the primary repository disappears.
  const readTopicInventory = topicRepository === "available" || !!selectedContext;
  const waitForTopicInventory = topicRepository === "checking" && !readTopicInventory;
  useEffect(() => {
    let alive = true;
    if(!projectPageVisible)return;
    setKnownContexts([]);
    setContextsError("");
    setContextsLoading(contextsEnabled && Boolean(projectId) && (readTopicInventory || waitForTopicInventory));
    if (contextsEnabled && projectId && readTopicInventory)
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
  }, [read, projectId, topicsRevision, contextsEnabled, projectPageVisible, readTopicInventory, waitForTopicInventory]);
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
  const repositoryMissing = Boolean(
    project &&
    gitRepositories.get(documentScopeId(displayOwner ? contextRef(displayOwner) : project.id)) === "missing",
  );
  const demonstrations=demoDirectory();
  // A demo needs a registered owner, not a Git repository, executable, or idle pipeline.
  const demoScope=project&&!contextUnavailable?(displayOwner?contextRef(displayOwner):project.id):null;
  const demoKey=demoScope===null?null:demoScopeKey(demoScope);
  const demoKeyRef=useRef(demoKey);demoKeyRef.current=demoKey;
  const demoShowId=useDemoValue(demonstrations,()=>demonstrations.showFor(demoKey)?.showId);
  const demoStarting=useDemoValue(demonstrations,()=>demoKey!==null&&demonstrations.starting.has(demoKey));
  const [demoRetry, setDemoRetry] = useState<{key:string; intent:number; reason:string} | null>(null);
  // A retry is offered only for an embedded startup failure in this workspace.
  // Neither a port conflict nor a stale selection is repaired by changing browsers.
  const canRetryDemo = !!demoRetry && demoRetry.key === demoKey &&
    demoRetry.intent === notificationIntent.current && demoRetry.reason === error;
  function enterDemo(start: boolean, engine?: "system") {
    if (!project || !demoScope || !demoKey) return;
    const intent = notificationIntent.current;
    const stillHere = () => demoKeyRef.current === demoKey && projectIdRef.current === project.id &&
      intent === notificationIntent.current;
    if (!stillHere()) return;
    setDemoRetry(null);
    if (!start) {
      if (demonstrations.showFor(demoKey)) setPage("demonstration");
      return;
    }
    void demonstrations.start(demoScope, engine).then(
      () => { if (stillHere()) setPage("demonstration"); },
      e => {
        if (!stillHere()) return;
        const reason = demoError(e);
        if (!engine && reason.startsWith(DEMO_EMBEDDED_START_ERROR))
          setDemoRetry({key: demoKey, intent, reason});
        setError(reason);
      },
    );
  }
  useDemoMonitor(demonstrations,!!project&&projectPageVisible,page==="demonstration");
  useEffect(()=>{if(page==="demonstration"&&!demoShowId)setPage("overview");},[page,demoShowId]);
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
  // Changing owner considers both editors of the outgoing workspace only.
  function navigateContext(action: () => void, transition:FileTransition = "workspace") {
    if (
      settingsBusy ||
      deletion.busy ||
      topicRemoval.busy ||
      settingsGuard.current?.busy ||
      topicCard ||
      projectRemoval ||
      projectCreationOpen || organizationModal || sessionBuffer ||
      pendingNavigation || leave.blocked()
    )
      return;
    notificationIntent.current++;
    guardFileTransition(action, transition);
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
      setPage(previous === "project" && !run && !attached ? "project-settings" : previous);
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
  const topicRemoval = useTopicRemovalController(deletion.execute, topicsChanged);
  useEffect(() => {
    const intent = initialPreparation;
    if (
      !createdTopic ||
      !intent?.creation ||
      page !== "context-preparation" ||
      projectId !== createdTopic.projectId ||
      intent.nonce !== initialPreparationNonce.current ||
      intent.identity.projectId !== createdTopic.projectId ||
      intent.identity.year !== createdTopic.year ||
      intent.identity.branch !== createdTopic.branch
    )
      return;
    // No late navigation while another page is visible, and no lost result
    // while a card/navigation guard is open. Their closure rechecks this effect.
    navigateContext(() => {
      setContextSelections((values) => ({
        ...values,
        [createdTopic.projectId]: createdTopic,
      }));
      setInitialPreparation(null);
      setCreatedTopic(null);
      if (
        workspaceLaunchBlockReason(
          runsRef.current, createdTopic.projectId, createdTopic, "pipeline",
        )
      )
        setPage("context-runs");
      else showContextPreparation("pipeline", createdTopic);
    },"stay");
  }, [
    createdTopic, initialPreparation, page, projectId, topicCard,
    pendingNavigation, leave.view, settingsBusy, deletion.busy, topicRemoval.busy,
  ]);
  function openAddMenu(trigger: HTMLElement) {
    const box = trigger.getBoundingClientRect();
    navigate(() =>
      setProjectAddMenu({ trigger, x: box.left, y: box.bottom + 6 }),
      false,"stay"
    );
  }
  function address(
    id: string,
    record?: WorktreeRecord | null,
  ): WorkspaceAddress {
    return record
      ? { kind: "topic", ref: contextRef(record) }
      : { kind: "primary", projectId: id };
  }
  const sessionEntries = useMemo<SessionEntry[]>(() => {
    const forms: SessionEntry[] = [];
    for (const [ids, kind] of [
      [openLaunches, "pipeline"],
      [openBuilds, "build"],
    ] as const) {
      for (const { id, owner, project: p } of preparationEntries(ids)) {
        forms.push({
          id: JSON.stringify([kind, id]),
          target: {
            kind: "draft",
            owner: address(p.id, owner),
            draftKind: kind,
            key: id,
          },
          dirty: false,
          busy: !!(kind === "build" ? buildBusy[id] : launchBusy[id]),
          touchedAt: 0,
        });
      }
    }
    return [...forms, ...documentEntries];
  }, [
    openLaunches,
    openBuilds,
    draftOwners,
    projects,
    repeatSeeds,
    buildBusy,
    launchBusy,
    documentEntries,
  ]);
  const homeOperations = useMemo(() => {
    const labels: Record<string, string> = Object.create(null);
    for (const operation of repositoryActions.busy.values())
      labels[operation.projectId] = operation.label;
    return labels;
  }, [repositoryActions.busy]);
  // Only actual workspace transitions enter MRU. Output, badges, ticks or a
  // hidden Home do not count as visiting a project.
  useEffect(() => {
    if (!project || !projectPageVisible || page==="demonstration") return;
    const owner = address(project.id, selectedContext);
    let target: HomeTarget;
    if (page === "launch" || page === "build") {
      if (!activeDraft) return;
      target = {
        kind: "draft",
        owner,
        draftKind: page === "launch" ? "pipeline" : "build",
        key: activeDraft,
      };
    } else if (page === "project" && selected)
      target = { kind: "run", owner, runId: selected };
    else if (page === "changes") target = { kind: "changes", owner };
    else
      target = {
        kind: "section",
        owner,
        section:
          page === "context-preparation"
            ? "context-runs"
            : page === "project"
              ? "overview"
              : page,
      };
    visitsStore.remember(target);
  }, [
    project?.id,
    projectPageVisible,
    page,
    selected,
    activeDraft,
    selectedContext?.contextId,
    selectedContext?.revision,
    visitsStore,
  ]);
  const homeNavigationState = useRef({ sessionEntries, sessionStore });
  homeNavigationState.current = { sessionEntries, sessionStore };
  // Opening a modal supersedes a pending Home shortcut even if the user
  // closes it before the owner read finishes. Other navigation remains unchanged.
  const homeIntentBlocked = page !== "home" || navigationBlocked() ||
    notifications.open || !!projectAddMenu || !!error;
  const homeGuardEpoch = useRef(0);
  useLayoutEffect(() => {
    if (homeIntentBlocked) homeGuardEpoch.current++;
    return () => { homeGuardEpoch.current++; };
  }, [homeIntentBlocked]);
  function openHomeTarget(target: HomeTarget) {
    if (homeIntentBlocked) return;
    const guardEpoch = homeGuardEpoch.current;
    const ticket = ++notificationIntent.current;
    const current = () =>
      ticket === notificationIntent.current &&
      guardEpoch === homeGuardEpoch.current && pageRef.current === "home";
    const pid =
      target.owner.kind === "primary"
        ? target.owner.projectId
        : target.owner.ref.projectId;
    const p = projectsRef.current.find((v) => v.id === pid);
    if (!p) {
      setError("Проект больше не находится в списке.");
      return;
    }
    if (target.kind === "run") {
      const r = runsRef.current.find(
        (v) => v.id === target.runId && v.projectId === pid,
      );
      if (r) {
        const same = r.context
          ? target.owner.kind === "topic" &&
            contextKey(r.context) === contextKey(target.owner.ref)
          : target.owner.kind === "primary";
        if (!same) {
          setError("Сохранённый запуск относится к другой рабочей области.");
          return;
        }
        navigate(() => openContextRun(r), true);
        return;
      }
    }
    void (async () => {
      const owner = await resolveHomeOwner(
        p,
        target.owner,
        (ref) => readRequest("resolveTopicContext", ref),
        (id) => readRequest("listTopicContexts", id),
        current,
      );
      if (
        !current() ||
        !projectsRef.current.some((v) => v.id === pid && v.path === p.path)
      )
        return;
      navigateRef.current(() => {
        let next: HomeSection | "launch" | "build" | "changes" | "project" = "overview",
          notice = "";
        let nextSelected:string|null=null;
        let draft = "";
        const { sessionEntries: live, sessionStore: store } =
          homeNavigationState.current;
        if (target.kind === "document") {
          if (!store.has(target)) {
            setError("Файл больше не содержит несохранённых изменений.");
            return;
          }
          const sameRevision =
            target.owner.kind === "primary" ||
            target.owner.ref.revision === owner?.revision;
          const opened = sameRevision ? store.reveal(target) : null;
          if (!opened) {
            setSessionBuffer(target);
            return;
          }
          if (opened.page === "project-settings")
            setProjectSettingsTabs((old) => ({ ...old, [pid]: opened.tab }));
          next = opened.page;
        } else if (target.kind === "draft") {
          const exists = live.some(
            (e) =>
              e.target.kind === "draft" &&
              e.target.key === target.key &&
              e.target.draftKind === target.draftKind &&
              JSON.stringify(e.target.owner) === JSON.stringify(target.owner),
          );
          if (
            exists &&
            (target.owner.kind === "primary" ||
              target.owner.ref.revision === owner?.revision)
          ) {
            next = target.draftKind === "pipeline" ? "launch" : "build";
            draft = target.key;
          } else
            notice =
              "Прежняя форма недоступна в этой рабочей области. Открыт Обзор; новый запуск не создан.";
        } else if (target.kind === "changes") next = "changes";
        else if (target.kind === "section") next = target.section;
        else if(target.kind==="run"&&attachedRef.current.some(v=>v.id===target.runId&&sameDashboardOwner(v.owner,{projectId:pid,context:owner?contextRef(owner):undefined}))){
          next="project";nextSelected=target.runId;
        }
        else
          notice =
            "Прежняя вкладка запуска недоступна. Открыт Обзор этой рабочей области.";
        restoration.current.delete(pid);
        setContextSelections((v) => ({ ...v, [pid]: owner }));
        setProjectId(pid);
        setSelected(nextSelected);
        setActiveDraft(draft);
        setPage(next);
        setError(notice);
      }, true);
    })().catch((e) => {
      if (!current()) return;
      if (
        target.kind === "document" &&
        homeNavigationState.current.sessionStore.has(target)
      )
        setSessionBuffer(target);
      else setError(preparationErrorMessage(e));
    });
  }
  const restoringPanels = useRef(new Map<string, Promise<void>>());
  function restorePanel(id: string) {
    const pending = restoringPanels.current.get(id);
    if (pending) return pending;
    const attempt = window.goga.restoreDashboard!(id)
      .then(() => {
        setViewErrors((previous) => {
          const next = { ...previous };
          delete next[id];
          return next;
        });
        setShowLogs((previous) => ({ ...previous, [id]: false }));
      })
      .finally(() => restoringPanels.current.delete(id));
    restoringPanels.current.set(id, attempt);
    return attempt;
  }
  function replaceSubmittedHomeSlot(
    kind: "build" | "pipeline",
    id: string,
    source: Project,
    owner: WorktreeRecord | undefined,
    r: Run,
    createdOwner?: WorktreeRecord,
  ) {
    if (
      source.id !== r.projectId ||
      !projectsRef.current.some(
        (p) => p.id === source.id && p.path === source.path,
      )
    )
      return;
    const historyOwner =
      createdOwner ??
      (r.context
        ? owner &&
          contextKey(owner) === contextKey(r.context) &&
          owner.revision === r.context.revision
          ? owner
          : recordedRunOwner(r.context)
        : null);
    visitsStore.replaceDraft(
      {
        kind: "draft",
        key: id,
        draftKind: kind,
        owner: address(source.id, owner),
      },
      { kind: "run", runId: r.id, owner: address(r.projectId, historyOwner) },
    );
    const saved = projectNavigation.current.get(source.id);
    if (
      (projectIdRef.current !== source.id ||
        pageRef.current === "home" ||
        pageRef.current === "settings") &&
      saved?.page === (kind === "build" ? "build" : "launch") &&
      saved.activeDraft === id
    ) {
      projectNavigation.current.set(source.id, {
        page: "project",
        selected: r.id,
        activeDraft: "",
      });
      if (historyOwner)
        setContextSelections((values) => ({
          ...values,
          [source.id]: historyOwner,
        }));
    }
  }
  function restoreFromHome(id: string) {
    const r = runsRef.current.find((v) => v.id === id);
    if (
      !r ||
      !canRestoreRunDashboard(r, viewErrors[id]) ||
      !window.goga.restoreDashboard
    )
      return;
    navigate(() => {
      if (openContextRun(r)) {
        void restorePanel(id).catch((e) =>
          setViewErrors((prev) => ({
            ...prev,
            [id]: preparationErrorMessage(e),
          })),
        );
      }
    }, true);
  }
  const content = (
    <ProjectSaveGuardShell
      projectSaveOnly={documentActivity === "project-save" && !otherSettingsBusy}
      className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}
    >
      <header className="titlebar">
        <div className="wordmark">
          <b>Go</b>ga <small>DESKTOP</small>
        </div>
        <NotificationBell controller={notifications} projects={projects} onOpen={openNotification}/>
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
        <ProjectSidebar projects={projects} controller={organization} activeProjectId={projectPageVisible?projectId:null}
          collapsed={sidebarCollapsed} disabled={settingsBusy} homeActive={page==="home"}
          onHome={()=>navigate(()=>{setPage("home");setError("");},true,"workspace")}
          onOpen={p=>{ if (p.id===projectId && projectPageVisible) return; navigate(()=>{
            const saved=projectNavigation.current.get(p.id);
            setProjectId(p.id); setPage(saved?.page??"overview");setActiveDraft(saved?.activeDraft??"");setSelected(saved?.selected??null);
            setError(saved?.page==="project" && saved.selected ? launchOwnerErrors.current.get(saved.selected)??"" : "");
          },false,"workspace");}}
          onAdd={openAddMenu} addMenuOpen={!!projectAddMenu}
          onRemove={requestProjectRemoval} canOpenMenu={()=>!settingsBusy && !navigationBlocked()}
          unreadByProject={notifications.snapshot.byProject} onNotifications={()=>notifications.setOpen(true)}
          onError={e=>setError(preparationErrorMessage(e))} onModalChange={setOrganizationModal}/>
        <button
          aria-label="Настройки"
          className={`settings-button ${page === "settings" ? "active" : ""}`}
          disabled={settingsBusy}
          onClick={() =>
            navigate(() => {
              if (page !== "settings") {
                settingsBack.current=page==="demonstration"?"demonstration":page==="home"||!project?"home":"project-settings";
                settingsTerminalOwner.current=null;
              }
              setPage("settings");
              setError("");
            },false,"workspace")
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
        {page!=="home" && <div className="project-bar" ref={repositoryPopupAnchor}>
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
                repository={topicRepository}
                catalogError={currentTopicsError}
                onRetryCatalog={() => setTopicsRevision((value) => value + 1)}
                selected={selectedContext}
                knownContexts={knownContexts}
                runs={runs as RunWithContext[]}
                disabled={settingsBusy}
                onTransitionIntent={() => {
                  notificationIntent.current++;
                  topicTransitionEpochs.current.set(
                    projectId,
                    (topicTransitionEpochs.current.get(projectId) ?? 0) + 1,
                  );
                  if (pageRef.current !== "context-preparation") return;
                  // A new explicit topic transition owns continuation even
                  // while its verification is pending. Retain A's flight
                  // for reconciliation, but never publish its late result.
                  initialPreparationNonce.current++;
                  setInitialPreparation(null);
                  setPage("context-runs");
                }}
                beforePrepare={beforeTopicPrepare}
                onCreationStarted={showTopicCreation}
                onCreationProgress={setTopicCreation}
                onShowCreation={identity=>navigateContext(()=>showTopicCreation(identity),"pipeline")}
                showCreationFeedback={false}
                onCreated={(record) => {
                  if (projectIdRef.current !== record.projectId) return;
                  setKnownContexts((values) => [
                    ...values.filter(
                      (value) => value.contextId !== record.contextId,
                    ),
                    record,
                  ]);
                  topicsChanged();
                  // Retain success even if the user left preparation or a
                  // modal currently prevents continuation. Returning can resume
                  // the form without creating/ensuring the copy again.
                  setCreatedTopic(record);
                }}
                onSelect={(record,approved) =>
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
                      pageRef.current === "demonstration" || pageRef.current === "overview" ||
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
                  },approved?.()?"stay":"workspace")
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
                      pageRef.current === "demonstration" || pageRef.current === "overview" ||
                        pageRef.current === "project-settings" ||
                        pageRef.current === "topics" ||
                        pageRef.current === "changes" ||
                        pageRef.current === "commits"
                        ? pageRef.current
                        : pageRef.current === "terminal"
                          ? "terminal"
                          : "project-settings",
                    );
                  },selectedContext?"workspace":"stay")
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
                    }),false,"stay"
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
                  [...gitBranchBusy.values()].includes(project.id) ||
                  repositoryMissing
                }
              />
            )}
            {page !== "settings" && project &&
              topicCreation?.identity.projectId === project.id &&
              !(page === "context-preparation" && initialPreparation?.creation) && (
                <TopicCreationFeedback
                  progress={topicCreation}
                  disabled={settingsBusy}
                  onShow={() => showTopicCreation(topicCreation.identity)}
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
              {demoStarting&&<small role="status">Запускаем демонстрацию…</small>}
              <ContextLaunchMenu
                context={displayOwner}
                runs={runs as RunWithContext[]}
                disabled={settingsBusy}
                blockedReason={launchUnavailable}
                prepareWithoutContext={!selectedContext}
                primaryProjectId={projectId}
                onPrepare={(kind) => navigate(() => prepareFromHeader(kind),false,kind)}
                demoItem={demonstrations.available&&demoScope&&demoKey ? closeMenu=><DemoLaunchItem key={demoKey}
                  store={demonstrations} scopeKey={demoKey} enter={start=>{
                    closeMenu();
                    navigate(() => enterDemo(start));
                  }}/> : undefined}
              />
            </div>
          )}
          <RepositoryOperationPopup
            anchor={repositoryPopupAnchor}
            onHandoff={openHandoff}
          />
        </div>}
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
            onClose={() => { setError(""); setDemoRetry(null); }}
          >
            <pre role="alert">{error}</pre>
            {canRetryDemo && <div className="form-actions">
              <button type="button" onClick={() => {
                if (demoRetry?.intent !== notificationIntent.current || demoRetry.key !== demoKeyRef.current) return;
                setError("");
                enterDemo(true, "system");
              }}>Запустить в системном браузере</button>
            </div>}
          </TopicModal>
        )}
        <RetainedViews activeKey={page === "settings" ? "settings" : null}>
          <div className="scroll-area global-settings-scroll-area">
            <Settings
              documents={settingsDocuments}
              selectedTab={globalSettingsTab}
              onTabChange={setGlobalSettingsTab}
              onBack={() => navigate(() => {
                // Metadata revisions do not change a retained terminal owner. Never
                // silently substitute an unrelated project/topic if the owner vanished.
                const dest=settingsBack.current;
                setPage(dest==="terminal" && sectionKey("terminal",displayOwner)!==settingsTerminalOwner.current ? "home" : dest);
              })}
            />
          </div>
        </RetainedViews>
        {page==="home" && <HomePage projects={projects} runs={runs} attached={attachedPanels} organization={organization.organization}
          visits={visits} sessionEntries={sessionEntries} notifications={notifications.available?{byProject:notifications.snapshot.byProject,error:notifications.error||undefined}:null}
          viewErrors={viewErrors} catalogReady={catalogReady} catalogError={catalogError} onRetry={()=>{setCatalogError("");retryCatalog(n=>n+1);}}
          runsReady={runsReady} runsError={runsError} onRetryRuns={()=>{setRunsError("");retryRuns(n=>n+1);}}
          onDetachPanel={row=>void detachPanel(row)} operations={homeOperations} onAdd={openAddMenu} onNavigate={openHomeTarget} onReconnect={typeof window.goga.restoreDashboard === "function" ? restoreFromHome : undefined}/>}
        {sessionBuffer && <SessionBuffer store={sessionStore} target={sessionBuffer} onClose={()=>setSessionBuffer(null)}/>}
        <div className="project-page" hidden={!projectPageVisible}>
          <div className="tabs" role="tablist" aria-label="Разделы проекта">
            {project && (
              <button
                type="button"
                className="topics-nav"
                aria-pressed={page === "overview"}
                disabled={settingsBusy}
                onClick={() => {if (page!=="overview") navigate(() => setPage("overview"));}}
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
                onClick={() => {if (page!=="project-settings") navigate(() => setPage("project-settings"));}}
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
            {projectPageVisible&&demoShowId&&<DemoRunTab key={demoShowId} store={demonstrations} showId={demoShowId}
              selected={page==="demonstration"} disabled={settingsBusy} onSelect={()=>navigate(()=>setPage("demonstration"))} onModalChange={setDemoCloseOpen} onError={setError}/>}
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
                        onClick={() => { if(!visible) navigate(() => returnToDraft(id, kind),false,kind); }}
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
            {workspacePanels.map(row=><div className="run-tab-group" key={row.id}>
              <button role="tab" aria-selected={page==="project"&&selected===row.id} className={`run-tab ${page==="project"&&selected===row.id?"active":""}`}
                onClick={()=>navigate(()=>openAttachedPanel(row.id))}><Cable size={15}/><span>{row.name}<small>Подключён по URL</small></span></button>
              <button className="close-tab" title="Отключить панель, не останавливая процесс" aria-label={`Отключить панель ${row.name}`}
                onClick={()=>navigate(()=>void detachPanel(row),false,"stay")}>×</button>
            </div>)}
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
                    aria-label={`${r.kind === "build" ? "Сборка" : r.pipeline} · ${r.topic || "Без топика"} · ${r.branch}`}
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
                    {notifications.snapshot.unreadRunIds.includes(r.id)&&<i className="run-unread-marker" aria-label="Есть непрочитанные уведомления"/>}
                    <span>
                      {r.kind === "build" ? "Сборка" : r.pipeline}
                      <small>
                        {r.kind === "build"
                          ? r.build?.planPath.split("/").at(-1)
                          : r.topic || "Без топика"}{" "}
                        · {r.branch}
                      </small>
                    </span>
                  </button>
                  <button
                    className="close-tab"
                    data-close-run={r.id}
                    aria-label={`Закрыть вкладку ${r.kind === "build" ? "Сборка" : r.pipeline} · ${r.topic || "Без топика"}`}
                    title="Закрыть вкладку"
                    disabled={closingIds.includes(r.id) || repeatingPipelines.has(r.id)}
                    onClick={() => navigate(() => void closeTab(r.id),false,"stay")}
                  >
                    ×
                  </button>
                </div>
              ))}
          </div>
          <div className="run-context" data-document-section={page === "project-settings" || undefined}>
            <span
              className="workspace-path"
              aria-label="Путь выбранного контекста"
              title={displayedPath.full}
            >
              {displayedPath.display}
            </span>
            <div className="document-status-outlet" ref={setDocumentStatusOutlet} />
            {attached&&page==="project"?<div className="run-actions"><span className="run-state">{viewErrors[attached.id]?"Панель недоступна":"Подключено · только просмотр"}</span>
              <PanelRefreshButton busy={refreshingIds.includes(attached.id)} onClick={()=>refreshAction.current(attached.id)}/></div>:run && page === "project" ? (
              <>
                {run.kind === "build" && (
                  <span className="run-build-plan" title={run.build?.planPath}>
                    Сборка <strong>{run.build?.planPath}</strong>
                  </span>
                )}
                <div className="run-actions">
                  {canShowDashboard ? (<>
                    <span className="run-state run-state-live" title="Работает">Работает</span>
                    <RunActionButton
                      className="run-output-toggle"
                      label="Работает — показ журнала вывода"
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
                      <SquareTerminal size={15} aria-hidden="true" />
                    </RunActionButton>
                  </>) : (
                    <span className={`run-state ${run.recovery === "unverified" ? "" : run.status === "running" ? "run-state-live" : ["exited", "failed", "stopped"].includes(run.status) ? "run-state-ended" : ""}`} title={run.recovery === "unverified" ? "Состояние процесса не подтверждено после перезапуска" : labels[run.status]}>
                      {run.recovery === "unverified"
                        ? "Состояние процесса не подтверждено после перезапуска"
                        : labels[run.status]}
                    </span>
                  )}
                  {visibleRun===run.id&&window.goga.refreshDashboard&&<PanelRefreshButton busy={refreshingIds.includes(run.id)} onClick={()=>refreshAction.current(run.id)}/>}
                  {run.recovery && (
                    <RunActionButton
                      label={reconcilingRun === run.id ? "Проверяем состояние процесса…" : "Проверить состояние процесса"}
                      aria-busy={reconcilingRun === run.id}
                      disabled={
                        !!reconcilingRun ||
                        typeof window.goga.reconcileRun !== "function"
                      }
                      onClick={() => void reconcileRun(run)}
                    >
                      <Activity size={15} aria-hidden="true" />
                    </RunActionButton>
                  )}
                  {run.kind !== "build" && run.pipelineRepeat &&
                    ["exited", "failed", "stopped"].includes(run.status) &&
                    run.recovery !== "unverified" &&
                    typeof window.goga.repeatPipeline === "function" && (
                      <RunActionButton label="Повторить запуск"
                        disabled={repeatingPipelines.has(run.id) || !!contextUnavailable || !!workspaceLaunchBlockReason(runs, run.projectId, run.context ?? null, "pipeline")}
                        title={`Повторить с прежними параметрами${run.pipelineRepeat.clean ? ", с очисткой состояния" : ""}${run.pipelineRepeat.update ? ", с пересборкой" : ""}`}
                        onClick={() => void repeatPipeline(run)}
                      ><RotateCcw size={15} aria-hidden="true" /></RunActionButton>
                    )}
                  {run.kind === "build" &&
                    !(
                      run.status === "starting" || run.status === "running"
                    ) && (
                      <RunActionButton label="Повторить сборку"
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
                        <RotateCcw size={15} aria-hidden="true" />
                      </RunActionButton>
                    )}
                  {(run.status === "starting" || run.status === "running") && (
                    <RunActionButton label="Остановить"
                      onClick={stop}
                      className="stop-button"
                      disabled={
                        run.recovery === "unverified" ||
                        reconcilingRun === run.id
                      }
                      title={
                        run.recovery === "unverified"
                          ? "Невозможно безопасно остановить процесс без подтверждённого владения после перезапуска."
                          : undefined
                      }
                    >
                      <Square size={15} aria-hidden="true" />
                    </RunActionButton>
                  )}
                </div>
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
                  activeKey={projectPageVisible ? sectionKey("git") : null}
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
                      onRepositoryStateChange={(scope, state) => {
                        const owner = documentScopeId(scope);
                        setGitRepositories((previous) => {
                          if (state === "unknown") {
                            if (!previous.has(owner)) return previous;
                            const next = new Map(previous);
                            next.delete(owner);
                            return next;
                          }
                          if (previous.get(owner) === state) return previous;
                          return new Map(previous).set(owner, state);
                        });
                      }}
                      onCurrentBranchChanged={(issuedScope) => {
                        gitSummaryCacheFor(window.goga).invalidate(issuedScope, true);
                        const owner = documentScopeId(issuedScope);
                        setGitRevision((previous) => ({
                          ...previous,
                          [owner]: (previous[owner] ?? 0) + 1,
                        }));
                      }}
                      onChanged={(id, issuedScope = id, change) => {
                        if (scopeProjectId(issuedScope) !== id) return;
                        gitSummaryCacheFor(window.goga).invalidate(issuedScope);
                        const owner = documentScopeId(issuedScope);
                        setGitRevision((previous) => ({
                          ...previous,
                          [owner]: (previous[owner] ?? 0) + 1,
                        }));
                        // Fetch imports tracking refs, not topics or working files.
                        // Reloading their catalogs would temporarily disable Git
                        // and dismiss the branch popup that owns this update.
                        if (change === "references-only") return;
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
                        !!contextUnavailable || contextsLoading || settingsBusy || repositoryMissing
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
            ref={dashboardViewport}
            className="scroll-area"
            hidden={page === "changes" || page === "commits"}
          >
            {dialogVisible&&<AttachPanelDialog key={attachmentKey} scope={activePanelScope} ownerLabel={project!.name+(selectedContext?" · "+selectedContext.topic:"")} onClose={()=>setAttachDialog(null)}
              onOpen={r=>{setAttachDialog(null);if(r.kind==="managed"){const match=runsRef.current.find(v=>v.id===r.id);
                if(match)navigate(()=>openContextRun(match));else setError("Запуск уже закрыт.");}
                else navigate(()=>openAttachedPanel(r.panel.id))}}/>}
            {page==="demonstration"&&demoShowId&&<DemoPanel key={demoShowId} store={demonstrations} showId={demoShowId}
              onSettings={()=>navigate(()=>{settingsBack.current="demonstration";setGlobalSettingsTab("demonstrations");setPage("settings");},false,"workspace")}/>}
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
                  sessions={sessionStore} retainedViewKey={sectionKey("overview")!}
                  onMutation={() => {
                    gitSummaryCacheFor(window.goga).invalidate(displayOwner ? contextRef(displayOwner) : project.id);
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
                    const previous = overviewCloseStates.current.get(key);
                    const next = {
                      paths: paths.map(
                        (p) =>
                          project.name +
                          " · " +
                          (displayOwner?.topic ?? "Без топика") +
                          " · " +
                          p,
                      ),
                      busy,
                    };
                    overviewCloseStates.current.set(key, next);
                    if (previous?.busy !== next.busy || JSON.stringify(previous?.paths ?? []) !== JSON.stringify(next.paths))
                      refreshOverviewCloseState(value => value + 1);
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
                  panels={workspacePanels}
                  viewErrors={viewErrors}
                  onAttach={window.goga.attachDashboard&&!contextUnavailable?()=>setAttachDialog(attachmentKey):undefined}
                  onOpenPanel={id=>navigate(()=>openAttachedPanel(id))}
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
                initialPreparation.creation ? (
                  <section className="context-stage" aria-label="Подготовка запуска">
                    {topicCreation?.state === "error" &&
                    topicCreation.identity.projectId === initialPreparation.identity.projectId &&
                    topicCreation.identity.year === initialPreparation.identity.year &&
                    topicCreation.identity.branch === initialPreparation.identity.branch ? (
                      <>
                        <h2>Подготовка конвейера</h2>
                        <p className="context-run-hint">
                          Топик: {topicCreation.identity.branch}
                        </p>
                        <p className="error" role="alert">{topicCreation.message}</p>
                        <button
                          type="button"
                          className="primary"
                          onClick={topicCreation.retry}
                        >
                          Повторить подготовку
                        </button>
                      </>
                    ) : (
                      <LoadingState label="Подготовка запуска" />
                    )}
                  </section>
                ) : (
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
                )
              )}
            {page === "project-settings" && contextUnavailable && (
              <section
                className="context-stage"
                aria-label="Контекст недоступен"
              >
                <p role="status">{contextUnavailable}</p>
              </section>
            )}
            <ProjectDocumentStatusOutlet.Provider value={documentStatusOutlet}>
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
                    specificationsState={specificationsState}
                    selectedTab={projectSettingsTabs[project.id]}
                    onTabChange={(tab) => setProjectSettingsTabs(values => ({ ...values, [project.id]: tab }))}
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
            </ProjectDocumentStatusOutlet.Provider>
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
                    onLaunched={(r, stale, superseded) => {
                      if (!runsRef.current.some((i) => i.id === r.id))
                        applyRuns([...runsRef.current, r]);
                      setContextOpenRuns(values => new Set(values).add(r.id));
                      if (superseded) return;
                      const visible = pageRef.current === "build" && activeDraftRef.current === id &&
                        matchesWorkspace(buildProject.id, owner, projectIdRef.current, selectedContextRef.current);
                      replaceSubmittedHomeSlot("build", id, buildProject, owner, r);
                      setOpenBuilds(values => {
                        const next = new Set(values); next.delete(id); return next;
                      });
                      buildDrafts.current.delete(id);
                      if (repeatSeeds[id]) setRepeatSeeds(previous => {
                        const next = {...previous}; delete next[id]; return next;
                      });
                      if (!visible) return;
                      if (!stale) navigateRef.current(() => openRunRef.current(r));
                      else setPage(owner ? "context-runs" : "project-settings");
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
                    onTopicsChanged={topicsChanged}
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
                    onLaunchStarted={() =>
                      launchTopicEpochs.current.set(
                        id,
                        topicTransitionEpochs.current.get(launchProject.id) ?? 0,
                      )
                    }
                    onLaunched={async (r, stale) => {
                      // The retained preparation owns this result, not whichever
                      // section/project happens to be visible when IPC resolves.
                      if (r && !runsRef.current.some((i) => i.id === r.id))
                        applyRuns([...runsRef.current, r]);
                      setContextOpenRuns((values) => new Set(values).add(r.id));
                      // A genuinely revised draft must survive a late result;
                      // hiding/reopening the form is not such a revision.
                      if (stale) return;
                      const sourceVisible = () =>
                        pageRef.current === "launch" &&
                        activeDraftRef.current === id &&
                        matchesWorkspace(
                          launchProject.id,
                          owner,
                          projectIdRef.current,
                          selectedContextRef.current,
                        );
                      let createdOwner: WorktreeRecord | undefined;
                      if (!owner && r?.context) {
                        try {
                          const record = worktreeRecordSchema.parse(
                            await readRequest(
                              "resolveTopicContext",
                              contextRef(r.context),
                            ),
                          );
                          if (
                            contextKey(record) !== contextKey(r.context) ||
                            record.revision !== r.context.revision ||
                            record.projectId !== launchProject.id ||
                            record.projectPath !== launchProject.path ||
                            (r.context.path &&
                              record.path !== r.context.path) ||
                            record.state !== "ready" ||
                            record.storageKind !== "clone" ||
                            record.ownership !== "managed" ||
                            record.preparation ||
                            record.deletedAt
                          )
                            throw Error(
                              "Созданная рабочая копия изменилась. Выберите топик заново.",
                            );
                          createdOwner = record;
                          setKnownContexts((values) => [
                            ...values.filter(
                              (v) => v.contextId !== record.contextId,
                            ),
                            record,
                          ]);
                          topicsChanged();
                        } catch (error) {
                          launchOwnerErrors.current.set(r.id, message(error));
                        }
                      }
                      const topicEpoch = launchTopicEpochs.current.get(id);
                      const canActivate = () =>
                        sourceVisible() &&
                        topicEpoch ===
                          (topicTransitionEpochs.current.get(launchProject.id) ?? 0);
                      await new Promise<void>((resolve) => {
                        let completed = false;
                        const complete = (activate: boolean) => {
                          if (completed) return;
                          completed = true;
                          pendingLaunchPresentations.current.delete(id);
                          launchTopicEpochs.current.delete(id);
                          setOpenLaunches((values) => {
                            const next = new Set(values);
                            next.delete(id);
                            return next;
                          });
                          replaceSubmittedHomeSlot("pipeline", id, launchProject, owner, r, createdOwner);
                          if (
                            activate &&
                            canActivate() &&
                            runsRef.current.some((run) => run.id === r.id)
                          )
                            openRunRef.current(r, createdOwner);
                          else if (sourceVisible())
                            setPage(owner ? "context-runs" : "project-settings");
                          resolve();
                        };
                        pendingLaunchPresentations.current.set(id, {
                          canActivate,
                          complete,
                        });
                        refreshLaunchPresentations((value) => value + 1);
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
                  suspendOpen={deletion.busy || topicRemoval.busy}
                  api={window.goga.terminal}
                  onPresetSettings={() => navigate(() => {
                    settingsBack.current="terminal";
                    settingsTerminalOwner.current=sectionKey("terminal", displayOwner);
                    setGlobalSettingsTab("terminal");
                    setPage("settings");
                    setError("");
                  },false,"workspace")}
                  scope={displayOwner ? contextRef(displayOwner) : project.id}
                  blocked={contextUnavailable || undefined}
                  obscured={Boolean(
                    error ||
                    handoff.candidate ||
                    topicCard ||
                    projectRemoval ||
                    projectCreationOpen || organizationModal ||
                    pendingNavigation || leave.view ||
                    repeatPending ||
                    repositoryActions.failures.length ||
                    gitModals.size || demoCloseOpen ||
                    deletion.operation ||
                    topicRemoval.operation,
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
              {project && (topicRepository === "checking" ?
                <LoadingState label="Проверяем Git в проекте" /> :
                topicRepository === "missing" ?
                <section className="topics-workspace project-content" aria-label="Топики проекта">
                  <div className="topics-heading"><h2>Топики</h2></div>
                  <TopicRepositoryNotice />
                </section> :
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
                      "stay"
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
            {!projectPageVisible || (page === "overview" && project) ||
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
                  Откройте существующую папку, создайте пустой проект
                  или клонируйте Git-репозиторий.
                </p>
                <div className="creation-welcome-actions">
                  <button onClick={() => navigate(() => void add())}>Открыть существующий…</button>
                  <button onClick={() => navigate(() => setProjectCreationOpen(true))} className="primary">Создать новый…</button>
                </div>
                <small>Для запуска нужны установленные Goga и Docker.</small>
              </div>
            ) : page==="project"&&attached ? (
              viewErrors[attached.id]?<section className="context-stage"><h2>Панель конвейера недоступна</h2><p className="error" role="alert">{viewErrors[attached.id]}</p>
              <button disabled={refreshingIds.includes(attached.id)} onClick={()=>refreshAction.current(attached.id)}>Восстановить панель</button></section>
              : <div className="afm-placeholder" aria-label="Подключённая панель конвейера">{refreshingIds.includes(attached.id)&&<p role="status">Обновляем страницу панели…</p>}</div>
            ) : page === "context-runs" ||
              page === "context-preparation" || page==="demonstration" ? null : !run ? (
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
                  onClick={() => navigate(() => prepareFromHeader("pipeline"),false,"pipeline")}
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
              {run && <LoadingBoundary pending={repeatingPipelines.has(run.id)} label="Подготавливаем повторный запуск…"><RunOutput key={run.id} run={run} viewError={viewErrors[run.id]} onRestore={typeof window.goga.restoreDashboard === "function" ? () => restorePanel(run.id) : undefined} /></LoadingBoundary>}
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
            setTopicCard(null);
            guardFileTransition(() => {
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
            },"pipeline");
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
      {projectAddMenu && <ProjectAddMenu target={projectAddMenu}
        onClose={restoreFocus => { if (restoreFocus) projectAddMenu.trigger.focus(); setProjectAddMenu(null); }}
        onAction={action => navigateRef.current(() => action === "open" ? void add() : setProjectCreationOpen(true),false,"stay")}
        onError={error => setError(preparationErrorMessage(error))} />}
      {projectCreationOpen && <ProjectCreationDialog onClose={() => setProjectCreationOpen(false)}
        onOpenExisting={() => {setProjectCreationOpen(false);setOpenAfterCreation(true);}}
        onSuccess={(created, warning) => {
          if (initialProjectsPending.current) initialProjectChanges.current.set(created.id, created);
          // A new directory is a new primary workspace, even if its path once
          // belonged to a removed project with a cached topic selection.
          restoration.current.delete(created.id);
          setContextSelections(previous => ({...previous,[created.id]:null}));
          setProjects(items => items.some(item => item.id === created.id) ? items : [...items,created]);
          setProjectCreationNotice(warning ?? "");
          setProjectCreationOpen(false);setCreatedProject(created);
        }} />}
      {projectCreationNotice && <div className="project-creation-notice" role="status">
        <span>{projectCreationNotice}</span><button aria-label="Закрыть сообщение о создании" onClick={() => setProjectCreationNotice("")}>×</button>
      </div>}
      {projectRemoval && <ProjectRemovalDialog project={projectRemoval.project} busy={projectRemoval.busy}
        error={projectRemoval.error} dirty={projectOverviewStates(projectRemoval.project.id).flatMap(state => state.paths)}
        blocked={projectRemovalBlocked(projectRemoval.project.id)}
        onClose={() => { if (!projectRemovalFlight.current) setProjectRemoval(null); }}
        onConfirm={() => void removeSelectedProject()} />}
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
      {leave.view && !leave.view.silent && (
        <WorkspaceLeaveDialog files={[...new Set(leave.view.intent.files.map(file=>file.path))]}
          launching={leave.view.intent.launching} busy={leave.view.busy} failure={leave.view.failure}
          onStay={leave.stay} onSave={leave.save} onKeep={leave.keep}
          onReveal={leave.view.failure?.reveal ? leave.reveal : undefined}/>
      )}
      <ContextDeletionPopup controller={deletion} />
      <TopicRemovalPopup controller={topicRemoval} />
    </ProjectSaveGuardShell>
  );
  return (
    <ContextDeletionProvider value={deletion.execute}>
      <TopicRemovalProvider value={topicRemoval.execute}>
        <NativeTopicPopupProvider value={(!!visibleRun && !viewErrors[visibleRun]) || page === "terminal"}>
          {content}
        </NativeTopicPopupProvider>
      </TopicRemovalProvider>
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

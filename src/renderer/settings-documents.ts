import {
  documentSaveErrorMessage,
  preparationErrorMessage,
} from "./preparation-error";
import type { SettingsConflict } from "./project-settings-save";
import type { ProjectSettings, ProjectSettingsView } from "../shared/types";
import type { TopicContextRef } from "../shared/worktrees";
import type { ScopeRef } from "../shared/context";
import { contextRef, contextRequestKey } from "./topic-context";
import { readRequest } from "./read-request";
import {
  isDeletableDocument,
  type DeletionTicket,
} from "../shared/document-deletion";
import type { SettingsFile, SettingsKind } from "../shared/bridge";
import {
  renamedProjectDocumentTarget,
  isProjectWorkflowName,
  isProjectProfileName,
  projectWorkflowAliasKey,
  isProjectPipelineName,
  isProjectToolName,
  isProjectToolPath,
  projectPipelineAliasKey,
} from "../shared/project-documents";
import type {
  ProjectWorkflow,
  ProjectTool,
  ProjectDocument,
  ProjectDocumentTarget,
} from "../shared/project-documents";
export type DocumentSource =
  | { scope: "home"; kind: SettingsKind; name?: string }
  | {
      scope: "project";
      projectId: string;
      context?: TopicContextRef;
      target: ProjectDocumentTarget;
    };
export const documentScopeId = (scope: ScopeRef) =>
  typeof scope === "string" ? scope : contextRequestKey(scope);
export const documentKey = (source: DocumentSource) =>
  JSON.stringify(
    source.scope === "home"
      ? ["home", source.kind, source.name ?? ""]
      : [
          "project",
          documentScopeId(source.context ?? source.projectId),
          source.target.kind,
          source.target.kind === "tool"
            ? source.target.tool
            : source.target.kind === "workflow" ||
                source.target.kind === "pipeline" ||
                source.target.kind === "profile"
              ? source.target.name
              : "",
          source.target.kind === "tool" || source.target.kind === "dockerfile"
            ? source.target.path
            : source.target.kind === "workflow" ||
                source.target.kind === "pipeline" ||
                source.target.kind === "profile"
              ? `.goga/${source.target.kind}s/${source.target.name}.yml`
              : "",
        ],
  );
// App-owned, memory-only registry form drafts. The registry itself is shared by
// projectId, but each exact file-validation scope owns its draft and base version.
export interface RegistrySettingsDraft {
  conflict?: SettingsConflict;
  doc: ProjectSettingsView | null;
  value: ProjectSettings | null;
  timeoutDraft: string;
  inputErrors: Record<number, string>;
  error: string;
  notice: string;
  saving: boolean;
}
const emptyRegistryDraft: RegistrySettingsDraft = {
  doc: null,
  value: null,
  timeoutDraft: "",
  inputErrors: {},
  error: "",
  notice: "",
  saving: false,
};
export interface DocumentDeletion {
  ticket: DeletionTicket;
  memoryOnly: boolean;
}
export interface DocumentDraft {
  /** Actual successful project write time; UI confirmation must not replay on reveal. */
  savedAt?: number;
  memoryOnly?: boolean;
  preparing?: boolean;
  deleting?: boolean;
  renaming?: boolean;
  deletion?: DocumentDeletion;
  document?: SettingsFile & Partial<ProjectDocument>;
  text: string;
  busy: boolean;
  saving?: boolean;
  reloading?: boolean;
  reloadError?: string;
  error: string;
  notice: string;
}
export interface WorkflowSelection {
  creating: boolean;
  name: string;
  selected: string;
  drafts: string[];
}
const emptyWorkflow: WorkflowSelection = {
  creating: false,
  name: "",
  selected: "",
  drafts: [],
};
const empty: DocumentDraft = { text: "", busy: false, error: "", notice: "" };
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
// Owned by App: raw documents survive every settings navigation, never persisted
// implicitly. Operation results are keyed to the captured source, not the selection.
export function createSettingsDocuments() {
  const entries = new Map<string, DocumentDraft>();
  const sources = new Map<string, DocumentSource>();
  // Opaque, session-only buffer identity. Closing/reopening a source with the
  // same filename must not redirect a stale Home shortcut to its replacement.
  let sequence = 0;
  const instances = new Map<string, { serial: number }>();
  const selectedTools = new Map<string, string>();
  function trackSource(source: DocumentSource) {
    const key = documentKey(source);
    sources.set(key, source);
    if (source.scope === "project" && !instances.has(key))
      instances.set(key, { serial: ++sequence });
  }
  const loads = new Map<string, Promise<SettingsFile>>();
  const dockerfiles = new Map<
    string,
    import("../shared/project-documents").ProjectDockerfile
  >();
  const registryDrafts = new Map<string, RegistrySettingsDraft>();
  function writeActivity(): "idle" | "project-save" | "other" {
    let activity: "idle" | "project-save" = "idle";
    for (const [key, draft] of entries) {
      if (draft.deleting || draft.renaming) return "other";
      if (!draft.saving) continue;
      if (sources.get(key)?.scope !== "project") return "other";
      activity = "project-save";
    }
    for (const draft of registryDrafts.values())
      if (draft.saving) return "other";
    return activity;
  }
  const listeners = new Set<() => void>();
  const selections = new Map<string, WorkflowSelection>();
  const revisions = new Map<string, { value: number; lastNonSave: number }>();
  function advanceRevision(id: string, reason: "save" | "other") {
    const previous = revisions.get(id);
    const value = (previous?.value ?? 0) + 1;
    revisions.set(id, {
      value,
      lastNonSave: reason === "other" ? value : (previous?.lastNonSave ?? 0),
    });
  }
  const toolSelections = new Map<string, WorkflowSelection>();
  const toolSelectionKey = (scope: ScopeRef, tool: string) =>
    JSON.stringify([documentScopeId(scope), tool]);
  const toolState = (scope: ScopeRef, tool: string) =>
    toolSelections.get(toolSelectionKey(scope, tool)) ?? emptyWorkflow;
  function updateTool(
    scope: ScopeRef,
    tool: string,
    patch: Partial<WorkflowSelection>,
  ) {
    toolSelections.set(toolSelectionKey(scope, tool), {
      ...toolState(scope, tool),
      ...patch,
    });
    listeners.forEach((fn) => fn());
  }
  let homeRevision = 0;
  let removalRevision = 0;
  const removed = new Map<string, number>();
  function invalidate(
    source: DocumentSource,
    reason: "save" | "other" = "other",
  ) {
    if (source.scope === "home") homeRevision++;
    else
      advanceRevision(
        documentScopeId(source.context ?? source.projectId),
        reason,
      );
  }
  function remove(source: DocumentSource) {
    removalRevision++;
    entries.delete(documentKey(source));
    instances.delete(documentKey(source));
    sources.delete(documentKey(source));
    removed.set(documentKey(source), removalRevision);
    if (source.scope === "project" && source.target.kind === "tool") {
      const scope = source.context ?? source.projectId;
      const { tool, path } = source.target;
      const state = toolState(scope, tool);
      toolSelections.set(toolSelectionKey(scope, tool), {
        ...state,
        drafts: state.drafts.filter((item) => item !== path),
        selected: state.selected === path ? "" : state.selected,
      });
    }
    if (
      source.scope === "project" &&
      (source.target.kind === "workflow" ||
        source.target.kind === "pipeline" ||
        source.target.kind === "profile")
    ) {
      const name = source.target.name;
      const state = flatState(
        source.context ?? source.projectId,
        source.target.kind,
      );
      selections.set(
        JSON.stringify([
          documentScopeId(source.context ?? source.projectId),
          source.target.kind,
        ]),
        {
          ...state,
          drafts: state.drafts.filter((item) => item !== name),
          selected: state.selected === source.target.name ? "" : state.selected,
        },
      );
    }
  }
  type FlatKind = "workflow" | "pipeline" | "profile";
  const flatState = (projectId: ScopeRef, kind: FlatKind) =>
    selections.get(JSON.stringify([documentScopeId(projectId), kind])) ??
    emptyWorkflow;
  function updateFlat(
    projectId: ScopeRef,
    kind: FlatKind,
    patch: Partial<WorkflowSelection>,
  ) {
    selections.set(JSON.stringify([documentScopeId(projectId), kind]), {
      ...flatState(projectId, kind),
      ...patch,
    });
    listeners.forEach((fn) => fn());
  }
  const workflowState = (projectId: ScopeRef) =>
    flatState(projectId, "workflow");
  const pipelineState = (projectId: ScopeRef) =>
    flatState(projectId, "pipeline");
  const updateWorkflow = (
    projectId: ScopeRef,
    patch: Partial<WorkflowSelection>,
  ) => updateFlat(projectId, "workflow", patch);
  const updatePipeline = (
    projectId: ScopeRef,
    patch: Partial<WorkflowSelection>,
  ) => updateFlat(projectId, "pipeline", patch);
  const get = (source: DocumentSource) =>
    entries.get(documentKey(source)) ?? empty;
  function put(source: DocumentSource, value: DocumentDraft) {
    trackSource(source);
    removed.delete(documentKey(source));
    entries.set(documentKey(source), value);
    if (
      source.scope === "project" &&
      (source.target.kind === "workflow" ||
        source.target.kind === "pipeline" ||
        source.target.kind === "profile")
    ) {
      const state = flatState(
        source.context ?? source.projectId,
        source.target.kind,
      );
      if (!state.drafts.includes(source.target.name))
        selections.set(
          JSON.stringify([
            documentScopeId(source.context ?? source.projectId),
            source.target.kind,
          ]),
          {
            ...state,
            drafts: [...state.drafts, source.target.name],
          },
        );
    }
    listeners.forEach((fn) => fn());
  }
  // Initial open and explicit reload use the same scoped read. Only the exact
  // pending entry can adopt its result; a new edit or a checkout supersedes it.
  async function readIntoEditor(source: DocumentSource, before: DocumentDraft) {
    const key = documentKey(source);
    const reloading = !!before.document;
    const pending = {
      ...before,
      busy: true,
      reloading,
      deletion: undefined,
      error: "",
      reloadError: undefined,
      notice: "",
    };
    put(source, pending);
    let loading: Promise<NonNullable<DocumentDraft["document"]>> | undefined;
    try {
      loading =
        source.scope === "home"
          ? readRequest("readSettings", source.kind, source.name)
          : readRequest(
              "readProjectDocument",
              source.context ? contextRef(source.context) : source.projectId,
              source.target,
            );
      loads.set(key, loading);
      const document = await loading;
      if (get(source) !== pending) return;
      if (
        reloading &&
        before.document?.exists !== false &&
        document.exists === false
      )
        throw new Error("Файла больше нет на диске.");
      put(source, {
        document,
        text: document.text,
        busy: false,
        error: "",
        notice: "",
      });
    } catch (e) {
      if (get(source) === pending) {
        const reason = preparationErrorMessage(e);
        put(source, {
          ...before,
          busy: false,
          reloading: false,
          deletion: undefined,
          ...(reloading
            ? {
                reloadError: `Не удалось обновить файл. ${reason} Текст в редакторе не изменён.`,
              }
            : { error: reason }),
        });
      }
    } finally {
      if (loads.get(key) === loading) loads.delete(key);
    }
  }
  function createFlat(
    kind: FlatKind,
    projectId: ScopeRef,
    name: string,
    catalog: ProjectWorkflow[],
  ) {
    const validName =
      kind === "profile"
        ? isProjectProfileName
        : kind === "pipeline"
          ? isProjectPipelineName
          : isProjectWorkflowName;
    const aliasKey =
      kind === "pipeline" ? projectPipelineAliasKey : projectWorkflowAliasKey;
    if (!validName(name))
      throw new Error(
        `Недопустимое имя ${kind === "profile" ? "профиля" : kind === "pipeline" ? "конвейера" : "рабочего процесса"}. Укажите имя без расширения, пробелов и разделителей пути.`,
      );
    const state = flatState(projectId, kind);
    const existingNames = [...entries.keys()]
      .map((key) => JSON.parse(key) as string[])
      .filter(
        (parts) =>
          parts[0] === "project" &&
          parts[1] === documentScopeId(projectId) &&
          parts[2] === kind,
      )
      .map((parts) => parts[3]);
    const alias = aliasKey(`${name}.yml`);
    const filenames = [
      ...catalog.map((item) => item.path.split("/").pop()!),
      ...state.drafts.map((item) => `${item}.yml`),
      ...existingNames.map((item) => `${item}.yml`),
    ];
    if (filenames.some((filename) => aliasKey(filename) === alias))
      throw new Error(
        `${kind === "profile" ? "Профиль" : kind === "pipeline" ? "Конвейер" : "Рабочий процесс"} с таким именем или эквивалентным написанием уже существует.`,
      );
    const source: DocumentSource = {
      scope: "project",
      projectId:
        typeof projectId === "string" ? projectId : projectId.projectId,
      ...(typeof projectId === "string"
        ? {}
        : { context: contextRef(projectId) }),
      target: { kind, name },
    };
    // Never read or write a file while creating an explicit in-memory draft.
    trackSource(source);
    removed.delete(documentKey(source));
    entries.set(documentKey(source), {
      ...empty,
      memoryOnly: true,
      document: {
        text: "",
        exists: false,
        version: "missing",
        relativePath: `.goga/${kind}s/${name}.yml`,
      },
    });
    updateFlat(projectId, kind, {
      drafts: [...state.drafts, name],
      selected: name,
      creating: false,
      name: "",
    });
  }
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get,
    // An editor belongs to its buffer, not the filename. Retain undo, cursor and
    // expanded state when a rename transfers the same buffer to another key.
    editorIdentity(source: DocumentSource) {
      const key = documentKey(source);
      const instance = instances.get(key);
      return instance ? `buffer:${instance.serial}` : key;
    },
    selectedTool: (scope: ScopeRef) =>
      selectedTools.get(documentScopeId(scope)) ?? "",
    selectTool(scope: ScopeRef, tool: string) {
      const key = documentScopeId(scope);
      if (selectedTools.get(key) === tool) return;
      selectedTools.set(key, tool);
      listeners.forEach((fn) => fn());
    },
    /** Only addresses of dirty project files; never personal settings, raw text,
     * paths inferred from a string key, or registry configuration fields. */
    dirtyProjectDocuments() {
      const result: {
        source: Extract<DocumentSource, { scope: "project" }>;
        instance: object;
        relativePath: string;
        busy: boolean;
      }[] = [];
      for (const [key, source] of sources) {
        if (source.scope !== "project") continue;
        const draft = entries.get(key),
          instance = instances.get(key);
        if (!instance || !draft?.document || draft.text === draft.document.text)
          continue;
        const target = source.target;
        const relativePath =
          draft.document.relativePath ||
          (target.kind === "tool"
            ? `.goga/tools/${target.tool}/${target.path}`
            : target.kind === "config"
              ? ".goga/config.yml"
              : target.kind === "dockerfile"
                ? target.path
                : `.goga/${target.kind}s/${target.name}.yml`);
        result.push({ source, instance, relativePath, busy: draft.busy });
      }
      return result;
    },
    readSessionBuffer(
      source: Extract<DocumentSource, { scope: "project" }>,
      instance: object,
    ) {
      if (instances.get(documentKey(source)) !== instance) return null;
      const draft = get(source);
      return draft.document && draft.text !== draft.document.text
        ? draft.text
        : null;
    },
    revealSessionDocument(
      source: Extract<DocumentSource, { scope: "project" }>,
      instance: object,
    ) {
      if (
        instances.get(documentKey(source)) !== instance ||
        !get(source).document
      )
        return null;
      const target = source.target,
        scope = source.context ?? source.projectId;
      if (target.kind === "tool") {
        selectedTools.set(documentScopeId(scope), target.tool);
        updateTool(scope, target.tool, {
          selected: target.path,
          creating: false,
        });
        return "tools";
      }
      if (target.kind === "config") return "config";
      if (target.kind === "dockerfile") {
        return dockerfiles.get(documentScopeId(scope))?.relativePath ===
          target.path
          ? "image"
          : null;
      }
      updateFlat(scope, target.kind, {
        selected: target.name,
        creating: false,
      });
      return target.kind + "s";
    },
    toolState,
    /** Real in-memory sources only: stale empty form/selection state is not a tool. */
    loadedToolFiles(scope: ScopeRef) {
      const id = documentScopeId(scope);
      return [...sources.values()].flatMap((source) =>
        source.scope === "project" &&
        source.target.kind === "tool" &&
        documentScopeId(source.context ?? source.projectId) === id &&
        !!entries.get(documentKey(source))?.document
          ? [{ tool: source.target.tool, path: source.target.path }]
          : [],
      );
    },
    updateTool,
    createToolFile(
      scope: ScopeRef,
      tool: string,
      path: string,
      catalog: ProjectTool[],
    ) {
      const selected = catalog.find((item) => item.name === tool);
      if (!isProjectToolName(tool) || !selected)
        throw new Error(
          "Выберите существующий инструмент перед созданием файла.",
        );
      if (!isProjectToolPath(path) || !/\.ya?ml$/.test(path))
        throw new Error(
          "Недопустимое имя или путь файла. Укажите файл с расширением .yml или .yaml внутри инструмента.",
        );
      try {
        encodeURIComponent(path);
        if (
          path
            .split("/")
            .some((part) => new TextEncoder().encode(part).length > 255)
        )
          throw new Error();
      } catch {
        throw new Error("Недопустимое имя или путь файла.");
      }
      const parts = path.split("/");
      for (let index = 1; index < parts.length; index++) {
        const parent = selected.entries.find(
          (entry) => entry.path === parts.slice(0, index).join("/"),
        );
        if (!parent || parent.kind !== "directory" || parent.reason)
          throw new Error(
            "Родительская папка отсутствует или недоступна. Выберите существующий безопасный каталог инструмента.",
          );
      }
      const state = toolState(scope, tool);
      const existing = [...entries.keys()]
        .map((key) => JSON.parse(key) as string[])
        .filter(
          (parts) =>
            parts[0] === "project" &&
            parts[1] === documentScopeId(scope) &&
            parts[2] === "tool" &&
            parts[3] === tool,
        )
        .map((parts) => parts[4]);
      const alias = projectWorkflowAliasKey(path);
      if (
        [
          ...selected.entries.map((entry) => entry.path),
          ...state.drafts,
          ...existing,
        ].some((entry) => projectWorkflowAliasKey(entry) === alias)
      )
        throw new Error(
          "Файл или папка с таким именем или эквивалентным написанием уже существует.",
        );
      const source: DocumentSource = {
        scope: "project",
        projectId: typeof scope === "string" ? scope : scope.projectId,
        ...(typeof scope === "string" ? {} : { context: contextRef(scope) }),
        target: { kind: "tool", tool, path },
      };
      // Creation never invokes host reads or writes. Only the existing Save flow
      // can materialize this missing leaf inside an already existing parent.
      trackSource(source);
      removed.delete(documentKey(source));
      entries.set(documentKey(source), {
        ...empty,
        memoryOnly: true,
        document: {
          text: "",
          exists: false,
          version: "missing",
          relativePath: `.goga/tools/${tool}/${path}`,
        },
      });
      updateTool(scope, tool, {
        drafts: [...state.drafts, path],
        selected: path,
        creating: false,
        name: "",
      });
    },
    dockerfile: (scope: ScopeRef) => dockerfiles.get(documentScopeId(scope)),
    selectDockerfile(
      scope: ScopeRef,
      metadata: import("../shared/project-documents").ProjectDockerfile,
    ) {
      dockerfiles.set(documentScopeId(scope), metadata);
      listeners.forEach((fn) => fn());
    },
    registryDraft: (scope: ScopeRef) =>
      registryDrafts.get(documentScopeId(scope)) ?? emptyRegistryDraft,
    updateRegistryDraft(
      scope: ScopeRef,
      update: (draft: RegistrySettingsDraft) => RegistrySettingsDraft,
    ) {
      const key = documentScopeId(scope);
      registryDrafts.set(
        key,
        update(registryDrafts.get(key) ?? emptyRegistryDraft),
      );
      listeners.forEach((fn) => fn());
    },
    projectProfileState: (projectId: ScopeRef) =>
      flatState(projectId, "profile"),
    updateProjectProfile: (
      projectId: ScopeRef,
      patch: Partial<WorkflowSelection>,
    ) => updateFlat(projectId, "profile", patch),
    createProjectProfile: (
      projectId: ScopeRef,
      name: string,
      catalog: ProjectWorkflow[],
    ) => createFlat("profile", projectId, name, catalog),
    workflowState,
    updateWorkflow,
    /** A checkout invalidates disk snapshots, never editor drafts or hidden files. */
    async refreshProject(scope: ScopeRef): Promise<void> {
      const id = documentScopeId(scope);
      advanceRevision(id, "other");
      const reloads: Promise<void>[] = [];
      for (const [key, source] of sources) {
        if (
          source.scope !== "project" ||
          documentScopeId(source.context ?? source.projectId) !== id
        )
          continue;
        const value = entries.get(key);
        if (
          !value ||
          value.memoryOnly ||
          value.saving ||
          value.deleting ||
          value.renaming
        )
          continue;
        if (value.document && value.text !== value.document.text) {
          entries.set(key, {
            ...value,
            // Replacing the entry invalidates a pending deletion preview. Its
            // late reply cannot clear these flags; keep the retained draft editable.
            busy: false,
            reloading: false,
            preparing: false,
            deletion: undefined,
            notice:
              "Файлы проекта могли измениться. Ваш черновик сохранён; перед записью проверяется версия файла.",
          });
          continue;
        }
        const stale = { ...empty, busy: true };
        entries.set(key, stale);
        const pending = loads.get(key);
        reloads.push(
          (async () => {
            // A cancelled logical read can still physically finish: drain it before
            // rereading the same key, and never let its stale response become visible.
            if (pending) await pending.catch(() => {});
            if (entries.get(key) !== stale) return;
            entries.delete(key);
            await this.open(source);
          })(),
        );
      }
      listeners.forEach((fn) => fn());
      await Promise.all(reloads);
    },
    projectRevision: (projectId: ScopeRef) =>
      projectId ? (revisions.get(documentScopeId(projectId))?.value ?? 0) : 0,
    // Only cosmetic: never relax action freshness while a saved document refreshes
    // its lists. A checkout or deletion anywhere since the last successful result
    // keeps the normal disabled appearance even if a later save overlaps it.
    onlyDocumentSavesSince(scope: ScopeRef, revision: number) {
      const latest = revisions.get(documentScopeId(scope));
      return (
        !!latest && latest.value > revision && latest.lastNonSave <= revision
      );
    },
    pipelineState,
    updatePipeline,
    createWorkflow: (
      projectId: ScopeRef,
      name: string,
      catalog: ProjectWorkflow[],
    ) => createFlat("workflow", projectId, name, catalog),
    createPipeline: (
      projectId: ScopeRef,
      name: string,
      catalog: ProjectWorkflow[],
    ) => createFlat("pipeline", projectId, name, catalog),
    writeActivity,
    busy: () => writeActivity() !== "idle",
    homeRevision: () => homeRevision,
    removalRevision: () => removalRevision,
    wasRemovedSince: (source: DocumentSource, revision: number) =>
      (removed.get(documentKey(source)) ?? 0) > revision,
    cancelDeletion(source: DocumentSource) {
      const entry = get(source);
      if (!entry.deleting && (entry.preparing || entry.deletion))
        put(source, {
          ...entry,
          busy: false,
          preparing: false,
          deletion: undefined,
        });
    },
    async prepareDeletion(source: DocumentSource) {
      const before = get(source);
      if (!isDeletableDocument(source) || before.busy || before.deletion)
        return;
      const pending: DocumentDraft = {
        ...before,
        busy: true,
        preparing: true,
        error: "",
        notice: "",
      };
      put(source, pending);
      try {
        const ticket = before.memoryOnly
          ? {
              token: "",
              name:
                source.scope === "home"
                  ? source.name
                  : source.target.kind === "tool"
                    ? source.target.path
                    : `${source.target.name}.yml`,
              relativePath:
                before.document?.relativePath ??
                (source.scope === "home"
                  ? `~/.goga/profiles/${source.name}.yml`
                  : source.target.kind === "tool"
                    ? `.goga/tools/${source.target.tool}/${source.target.path}`
                    : `.goga/${source.target.kind}s/${source.target.name}.yml`),
            }
          : await readRequest(
              "prepareDocumentDeletion",
              source,
              before.document?.version,
            );
        if (get(source) !== pending) return;
        put(source, {
          ...before,
          error: "",
          notice: "",
          deletion: { ticket, memoryOnly: !!before.memoryOnly },
        });
      } catch (error) {
        if (get(source) === pending)
          put(source, { ...before, error: message(error), notice: "" });
      }
    },
    async delete(source: DocumentSource, deletion: DocumentDeletion) {
      const before = get(source);
      if (
        before.busy ||
        before.deletion !== deletion ||
        !isDeletableDocument(source)
      )
        return false;
      if (deletion.memoryOnly) {
        remove(source);
        listeners.forEach((fn) => fn());
        return true;
      }
      const pending: DocumentDraft = {
        ...before,
        busy: true,
        deleting: true,
        error: "",
        notice: "",
      };
      put(source, pending);
      try {
        const result = await window.goga.deleteDocument(deletion.ticket.token);
        if (result.status !== "trashed") throw new Error(result.message);
        if (get(source) === pending) remove(source);
        return true;
      } catch (error) {
        if (get(source) === pending)
          put(source, {
            ...before,
            deletion: undefined,
            busy: false,
            deleting: false,
            error: message(error),
            notice: "",
          });
        return false;
      } finally {
        // Even a bridge rejection can follow a completed host-side operation.
        // Refresh catalogs/previews without treating an uncertain outcome as success.
        invalidate(source);
        listeners.forEach((fn) => fn());
      }
    },
    profiles: () =>
      [...entries.keys()]
        .map((key) => JSON.parse(key) as string[])
        .filter((parts) => parts[0] === "home" && parts[1] === "profile")
        .map((parts) => parts[2]),
    createProfile(name: string) {
      const source: DocumentSource = { scope: "home", kind: "profile", name };
      if (!entries.has(documentKey(source)))
        put(source, {
          ...empty,
          memoryOnly: true,
          text: "{}\n",
          document: {
            text: "{}\n",
            version: "missing",
            exists: false,
            relativePath: `~/.goga/profiles/${name}.yml`,
          },
        });
    },
    edit(source: DocumentSource, text: string) {
      const entry = get(source);
      if (!entry.busy || entry.reloading)
        put(source, {
          ...entry,
          busy: false,
          reloading: false,
          reloadError: undefined,
          text,
          deletion: undefined,
          notice: "",
          savedAt: undefined,
          error: "",
        });
    },
    reset(source: DocumentSource) {
      const entry = get(source);
      if (entry.busy || !entry.document) return;
      put(source, {
        ...entry,
        text: entry.document.text,
        reloadError: undefined,
        deletion: undefined,
        error: "",
        notice: "",
        savedAt: undefined,
      });
    },
    discard(source: DocumentSource) {
      if (!get(source).busy) {
        instances.delete(documentKey(source));
        if (get(source).memoryOnly)
          entries.set(documentKey(source), { ...empty, memoryOnly: true });
        else entries.delete(documentKey(source));
        listeners.forEach((fn) => fn());
      }
    },
    async open(source: DocumentSource) {
      const before = get(source);
      if (before.busy || before.document) return;
      if (before.memoryOnly) {
        const text = source.scope === "home" ? "{}\n" : "";
        put(source, {
          ...empty,
          memoryOnly: true,
          text,
          document: { text, version: "missing", exists: false },
        });
        return;
      }
      await readIntoEditor(source, before);
    },
    async rename(source: DocumentSource, newName: string) {
      const before = get(source);
      if (
        source.scope !== "project" ||
        !isDeletableDocument(source) ||
        !before.document?.exists ||
        before.memoryOnly ||
        before.busy ||
        before.deletion
      )
        throw Error("Файл сейчас недоступен для переименования.");
      const target = renamedProjectDocumentTarget(source.target, newName);
      const dest = { ...source, target };
      const key = documentKey(source),
        destKey = documentKey(dest);
      const scope = source.context ?? source.projectId;
      // The host checks the disk, but cannot see another unsaved editor.
      // Reserve the exact destination so a concurrent open/create cannot adopt this result.
      const identity = (k: string) => {
        const [space, owner, kind, name, path] = JSON.parse(k) as string[];
        return JSON.stringify([
          space,
          owner,
          kind,
          kind === "tool" ? name : "",
          projectWorkflowAliasKey(path ?? ""),
        ]);
      };
      const alias = identity(destKey);
      if (
        key === destKey ||
        [...entries.keys()].some((k) => k !== key && identity(k) === alias)
      )
        throw Error("Имя уже используется открытым файлом или черновиком.");
      const reserved: DocumentDraft = { ...empty, busy: true };
      const pending = { ...before, busy: true, renaming: true };
      entries.set(destKey, reserved);
      put(source, pending);
      try {
        const document = await window.goga.renameProjectDocument(
          scope,
          source.target,
          newName,
          before.document.version,
        );
        if (get(source) !== pending || get(dest) !== reserved)
          throw Error(
            "Документ в редакторе уже изменился. Проверьте имена файлов в каталоге.",
          );
        const oldName =
          source.target.kind === "tool"
            ? source.target.path
            : source.target.name;
        const nextName = target.kind === "tool" ? target.path : target.name;
        const moveSelection = (s: WorkflowSelection): WorkflowSelection => ({
          ...s,
          selected: s.selected === oldName ? nextName : s.selected,
          drafts: [
            ...new Set([...s.drafts.filter((n) => n !== oldName), nextName]),
          ],
        });
        // remove retires shortcuts to the old filename. Publish selection and the
        // new baseline together, leaving a dirty buffer dirty under its new key.
        const selected = moveSelection(
          target.kind === "tool"
            ? toolState(scope, target.tool)
            : flatState(scope, target.kind),
        );
        const instance = instances.get(key);
        remove(source);
        if (instance) instances.set(destKey, instance);
        if (target.kind === "tool")
          toolSelections.set(toolSelectionKey(scope, target.tool), selected);
        else
          selections.set(
            JSON.stringify([documentScopeId(scope), target.kind]),
            selected,
          );
        put(dest, {
          ...empty,
          document,
          text:
            before.text === before.document.text ? document.text : before.text,
        });
      } catch (error) {
        if (get(source) === pending) put(source, before);
        throw Error(preparationErrorMessage(error));
      } finally {
        if (entries.get(destKey) === reserved) entries.delete(destKey);
        invalidate(source);
        listeners.forEach((fn) => fn());
      }
    },
    async reload(source: DocumentSource, confirmed?: DocumentDraft) {
      const before = get(source);
      if (
        source.scope !== "project" ||
        !before.document ||
        before.memoryOnly ||
        before.busy ||
        before.deletion ||
        (confirmed !== undefined && confirmed !== before) ||
        (before.text !== before.document.text && confirmed !== before)
      )
        return;
      await readIntoEditor(source, before);
    },
    async save(source: DocumentSource) {
      const before = get(source);
      if (before.busy || !before.document) return false;
      const pending = {
        ...before,
        deletion: undefined,
        busy: true,
        saving: true,
        error: "",
        notice: "",
        savedAt: undefined,
      };
      put(source, pending);
      try {
        const document =
          source.scope === "home"
            ? await window.goga.saveSettings(
                source.kind,
                source.name,
                before.text,
                before.document.version,
              )
            : await window.goga.saveProjectDocument(
                source.context ? contextRef(source.context) : source.projectId,
                source.target,
                before.text,
                before.document.version,
              );
        if (get(source) !== pending) return false;
        if (source.scope === "project") invalidate(source, "save");
        put(source, {
          document,
          text: document.text,
          busy: false,
          error: "",
          notice:
            source.scope === "project"
              ? "Сохранено"
              : "Сохранено. Изменения применятся к следующим запускам.",
          ...(source.scope === "project" ? { savedAt: Date.now() } : {}),
        });
        return true;
      } catch (e) {
        if (get(source) === pending)
          put(source, {
            ...before,
            deletion: undefined,
            busy: false,
            reloadError: undefined,
            error: documentSaveErrorMessage(e),
            notice: "",
            savedAt: undefined,
          });
        return false;
      }
    },
  };
}
export type SettingsDocuments = ReturnType<typeof createSettingsDocuments>;

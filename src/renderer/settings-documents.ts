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
  isProjectWorkflowName,
  isProjectProfileName,
  projectWorkflowAliasKey,
  isProjectPipelineName,
  projectPipelineAliasKey,
} from "../shared/project-documents";
import type {
  ProjectWorkflow,
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
          source.target.kind === "tool"
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
  memoryOnly?: boolean;
  preparing?: boolean;
  deleting?: boolean;
  deletion?: DocumentDeletion;
  document?: SettingsFile & Partial<ProjectDocument>;
  text: string;
  busy: boolean;
  saving?: boolean;
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
  const registryDrafts = new Map<string, RegistrySettingsDraft>();
  const listeners = new Set<() => void>();
  const selections = new Map<string, WorkflowSelection>();
  const revisions = new Map<string, number>();
  let homeRevision = 0;
  let removalRevision = 0;
  const removed = new Map<string, number>();
  function invalidate(source: DocumentSource) {
    if (source.scope === "home") homeRevision++;
    else
      revisions.set(
        documentScopeId(source.context ?? source.projectId),
        (revisions.get(documentScopeId(source.context ?? source.projectId)) ??
          0) + 1,
      );
  }
  function remove(source: DocumentSource) {
    removalRevision++;
    entries.delete(documentKey(source));
    removed.set(documentKey(source), removalRevision);
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
    projectRevision: (projectId: ScopeRef) =>
      projectId ? (revisions.get(documentScopeId(projectId)) ?? 0) : 0,
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
    busy: () =>
      [...entries.values()].some((entry) => entry.saving || entry.deleting) ||
      [...registryDrafts.values()].some((entry) => entry.saving),
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
      if (!entry.busy)
        put(source, {
          ...entry,
          text,
          deletion: undefined,
          notice: "",
          error: "",
        });
    },
    discard(source: DocumentSource) {
      if (!get(source).busy) {
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
      const pending = {
        ...before,
        busy: true,
        deletion: undefined,
        error: "",
        notice: "",
      };
      put(source, pending);
      try {
        const document =
          source.scope === "home"
            ? await readRequest("readSettings", source.kind, source.name)
            : await readRequest(
                "readProjectDocument",
                source.context ? contextRef(source.context) : source.projectId,
                source.target,
              );
        if (get(source) !== pending) return;
        put(source, {
          document,
          text: document.text,
          busy: false,
          error: "",
          notice: "",
        });
      } catch (e) {
        if (get(source) === pending)
          put(source, {
            ...before,
            busy: false,
            deletion: undefined,
            error: message(e),
          });
      }
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
        if (source.scope === "project") invalidate(source);
        put(source, {
          document,
          text: document.text,
          busy: false,
          error: "",
          notice: "Сохранено. Изменения применятся к следующим запускам.",
        });
        return true;
      } catch (e) {
        if (get(source) === pending)
          put(source, {
            ...before,
            deletion: undefined,
            busy: false,
            error: message(e),
            notice: "",
          });
        return false;
      }
    },
  };
}
export type SettingsDocuments = ReturnType<typeof createSettingsDocuments>;

import {
  gitDiscardRequestSchema,
  gitDiscardTokenSchema,
} from "../shared/git-discard";
import {
  gitUpdateHandoffRequestSchema,
  gitUpdateHandoffTokenSchema,
} from "../shared/git-update-handoff";
import {
  gitSequencerOperationRequestSchema,
  gitSequencerOperationTokenSchema,
} from "../shared/git-sequencer-operations";
import {
  gitRebaseOperationRequestSchema,
  gitRebaseOperationTokenSchema,
} from "../shared/git-rebase-operations";
import {
  gitMergeOperationRequestSchema,
  gitMergeOperationTokenSchema,
} from "../shared/git-operations";
import {
  gitConflictSaveRequestSchema,
  gitConflictSaveTokenSchema,
} from "../shared/git-conflict-save";
import { gitConflictReadRequestSchema } from "../shared/git-conflicts";
import {
  gitBranchProjectSchema,
  gitBranchRequestSchema,
  gitBranchTokenSchema,
} from "../shared/git-branches";
import { gitDiffRequestSchema } from "../shared/git-workspace";
import {
  gitCommitRequestSchema,
  gitCommitTokenSchema,
} from "../shared/git-commit";
import {
  historyYearSchema,
  historyEntrySchema,
  historyPathSchema,
} from "../shared/history";
import {
  topicPopupBoundsSchema,
  topicPopupIdSchema,
  type TopicPopupBounds,
} from "../shared/topic-popup";
import { IPC_SCOPES } from "../shared/operation-scopes";
import { repositoryActionRequestSchema } from "../shared/repository-actions";
import { scopeRefSchema } from "../shared/context";
import {
  topicContextIdentitySchema,
  topicContextReadinessSchema,
  topicContextRefSchema,
} from "../shared/worktrees";
import {
  READ_BUDGETS,
  readChannel,
  readTimeoutMessage,
  readCancelledMessage,
  type ReadMethod,
} from "../shared/read-deadlines";
import { withReadScope } from "../host/read-scope";
import { buildRequestSchema, buildSelectionSchema } from "../shared/build";
import {
  topicYearSchema,
  topicTargetSchema,
  topicOperationSchema,
  topicTokenSchema,
} from "../shared/topics-schema";
import { isStartupTimeoutMinutes } from "../shared/startup-timeout";
import {
  isDeletableDocument,
  isDeletionToken,
  isDeletionVersion,
  type DeletableDocument,
} from "../shared/document-deletion";
import {
  isProjectToolName,
  isProjectWorkflowName,
  isProjectPipelineName,
  isProjectProfileName,
  isProjectDockerfilePath,
  isProjectToolPath,
} from "../shared/project-documents";
import type { Run } from "../shared/types";
import type { IpcMain, BrowserWindow, IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import type { HostService } from "../host/service";
import type { SettingsStore } from "../host/settings";
import { validShellSender } from "./security";
const id = z.string().min(1).max(256);
const documentTarget = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("dockerfile"),
      path: z.string().refine(isProjectDockerfilePath),
    })
    .strict(),
  z
    .object({
      kind: z.literal("profile"),
      name: z.string().refine(isProjectProfileName),
    })
    .strict(),
  z.object({ kind: z.literal("config") }).strict(),
  z
    .object({
      kind: z.literal("pipeline"),
      name: z.string().refine(isProjectPipelineName),
    })
    .strict(),
  z
    .object({
      kind: z.literal("workflow"),
      name: z.string().refine(isProjectWorkflowName),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tool"),
      tool: z.string().refine(isProjectToolName),
      path: z.string().refine(isProjectToolPath),
    })
    .strict(),
]);
const documentText = z
  .string()
  .max(1024 * 1024)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 1024 * 1024);
const pipeline = z
  .object({
    projectId: id,
    context: topicContextRefSchema.optional(),
    pipeline: id,
    workflow: id,
    profile: z.string().max(180),
    profileMode: z.enum(["project", "auto"]).optional(),
    skips: z.array(id).max(1000),
  })
  .strict();
const taskReader = z
  .object({
    projectId: id,
    context: topicContextRefSchema.optional(),
    branch: id.refine(
      (value) => !value.startsWith("-") && !/[\x00-\x20]/.test(value),
    ),
    topic: z
      .string()
      .max(180)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  })
  .strict();
const launch = pipeline
  .extend({
    clean: z.boolean(),
    update: z.boolean().optional(),
    expectedBranch: z.string().max(256),
    confirmBranchSwitch: z.boolean(),
    previewToken: id,
    task: z.string().max(100000),
    taskVersion: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    confirmEmptyTask: z.boolean(),
    topic: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("existing"), branch: id, topic: id }).strict(),
      z.object({ mode: z.literal("new"), name: id, baseRef: id }).strict(),
    ]),
  })
  .refine(
    (value) =>
      value.topic.mode === "existing"
        ? value.taskVersion !== undefined
        : value.taskVersion === undefined,
    {
      message: "Версия задачи обязательна только для существующего топика",
      path: ["taskVersion"],
    },
  );
interface Dependencies {
  topicPopup?: {
    setBounds(id: string, bounds: TopicPopupBounds): void;
    close(id: string): void;
  };
  service: HostService;
  settings: SettingsStore;
  window: BrowserWindow;
  shellURL: string;
  choose: () => Promise<string | null>;
  select: (id: string | null) => void;
  confirmClose: (run: Run) => Promise<boolean>;
  stop: (id: string) => Promise<void>;
}
export function registerIPC(ipc: Pick<IpcMain, "handle">, d: Dependencies) {
  const readHandlers = new Map<string, (...args: any[]) => unknown>();
  function handle(name: string, fn: (...args: any[]) => unknown) {
    if (!Object.hasOwn(IPC_SCOPES, name))
      throw Error("IPC operation has no explicit scope classification");
    readHandlers.set(name, fn);
    ipc.handle(
      `goga:${name}`,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        if (
          !validShellSender(
            event.sender.id,
            d.window.webContents.id,
            event.senderFrame?.url ?? "",
            d.shellURL,
            event.senderFrame?.parent === null,
          )
        )
          throw new Error("IPC: доступ запрещён");
        return fn(...args);
      },
    );
  }
  handle("set-topic-popup-bounds", (id, bounds) => {
    const popupId = topicPopupIdSchema.parse(id);
    const parsedBounds = topicPopupBoundsSchema.parse(bounds);
    d.topicPopup?.setBounds(popupId, parsedBounds);
  });
  handle("close-topic-popup", (id) => {
    const popupId = topicPopupIdSchema.parse(id);
    d.topicPopup?.close(popupId);
  });
  handle("prepare-build-repeat", (runId) =>
    d.service.prepareBuildRepeat(id.parse(runId)),
  );
  handle("reconcile-run", (runId) => d.service.reconcileRun(id.parse(runId)));
  const reads = new Map<string, { controller: AbortController }>();
  const requestId = z.string().regex(/^[a-zA-Z0-9-]{1,80}$/);
  handle("cancel-read", (value) => {
    const request = reads.get(requestId.parse(value));
    request?.controller.abort();
  });
  handle("read-request", (value, rawMethod, rawArgs) => {
    const id = requestId.parse(value);
    const method = z
      .string()
      .refine((v) => Object.hasOwn(READ_BUDGETS, v))
      .parse(rawMethod) as ReadMethod;
    const args = z.array(z.unknown()).max(8).parse(rawArgs);
    const handler = readHandlers.get(readChannel(method));
    if (!handler || reads.has(id) || reads.size >= 64)
      throw Error(
        "Чтение временно недоступно: дождитесь завершения предыдущих запросов.",
      );
    const controller = new AbortController();
    reads.set(id, { controller });
    const budget = READ_BUDGETS[method];
    let abort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(Error(readCancelledMessage));
      controller.signal.addEventListener("abort", abort, { once: true });
    });
    const timer = setTimeout(() => controller.abort(), budget);
    const physical = Promise.resolve().then(() =>
      withReadScope(controller.signal, () => {
        if (controller.signal.aborted) throw Error(readCancelledMessage);
        return handler(...args);
      }),
    );
    // Keep physically blocked filesystem work counted even after the UI deadline.
    void physical.then(
      () => reads.delete(id),
      () => reads.delete(id),
    );
    return Promise.race([physical, aborted])
      .catch((error) => {
        if (controller.signal.aborted) throw Error(readTimeoutMessage(budget));
        throw error;
      })
      .finally(() => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", abort);
      });
  });
  d.window.webContents.once?.("destroyed", () => {
    for (const request of reads.values()) request.controller.abort();
  });
  handle("ensure-topic-context", (identity) =>
    d.service.ensureTopicContext(topicContextIdentitySchema.parse(identity)),
  );
  handle("resolve-topic-context", (ref) =>
    d.service.resolveTopicContext(topicContextRefSchema.parse(ref)),
  );
  handle("check-topic-context-readiness", (ref) =>
    d.service.checkTopicContextReadiness(
      topicContextReadinessSchema.parse(ref),
    ),
  );
  handle("list-topic-contexts", (projectId) =>
    d.service.listTopicContexts(id.parse(projectId)),
  );
  handle("create-topic-context", (input) =>
    d.service.createTopicContext(
      z
        .object({
          projectId: id,
          year: z.string().regex(/^\d{4}$/),
          branch: topicContextIdentitySchema.shape.branch,
          baseRef: topicContextIdentitySchema.shape.branch,
        })
        .strict()
        .parse(input),
    ),
  );
  handle("migrate-topic-context", (input) =>
    d.service.migrateTopicContext(topicContextIdentitySchema.parse(input)),
  );
  handle("select-topic-context", (ref) =>
    d.service.selectTopicContext(topicContextRefSchema.nullable().parse(ref)),
  );
  handle("read-git-branches", (projectId) =>
    d.service.readGitBranches(gitBranchProjectSchema.parse(projectId)),
  );
  handle("prepare-git-branch", (request) =>
    d.service.prepareGitBranch(gitBranchRequestSchema.parse(request)),
  );
  handle("execute-git-branch", (token) =>
    d.service.executeGitBranch(gitBranchTokenSchema.parse(token)),
  );
  handle("read-git-summary", (scope) =>
    d.service.readGitSummary(scopeRefSchema.parse(scope)),
  );
  handle("read-git-workspace", (scope) =>
    d.service.readGitWorkspace(scopeRefSchema.parse(scope)),
  );
  handle("read-git-conflict", (request: unknown) =>
    d.service.readGitConflict(gitConflictReadRequestSchema.parse(request)),
  );
  handle("read-git-diff", (request) =>
    d.service.readGitDiff(gitDiffRequestSchema.parse(request)),
  );
  handle("prepare-git-conflict-save", (request) =>
    d.service.prepareGitConflictSave(
      gitConflictSaveRequestSchema.parse(request),
    ),
  );
  handle("execute-git-conflict-save", (token) =>
    d.service.executeGitConflictSave(gitConflictSaveTokenSchema.parse(token)),
  );
  handle("prepare-git-rebase-operation", (request) =>
    d.service.prepareGitRebaseOperation(
      gitRebaseOperationRequestSchema.parse(request),
    ),
  );
  handle("execute-git-rebase-operation", (token) =>
    d.service.executeGitRebaseOperation(
      gitRebaseOperationTokenSchema.parse(token),
    ),
  );
  handle("prepare-git-update-handoff", (request) =>
    d.service.prepareGitUpdateHandoff(
      gitUpdateHandoffRequestSchema.parse(request),
    ),
  );
  handle("execute-git-update-handoff", (token) =>
    d.service.executeGitUpdateHandoff(gitUpdateHandoffTokenSchema.parse(token)),
  );
  handle("prepare-git-sequencer-operation", (request) =>
    d.service.prepareGitSequencerOperation(
      gitSequencerOperationRequestSchema.parse(request),
    ),
  );
  handle("execute-git-sequencer-operation", (token) =>
    d.service.executeGitSequencerOperation(
      gitSequencerOperationTokenSchema.parse(token),
    ),
  );
  handle("prepare-git-merge-operation", (request) =>
    d.service.prepareGitMergeOperation(
      gitMergeOperationRequestSchema.parse(request),
    ),
  );
  handle("execute-git-merge-operation", (token) =>
    d.service.executeGitMergeOperation(
      gitMergeOperationTokenSchema.parse(token),
    ),
  );
  handle("prepare-git-discard", (request) =>
    d.service.prepareGitDiscard(gitDiscardRequestSchema.parse(request)),
  );
  handle("execute-git-discard", (token) =>
    d.service.executeGitDiscard(gitDiscardTokenSchema.parse(token)),
  );
  handle("prepare-git-commit", (request) =>
    d.service.prepareGitCommit(gitCommitRequestSchema.parse(request)),
  );
  handle("execute-git-commit", (token) =>
    d.service.executeGitCommit(gitCommitTokenSchema.parse(token)),
  );
  handle("run-repository-action", (request) =>
    d.service.runRepositoryAction(repositoryActionRequestSchema.parse(request)),
  );
  handle("sync-topic-context", (ref) =>
    d.service.syncTopicContext(topicContextRefSchema.parse(ref)),
  );
  handle("topic-sync-status", (ref) =>
    d.service.topicSyncStatus(topicContextRefSchema.parse(ref)),
  );
  handle("retry-context-sync", (ref) =>
    d.service.retryContextSync(topicContextRefSchema.parse(ref)),
  );
  handle("prepare-context-apply", (ref) =>
    d.service.prepareContextApply(topicContextRefSchema.parse(ref)),
  );
  handle("apply-context", (input) =>
    d.service.applyContext(
      z
        .object({
          projectId: id,
          token: z.string().uuid(),
          confirmed: z.literal(true),
        })
        .strict()
        .parse(input),
    ),
  );
  handle("context-deletion-recovery", (ref) =>
    d.service.contextDeletionRecovery(topicContextRefSchema.parse(ref)),
  );
  handle("prepare-context-deletion", (ref, branch) => {
    const owner = topicContextRefSchema.parse(ref);
    const selected = z.string().min(1).max(1024).optional().parse(branch);
    return selected === undefined
      ? d.service.prepareContextDeletion(owner)
      : d.service.prepareContextDeletion(owner, selected);
  });
  handle("delete-context", (input) =>
    d.service.deleteContext(
      z
        .object({
          projectId: id,
          token: z.string().uuid(),
          allowAhead: z.literal(true).optional(),
        })
        .strict()
        .parse(input),
    ),
  );
  handle("finish-context-deletion", (input) =>
    d.service.finishContextDeletion(
      z
        .object({ projectId: id, token: z.string().uuid() })
        .strict()
        .parse(input),
    ),
  );
  const buildPath = z
    .string()
    .max(4096)
    .refine((v) => !/[\x00-\x1f\x7f]/.test(v));
  handle("build-context", (projectId, selection) => {
    const result = buildSelectionSchema.optional().safeParse(selection);
    if (!result.success) throw new Error("Некорректный выбор сборки");
    return d.service.buildContext(scopeRefSchema.parse(projectId), result.data);
  });
  handle("list-build-files", (projectId, directory) =>
    d.service.listBuildFiles(
      scopeRefSchema.parse(projectId),
      buildPath.parse(directory),
    ),
  );
  handle("read-build-plan", (projectId, path) =>
    d.service.readBuildPlan(
      scopeRefSchema.parse(projectId),
      buildPath.min(1).parse(path),
    ),
  );
  handle("launch-build", (request) => {
    const result = buildRequestSchema.safeParse(request);
    if (!result.success) throw new Error("Некорректный запрос сборки");
    return d.service.launchBuild(result.data);
  });
  handle("repeat-build", (runId, confirmClean) =>
    d.service.repeatBuild(id.parse(runId), z.boolean().parse(confirmClean)),
  );
  handle("prepare-history-prune", (projectId, year) =>
    d.service.prepareHistoryPrune(
      id.parse(projectId),
      historyYearSchema.parse(year),
    ),
  );
  handle("prune-history", (projectId, token) =>
    d.service.pruneHistory(id.parse(projectId), z.uuid().parse(token)),
  );
  handle("list-history-years", (scope) =>
    d.service.listHistoryYears(scopeRefSchema.parse(scope)),
  );
  handle("list-history-entries", (scope, year) =>
    d.service.listHistoryEntries(
      scopeRefSchema.parse(scope),
      historyYearSchema.parse(year),
    ),
  );
  handle("list-history-artifacts", (scope, year, entry, target) =>
    d.service.listHistoryArtifacts(
      scopeRefSchema.parse(scope),
      historyYearSchema.parse(year),
      historyEntrySchema.parse(entry),
      topicTargetSchema.optional().parse(target),
    ),
  );
  handle("read-history-artifact", (scope, year, entry, path, target) =>
    d.service.readHistoryArtifact(
      scopeRefSchema.parse(scope),
      historyYearSchema.parse(year),
      historyEntrySchema.parse(entry),
      historyPathSchema.parse(path),
      topicTargetSchema.optional().parse(target),
    ),
  );
  handle("read-topic-catalog", (projectId, year) =>
    d.service.readTopicCatalog(
      id.parse(projectId),
      topicYearSchema.parse(year),
    ),
  );
  handle("read-topic-table", (projectId, year) =>
    d.service.readTopicTable(id.parse(projectId), topicYearSchema.parse(year)),
  );
  handle("read-topic-overview", (scope, year, target) =>
    d.service.readTopicOverview(
      scopeRefSchema.parse(scope),
      topicYearSchema.parse(year),
      topicTargetSchema.parse(target),
    ),
  );
  handle("read-project-branches", (projectId) =>
    d.service.readProjectBranches(id.parse(projectId)),
  );
  handle("read-topic-board", (projectId, year) =>
    d.service.readTopicBoard(
      scopeRefSchema.parse(projectId),
      topicYearSchema.parse(year),
    ),
  );
  handle("read-topic-details", (projectId, year, target) =>
    d.service.readTopicDetails(
      scopeRefSchema.parse(projectId),
      topicYearSchema.parse(year),
      topicTargetSchema.parse(target),
    ),
  );
  handle("prepare-topic-operation", (request) =>
    d.service.prepareTopicOperation(topicOperationSchema.parse(request)),
  );
  handle("execute-topic-operation", (token) =>
    d.service.executeTopicOperation(topicTokenSchema.parse(token)),
  );
  handle("prepare-document-deletion", (source, version) =>
    d.service.prepareDocumentDeletion(
      z.custom<DeletableDocument>(isDeletableDocument).parse(source),
      z.string().refine(isDeletionVersion).optional().parse(version),
    ),
  );
  handle("delete-document", (token) =>
    d.service.deleteDocument(z.string().refine(isDeletionToken).parse(token)),
  );
  handle("list-projects", () => d.service.listProjects());
  handle("list-project-profiles", (projectId) =>
    d.service.listProjectProfiles(scopeRefSchema.parse(projectId)),
  );
  handle("list-project-tools", (projectId) =>
    d.service.listProjectTools(scopeRefSchema.parse(projectId)),
  );
  handle("resolve-project-dockerfile", (projectId) =>
    d.service.resolveProjectDockerfile(scopeRefSchema.parse(projectId)),
  );
  handle("list-project-pipelines", (projectId) =>
    d.service.listProjectPipelines(scopeRefSchema.parse(projectId)),
  );
  handle("list-project-workflows", (projectId) =>
    d.service.listProjectWorkflows(scopeRefSchema.parse(projectId)),
  );
  handle("list-workflow-suggestions", (projectId) =>
    d.service.listWorkflowSuggestions(scopeRefSchema.parse(projectId)),
  );
  handle("read-project-document", (projectId, target) =>
    d.service.readProjectDocument(
      scopeRefSchema.parse(projectId),
      documentTarget.parse(target),
    ),
  );
  handle("save-project-document", (projectId, target, text, version) =>
    d.service.saveProjectDocument(
      scopeRefSchema.parse(projectId),
      documentTarget.parse(target),
      documentText.parse(text),
      id.parse(version),
    ),
  );
  handle("choose-project", async () => {
    const folder = await d.choose();
    return folder ? d.service.addProject(folder) : null;
  });
  handle("checkout-branch", (value) =>
    d.service.checkoutBranch(scopeRefSchema.parse(value)),
  );
  handle("read-project-settings", (value) =>
    d.service.readProjectSettings(scopeRefSchema.parse(value)),
  );
  handle("save-project-settings", (projectId, value, version) => {
    const schema = z
      .object({
        startupTimeoutMinutes: z
          .custom<number>(isStartupTimeoutMinutes)
          .optional(),
        executable: z.string().max(4096),
        profile: z.string().max(180),
        env: z
          .array(
            z
              .object({
                key: z.string().max(128),
                value: z.string().max(65536),
                secret: z.boolean().default(false),
                runtime: z.boolean().default(false),
              })
              .strict(),
          )
          .max(256),
      })
      .strict();
    const result = schema.safeParse(value);
    if (!result.success) throw new Error("Некорректные настройки проекта");
    return d.service.saveProjectSettings(
      scopeRefSchema.parse(projectId),
      result.data,
      id.parse(version),
    );
  });
  handle("discover", (value) =>
    d.service.discover(scopeRefSchema.parse(value)),
  );
  handle("read-topic-task", (value) =>
    d.service.readTopicTask(taskReader.parse(value)),
  );
  handle("preview", (value) => d.service.preview(pipeline.parse(value)));
  handle("launch", (value) => d.service.launch(launch.parse(value)));
  handle("runs", () => d.service.runs());
  handle("select-run", (value) => {
    const runId = id.nullable().parse(value);
    if (runId !== null && !d.service.runs().some((r) => r.id === runId))
      throw new Error("Неизвестный запуск");
    d.select(runId);
  });
  handle("close-run", (value) =>
    d.service.closeRun(id.parse(value), d.confirmClose),
  );
  handle("stop-run", (value) => d.stop(id.parse(value)));
  handle("list-settings", () => d.settings.listSettings());
  handle("read-settings", (kind, name) =>
    d.settings.readSettings(
      z.enum(["config", "profile"]).parse(kind),
      id.optional().parse(name),
    ),
  );
  handle("save-settings", (kind, name, text, version) =>
    d.settings.saveSettings(
      z.enum(["config", "profile"]).parse(kind),
      id.optional().parse(name),
      z
        .string()
        .max(1024 * 1024)
        .parse(text),
      id.parse(version),
    ),
  );
}

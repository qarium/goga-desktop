import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  gitBranchProjectSchema,
  gitBranchRequestSchema,
  gitBranchTokenSchema,
  type GitBranchInventory,
  type GitBranchPreview,
  type GitBranchRequest,
  type GitBranchResult,
} from "../shared/git-branches";
import {
  GitMergeSafety,
  GitMetadataLockCleanupError,
  type GitMergeContext,
  type State,
  type MergeDestinations,
  stale,
  oid,
  stat,
  auditMetadata,
  mixedOperations,
} from "./git-merge-safety";
import { sanitizeRepositoryLog } from "./repository-actions";
import { noSymlinks } from "./settings";
import { CommandExitError } from "./process";
export interface GitBranchContext extends GitMergeContext {
  scope: string;
  /** Host-bound online capability, used exclusively for an explicit fetch. */
  remoteGit(args: string[]): Promise<{ stdout: string; stderr: string }>;
}
interface Plan {
  preview: GitBranchPreview;
  request: GitBranchRequest;
  state: State;
  ownerKey: string;
  attributes?: string;
  remote?: {
    name: string;
    endpoint: string;
    source: string;
    destination: string;
  };
}
export class GitBranchActions extends GitMergeSafety {
  private tickets = new Map<string, Plan>();
  constructor(
    private readonly options: {
      context: <T>(
        projectId: string,
        fn: (ctx: GitBranchContext) => Promise<T>,
      ) => Promise<T>;
      now?: () => number;
    },
  ) {
    super();
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  async inventory(input: string): Promise<GitBranchInventory> {
    const projectId = gitBranchProjectSchema.parse(input);
    return this.options.context(
      projectId,
      async (ctx) => (await this.capture(ctx, projectId)).inventory,
    );
  }
  private async remote(
    ctx: GitBranchContext,
    state: State,
    name: string,
    source = "refs/heads/*",
  ): Promise<NonNullable<Plan["remote"]>> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(name) || name === ".")
      throw Error("Upstream remote отсутствует или неоднозначен.");
    const prefix = `remote.${name}.`,
      entries = state.config.filter(([key]) => key.startsWith(prefix));
    if (
      !entries.length ||
      entries.some(
        ([key]) =>
          !["url", "pushurl", "fetch"].includes(key.slice(prefix.length)),
      )
    )
      throw Error(
        "Remote содержит неподдерживаемые или небезопасные настройки.",
      );
    const get = (key: string) =>
      entries.filter(([k]) => k === prefix + key).map(([, v]) => v);
    if (
      get("url").length !== 1 ||
      get("fetch").length !== 1 ||
      get("pushurl").length > 1
    )
      throw Error("Remote или refspec неоднозначен.");
    // Do not infer custom mappings from an apparently familiar short name.
    if (
      ![
        `+refs/heads/*:refs/remotes/${name}/*`,
        `refs/heads/*:refs/remotes/${name}/*`,
      ].includes(get("fetch")[0])
    )
      throw Error("Неподдерживаемый или неоднозначный refspec remote.");
    const endpoint = (
      await this.git(ctx, ["remote", "get-url", "--all", name])
    ).stdout.trim();
    if (
      !endpoint ||
      endpoint.startsWith("-") ||
      /[\x00-\x20\x7f]/.test(endpoint) ||
      endpoint.includes("::")
    )
      throw Error("Remote содержит недопустимый адрес.");
    const url = /^(https|ssh):\/\//.test(endpoint),
      scp = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+:[^/].+/.test(endpoint),
      local = path.isAbsolute(endpoint);
    if (!url && !scp && !local)
      throw Error(
        "Поддерживаются только HTTPS, SSH и абсолютный локальный адрес remote.",
      );
    if (local) await noSymlinks(endpoint);
    if (
      state.config.some(([key]) =>
        /^(core\.(sshcommand|gitproxy)|remote\..+\.(uploadpack|proxy)|url\..+\.(insteadof|pushinsteadof))$/i.test(
          key,
        ),
      )
    )
      throw Error(
        "Внешние transport helpers или перенаправления remote не поддерживаются.",
      );
    if (!source.startsWith("refs/heads/"))
      throw Error("Upstream должен быть однозначной веткой refs/heads.");
    if (source !== "refs/heads/*")
      await this.git(ctx, ["check-ref-format", source]);
    return {
      name,
      endpoint,
      source,
      destination: `refs/remotes/${name}/${source.slice(11)}`,
    };
  }
  private async isAncestor(
    ctx: GitBranchContext,
    ancestor: string,
    descendant: string,
  ): Promise<boolean> {
    try {
      await this.git(ctx, [
        "merge-base",
        "--is-ancestor",
        oid(ancestor),
        oid(descendant),
      ]);
      return true;
    } catch (error) {
      if (error instanceof CommandExitError && error.exitCode === 1)
        return false;
      throw error;
    }
  }
  private async validate(
    ctx: GitBranchContext,
    request: GitBranchRequest,
    state: State,
  ): Promise<Omit<Plan, "ownerKey" | "state" | "request">> {
    const s = state.snapshot;
    const merging =
      request.action === "merge" || request.action === "abort-merge";
    if (
      request.action !== "abort-merge" &&
      (s.operation !== "none" || s.files.some((f) => f.kind === "conflict"))
    )
      throw Error(
        "Сначала завершите текущую операцию Git и разрешите конфликты.",
      );
    await auditMetadata(ctx.root);
    if (merging) {
      if (!s.branch || !s.head)
        throw Error(
          "Слияние требует текущую локальную ветку с коммитом, не detached или unborn HEAD.",
        );
      if (
        state.worktrees
          .split("\0")
          .filter((row) => row === `branch refs/heads/${s.branch}`).length !== 1
      )
        throw Error("Текущая ветка уже открыта в другой рабочей копии.");
      for (const name of [...mixedOperations, "MERGE_AUTOSTASH"])
        if (await stat(path.join(ctx.root, ".git", name)))
          throw Error(
            "Смешанная операция Git или внешний autostash: безопасная операция слияния невозможна.",
          );
      if (state.config.some(([key]) => /^merge\..+\.driver$/i.test(key)))
        throw Error("Внешние merge-драйверы (driver) пока не поддерживаются.");
      if (request.action === "abort-merge") {
        if (!ctx.privateGit)
          throw Error(
            "Исполнитель не поддерживает безопасный частный индекс для отмены слияния.",
          );
        await this.mergeState(ctx, state);
      }
    }
    for (const name of [
      "index.lock",
      "HEAD.lock",
      "config.lock",
      "packed-refs.lock",
    ])
      if (await stat(path.join(ctx.root, ".git", name)))
        throw Error("Репозиторий занят другой операцией Git.");
    const switches =
      request.action === "switch-local" ||
      request.action === "switch-remote" ||
      (request.action === "create" && request.switch);
    if (switches && state.inventory.dirty)
      throw Error(
        "Переключение требует чистой рабочей папки: сохраните все изменения, включая неотслеживаемые файлы.",
      );
    if (
      (switches || request.action === "pull" || merging) &&
      state.config.some(([key]) =>
        /^filter\..+\.(clean|smudge|process|required)$/i.test(key),
      )
    )
      throw Error(
        "Внешние Git-фильтры (например LFS) пока не поддерживаются при переключении, pull или слиянии.",
      );
    if (switches || request.action === "pull" || merging) {
      const flags = (await this.git(ctx, ["ls-files", "-v", "-z"])).stdout;
      if (
        flags
          .split("\0")
          .some((row) => row && (/^[a-z] /.test(row) || row.startsWith("S ")))
      )
        throw Error(
          "Индекс скрывает изменения (assume-unchanged или sparse/skip-worktree). Сначала восстановите обычный индекс самостоятельно.",
        );
    }
    let sourceOid: string | null = null;
    let toRef: string | null = null,
      toOid: string | null = null,
      remote: Plan["remote"];
    if (request.action === "create") {
      await this.git(ctx, ["check-ref-format", "--branch", request.name]);
      if (request.name.startsWith("refs/") || request.name.includes("@{"))
        throw Error("Укажите обычное имя локальной ветки.");
      if (!s.head)
        throw Error("Сначала создайте первый коммит: HEAD ещё не существует.");
      toRef = `refs/heads/${request.name}`;
      toOid = s.head;
      if (
        state.inventory.local.some((r) => r.ref === toRef) ||
        state.config.some(([key]) => key.startsWith(`branch.${request.name}.`))
      )
        throw Error(
          "Локальная ветка или её настройки уже существуют. Используйте список локальных веток.",
        );
    } else if (request.action === "switch-local") {
      const target = state.inventory.local.find((r) => r.ref === request.ref);
      if (!target) throw stale();
      toRef = target.ref;
      toOid = target.oid;
      if (target.checkedOut && s.branch !== target.name)
        throw Error("Ветка уже открыта в другой рабочей копии.");
    } else if (request.action === "switch-remote") {
      const target = state.inventory.remote.find((r) => r.ref === request.ref);
      if (!target) throw stale();
      const matching = state.config
        .filter(([key]) => key.startsWith("remote.") && key.endsWith(".fetch"))
        .map(([key]) => key.slice(7, -6))
        .filter((name) => target.ref.startsWith(`refs/remotes/${name}/`));
      if (new Set(matching).size !== 1)
        throw Error("Remote выбранной ветки неоднозначен.");
      const name = matching[0],
        branch = target.ref.slice(`refs/remotes/${name}/`.length);
      remote = await this.remote(ctx, state, name, `refs/heads/${branch}`);
      toRef = `refs/heads/${branch}`;
      toOid = target.oid;
      await this.git(ctx, ["check-ref-format", "--branch", branch]);
      if (
        state.inventory.local.some((r) => r.ref === toRef) ||
        state.config.some(([key]) => key.startsWith(`branch.${branch}.`))
      )
        throw Error(
          "Локальная ветка или её настройки уже существуют. Используйте список локальных веток.",
        );
    } else if (request.action === "merge") {
      await this.git(ctx, ["check-ref-format", request.ref]);
      const source = [...state.inventory.local, ...state.inventory.remote].find(
        (r) => r.ref === request.ref,
      );
      if (!source) throw stale();
      sourceOid = source.oid;
      if (
        (await this.git(ctx, ["cat-file", "-t", sourceOid])).stdout.trim() !==
        "commit"
      )
        throw Error(
          "Источник слияния должен указывать непосредственно на коммит.",
        );
      toRef = `refs/heads/${s.branch!}`;
      toOid = s.head;
    } else if (request.action === "abort-merge") {
      sourceOid = (await this.mergeState(ctx, state)).source;
      toRef = `refs/heads/${s.branch!}`;
      toOid = s.head;
    } else if (request.action === "fetch")
      remote = await this.remote(ctx, state, "origin");
    else if (request.action === "pull") {
      if (!s.branch || !s.head)
        throw Error(
          "Pull требует текущую локальную ветку с коммитом, не detached или unborn HEAD.",
        );
      const get = (key: string) =>
        state.config
          .filter(([k]) => k === `branch.${s.branch}.${key}`)
          .map(([, v]) => v);
      if (get("remote").length !== 1 || get("merge").length !== 1)
        throw Error("Настроенный upstream отсутствует или неоднозначен.");
      remote = await this.remote(ctx, state, get("remote")[0], get("merge")[0]);
      const local = state.inventory.local.find(
        (r) => r.ref === `refs/heads/${s.branch}`,
      );
      if (local?.upstream && local.upstream !== remote.destination)
        throw Error(
          "Настроенный upstream не соответствует проверенному refspec.",
        );
      toRef = local!.ref;
      toOid =
        state.inventory.remote.find((r) => r.ref === remote!.destination)
          ?.oid ?? null;
    }
    if (switches || request.action === "pull" || merging)
      await this.assertNoGitlinks(ctx, [s.head, toOid, sourceOid]);
    return {
      remote,
      attributes: merging
        ? await this.mergeAttributes(ctx, s.head!, sourceOid!)
        : undefined,
      preview: {
        token: "",
        projectId: request.projectId,
        root: ctx.root,
        action: request.action,
        fromRef: s.branch ? `refs/heads/${s.branch}` : null,
        fromOid: s.head,
        sourceRef:
          request.action === "merge"
            ? request.ref
            : request.action === "pull"
              ? remote!.destination
              : request.action === "switch-local" ||
                  request.action === "switch-remote"
                ? request.ref
                : request.action === "create" && s.branch
                  ? `refs/heads/${s.branch}`
                  : null,
        ...(merging
          ? {
              sourceOid,
              mergeMode:
                request.action === "merge"
                  ? ("ff-or-commit" as const)
                  : ("abort" as const),
              autoCommit: request.action === "merge",
            }
          : {}),
        toRef,
        toOid,
        remote: remote?.name ?? null,
        createsBranch:
          request.action === "create" || request.action === "switch-remote",
        switchesBranch: switches,
        hooks: "disabled",
        expiresAt: this.now() + 300000,
      },
    };
  }
  async prepare(input: GitBranchRequest): Promise<GitBranchPreview> {
    const request = gitBranchRequestSchema.parse(input);
    return this.options.context(request.projectId, async (ctx) => {
      const state = await this.capture(ctx, request.projectId);
      if (state.fingerprint !== request.revision) throw stale();
      const plan = await this.validate(ctx, request, state);
      const again = await this.capture(ctx, request.projectId);
      if (again.fingerprint !== state.fingerprint) throw stale();
      if (
        plan.attributes !== undefined &&
        (await this.mergeAttributes(
          ctx,
          state.snapshot.head!,
          plan.preview.sourceOid!,
        )) !== plan.attributes
      )
        throw stale();
      for (const [token, ticket] of this.tickets)
        if (ticket.preview.expiresAt <= this.now()) this.tickets.delete(token);
      while (this.tickets.size >= 64)
        this.tickets.delete(this.tickets.keys().next().value!);
      plan.preview.token = randomBytes(32).toString("hex");
      this.tickets.set(plan.preview.token, {
        ...plan,
        request,
        state,
        ownerKey: ctx.ownerKey,
      });
      return plan.preview;
    });
  }
  /** Existing-branch switch does not write that branch ref. Holding its native
   * .lock freezes the selected exact OID against cooperative Git ref writers.
   * This does not claim protection from direct uncooperative .git tampering. */
  private async withRefLock<T>(
    ctx: GitBranchContext,
    ref: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!ref.startsWith("refs/heads/") && !ref.startsWith("refs/remotes/"))
      throw stale();
    await this.git(ctx, ["check-ref-format", ref]);
    return this.withMetadataLock(ctx, `${ref}.lock`, fn);
  }
  private async executeMerge(ticket: Plan): Promise<GitBranchResult> {
    const { request, preview } = ticket;
    let attempted = false;
    let retainedAbortLocks = false;
    let executedAbort: GitBranchResult | undefined;
    const lines: string[] = [];
    let sanitize = (value: string) => sanitizeRepositoryLog(value);
    const diagnostics = (value: GitBranchResult): GitBranchResult => ({
      ...value,
      message: sanitize(value.message),
      log: sanitize(value.log),
    });
    const result = (
      status: GitBranchResult["status"],
      changed: boolean,
      message: string,
      conflictCount?: number,
    ): GitBranchResult => ({
      projectId: request.projectId,
      action: request.action,
      status,
      changed,
      ...(conflictCount === undefined ? {} : { conflictCount }),
      message: sanitizeRepositoryLog(message),
      log: sanitizeRepositoryLog(lines.join("\n")),
    });
    try {
      const completed = await this.options.context(
        request.projectId,
        async (ctx) => {
          sanitize = ctx.sanitizeDiagnostics ?? sanitize;
          if (ctx.ownerKey !== ticket.ownerKey) throw stale();
          const before = await this.capture(ctx, request.projectId);
          if (before.fingerprint !== ticket.state.fingerprint) throw stale();
          const validation = await this.validate(ctx, request, before);
          if (validation.attributes !== ticket.attributes) throw stale();
          const effect = await this.mergeEffect(ctx, before);
          const execute = async () => {
            // Config and the selected source ref are held against cooperative Git
            // writers; the native merge owns its index and current-ref CAS locks.
            if (
              (await this.capture(ctx, request.projectId)).fingerprint !==
              before.fingerprint
            )
              throw stale();
            const options = [
              "-c",
              `branch.${before.snapshot.branch!}.mergeOptions=`,
              "-c",
              "rerere.enabled=false",
              "-c",
              "rerere.autoupdate=false",
              "-c",
              "merge.autoStash=false",
            ];
            let expectedHead: string | undefined;
            if (request.action === "merge") {
              if (
                await this.isAncestor(
                  ctx,
                  before.snapshot.head!,
                  preview.sourceOid!,
                )
              )
                expectedHead = preview.sourceOid!;
              else if (
                await this.isAncestor(
                  ctx,
                  preview.sourceOid!,
                  before.snapshot.head!,
                )
              )
                expectedHead = before.snapshot.head!;
            }
            const mergeTree = await this.protectMergeDestinations(
              ctx,
              before,
              preview.sourceOid!,
              options,
            );
            const indexPaths = await this.indexPaths(ctx);
            const tracked = new Set([...mergeTree.current, ...indexPaths]);
            let destinations: MergeDestinations = {
              current: mergeTree.current,
              incoming: mergeTree.incoming,
              tracked,
            };
            if (request.action === "abort-merge") {
              await this.assertAbortIndex(ctx, mergeTree);
              destinations = {
                current: new Set(indexPaths),
                incoming: [...mergeTree.current],
                tracked,
                original: {
                  paths: new Set(mergeTree.incoming),
                  conflicts: mergeTree.conflicts,
                },
              };
            }
            if (request.action === "abort-merge") {
              const aborted = await this.pinnedMergeAbort(
                ctx,
                before,
                destinations,
                async () => {
                  await ctx.verify();
                  if (
                    preview.expiresAt <= this.now() ||
                    (await this.mergeAttributes(
                      ctx,
                      before.snapshot.head!,
                      preview.sourceOid!,
                      destinations.incoming,
                    )) !== ticket.attributes
                  )
                    throw stale();
                },
              );
              const protectedAbort = this.holdConfigForUnknown(aborted);
              Object.assign(aborted, protectedAbort);
              retainedAbortLocks = aborted.lockRetained;
              attempted = aborted.changed;
              return (executedAbort = {
                ...result(aborted.status, aborted.changed, aborted.message),
                log: sanitizeRepositoryLog(aborted.log),
                nativeWarning: aborted.nativeWarning,
                lockRetained: aborted.lockRetained,
                uncheckedLocks: aborted.uncheckedLocks,
                recoveryUnverified: aborted.recoveryUnverified,
                retainedLocks: aborted.lockRetained
                  ? [...new Set([...aborted.retainedLocks, "config.lock"])]
                  : [],
                ...(aborted.recoveryPath
                  ? { recoveryPath: aborted.recoveryPath }
                  : {}),
              });
            }
            await ctx.verify();
            if (
              (await this.capture(ctx, request.projectId)).fingerprint !==
              before.fingerprint
            )
              throw stale();
            if (
              (await this.mergeAttributes(
                ctx,
                before.snapshot.head!,
                preview.sourceOid!,
                destinations.incoming,
              )) !== ticket.attributes
            )
              throw stale();
            // Last pre-mutation boundary: no unrelated awaited work after this
            // check. Arbitrary external filesystem writers after the check cannot
            // be made atomic with native Git; callers must not promise that.
            await this.checkMergeDestinations(ctx, destinations);
            let failure: unknown;
            attempted = true;
            try {
              const output = await this.git(ctx, [
                ...options,
                "merge",
                ...[
                  "--ff",
                  "--commit",
                  "--no-edit",
                  "--no-squash",
                  "--no-autostash",
                  "--no-overwrite-ignore",
                  "--no-verify-signatures",
                  "--no-stat",
                  "--strategy=ort",
                  "--",
                  preview.sourceOid!,
                ],
              ]);
              lines.push(output.stdout, output.stderr);
            } catch (error) {
              failure = error;
              const e = error as {
                message?: string;
                stdout?: string;
                stderr?: string;
              };
              lines.push(
                e.stdout ?? "",
                e.stderr ?? "",
                e.message ?? String(error),
              );
            }
            await ctx.verify();
            const after = await this.capture(ctx, request.projectId);
            if (after.snapshot.branch !== before.snapshot.branch) throw stale();
            if (failure) {
              if (
                request.action === "merge" &&
                after.snapshot.head === before.snapshot.head &&
                after.snapshot.operation === "merge"
              ) {
                const merge = await this.mergeState(ctx, after);
                if (
                  merge.source === preview.sourceOid &&
                  merge.conflictCount > 0
                )
                  return result(
                    "conflict",
                    true,
                    "Слияние остановлено: разрешите конфликты или явно подтвердите отмену. Незавершённое слияние сохранено.",
                    merge.conflictCount,
                  );
              }
              if (
                failure instanceof CommandExitError &&
                (await this.mergeEffect(ctx, after)) === effect
              )
                return result(
                  "error",
                  false,
                  "Git отказал в слиянии. Ветка и изменения сохранены; изучите журнал. Сброс и повтор не выполнялись.",
                );
              return result(
                "uncertain",
                true,
                "Операция Git не завершена; возможно частичное изменение или незавершённое слияние. Проверьте состояние и журнал. Автоматическая отмена и повтор не выполнялись.",
              );
            }
            if (after.snapshot.operation !== "none") throw stale();
            if (expectedHead) {
              if (after.snapshot.head !== expectedHead) throw stale();
            } else {
              if (!after.snapshot.head) throw stale();
              const parents = (
                await this.git(ctx, [
                  "rev-list",
                  "--parents",
                  "-n",
                  "1",
                  after.snapshot.head,
                ])
              ).stdout
                .trim()
                .split(" ");
              if (
                parents.length !== 3 ||
                parents[1] !== before.snapshot.head ||
                parents[2] !== preview.sourceOid
              )
                throw stale();
            }
            return result(
              "success",
              after.snapshot.head !== before.snapshot.head,
              "Слияние завершено. Публикация не выполнялась.",
            );
          };
          return this.withMetadataLock(
            ctx,
            "config.lock",
            () =>
              request.action === "merge" && preview.sourceRef !== preview.toRef
                ? this.withRefLock(ctx, preview.sourceRef!, execute)
                : execute(),
            () => retainedAbortLocks,
          );
        },
      );
      if (
        executedAbort?.recoveryPath &&
        !executedAbort.lockRetained &&
        executedAbort.status !== "uncertain"
      ) {
        await fs.rm(executedAbort.recoveryPath, {
          recursive: true,
          force: true,
        });
        delete executedAbort.recoveryPath;
      }
      return diagnostics(completed);
    } catch (error) {
      const e = error as { message?: string; stdout?: string; stderr?: string };
      lines.push(e.stdout ?? "", e.stderr ?? "", e.message ?? String(error));
      const failed = result(
        attempted ? "uncertain" : "error",
        attempted,
        attempted
          ? "Результат Git не подтверждён. Проверьте состояние и журнал; сброс и повтор не выполнялись."
          : error instanceof Error
            ? error.message
            : "Операция Git не выполнена.",
      );
      if (executedAbort)
        failed.log = sanitizeRepositoryLog(
          executedAbort.log + "\n" + failed.log,
        );
      const retained = [...(executedAbort?.retainedLocks ?? [])];
      if (
        error instanceof GitMetadataLockCleanupError &&
        error.retained &&
        !retained.includes(error.lock)
      )
        retained.push(error.lock);
      const unchecked = [...(executedAbort?.uncheckedLocks ?? [])];
      if (
        error instanceof GitMetadataLockCleanupError &&
        error.unchecked &&
        !unchecked.includes(error.lock)
      )
        unchecked.push(error.lock);
      return diagnostics(
        await this.recoveryDiagnostics({
          ...executedAbort,
          ...failed,
          lockRetained: retained.length > 0,
          retainedLocks: retained,
          uncheckedLocks: unchecked,
        }),
      );
    }
  }
  async execute(input: string): Promise<GitBranchResult> {
    const token = gitBranchTokenSchema.parse(input),
      ticket = this.tickets.get(token);
    this.tickets.delete(token);
    if (!ticket || ticket.preview.expiresAt <= this.now()) throw stale();
    const { request, preview } = ticket;
    if (request.action === "merge" || request.action === "abort-merge")
      return this.executeMerge(ticket);
    let changed = false,
      attempted = false;
    const lines: string[] = [];
    try {
      return await this.options.context(request.projectId, async (ctx) => {
        if (ctx.ownerKey !== ticket.ownerKey) throw stale();
        let state = await this.capture(ctx, request.projectId);
        if (state.fingerprint !== ticket.state.fingerprint) throw stale();
        await this.validate(ctx, request, state);
        let pullExpectedHead: string | undefined;
        const run = async (args: string[]) => {
          attempted = true;
          const r = await this.git(ctx, args);
          lines.push(r.stdout, r.stderr);
          changed = true;
        };
        if (preview.createsBranch) {
          if (
            (await this.capture(ctx, request.projectId)).fingerprint !==
            state.fingerprint
          )
            throw stale();
          await run([
            "branch",
            "--no-track",
            "--",
            preview.toRef!.slice(11),
            preview.toOid!,
          ]);
          const created = await this.capture(ctx, request.projectId);
          if (
            created.anchor !== state.anchor ||
            JSON.stringify(created.inventory.remote) !==
              JSON.stringify(state.inventory.remote) ||
            JSON.stringify(
              created.inventory.local.filter((r) => r.ref !== preview.toRef),
            ) !== JSON.stringify(state.inventory.local) ||
            created.inventory.local.find((r) => r.ref === preview.toRef)
              ?.oid !== preview.toOid
          )
            throw stale();
          state = created;
          if (request.action === "switch-remote") {
            const name = preview.toRef!.slice(11);
            for (const [key, value] of [
              [`branch.${name}.remote`, ticket.remote!.name],
              [`branch.${name}.merge`, ticket.remote!.source],
            ]) {
              if (
                (await this.capture(ctx, request.projectId)).fingerprint !==
                  state.fingerprint ||
                state.config.some(([k]) => k === key)
              )
                throw stale();
              // --add cannot replace an unrelated upstream written concurrently.
              await run(["config", "--local", "--add", key, value]);
              const updated = await this.capture(ctx, request.projectId),
                actual = updated.config.filter(([k]) => k === key);
              if (
                updated.workspace !== state.workspace ||
                JSON.stringify(updated.config.filter(([k]) => k !== key)) !==
                  JSON.stringify(state.config) ||
                actual.length !== 1 ||
                actual[0][1] !== value
              )
                throw stale();
              state = updated;
            }
          }
        }
        if (preview.switchesBranch) {
          await this.withMetadataLock(ctx, "config.lock", () =>
            this.withRefLock(ctx, preview.toRef!, async () => {
              const fresh = await this.capture(ctx, request.projectId);
              if (fresh.fingerprint !== state.fingerprint) throw stale();
              if (
                fresh.inventory.local.find((r) => r.ref === preview.toRef)
                  ?.oid !== preview.toOid
              )
                throw stale();
              await run([
                "switch",
                "--no-guess",
                "--no-overwrite-ignore",
                preview.toRef!.slice(11),
              ]);
            }),
          );
        }
        if (request.action === "fetch" || request.action === "pull") {
          if (
            (await this.capture(ctx, request.projectId)).fingerprint !==
            state.fingerprint
          )
            throw stale();
          const remote = await this.remote(
            ctx,
            state,
            ticket.remote!.name,
            ticket.remote!.source,
          );
          if (JSON.stringify(remote) !== JSON.stringify(ticket.remote))
            throw stale();
          await ctx.verify();
          const fresh = await this.withMetadataLock(
            ctx,
            "config.lock",
            async () => {
              if (
                (await this.capture(ctx, request.projectId)).fingerprint !==
                state.fingerprint
              )
                throw stale();
              attempted = true;
              const fetched = await ctx.remoteGit(
                this.args(ctx, [
                  "-c",
                  "protocol.file.allow=always",
                  "-c",
                  "protocol.https.allow=always",
                  "-c",
                  "protocol.ssh.allow=always",
                  "-c",
                  "http.followRedirects=false",
                  "-c",
                  "credential.helper=",
                  "-c",
                  "fetch.pruneTags=false",
                  "-c",
                  "fetch.writeCommitGraph=false",
                  "fetch",
                  "--atomic",
                  "--no-tags",
                  "--no-prune",
                  "--no-write-fetch-head",
                  "--no-recurse-submodules",
                  "--no-auto-maintenance",
                  "--no-write-commit-graph",
                  "--",
                  remote.endpoint,
                  `${remote.source}:${remote.destination}`,
                ]),
              );
              lines.push(fetched.stdout, fetched.stderr);
              changed = true;
              const fresh = await this.capture(ctx, request.projectId);
              if (fresh.anchor !== state.anchor) throw stale();
              if (
                JSON.stringify(
                  await this.remote(ctx, fresh, remote.name, remote.source),
                ) !== JSON.stringify(remote)
              )
                throw stale();
              return fresh;
            },
          );
          if (request.action === "pull") {
            const target = fresh.inventory.remote.find(
              (r) => r.ref === remote.destination,
            );
            if (!target)
              throw Error("После fetch настроенная upstream-ветка не найдена.");
            await this.validate(ctx, request, fresh);
            await this.withMetadataLock(ctx, "config.lock", async () => {
              if (
                (await this.capture(ctx, request.projectId)).fingerprint !==
                fresh.fingerprint
              )
                throw stale();
              const current = fresh.snapshot.head!;
              if (await this.isAncestor(ctx, current, target.oid))
                pullExpectedHead = target.oid;
              else if (await this.isAncestor(ctx, target.oid, current))
                pullExpectedHead = current;
              else
                throw Error(
                  "Локальная ветка и upstream разошлись. Допускается только fast-forward; merge/rebase не выполнялись.",
                );
              await run([
                "-c",
                `branch.${fresh.snapshot.branch!}.mergeOptions=`,
                "merge",
                "--ff-only",
                "--no-overwrite-ignore",
                "--no-squash",
                "--no-edit",
                "--no-autostash",
                "--no-gpg-sign",
                target.oid,
              ]);
            });
          }
        }
        await ctx.verify();
        const after = await this.capture(ctx, request.projectId);
        if (
          request.action === "pull" &&
          (after.snapshot.branch !== ticket.state.snapshot.branch ||
            after.snapshot.head !== pullExpectedHead)
        )
          throw stale();
        if (
          request.action !== "pull" &&
          preview.toRef &&
          after.inventory.local.find((r) => r.ref === preview.toRef)?.oid !==
            preview.toOid
        )
          throw stale();
        if (
          preview.switchesBranch &&
          (after.snapshot.branch !== preview.toRef!.slice(11) ||
            after.snapshot.head !== preview.toOid)
        )
          throw stale();
        return {
          projectId: request.projectId,
          action: request.action,
          status: "success",
          changed,
          message: "Операция Git завершена.",
          log: sanitizeRepositoryLog(
            lines.join("\n"),
            ticket.remote ? [ticket.remote.endpoint] : [],
          ),
        };
      });
    } catch (error) {
      const e = error as { message?: string; stdout?: string; stderr?: string };
      lines.push(e.stdout ?? "", e.stderr ?? "", e.message ?? String(error));
      return {
        projectId: request.projectId,
        action: request.action,
        status: attempted ? "uncertain" : "error",
        changed: changed || attempted,
        message: sanitizeRepositoryLog(
          e.message ?? "Операция Git не выполнена.",
          ticket.remote ? [ticket.remote.endpoint] : [],
        ),
        log: sanitizeRepositoryLog(
          lines.join("\n"),
          ticket.remote ? [ticket.remote.endpoint] : [],
        ),
      };
    }
  }
}

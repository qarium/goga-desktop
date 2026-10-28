import {
  withNativeGitCompletion,
  deferNativeGitRecovery,
} from "./git-native-completion";
import { NativeGitPreflightRejection } from "./git-native-journal";
import { NativeGitMergeOperations } from "./git-native-merge";
import { nativeIntent } from "./git-native-context";
import { randomBytes } from "node:crypto";
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
  type GitMergeContext,
  type State,
  stale,
  oid,
  stat,
  auditMetadata,
  mixedOperations,
} from "./git-merge-safety";
import { sanitizeRepositoryLog } from "./repository-actions";
import { noSymlinks } from "./settings";
import { ByteCommandError, CommandExitError } from "./process";
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
  mergeToken?: string;
  attributes?: string;
  native?: { token: string; intent: string; paths: string[] };
  remote?: {
    name: string;
    endpoint: string;
    source: string;
    destination: string;
  };
}
export class GitBranchActions extends GitMergeSafety {
  private tickets = new Map<string, Plan>();
  private nativeMerges: NativeGitMergeOperations;
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
    this.nativeMerges = new NativeGitMergeOperations({
      context: (scope, action) => {
        if (typeof scope !== "string") throw stale();
        return this.options.context(scope, action);
      },
      now: options.now,
    });
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
    configLocked = false,
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
    if (
      request.action === "merge" &&
      s.files.some((f) => ![".", " ", "?"].includes(f.indexStatus))
    )
      throw Error(
        "Перед слиянием уберите посторонние staged изменения: они не должны попасть в merge-коммит.",
      );
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
      // REBASE_HEAD may survive a completed native rebase; it is sealed as
      // metadata, but is not proof of a running sequencer on its own.
      for (const name of [
        ...mixedOperations.filter((n) => n !== "REBASE_HEAD"),
        "MERGE_AUTOSTASH",
      ])
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
      ...(configLocked ? [] : ["config.lock"]),
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
    if (request.action === "abort-merge") {
      const state = await this.options.context(
        request.projectId,
        async (ctx) => {
          const state = await this.capture(ctx, request.projectId);
          if (state.fingerprint !== request.revision) throw stale();
          return { state, ownerKey: ctx.ownerKey };
        },
      );
      const pending = await this.nativeMerges.prepare({
        scope: request.projectId,
        action: "abort",
        revision: state.state.snapshot.revision,
      });
      const preview: GitBranchPreview = {
        token: pending.token,
        projectId: request.projectId,
        root: pending.root,
        action: "abort-merge",
        fromRef: `refs/heads/${pending.branch}`,
        fromOid: pending.head,
        sourceRef: null,
        sourceOid: pending.sourceOid,
        toRef: `refs/heads/${pending.branch}`,
        toOid: pending.head,
        remote: null,
        createsBranch: false,
        switchesBranch: false,
        hooks: "disabled",
        expiresAt: pending.expiresAt,
        mergeMode: "abort",
        autoCommit: false,
      };
      this.tickets.set(preview.token, {
        preview,
        request,
        ...state,
        mergeToken: pending.token,
      });
      return preview;
    }
    return this.options.context(request.projectId, async (ctx) => {
      const state = await this.capture(ctx, request.projectId);
      if (ctx.native)
        await ctx.native.journal.assertAdmission(
          ctx.root,
          await ctx.native.owner(),
        );
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
      let native: Plan["native"];
      if (
        request.action === "create" ||
        request.action === "switch-local" ||
        request.action === "merge" ||
        request.action === "fetch" ||
        request.action === "pull" ||
        request.action === "switch-remote"
      ) {
        const paths = [
          ...new Set(
            state.snapshot.files.flatMap((f) => [
              f.path,
              ...(f.originalPath ? [f.originalPath] : []),
            ]),
          ),
        ];
        const guard = await this.nativeGuard(
          ctx,
          state,
          paths,
          request.action === "merge" ? plan.preview.sourceOid! : undefined,
          request.action === "switch-remote"
            ? this.trackingConfig(plan.preview, plan.remote!)
            : [],
        );
        const snapshot = await guard.capture();
        const record = await guard.journal.inspect(snapshot, true);
        if (
          record &&
          (!["completed", "rejected"].includes(record.state) ||
            record.recovery !== null)
        )
          throw Error(
            "Предыдущая операция Git требует проверки; повторная запись запрещена.",
          );
        const intent = nativeIntent([request, plan.preview, ctx.ownerKey]);
        native = {
          token: guard.journal.prepare(
            request.action === "merge"
              ? "merge"
              : request.action === "fetch" || request.action === "pull"
                ? request.action
                : plan.preview.switchesBranch
                  ? "switch"
                  : "branch",
            snapshot,
            intent,
          ),
          intent,
          paths,
        };
      }
      this.tickets.set(plan.preview.token, {
        ...plan,
        native,
        request,
        state,
        ownerKey: ctx.ownerKey,
      });
      return plan.preview;
    });
  }
  private matchesTrackingConfig(
    actual: [string, string][],
    original: [string, string][],
    additions: [string, string][],
  ) {
    return (
      JSON.stringify(
        actual.filter(([key]) => !additions.some(([k]) => key === k)),
      ) === JSON.stringify(original) &&
      additions.every(([key, value]) => {
        const found = actual.filter(([k]) => k === key);
        return found.length === 1 && found[0][1] === value;
      })
    );
  }
  private trackingConfig(
    preview: GitBranchPreview,
    remote: NonNullable<Plan["remote"]>,
  ): [string, string][] {
    const name = preview.toRef!.slice(11);
    return [
      [`branch.${name}.remote`, remote.name],
      [`branch.${name}.merge`, remote.source],
    ];
  }
  private async switchRemote(
    ctx: GitBranchContext,
    ticket: Plan,
    before: State,
    client: Awaited<
      ReturnType<NonNullable<GitBranchContext["native"]>["client"]>
    >,
    lines: string[],
    attempted: () => void,
  ) {
    const p = ticket.preview,
      additions = this.trackingConfig(p, ticket.remote!);
    return this.withRefLock(
      ctx,
      ticket.request.action === "switch-remote" ? ticket.request.ref : "",
      async () => {
        if (
          (await this.capture(ctx, ticket.request.projectId)).fingerprint !==
          before.fingerprint
        )
          throw stale();
        attempted();
        const run = async (args: string[]) => {
          const output = await client.run({
            policy: "local-write",
            command: "branch",
            args,
          });
          lines.push(
            output.stdout.toString("utf8"),
            output.stderr.toString("utf8"),
          );
          return output;
        };
        // No checkout while config is writable. Native branch config owns config.lock.
        const createdOutput = await this.withMetadataLock(
          ctx,
          "config.lock",
          () => run(["--no-track", "--", p.toRef!.slice(11), p.toOid!]),
        );
        if (createdOutput.exitCode !== 0 || createdOutput.signal)
          return createdOutput;
        const created = await this.capture(ctx, ticket.request.projectId);
        if (
          created.anchor !== before.anchor ||
          JSON.stringify(created.inventory.remote) !==
            JSON.stringify(before.inventory.remote) ||
          JSON.stringify(
            created.inventory.local.filter((r) => r.ref !== p.toRef),
          ) !== JSON.stringify(before.inventory.local) ||
          created.inventory.local.find((r) => r.ref === p.toRef)?.oid !==
            p.toOid
        )
          throw stale();
        const trackingOutput = await run([
          `--set-upstream-to=${ticket.remote!.destination}`,
          "--",
          p.toRef!.slice(11),
        ]);
        if (trackingOutput.exitCode !== 0 || trackingOutput.signal)
          return trackingOutput;
        return this.withMetadataLock(ctx, "config.lock", () =>
          this.withRefLock(ctx, p.toRef!, async () => {
            const ready = await this.capture(ctx, ticket.request.projectId);
            if (
              ready.workspace !== created.workspace ||
              !this.matchesTrackingConfig(
                ready.config,
                before.config,
                additions,
              ) ||
              ready.inventory.local.find((r) => r.ref === p.toRef)?.oid !==
                p.toOid ||
              JSON.stringify(ready.inventory.remote) !==
                JSON.stringify(before.inventory.remote)
            )
              throw stale();
            const output = await client.run({
              policy: "local-write",
              command: "switch",
              args: ["--no-guess", "--no-overwrite-ignore", p.toRef!.slice(11)],
            });
            lines.push(
              output.stdout.toString("utf8"),
              output.stderr.toString("utf8"),
            );
            return output;
          }),
        );
      },
    );
  }
  private async executeNativeLocal(ticket: Plan): Promise<GitBranchResult> {
    const { request, preview } = ticket;
    let attempted = false;
    const lines: string[] = [];
    try {
      return await this.options.context(request.projectId, async (ctx) => {
        if (ctx.ownerKey !== ticket.ownerKey || !ticket.native) throw stale();
        const before = await this.capture(ctx, request.projectId);
        if (before.fingerprint !== ticket.state.fingerprint) throw stale();
        await this.validate(ctx, request, before);
        const additions =
          request.action === "switch-remote"
            ? this.trackingConfig(preview, ticket.remote!)
            : [];
        const guard = await this.nativeGuard(
          ctx,
          before,
          ticket.native.paths,
          undefined,
          additions,
        );
        const result = await guard.journal.execute({
          deferRecoveryCleanup: deferNativeGitRecovery,
          token: ticket.native.token,
          intentFingerprint: ticket.native.intent,
          operation: preview.switchesBranch ? "switch" : "branch",
          capture: guard.capture,
          run: () =>
            request.action === "switch-remote"
              ? this.switchRemote(
                  ctx,
                  ticket,
                  before,
                  guard.client,
                  lines,
                  () => {
                    attempted = true;
                  },
                )
              : this.withMetadataLock(ctx, "config.lock", async () => {
                  // The journal and recovery are durable; Git owns its own native locks.
                  if (
                    (await this.capture(ctx, request.projectId)).fingerprint !==
                    before.fingerprint
                  )
                    throw stale();
                  attempted = true;
                  const command = preview.switchesBranch
                    ? ("switch" as const)
                    : ("branch" as const);
                  const args = preview.switchesBranch
                    ? [
                        "--no-guess",
                        "--no-overwrite-ignore",
                        ...(preview.createsBranch
                          ? [
                              "--no-track",
                              "--create",
                              preview.toRef!.slice(11),
                              preview.toOid!,
                            ]
                          : [preview.toRef!.slice(11)]),
                      ]
                    : [
                        "--no-track",
                        "--",
                        preview.toRef!.slice(11),
                        preview.toOid!,
                      ];
                  const execute = () =>
                    guard.client.run({ policy: "local-write", command, args });
                  const output =
                    preview.switchesBranch && !preview.createsBranch
                      ? await this.withRefLock(ctx, preview.toRef!, execute)
                      : await execute();
                  lines.push(
                    output.stdout.toString("utf8"),
                    output.stderr.toString("utf8"),
                  );
                  return output;
                }),
          verify: async (baseline, after) => {
            const actual = await this.capture(ctx, request.projectId);
            if (
              actual.snapshot.operation !== "none" ||
              actual.snapshot.head !== preview.toOid ||
              actual.snapshot.branch !==
                (preview.switchesBranch
                  ? preview.toRef!.slice(11)
                  : before.snapshot.branch) ||
              actual.inventory.local.find((r) => r.ref === preview.toRef)
                ?.oid !== preview.toOid ||
              !this.matchesTrackingConfig(
                actual.config,
                before.config,
                additions,
              ) ||
              JSON.stringify(actual.inventory.remote) !==
                JSON.stringify(before.inventory.remote)
            )
              throw stale();
            // checkedOut is expected to change on switch, no other ref/OID/upstream is.
            const refs = (state: State) =>
              state.inventory.local
                .filter(
                  (r) => !preview.createsBranch || r.ref !== preview.toRef,
                )
                .map(({ checkedOut: _, ...r }) => r);
            if (JSON.stringify(refs(actual)) !== JSON.stringify(refs(before)))
              throw stale();
            if (JSON.stringify(baseline.files) !== JSON.stringify(after.files))
              throw stale();
            if (
              preview.switchesBranch
                ? actual.inventory.dirty
                : baseline.index !== after.index ||
                  baseline.status !== after.status
            )
              throw stale();
            return {
              outcome: "completed",
              afterHead: after.head,
              conflicts: [],
              verifiedUnrelatedData: true,
            };
          },
        });
        return {
          projectId: request.projectId,
          action: request.action,
          native: result,
          status: result.outcome === "completed" ? "success" : "uncertain",
          changed: attempted,
          ...(result.recoveryPath ? { recoveryPath: result.recoveryPath } : {}),
          message:
            result.outcome === "completed"
              ? "Операция Git завершена; результат проверен."
              : "Результат Git не подтверждён. Материалы восстановления сохранены; автоматический повтор запрещён.",
          log: (ctx.sanitizeDiagnostics ?? sanitizeRepositoryLog)(
            lines.join("\n"),
          ),
        };
      });
    } catch (error) {
      return {
        projectId: request.projectId,
        action: request.action,
        status: attempted ? "uncertain" : "error",
        changed: attempted,
        message: sanitizeRepositoryLog(
          error instanceof Error ? error.message : "Операция Git не выполнена.",
        ),
        log: "Внешний контекст операции завершился ошибкой; диагностика окружения скрыта.",
      };
    }
  }
  private async executeNativeFetch(ticket: Plan): Promise<GitBranchResult> {
    const { request } = ticket;
    let attempted = false;
    const lines: string[] = [];
    try {
      return await this.options.context(request.projectId, async (ctx) => {
        if (
          ctx.ownerKey !== ticket.ownerKey ||
          !ticket.native ||
          !ticket.remote
        )
          throw stale();
        const before = await this.capture(ctx, request.projectId);
        if (before.fingerprint !== ticket.state.fingerprint) throw stale();
        const validated = await this.validate(ctx, request, before);
        if (JSON.stringify(validated.remote) !== JSON.stringify(ticket.remote))
          throw stale();
        const guard = await this.nativeGuard(ctx, before, ticket.native.paths);
        const remote = ticket.remote;
        const client = await ctx.native!.client([
          ...before.config,
          ["protocol.file.allow", "always"],
          ["protocol.https.allow", "always"],
          ["protocol.ssh.allow", "always"],
          ["http.followRedirects", "false"],
          ["credential.helper", ""],
          ["fetch.pruneTags", "false"],
          ["fetch.writeCommitGraph", "false"],
        ]);
        // Inspect all public refs, not just the branch inventory (tags included).
        const refs = async () => {
          const result = await guard.client.run({
            policy: "local-read",
            command: "for-each-ref",
            args: ["--format=%(refname) %(objectname)"],
          });
          if (result.exitCode !== 0) throw stale();
          return result.stdout
            .toString("utf8")
            .split("\n")
            .filter(Boolean)
            .sort();
        };
        const beforeRefs = await refs();
        const pull = request.action === "pull";
        let expectedHead: string | null = before.snapshot.head;
        let fetchedRefs: string[] | undefined;
        const prefix = `refs/remotes/${remote.name}/`;
        const unrelated = (rows: string[]) =>
          rows.filter(
            (row) =>
              !(pull
                ? row.startsWith(remote.destination + " ") ||
                  row.startsWith(`refs/heads/${before.snapshot.branch} `)
                : row.startsWith(prefix)),
          );
        const applyClient = await ctx.native!.client([
          ...before.config,
          [`branch.${before.snapshot.branch}.mergeOptions`, ""],
          ["merge.autoStash", "false"],
        ]);
        const result = await guard.journal.execute({
          deferRecoveryCleanup: deferNativeGitRecovery,
          token: ticket.native.token,
          intentFingerprint: ticket.native.intent,
          operation: pull ? "pull" : "fetch",
          capture: guard.capture,
          run: () =>
            this.withMetadataLock(ctx, "config.lock", async () => {
              if (
                (await this.capture(ctx, request.projectId)).fingerprint !==
                  before.fingerprint ||
                JSON.stringify(await refs()) !== JSON.stringify(beforeRefs)
              )
                throw new NativeGitPreflightRejection(
                  "Состояние Git изменилось до fetch.",
                );
              attempted = true;
              const output = await client.run({
                policy: "remote",
                command: "fetch",
                args: [
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
                ],
              });
              lines.push(
                output.stdout.toString("utf8"),
                output.stderr.toString("utf8"),
              );
              if (!pull || output.exitCode !== 0 || output.signal)
                return output;
              const fetched = await this.capture(ctx, request.projectId);
              fetchedRefs = await refs();
              if (
                fetched.anchor !== before.anchor ||
                JSON.stringify(unrelated(fetchedRefs)) !==
                  JSON.stringify(unrelated(beforeRefs))
              )
                throw stale();
              const target = fetched.inventory.remote.find(
                (r) => r.ref === remote.destination,
              );
              if (!target)
                throw Error("После fetch upstream-ветка не найдена.");
              await this.validate(ctx, request, fetched, true);
              if (await this.isAncestor(ctx, before.snapshot.head!, target.oid))
                expectedHead = target.oid;
              else if (
                !(await this.isAncestor(ctx, target.oid, before.snapshot.head!))
              )
                throw Error(
                  "Ветки разошлись. Fetch выполнен, fast-forward невозможен; merge/rebase не запускались.",
                );
              if (
                (await this.capture(ctx, request.projectId)).fingerprint !==
                fetched.fingerprint
              )
                throw stale();
              const applied = await applyClient.run({
                policy: "local-write",
                command: "merge",
                args: [
                  "--ff-only",
                  "--no-overwrite-ignore",
                  "--no-squash",
                  "--no-edit",
                  "--no-autostash",
                  "--",
                  target.oid,
                ],
              });
              lines.push(
                applied.stdout.toString("utf8"),
                applied.stderr.toString("utf8"),
              );
              return applied;
            }),
          verify: async (baseline, after, command) => {
            const actual = await this.capture(ctx, request.projectId);
            const afterRefs = await refs();
            if (
              after.head !==
                (pull && command.exitCode === 0
                  ? expectedHead
                  : baseline.head) ||
              after.headRef !== baseline.headRef ||
              (!pull &&
                (after.index !== baseline.index ||
                  after.status !== baseline.status ||
                  after.controlFingerprint !== baseline.controlFingerprint)) ||
              actual.snapshot.operation !== "none" ||
              JSON.stringify(actual.snapshot.files) !==
                JSON.stringify(before.snapshot.files) ||
              JSON.stringify(after.files) !== JSON.stringify(baseline.files) ||
              (!pull && actual.anchor !== before.anchor) ||
              JSON.stringify(actual.config) !== JSON.stringify(before.config) ||
              JSON.stringify(unrelated(afterRefs)) !==
                JSON.stringify(unrelated(beforeRefs)) ||
              beforeRefs.some(
                (row) =>
                  !afterRefs.some(
                    (next) => next.split(" ")[0] === row.split(" ")[0],
                  ),
              )
            )
              throw stale();
            if (pull) {
              const protectedIndex = (data: string) =>
                Buffer.from(data, "base64")
                  .toString("utf8")
                  .split("\0")
                  .filter((row) =>
                    ticket.native!.paths.includes(
                      row.slice(row.indexOf("\t") + 1),
                    ),
                  );
              if (
                JSON.stringify(protectedIndex(baseline.indexData)) !==
                JSON.stringify(protectedIndex(after.indexData))
              )
                throw stale();
              // A nonzero command after successful fetch is a partial result,
              // never unchanged rejection. Keep recovery and prevent replay.
              if (command.exitCode !== 0 && fetchedRefs) throw stale();
            }
            return {
              outcome: command.exitCode === 0 ? "completed" : "rejected",
              afterHead: after.head,
              conflicts: [],
              verifiedUnrelatedData: true,
            };
          },
        });
        return {
          projectId: request.projectId,
          action: request.action,
          native: result,
          status:
            result.outcome === "completed"
              ? "success"
              : result.outcome === "rejected"
                ? "error"
                : "uncertain",
          changed: attempted && result.outcome !== "rejected",
          ...(result.recoveryPath ? { recoveryPath: result.recoveryPath } : {}),
          message:
            result.outcome === "completed"
              ? pull
                ? "Изменения подтянуты штатным Git; fast-forward и сохранность правок проверены."
                : "Remote-ветки обновлены; рабочие файлы, индекс и локальные ветки сохранены и проверены."
              : result.outcome === "rejected"
                ? "Git отказал в обновлении; состояние сохранено и проверено."
                : "Результат обновления не подтверждён. Материалы восстановления сохранены; повтор запрещён.",
          log: sanitizeRepositoryLog(lines.join("\n"), [remote.endpoint]),
        };
      });
    } catch (error) {
      return {
        projectId: request.projectId,
        action: request.action,
        status: attempted ? "uncertain" : "error",
        changed: attempted,
        message: sanitizeRepositoryLog(
          error instanceof Error ? error.message : "Обновление не выполнено.",
          ticket.remote ? [ticket.remote.endpoint] : [],
        ),
        log: "Внешний контекст операции завершился ошибкой; диагностика окружения скрыта.",
      };
    }
  }
  private async executeNativeMerge(ticket: Plan): Promise<GitBranchResult> {
    const { request, preview } = ticket;
    let attempted = false;
    const lines: string[] = [];
    try {
      return await this.options.context(request.projectId, async (ctx) => {
        if (ctx.ownerKey !== ticket.ownerKey || !ticket.native) throw stale();
        const before = await this.capture(ctx, request.projectId);
        if (before.fingerprint !== ticket.state.fingerprint) throw stale();
        const admitted = await this.validate(ctx, request, before);
        if (admitted.attributes !== ticket.attributes) throw stale();
        const guard = await this.nativeGuard(
          ctx,
          before,
          ticket.native.paths,
          preview.sourceOid!,
        );
        const expectedHead = (await this.isAncestor(
          ctx,
          before.snapshot.head!,
          preview.sourceOid!,
        ))
          ? preview.sourceOid!
          : (await this.isAncestor(
                ctx,
                preview.sourceOid!,
                before.snapshot.head!,
              ))
            ? before.snapshot.head
            : null;
        const overrides = [
          [`branch.${before.snapshot.branch!}.mergeOptions`, ""],
          ["rerere.enabled", "false"],
          ["rerere.autoupdate", "false"],
          ["merge.autoStash", "false"],
        ] as [string, string][];
        const client = await ctx.native!.client([
          ...before.config,
          ...overrides,
        ]);
        const result = await guard.journal.execute({
          deferRecoveryCleanup: deferNativeGitRecovery,
          token: ticket.native.token,
          intentFingerprint: ticket.native.intent,
          operation: "merge",
          capture: guard.capture,
          run: () =>
            this.withMetadataLock(ctx, "config.lock", async () => {
              // Native merge-tree may write immutable objects: it too is after the
              // durable intent, not an unjournalled trial mutation during prepare.
              try {
                const probing: GitMergeContext = {
                  ...ctx,
                  git: async (args, stdin) => {
                    const at = args.indexOf("merge-tree");
                    if (at < 0) return ctx.git(args, stdin);
                    const output = await client.run({
                      policy: "local-write",
                      command: "merge-tree",
                      args: args.slice(at + 1),
                    });
                    if (output.exitCode !== 0)
                      throw new CommandExitError(
                        "Git merge-tree отказал в подготовке.",
                        output.exitCode,
                        output.stdout.toString("utf8"),
                        output.stderr.toString("utf8"),
                      );
                    return {
                      stdout: output.stdout.toString("utf8"),
                      stderr: output.stderr.toString("utf8"),
                    };
                  },
                };
                const destinations = await this.protectMergeDestinations(
                  probing,
                  before,
                  preview.sourceOid!,
                  overrides.flatMap(([k, v]) => ["-c", k + "=" + v]),
                );
                if (
                  (await this.capture(ctx, request.projectId)).fingerprint !==
                    before.fingerprint ||
                  (await this.mergeAttributes(
                    ctx,
                    before.snapshot.head!,
                    preview.sourceOid!,
                    destinations.incoming,
                  )) !== ticket.attributes
                )
                  throw stale();
                await this.checkMergeDestinations(ctx, {
                  ...destinations,
                  tracked: new Set([
                    ...destinations.current,
                    ...(await this.indexPaths(ctx)),
                  ]),
                });
              } catch (error) {
                if (error instanceof ByteCommandError) throw error;
                lines.push(
                  error instanceof Error
                    ? error.message
                    : "Проверка перед слиянием не пройдена.",
                );
                throw new NativeGitPreflightRejection(lines.at(-1));
              }
              attempted = true;
              const output = await client.run({
                policy: "local-write",
                command: "merge",
                args: [
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
              });
              lines.push(
                output.stdout.toString("utf8"),
                output.stderr.toString("utf8"),
              );
              return output;
            }),
          verify: async (baseline, after, command) => {
            const actual = await this.capture(ctx, request.projectId);
            if (
              actual.snapshot.branch !== before.snapshot.branch ||
              JSON.stringify(baseline.files) !== JSON.stringify(after.files)
            )
              throw stale();
            const unaffectedRefs = (s: State) => [
              s.inventory.local.filter(
                (r) => r.ref !== `refs/heads/${before.snapshot.branch}`,
              ),
              s.inventory.remote,
            ];
            if (
              JSON.stringify(unaffectedRefs(actual)) !==
              JSON.stringify(unaffectedRefs(before))
            )
              throw stale();
            const conflicts = actual.snapshot.files
              .filter((f) => f.kind === "conflict")
              .map((f) => f.path);
            if (
              command.exitCode === 1 &&
              conflicts.length &&
              actual.snapshot.operation === "merge" &&
              after.head === baseline.head
            ) {
              if (
                oid(
                  (
                    await this.git(ctx, [
                      "rev-parse",
                      "--verify",
                      "MERGE_HEAD^{commit}",
                    ])
                  ).stdout.trim(),
                ) !== preview.sourceOid
              )
                throw stale();
              return {
                outcome: "conflicts",
                afterHead: after.head,
                conflicts,
                verifiedUnrelatedData: true,
              };
            }
            if (
              command.exitCode !== 0 &&
              actual.snapshot.operation === "merge" &&
              conflicts.length === 0 &&
              after.head === baseline.head
            ) {
              if (
                oid(
                  (
                    await this.git(ctx, [
                      "rev-parse",
                      "--verify",
                      "MERGE_HEAD^{commit}",
                    ])
                  ).stdout.trim(),
                ) !== preview.sourceOid
              )
                throw stale();
              return {
                outcome: "stopped",
                afterHead: after.head,
                conflicts: [],
                verifiedUnrelatedData: true,
              };
            }
            if (
              command.exitCode !== 0 &&
              actual.snapshot.operation === "none" &&
              conflicts.length === 0 &&
              after.head === baseline.head &&
              after.index === baseline.index &&
              after.refs === baseline.refs
            )
              return {
                outcome: "rejected",
                afterHead: after.head,
                conflicts: [],
                verifiedUnrelatedData: true,
              };
            if (
              actual.snapshot.operation !== "none" ||
              conflicts.length ||
              !after.head
            )
              throw stale();
            if (
              expectedHead
                ? after.head !== expectedHead
                : (
                    await this.git(ctx, [
                      "rev-list",
                      "--parents",
                      "-n",
                      "1",
                      after.head,
                    ])
                  ).stdout.trim() !==
                  [after.head, baseline.head, preview.sourceOid].join(" ")
            )
              throw stale();
            return {
              outcome: "completed",
              afterHead: after.head,
              conflicts: [],
              verifiedUnrelatedData: true,
            };
          },
        });
        return {
          projectId: request.projectId,
          action: request.action,
          native: result,
          status:
            result.outcome === "completed"
              ? "success"
              : result.outcome === "conflicts"
                ? "conflict"
                : result.outcome === "rejected"
                  ? "error"
                  : "uncertain",
          changed: attempted && result.outcome !== "rejected",
          conflictCount: result.conflicts.length,
          ...(result.recoveryPath ? { recoveryPath: result.recoveryPath } : {}),
          message:
            result.outcome === "completed"
              ? "Слияние завершено; результат проверен. Публикация не выполнялась."
              : result.outcome === "rejected"
                ? "Git отказал в слиянии; ветка и изменения сохранены и проверены. Повтор и сброс не выполнялись."
                : result.outcome === "conflicts"
                  ? "Слияние остановлено на конфликтах. Исходные данные сохранены; разрешите конфликты или подтвердите отмену."
                  : "Результат слияния не подтверждён. Материалы восстановления сохранены; повтор запрещён.",
          log: (ctx.sanitizeDiagnostics ?? sanitizeRepositoryLog)(
            lines.join("\n"),
          ),
        };
      });
    } catch (error) {
      return {
        projectId: request.projectId,
        action: request.action,
        status: attempted ? "uncertain" : "error",
        changed: attempted,
        message: sanitizeRepositoryLog(
          error instanceof Error ? error.message : "Слияние не выполнено.",
        ),
        log: "Внешний контекст операции завершился ошибкой; диагностика окружения скрыта.",
      };
    }
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
  async execute(input: string): Promise<GitBranchResult> {
    return withNativeGitCompletion(() => this.executeInCompletion(input));
  }
  private async executeInCompletion(input: string): Promise<GitBranchResult> {
    const token = gitBranchTokenSchema.parse(input),
      ticket = this.tickets.get(token);
    this.tickets.delete(token);
    if (!ticket || ticket.preview.expiresAt <= this.now()) throw stale();
    const { request, preview } = ticket;
    if (
      request.action === "create" ||
      request.action === "switch-local" ||
      request.action === "switch-remote"
    )
      return this.executeNativeLocal(ticket);
    if (request.action === "merge") return this.executeNativeMerge(ticket);
    if (request.action === "fetch" || request.action === "pull")
      return this.executeNativeFetch(ticket);
    if (request.action === "abort-merge") {
      if (!ticket.mergeToken) throw stale();
      const result = await this.nativeMerges.execute(ticket.mergeToken);
      return { ...result, projectId: request.projectId, action: "abort-merge" };
    }
    throw stale();
  }
}

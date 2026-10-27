import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { lstat, open, readlink, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import type { Project } from "../shared/types";
import type {
  TopicBoardSnapshot,
  TopicCatalogSnapshot,
  TopicDetails,
  TopicOperationRequest,
  TopicOperationPlan,
  TopicOperationResult,
  TopicTarget,
} from "../shared/topics";
import {
  topicYearSchema,
  topicTargetSchema,
  topicOperationSchema,
  topicRecordsSchema,
  topicEntriesSchema,
  topicTokenSchema,
} from "../shared/topics-schema";
import { assertReadActive } from "./read-scope";
import { digest, atomicWrite, noSymlinks } from "./settings";
import {
  guardedProject,
  readWorkingTask,
  readCommittedTask,
  taskPath,
  taskDocument,
  validateTaskText,
} from "./topic-task";
export interface TopicsContext {
  /** Host-only read-only preview; never used by execute. */
  deletionSwitchFrom?: string;
  project: Project;
  root?: string;
  owner?: import("../shared/worktrees").TopicContextRef;
  gitEnv?: NodeJS.ProcessEnv;
  git: (args: string[]) => Promise<string>;
  goga: (args: string[], stdin?: string) => Promise<string>;
  fingerprint: () => Promise<string>;
  baseRef: () => Promise<string>;
  active: () => boolean;
  /** Host registry gate for primary update/deletion; never substitutes an owner context. */
  assertPrimaryOwnerAvailable?: (
    request: TopicOperationRequest,
  ) => Promise<void>;
  assertBranchesAvailable?: (
    branches: string[],
    operation: TopicOperationRequest["action"],
  ) => Promise<void>;
}
const normalize = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^\x00-\x7f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const short = (name: string) => name.slice(name.indexOf("/") + 1);
interface Ref {
  full: string;
  name: string;
  remote: boolean;
  commit: string;
}
interface State {
  refs: Ref[];
  current: string;
  dirty: boolean;
  revision: string;
}
interface Command {
  args: string[];
  stdin?: string;
}
interface Prepared {
  guards: string[];
  request: TopicOperationRequest;
  plan: TopicOperationPlan;
  commands: Command[];
  save?: { relative: string; text: string };
}
const stale = () =>
  new Error(
    "Подтверждение устарело: проект, ветки, задача или настройки изменились. Обновите данные.",
  );
/** A read raced repository changes; never use this as a mutation retry signal. */
class TopicSnapshotChangedError extends Error {
  constructor() {
    super(
      "Данные проекта меняются во время загрузки топиков. Повторите загрузку через несколько секунд.",
    );
    this.name = "TopicSnapshotChangedError";
  }
}
async function refs(d: Pick<TopicsContext, "git">): Promise<Ref[]> {
  const raw = await d.git([
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(symref)",
    "refs/heads",
    "refs/remotes",
  ]);
  return raw
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [full, commit, symref] = line.split("\0");
      if (!full || !commit || !/^[a-f0-9]{40,64}$/.test(commit))
        throw Error("Некорректный каталог Git refs");
      if (symref || full.endsWith("/HEAD")) return [];
      const remote = full.startsWith("refs/remotes/");
      return [{ full, commit, remote, name: full.slice(remote ? 13 : 11) }];
    });
}
/** Names only; deliberately no state fingerprint, Goga, base config or clone inventory. */
export async function readBranchChoices(git: TopicsContext["git"]) {
  const inventory = await refs({ git });
  return {
    branches: inventory.map((r) => r.name),
    localBranches: inventory.filter((r) => !r.remote).map((r) => r.name),
  };
}
// A bounded buffer, not a bounded file: unrelated large files must not hide
// read-only boards. Pin the descriptor and verify its identity/metadata so a
// concurrent replacement or edit cannot yield a falsely stable fingerprint.
async function workingFileDigest(file: string): Promise<string> {
  await noSymlinks(file);
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new TopicSnapshotChangedError();
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - offset),
        offset,
      );
      if (!bytesRead) throw new TopicSnapshotChangedError();
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat(),
      current = await lstat(file);
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      current.size !== before.size ||
      current.mtimeMs !== before.mtimeMs ||
      current.ctimeMs !== before.ctimeMs ||
      current.isSymbolicLink()
    )
      throw new TopicSnapshotChangedError();
    await noSymlinks(file);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}
async function state(d: TopicsContext, year: string): Promise<State> {
  await guardedProject(d.root ?? d.project.path);
  const [
    inventory,
    current,
    status,
    diff,
    cached,
    untracked,
    config,
    gitConfig,
    allRefs,
  ] = await Promise.all([
    refs(d),
    d.git(["branch", "--show-current"]),
    d.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    d.git(["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--"]),
    d.git([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--binary",
      "--cached",
      "--",
    ]),
    d.git(["ls-files", "--others", "--exclude-standard", "-z"]),
    d.fingerprint(),
    d.git(["config", "--null", "--list", "--show-origin"]),
    d.git(["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)"]),
  ]);
  const extra: string[] = [];
  for (const name of untracked.split("\0").filter(Boolean)) {
    const file = path.resolve(d.root ?? d.project.path, name);
    if (!file.startsWith((d.root ?? d.project.path) + path.sep))
      throw Error("Некорректный путь Git");
    const info = await lstat(file);
    if (info.isSymbolicLink()) extra.push(name, await readlink(file));
    else if (info.isFile()) {
      extra.push(name, await workingFileDigest(file));
    } else extra.push(name, String(info.mtimeMs));
  }
  // Ignored current task also belongs to the stale guard.
  const own = normalize(current.trim());
  const task = own
    ? await readWorkingTask(d.root ?? d.project.path, taskPath(own, year))
    : null;
  return {
    refs: inventory,
    current: current.trim(),
    dirty: !!status,
    revision: digest(
      JSON.stringify([
        d.project,
        year,
        inventory,
        current,
        status,
        diff,
        cached,
        extra,
        config,
        gitConfig,
        allRefs,
        task,
      ]),
    ),
  };
}
/** A successful native catalog read proved only this exact target absent. */
export class TopicCatalogMissingError extends Error {
  constructor() {
    super("Топик отсутствует. Обновите каталог.");
    this.name = "TopicCatalogMissingError";
  }
}
export class TopicsDomain {
  private tickets = new Map<string, Prepared>();
  scopeForToken(token: string) {
    const id = this.projectForToken(token);
    return this.tickets.get(token)?.request.context ?? id;
  }
  projectForToken(token: string) {
    topicTokenSchema.parse(token);
    const ticket = this.tickets.get(token);
    if (!ticket || Date.now() >= ticket.plan.expiresAt) {
      this.tickets.delete(token);
      throw stale();
    }
    return ticket.request.projectId;
  }
  async catalog(
    d: Pick<TopicsContext, "project" | "goga">,
    year: string,
  ): Promise<TopicCatalogSnapshot> {
    topicYearSchema.parse(year);
    assertReadActive();
    await guardedProject(d.project.path);
    assertReadActive();
    const raw = await d.goga(["topics", "--year", year, "board", "--json"]);
    assertReadActive();
    let rows;
    try {
      rows = topicEntriesSchema.parse(JSON.parse(raw));
    } catch {
      throw Error("Goga вернула некорректный JSON каталог топиков");
    }
    // The aggregated board already defines logical entries; per-host history
    // and clone inventories are deliberately not consulted for this display.
    const entries = new Map<string, TopicTarget>();
    const current = new Map<string, TopicTarget>();
    for (const row of rows) {
      if (row.remote) continue;
      const target = { topic: row.topic, branch: row.branch, remote: false };
      const key = JSON.stringify([target.topic, target.branch]);
      entries.set(key, target);
      if (row.current && normalize(row.branch) === row.topic)
        current.set(key, target);
    }
    await guardedProject(d.project.path);
    assertReadActive();
    return {
      projectId: d.project.id,
      year,
      entries: [...entries.values()],
      currentTopic: current.size === 1 ? [...current.values()][0]! : null,
    };
  }
  async board(d: TopicsContext, year: string): Promise<TopicBoardSnapshot> {
    topicYearSchema.parse(year);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.boardSnapshot(d, year);
      } catch (error) {
        if (!(error instanceof TopicSnapshotChangedError) || attempt >= 2)
          throw error;
        // Finalization may still be writing. Restart the complete read, never
        // accept a mixed snapshot or retry a prepared mutation/confirmation.
        await delay(100 * (attempt + 1));
      }
    }
  }
  private async boardSnapshot(
    d: TopicsContext,
    year: string,
  ): Promise<TopicBoardSnapshot> {
    const before = await state(d, year);
    const args = ["topics", "--year", year, "board", "--json"];
    let entries, records, remoteEntries, remoteRecords;
    try {
      const raw = await Promise.all([
        d.goga(args),
        d.goga([...args, "--per-host"]),
        d.goga([...args, "--remote"]),
        d.goga([...args, "--remote", "--per-host"]),
      ]);
      entries = topicEntriesSchema.parse(JSON.parse(raw[0]!));
      records = topicRecordsSchema.parse(JSON.parse(raw[1]!));
      remoteEntries = topicEntriesSchema.parse(JSON.parse(raw[2]!));
      remoteRecords = topicRecordsSchema.parse(JSON.parse(raw[3]!));
    } catch (error) {
      if (error instanceof SyntaxError || (error as Error).name === "ZodError")
        throw Error("Goga вернула некорректный JSON каталог топиков");
      throw error;
    }
    const after = await state(d, year);
    if (before.revision !== after.revision)
      throw new TopicSnapshotChangedError();
    const own = records.find(
      (r) =>
        !r.remote &&
        r.branch === after.current &&
        r.topic === normalize(after.current),
    );
    return {
      projectId: d.project.id,
      year,
      revision: after.revision,
      currentBranch: after.current,
      currentTopic: own
        ? { topic: own.topic, branch: own.branch, remote: false }
        : null,
      baseRef: await d.baseRef(),
      branches: after.refs.map((r) => r.name),
      localBranches: after.refs.filter((r) => !r.remote).map((r) => r.name),
      dirty: after.dirty,
      active: d.active(),
      entries,
      records,
      remoteEntries,
      remoteRecords,
    };
  }
  async details(
    d: TopicsContext,
    year: string,
    target: TopicTarget,
  ): Promise<TopicDetails> {
    topicYearSchema.parse(year);
    topicTargetSchema.parse(target);
    const before = await state(d, year);
    const board = await this.board(d, year);
    const exactRows = (snapshot: TopicBoardSnapshot) =>
      (target.remote ? snapshot.remoteRecords : snapshot.records).filter(
        (r) =>
          r.topic === target.topic &&
          r.branch === target.branch &&
          r.remote === target.remote,
      );
    const rows = exactRows(board);
    if (rows.length > 1) throw Error("Топик неоднозначен. Обновите каталог.");
    const ownedCurrent =
      !!d.owner &&
      !target.remote &&
      d.owner.projectId === d.project.id &&
      d.owner.year === year &&
      d.owner.topic === target.topic &&
      d.owner.branch === target.branch &&
      before.current === target.branch &&
      normalize(target.branch) === target.topic;
    if (!rows.length && !ownedCurrent) throw new TopicCatalogMissingError();
    const catalogState = !rows.length
      ? ("missing-local-metadata" as const)
      : undefined;
    const ref = before.refs.find(
      (r) => r.name === target.branch && r.remote === target.remote,
    );
    if (!ref) throw Error("Ветка отсутствует. Обновите каталог.");
    const own =
      normalize(target.remote ? short(target.branch) : target.branch) ===
      target.topic;
    const current = !target.remote && before.current === target.branch && own;
    const relative = taskPath(target.topic, year);
    let taskStamp: string | undefined;
    const value = current
      ? await readWorkingTask(d.root ?? d.project.path, relative, (stamp) => {
          taskStamp = stamp;
        })
      : await readCommittedTask(
          d.root ?? d.project.path,
          ref.commit,
          relative,
          d.git,
          d.gitEnv,
        );
    const after = await this.board(d, year);
    if (
      after.revision !== before.revision ||
      JSON.stringify(exactRows(after)) !== JSON.stringify(rows)
    )
      throw stale();
    if (current) {
      let stamp: string | undefined;
      await readWorkingTask(d.root ?? d.project.path, relative, (value) => {
        stamp = value;
      });
      if (stamp !== taskStamp) throw stale();
    }
    const document = taskDocument(
      d.root ?? d.project.path,
      target.branch,
      ref.commit,
      relative,
      { ...value, ...(catalogState ? { catalogState } : {}) },
    );
    return {
      projectId: d.project.id,
      year,
      target,
      ...(catalogState ? { catalogState } : {}),
      ...value,
      version: document.version,
      editable: current && !d.active(),
      ...(!current
        ? {
            reason: target.remote
              ? "Удалённая ветка: задача доступна только для чтения. Переключитесь на локальную собственную ветку топика."
              : !own
                ? "Это размещённая история другого топика. Редактирование возможно только в собственной текущей ветке."
                : "Для редактирования сначала переключитесь на собственную ветку топика.",
          }
        : d.active()
          ? {
              reason:
                "Во время активного запуска задача доступна только для чтения.",
            }
          : {}),
    };
  }
  async prepare(
    d: TopicsContext,
    input: TopicOperationRequest,
  ): Promise<TopicOperationPlan> {
    const request = topicOperationSchema.parse(input);
    const prepared = await this.resolve(d, request);
    for (const [token, ticket] of this.tickets)
      if (Date.now() >= ticket.plan.expiresAt) this.tickets.delete(token);
    if (this.tickets.size >= 100)
      this.tickets.delete(this.tickets.keys().next().value!);
    this.tickets.set(prepared.plan.token, prepared);
    return prepared.plan;
  }
  private async resolve(
    d: TopicsContext,
    r: TopicOperationRequest,
  ): Promise<Prepared> {
    if (d.active())
      throw Error(
        "В репозитории работает конвейер. Остановите его перед изменением топиков.",
      );
    const board = await this.board(d, r.year);
    if (board.revision !== r.expectedRevision) throw stale();
    const s = await state(d, r.year);
    if (s.revision !== r.expectedRevision) throw stale();
    if (r.task !== undefined) validateTaskText(r.task);
    const prefix = ["topics", "--year", r.year],
      commands: Command[] = [],
      details: string[] = [],
      guards: string[] = [];
    let save: Prepared["save"];
    // Independent switch/current update require a clean worktree. Native create
    // protects checkout conflicts itself and can preserve unrelated dirty work.
    // Other-topic deletion and update are checkout-free; their own target/base
    // checks and fresh confirmation guards still apply below.
    const dirtyUnsafe =
      r.action === "switch" ||
      (r.action === "update" &&
        !r.target?.remote &&
        r.target?.branch === s.current);
    if (s.dirty && dirtyUnsafe)
      throw Error(
        "В рабочей копии есть незакоммиченные изменения (dirty). Сохраните их перед операцией.",
      );
    const ensureBase = async () => {
      const base = r.baseRef || board.baseRef;
      if (!base || base.startsWith("-") || /[\x00-\x20]/.test(base))
        throw Error("Выберите базовую ветку");
      await d.git(["rev-parse", "--verify", `${base}^{commit}`]);
      return base;
    };
    if (r.action === "create") {
      if (!r.branch) throw Error("Укажите имя ветки");
      await d.git(["check-ref-format", "--branch", r.branch]);
      await d.assertBranchesAvailable?.([r.branch], r.action);
      const slug = normalize(r.branch);
      if (!slug) throw Error("Имя ветки не образует допустимый топик");
      if (
        s.refs.some(
          (ref) => normalize(ref.remote ? short(ref.name) : ref.name) === slug,
        ) ||
        [...board.records, ...board.remoteRecords].some(
          (row) => row.topic === slug,
        )
      )
        throw Error("Топик или ветка уже существует");
      await noSymlinks(
        path.join(d.root ?? d.project.path, ".goga/history", r.year, slug),
      );
      try {
        await lstat(
          path.join(d.root ?? d.project.path, ".goga/history", r.year, slug),
        );
        throw Error("Каталог топика уже существует");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const base = await ensureBase();
      if ((r.publish || !r.switch) && !r.task)
        throw Error(
          "Для публикации или создания без переключения требуется задача",
        );
      if (r.commit && !r.publish)
        throw Error("--commit действует только при публикации");
      const args = [
        ...prefix,
        "create",
        r.branch,
        "--base-ref",
        base,
        ...(r.publish ? ["--publish"] : r.switch ? ["--switch"] : []),
        ...(r.commit ? ["--commit", r.commit] : []),
        ...(r.task ? ["--todo"] : []),
      ];
      commands.push({ args, ...(r.task ? { stdin: r.task } : {}) });
      details.push(
        `Создать ${r.branch} (${r.year}/${slug}) от ${base}.`,
        r.publish
          ? "Создать коммит задачи и опубликовать ветку в origin."
          : r.switch
            ? "Переключить ветку; задача останется незакоммиченной."
            : "Создать локальный коммит задачи без переключения.",
      );
      if (r.publish && r.switch) {
        commands.push({ args: [...prefix, "switch", r.branch] });
        details.push(
          "После публикации отдельно переключиться. Если переключение не удастся, опубликованная ветка останется.",
        );
      }
    } else if (r.action === "save-task") {
      if (!r.target || r.task === undefined || !r.taskVersion)
        throw Error("Отсутствует задача или её версия");
      const doc = await this.details(d, r.year, r.target);
      if (!doc.editable) throw Error(doc.reason);
      if (
        doc.catalogState === "missing-local-metadata" &&
        !doc.exists &&
        !r.task.trim()
      )
        throw Error(
          "Введите непустое описание задачи для создания локальных данных.",
        );
      if (doc.version !== r.taskVersion) throw stale();
      save = { relative: taskPath(r.target.topic, r.year), text: r.task };
      details.push(
        `Записать ${save.relative} в текущей ветке ${r.target.branch}. Без коммита и публикации.`,
      );
      if (!r.task.trim()) details.push("Задача будет полностью очищена.");
    } else if (r.action === "delete") {
      await d.assertPrimaryOwnerAvailable?.(r);
      const topics = [
        ...new Set(r.topics ?? (r.target ? [r.target.topic] : [])),
      ];
      if (!topics.length) throw Error("Выберите топики для удаления");
      await this.deletion(d, r.year, s, topics, details, guards);
      commands.push({ args: [...prefix, "delete", ...topics, "--yes"] });
      details.push(
        "Удаление без корзины. Ранее удалённые топики не восстанавливаются при ошибке следующего.",
      );
    } else {
      if (!r.target) throw Error("Выберите топик");
      if (r.action === "update") await d.assertPrimaryOwnerAvailable?.(r);
      if (
        ![...board.records, ...board.remoteRecords].some(
          (row) =>
            row.topic === r.target!.topic &&
            row.branch === r.target!.branch &&
            row.remote === r.target!.remote,
        )
      )
        throw Error("Топик отсутствует");
      if (
        normalize(
          r.target.remote ? short(r.target.branch) : r.target.branch,
        ) !== r.target.topic
      )
        throw Error(
          "Операция доступна только для собственной ветки топика, не размещённой истории",
        );
      if (r.target.remote && r.action !== "switch")
        throw Error("Операция требует локальную собственную ветку топика");
      const own = s.refs.filter(
        (ref) =>
          normalize(ref.remote ? short(ref.name) : ref.name) ===
            r.target!.topic && !ref.remote,
      );
      if (own.length > 1)
        throw Error("Неоднозначный топик: несколько собственных веток");
      if (
        r.target.remote &&
        (own.length ||
          s.refs.some((ref) => !ref.remote && ref.name === r.target!.branch))
      )
        throw Error(
          "Неоднозначное переключение: существует локальная ветка с тем же именем. Выберите локальную ветку.",
        );
      const identifier = r.target.branch;
      const args = [...prefix, r.action, identifier];
      if (r.action === "switch" || r.action === "update")
        await d.assertBranchesAvailable?.(
          [r.target.remote ? short(identifier) : identifier],
          r.action,
        );
      if (r.action === "update" || r.action === "propagate") {
        const base = await ensureBase();
        // Mirror Goga exchange._base_branch_names: a literal local
        // "origin/..." branch wins over the remote shorthand. HEAD, full
        // refs, tags and hashes are pinned revisions, not branch aliases.
        const localSpelling = s.refs.some(
          (ref) => !ref.remote && ref.name === base,
        );
        const originAlias = base.startsWith("origin/") && !localSpelling;
        const localBase = originAlias ? short(base) : base;
        const twin = originAlias ? base : `origin/${base}`;
        const branchShaped = s.refs.some((ref) =>
          ref.remote ? ref.name === twin : ref.name === localBase,
        );
        if (branchShaped && localBase === s.current)
          throw Error(
            `Базовая ветка «${localBase}» сейчас текущая. Сначала переключитесь на ветку топика или другую ветку.`,
          );
        if (r.action === "propagate" && branchShaped)
          await d.assertBranchesAvailable?.([localBase], r.action);
        args.push("--base-ref", base);
        details.push(`Базовая ветка: ${base}.`);
      }
      if (r.action === "update" && r.publish) args.push("--publish");
      if (r.action === "propagate") {
        args.push("--yes");
        details.push(
          "Включить топик в базовую ветку и отправить базовую ветку в origin (push).",
        );
      }
      if (r.action === "publish" || (r.action === "update" && r.publish))
        details.push(`Отправить ветку ${identifier} в origin (push).`);
      if (s.dirty && (r.action === "publish" || r.action === "propagate"))
        details.push(
          "Только коммиты. Незакоммиченные изменения не включаются и остаются в рабочей копии.",
        );
      details.unshift(`${r.action}: ${r.target.topic} → ${identifier}.`);
      commands.push({ args });
    }
    if ((await state(d, r.year)).revision !== s.revision) throw stale();
    return {
      guards,
      request: r,
      commands,
      save,
      plan: {
        token: randomUUID(),
        projectId: r.projectId,
        year: r.year,
        action: r.action,
        title: {
          create: "Создание топика",
          switch: "Переключение ветки",
          "save-task": "Сохранение задачи",
          update: "Обновление топика",
          publish: "Публикация в origin",
          propagate: "Включение в базовую ветку",
          delete: "Удаление топиков",
        }[r.action],
        details,
        expiresAt: Date.now() + 5 * 60 * 1000,
      },
    };
  }
  private async deletion(
    d: TopicsContext,
    year: string,
    s: State,
    topics: string[],
    details: string[],
    guards: string[],
  ) {
    const prefix = `.goga/history/${year}/`;
    const hosted = new Map<string, Set<string>>();
    for (const ref of s.refs) {
      const paths = await d.git([
        "ls-tree",
        "-r",
        "--name-only",
        "-z",
        ref.commit,
        "--",
        prefix,
      ]);
      hosted.set(
        ref.full,
        new Set(
          paths
            .split("\0")
            .filter((p) => p.startsWith(prefix))
            .map((p) => p.slice(prefix.length).split("/")[0]!),
        ),
      );
    }
    for (const topic of topics) {
      if (normalize(s.current) === topic && d.deletionSwitchFrom !== s.current)
        throw Error(
          "Нельзя удалить топик текущей ветки. Сначала переключитесь.",
        );
      const own = s.refs.filter(
          (r) => normalize(r.remote ? short(r.name) : r.name) === topic,
        ),
        local = own.filter((r) => !r.remote),
        origin = own.filter((r) => r.remote && r.name.startsWith("origin/"));
      if (local.length > 1 || origin.length > 1)
        throw Error("Неоднозначный топик: несколько собственных веток");
      if (local.length)
        await d.assertBranchesAvailable?.(
          local.map((ref) => ref.name),
          "delete",
        );
      const directory = path.join(d.root ?? d.project.path, prefix, topic);
      await noSymlinks(directory);
      let disk = false;
      try {
        disk = (await lstat(directory)).isDirectory();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const carried = s.refs.some((r) => hosted.get(r.full)!.has(topic));
      if (!own.length && carried)
        throw Error(
          "Топик не имеет собственной ветки: это история, удалять нечего",
        );
      if (!carried && !disk) throw Error("Топик отсутствует");
      // Match the CLI first (exact branch-name) tier. Never allow it to widen a slug into other hosted topics.
      const exact = s.refs.filter(
        (r) => (r.remote ? short(r.name) : r.name) === topic,
      );
      const matched = new Set(exact.flatMap((r) => [...hosted.get(r.full)!]));
      if (matched.size > 1 || (matched.size === 1 && !matched.has(topic)))
        throw Error(
          "Неоднозначный идентификатор удаления: ветка содержит другие топики",
        );
      const survivors = s.refs.filter((r) => r !== local[0] && r !== origin[0]);
      const removeDir =
        disk && !survivors.some((r) => hosted.get(r.full)!.has(topic));
      if (!local.length && !origin.length && !removeDir)
        throw Error(
          "Для топика нет удаляемой локальной ветки или origin-двойника",
        );
      // Guard the entire removable directory, not only todo.md: CLI recursively removes it.
      if (removeDir) guards.push(await this.guardDirectory(directory));
      details.push(
        `${topic}: локальная ветка ${local[0]?.name ?? "отсутствует"}; удалённая ветка origin/${origin[0] ? short(origin[0].name) : "(отсутствует)"}.`,
        removeDir
          ? `Удалить каталог ${prefix}${topic}.`
          : `Каталог ${prefix}${topic} сохраняется: отсутствует или есть другие ветки-носители.`,
      );
    }
  }
  private async guardDirectory(directory: string, depth = 0): Promise<string> {
    if (depth > 32) throw Error("Каталог топика слишком глубок");
    await noSymlinks(directory);
    const parts: string[] = [];
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name),
        info = await lstat(file);
      if (entry.isSymbolicLink())
        throw Error("Ссылки в удаляемом каталоге топика не поддержаны");
      parts.push(
        entry.name,
        JSON.stringify([
          info.ino,
          info.dev,
          info.size,
          info.mtimeMs,
          info.ctimeMs,
        ]),
      );
      if (entry.isDirectory())
        parts.push(await this.guardDirectory(file, depth + 1));
    }
    return digest(JSON.stringify(parts));
  }
  async execute(
    d: TopicsContext,
    token: string,
  ): Promise<TopicOperationResult> {
    if (d.deletionSwitchFrom)
      throw Error(
        "Предпросмотр переключения не разрешает выполнение удаления.",
      );
    const id = this.projectForToken(token),
      ticket = this.tickets.get(token)!;
    this.tickets.delete(token);
    if (id !== d.project.id) throw stale();
    const fresh = await this.resolve(d, ticket.request);
    if (
      JSON.stringify([
        fresh.commands,
        fresh.save,
        fresh.plan.details,
        fresh.guards,
      ]) !==
      JSON.stringify([
        ticket.commands,
        ticket.save,
        ticket.plan.details,
        ticket.guards,
      ])
    )
      throw stale();
    // Recheck after all Git/file validation, outside the mutation error handler:
    // an owner appearing after preview is a rejected admission, not a partial mutation.
    if (["delete", "update"].includes(ticket.request.action))
      await d.assertPrimaryOwnerAvailable?.(ticket.request);
    let completed = 0;
    try {
      if (fresh.save) {
        const file = path.join(d.root ?? d.project.path, fresh.save.relative);
        await noSymlinks(file);
        await atomicWrite(file, fresh.save.text);
      }
      for (const command of fresh.commands) {
        await d.goga(command.args, command.stdin);
        completed++;
      }
      return {
        projectId: id,
        status: "success",
        message: "Операция выполнена. Обновите доску для просмотра состояния.",
      };
    } catch {
      // Local refs cannot prove that an origin push failed before taking effect.
      const remoteUncertain =
        ["publish", "propagate", "delete"].includes(ticket.request.action) ||
        ticket.request.publish === true;
      let changed = completed > 0 || remoteUncertain;
      try {
        // Diagnostics must not refresh the real index after the failed command:
        // a handoff may already pin its physical identity for confirmation.
        const diagnostic = {
          ...d,
          git: (args: string[]) => d.git(["--no-optional-locks", ...args]),
        };
        changed ||=
          (await state(diagnostic, ticket.request.year)).revision !==
          ticket.request.expectedRevision;
      } catch {
        changed = true;
      }
      return {
        projectId: id,
        status: changed ? "partial" : "failed",
        message: changed
          ? "Команда завершилась ошибкой. Возможны частичные изменения; автоматического отката нет. Обновите доску и проверьте локальные ветки и origin."
          : "Команда завершилась ошибкой. Изменений локального снимка не обнаружено; проверьте состояние репозитория и настройки Goga.",
      };
    }
  }
}

import { randomUUID } from "node:crypto";
import {
  topicRemovalRequestSchema,
  topicRemovalTokenSchema,
  type TopicRemovalRequest,
  type TopicRemovalPreview,
  type TopicRemovalResult,
} from "../shared/topic-removal";
import {
  worktreeContextRef,
  type TopicContextRef,
  type WorktreeRecord,
} from "../shared/worktrees";
import type { ContextDeletionPreview } from "../shared/context-deletion";
import type { TopicOperationResult } from "../shared/topics";
import type { CloneRemovalBaseline, WholeCopyIdentity } from "./clones";
import { assertReadActive } from "./read-scope";
import {
  normalizeTopicBranch,
  type TopicRef,
  type TopicMutationSnapshot,
} from "./topics";
type RemovalBaseline = CloneRemovalBaseline | WholeCopyIdentity;
export interface RemovalInventory {
  projectId: string;
  projectPath: string;
  year: string;
  revision: string;
  primaryState: TopicMutationSnapshot;
  refs: TopicRef[];
  owners: WorktreeRecord[];
}
export interface TopicRemovalAccess {
  inventory: () => Promise<RemovalInventory>;
  diskOnlyRemaining: (
    inventory: RemovalInventory,
    topics: string[],
  ) => Promise<Set<string>>;
  inspect: (
    owner: TopicContextRef,
    action: TopicRemovalRequest["action"],
  ) => Promise<RemovalBaseline>;
  prepareNative: (
    request: TopicRemovalRequest,
    before: RemovalInventory,
  ) => Promise<{ token: string; details: string[]; expiresAt: number } | null>;
  executeNative: (
    token: string,
    before: RemovalInventory,
  ) => Promise<TopicOperationResult>;
  prepareCleanup: (
    owner: TopicContextRef,
    baseline?: RemovalBaseline,
  ) => Promise<ContextDeletionPreview>;
}
interface Prepared {
  plan: TopicRemovalPreview;
  request: TopicRemovalRequest;
  before: RemovalInventory;
  nativeToken?: string;
  baselines: Map<string, RemovalBaseline>;
}
const stale = () =>
  Error(
    "Подтверждение удаления устарело: проект или контексты изменились. Проверьте данные заново.",
  );
export function removalInventoryKey(i: RemovalInventory) {
  return JSON.stringify([
    i.projectId,
    i.projectPath,
    i.year,
    i.revision,
    i.refs.map((r) => [r.full, r.commit]).sort(),
    i.owners
      .map((r) => [
        r.contextId,
        r.revision,
        r.projectId,
        r.projectPath,
        r.year,
        r.topic,
        r.branch,
        r.path,
        r.state,
        r.deletedAt,
      ])
      .sort(),
  ]);
}
export function ownTopicRefs(refs: TopicRef[], topic: string) {
  return refs.filter(
    (r) =>
      (!r.remote || r.name.startsWith("origin/")) &&
      normalizeTopicBranch(
        r.remote ? r.name.slice(r.name.indexOf("/") + 1) : r.name,
      ) === topic,
  );
}
/** Only coordinates two existing CLI actions and subsequent owned-copy cleanup. */
export class TopicRemovalDomain {
  private tickets = new Map<string, Prepared>();
  private receipts = new Map<string, Prepared>();
  private prune(map: Map<string, Prepared>) {
    for (const [key, p] of map)
      if (p.plan.expiresAt <= Date.now()) map.delete(key);
    while (map.size >= 100) map.delete(map.keys().next().value!);
  }
  async prepare(
    access: TopicRemovalAccess,
    input: TopicRemovalRequest,
  ): Promise<TopicRemovalPreview> {
    const parsed = topicRemovalRequestSchema.parse(input);
    const request =
      parsed.action === "delete"
        ? { ...parsed, topics: [...new Set(parsed.topics)] }
        : parsed;
    const before = await access.inventory();
    if (
      before.projectId !== request.projectId ||
      before.year !== request.year ||
      (request.expectedRevision !== undefined &&
        before.revision !== request.expectedRevision)
    )
      throw stale();
    const owners = before.owners.filter(
      (o) => request.action === "clear" || request.topics.includes(o.topic),
    );
    const baselines = new Map<string, RemovalBaseline>();
    const blocked: Array<{ topic: string; reason: string }> = [];
    for (const owner of owners) {
      assertReadActive();
      try {
        baselines.set(
          owner.contextId,
          await access.inspect(worktreeContextRef(owner), request.action),
        );
      } catch (error) {
        assertReadActive();
        if (request.action === "delete")
          blocked.push({
            topic: owner.topic,
            reason:
              error instanceof Error
                ? error.message
                : "Не удалось проверить владельца рабочей копии.",
          });
      }
    }
    assertReadActive();
    const native = await access.prepareNative(request, before);
    // This read merely grants a preview. Execution re-reads and compares the
    // inventory under the operation lock before consuming any native authority.
    assertReadActive();
    const plan: TopicRemovalPreview = {
      projectId: request.projectId,
      year: request.year,
      action: request.action,
      token: randomUUID(),
      ...(blocked.length ? { blocked } : {}),
      expiresAt: Math.min(
        native?.expiresAt ?? Date.now() + 120000,
        Date.now() + 120000,
      ),
      details: [
        ...(native?.details ?? [
          "В основной папке нет собственной ветки выбранного топика. История других веток сохраняется.",
        ]),
        ...(request.action === "clear"
          ? [
              "Копии с локальными изменениями, активными процессами или неподтверждёнными коммитами сохраняются. Ошибка команды не запускает очистку копий.",
            ]
          : []),
      ],
    };
    this.prune(this.tickets);
    this.tickets.set(plan.token, {
      plan,
      request,
      before,
      nativeToken: native?.token,
      baselines,
    });
    return plan;
  }
  take(projectId: string, token: string): Prepared {
    topicRemovalTokenSchema.parse({ projectId, token });
    const item = this.tickets.get(token);
    this.tickets.delete(token);
    if (
      !item ||
      item.plan.projectId !== projectId ||
      item.plan.expiresAt <= Date.now()
    )
      throw stale();
    return item;
  }
  async execute(
    access: TopicRemovalAccess,
    p: Prepared,
  ): Promise<TopicRemovalResult> {
    if (p.plan.blocked?.length)
      throw Error(
        "Не все выбранные топики доступны. Исключите их явно или устраните причины.",
      );
    const current = await access.inventory();
    if (removalInventoryKey(current) !== removalInventoryKey(p.before))
      throw stale();
    const owners = p.before.owners.filter(
      (o) => p.request.action === "clear" || p.request.topics.includes(o.topic),
    );
    const kept = (owner: WorktreeRecord, reason: string) => ({
      contextId: owner.contextId,
      topic: owner.topic,
      status: "kept" as const,
      reason,
    });
    let native: TopicOperationResult;
    try {
      native = p.nativeToken
        ? await access.executeNative(p.nativeToken, current)
        : {
            projectId: p.request.projectId,
            status: "success",
            message:
              "В основной папке удалять нечего; проверяем выбранные копии.",
          };
    } catch {
      native = {
        projectId: p.request.projectId,
        status: "partial",
        message:
          "Результат команды не подтверждён. Возможны частичные изменения; копии сохранены. Не повторяйте удаление автоматически.",
      };
    }
    const result: TopicRemovalResult = {
      projectId: p.request.projectId,
      topics: { status: native.status, message: native.message },
      copies: [],
      cleanup: [],
    };
    if (native.status !== "success") {
      result.copies = owners.map((o) =>
        kept(o, "Удаление топиков не подтверждено. Копия сохранена."),
      );
      return result;
    }
    let after: RemovalInventory;
    const unconfirmed = (message: string) => {
      result.topics = { status: "partial", message };
      result.copies = owners.map((o) =>
        kept(o, "Удаление не подтверждено. Копия сохранена."),
      );
      return result;
    };
    try {
      after = await access.inventory();
      if (p.request.action === "delete") {
        const topics = p.request.topics;
        const diskOnly = await access.diskOnlyRemaining(after, topics);
        const remaining = topics.filter(
          (t) => ownTopicRefs(after.refs, t).length || diskOnly.has(t),
        );
        if (remaining.length)
          return unconfirmed(
            "Удаление не подтверждено: в основной папке остались топики " +
              remaining.join(", ") +
              ".",
          );
      }
    } catch {
      if (p.request.action === "delete")
        return unconfirmed(
          "Команда завершилась, но проверить удаление выбранных топиков не удалось.",
        );
      result.copies = owners.map((o) =>
        kept(
          o,
          "Команда выполнена, но проверка результата не завершена. Копия сохранена.",
        ),
      );
      return result;
    }
    this.prune(this.receipts);
    this.receipts.set(p.plan.token, {
      ...p,
      plan: { ...p.plan, expiresAt: Date.now() + 120000 },
    });
    for (const owner of owners) {
      const beforeRefs = ownTopicRefs(p.before.refs, owner.topic),
        afterRefs = ownTopicRefs(after.refs, owner.topic);
      if (
        afterRefs.length ||
        (p.request.action === "clear" &&
          !beforeRefs.some(
            (r) =>
              r.name === owner.branch || r.name === `origin/${owner.branch}`,
          ))
      )
        continue;
      const same =
        after.projectId === p.before.projectId &&
        after.year === p.before.year &&
        after.projectPath === p.before.projectPath &&
        after.owners.some(
          (o) =>
            o.contextId === owner.contextId &&
            o.revision === owner.revision &&
            o.path === owner.path &&
            o.branch === owner.branch &&
            o.topic === owner.topic &&
            !o.deletedAt,
        );
      const baseline = p.baselines.get(owner.contextId);
      if (!same || !baseline) {
        result.copies.push(
          kept(
            owner,
            "Владелец или состояние копии не подтверждены. Копия сохранена.",
          ),
        );
        continue;
      }
      try {
        const plan = await access.prepareCleanup(
          worktreeContextRef(owner),
          baseline,
        );
        result.cleanup.push({ owner: worktreeContextRef(owner), plan });
      } catch (error) {
        result.copies.push(
          kept(
            owner,
            error instanceof Error
              ? error.message
              : "Не удалось проверить копию. Она оставлена на диске.",
          ),
        );
      }
    }
    return result;
  }
  baseline(token: string, owner: TopicContextRef): RemovalBaseline | undefined {
    const receipt = this.receipts.get(token);
    if (
      !receipt ||
      receipt.plan.expiresAt <= Date.now() ||
      !receipt.before.owners.some(
        (o) =>
          o.contextId === owner.contextId &&
          o.projectId === owner.projectId &&
          o.year === owner.year &&
          o.topic === owner.topic &&
          o.branch === owner.branch &&
          o.revision === owner.revision,
      )
    )
      throw stale();
    return receipt.baselines.get(owner.contextId);
  }
}

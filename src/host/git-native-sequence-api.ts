import type { ScopeRef } from "../shared/context";
import {
  gitRebaseOperationRequestSchema,
  type GitRebaseOperationRequest,
  type GitRebaseOperationPreview,
} from "../shared/git-rebase-operations";
import {
  gitSequencerOperationRequestSchema,
  type GitSequencerOperationRequest,
  type GitSequencerOperationPreview,
} from "../shared/git-sequencer-operations";
import { NativeGitSequence } from "./git-native-sequence";
import type { GitMergeContext } from "./git-merge-safety";
import type { NativeSequenceAPIResult } from "../shared/git-native-sequence";
/** Renderer can only prepare a follow-up. It cannot supply start args, receipt,
 * owner, journal path, or turn external Git state into a Desktop operation. */
export class NativeGitSequenceAPI {
  private readonly engine: NativeGitSequence;
  private readonly pending = new Map<
    string,
    {
      scope: ScopeRef;
      operation: "rebase" | "cherry-pick" | "revert";
      action: "continue" | "abort";
      expiresAt: number;
    }
  >();
  constructor(options: {
    context<T>(
      scope: ScopeRef,
      action: (c: GitMergeContext) => Promise<T>,
    ): Promise<T>;
  }) {
    this.engine = new NativeGitSequence(options);
  }
  async prepareRebase(
    input: GitRebaseOperationRequest,
  ): Promise<GitRebaseOperationPreview> {
    const request = gitRebaseOperationRequestSchema.parse(input);
    const p = await this.engine.prepare({ ...request, operation: "rebase" });
    this.remember(p.token, {
      ...request,
      operation: "rebase",
      expiresAt: p.expiresAt,
    });
    return {
      ...p,
      operation: "rebase",
      action: request.action,
      backend: p.backend as "merge" | "apply",
      hooks: "disabled",
      effects: this.effects(request.action),
    };
  }
  async prepareSequencer(
    input: GitSequencerOperationRequest,
  ): Promise<GitSequencerOperationPreview> {
    const request = gitSequencerOperationRequestSchema.parse(input);
    const p = await this.engine.prepare(request);
    this.remember(p.token, { ...request, expiresAt: p.expiresAt });
    return {
      ...p,
      operation: request.operation,
      action: request.action,
      hooks: "disabled",
      effects: this.effects(request.action),
    };
  }
  private effects(action: "continue" | "abort") {
    return action === "continue"
      ? "Git продолжит подтверждённую операцию. Возможны новый коммит и следующая остановка на конфликте. Хуки отключены; публикация и повтор Goga не выполняются."
      : "Git отменит подтверждённую операцию. Решения её конфликтов будут отброшены; несвязанные файлы проверяются и сохраняются. Публикация не выполняется.";
  }
  private remember(
    token: string,
    p: Parameters<NativeGitSequenceAPI["pending"]["set"]>[1],
  ) {
    for (const [key, value] of this.pending)
      if (value.expiresAt <= Date.now()) this.pending.delete(key);
    if (this.pending.size >= 64)
      this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(token, p);
  }
  executeRebase(token: string) {
    return this.execute(token, "rebase");
  }
  executeSequencer(token: string) {
    return this.execute(token, "sequencer");
  }
  private async execute(
    token: string,
    kind: "rebase" | "sequencer",
  ): Promise<NativeSequenceAPIResult> {
    const p = this.pending.get(token);
    this.pending.delete(token);
    if (
      !p ||
      p.expiresAt <= Date.now() ||
      (p.operation === "rebase") !== (kind === "rebase")
    )
      throw Error("Подтверждение устарело или относится к другой операции.");
    const { log, lockRetained, retainedLocks, uncheckedLocks, ...native } =
      await this.engine.execute(token);
    return {
      scope: p.scope,
      operation: p.operation,
      action: p.action,
      native,
      lockRetained,
      retainedLocks,
      uncheckedLocks,
      status:
        native.outcome === "completed"
          ? "success"
          : native.outcome === "conflicts"
            ? "conflict"
            : native.outcome === "rejected"
              ? "error"
              : "uncertain",
      changed: native.outcome !== "rejected",
      log,
      ...(native.recoveryPath ? { recoveryPath: native.recoveryPath } : {}),
      message:
        native.outcome === "completed"
          ? "Штатная операция Git завершена, результат и сохранность несвязанных данных проверены. Публикация не выполнялась."
          : native.outcome === "conflicts"
            ? "Git остановился на конфликте. Исходный снимок сохранён; требуется отдельное разрешение и подтверждение."
            : "Результат не подтверждён. Автоматический повтор запрещён; проверьте журнал и рабочую папку.",
    };
  }
}

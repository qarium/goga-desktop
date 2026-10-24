/** File IO is distinct from CLI snapshots (the host already allows 120s/command). */
export const READ_BUDGETS = {
  prepareHistoryPrune: 300000,
  listHistoryYears: 30000,
  listHistoryEntries: 30000,
  listHistoryArtifacts: 30000,
  readHistoryArtifact: 30000,
  contextDeletionRecovery: 30000,
  topicSyncStatus: 30000,
  prepareContextDeletion: 300000,
  listTopicContexts: 30000,
  resolveTopicContext: 300000,
  checkTopicContextReadiness: 300000,
  buildContext: 300000,
  readBuildPlan: 30000,
  listBuildFiles: 30000,
  discover: 300000,
  preview: 300000,
  checkoutBranch: 300000,
  readTopicCatalog: 300000,
  readTopicTable: 300000,
  readTopicOverview: 300000,
  readTopicBoard: 300000,
  readTopicDetails: 300000,
  readTopicTask: 300000,
  prepareTopicOperation: 300000,
  prepareDocumentDeletion: 300000,
  readProjectSettings: 30000,
  listSettings: 30000,
  readSettings: 30000,
  listProjectTools: 30000,
  listProjectWorkflows: 30000,
  listProjectPipelines: 30000,
  resolveProjectDockerfile: 30000,
  listProjectProfiles: 30000,
  readProjectDocument: 30000,
  listWorkflowSuggestions: 300000,
  listProjects: 30000,
  runs: 30000,
} as const;
export type ReadMethod = keyof typeof READ_BUDGETS;
export const readChannel = (method: ReadMethod) =>
  method.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
export const readTimeoutMessage = (budget: number) =>
  `Превышено время ожидания чтения (${Math.ceil(budget / 1000)} с). Проверьте доступность проекта, Goga и Docker. Повторите загрузку или закройте раздел; черновик сохранён.`;
export const readCancelledMessage = "Чтение отменено. Черновик сохранён.";
/** Physical calls stay counted after timeout until transport really settles.
 * A fresh retry gets its own result; non-cancellable broken transports cannot grow forever. */
export class ReadCoordinator {
  private physical = new Map<string, number>();
  private total = 0;
  run<T>(
    key: string,
    budget: number,
    invoke: () => Promise<T>,
    cancel: () => void,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(Error(readCancelledMessage));
    if (this.total >= 64 || (this.physical.get(key) ?? 0) >= 2)
      return Promise.reject(
        Error(
          "Ожидаем завершения предыдущих чтений. Новые запросы временно ограничены, чтобы не создавать зависшие процессы. Повторите позже; черновик сохранён.",
        ),
      );
    this.total++;
    this.physical.set(key, (this.physical.get(key) ?? 0) + 1);
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = (failed: boolean, error: unknown, value?: T) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (failed) reject(error);
        else resolve(value as T);
      };
      const stop = (message: string) => {
        if (done) return;
        finish(true, Error(message));
        try {
          cancel();
        } catch {
          /* cancellation is best effort; result is already invalidated */
        }
      };
      const abort = () => stop(readCancelledMessage);
      const timer = setTimeout(() => stop(readTimeoutMessage(budget)), budget);
      signal?.addEventListener("abort", abort, { once: true });
      let physical: Promise<T>;
      try {
        physical = Promise.resolve(invoke());
      } catch (error) {
        physical = Promise.reject(error);
      }
      physical
        .then(
          (value) => finish(false, null, value),
          (error) => finish(true, error),
        )
        .then(() => {
          this.total--;
          const count = (this.physical.get(key) ?? 1) - 1;
          if (count) this.physical.set(key, count);
          else this.physical.delete(key);
        });
    });
  }
}

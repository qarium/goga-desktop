import { preparationErrorMessage } from "../preparation-error";
import type { DesktopAPI } from "../../shared/bridge";
import type { ScopeRef } from "../../shared/context";
import type {
  CellContract,
  SchemaCell,
} from "../../shared/project-architecture";
import type {
  OverviewDirectory,
  OverviewFile,
} from "../../shared/project-overview";
import type { YamlEditorMemory } from "../YamlEditor";

export type OverviewAPI = Pick<
  DesktopAPI,
  | "listOverviewDirectory"
  | "searchOverviewFiles"
  | "readOverviewFile"
  | "saveOverviewFile"
  | "createOverviewEntry"
  | "readOverviewSchema"
  | "readOverviewContract"
>;
export interface OverviewFileState {
  /** The accepted baseline, not an externally changed disk version. */
  document: OverviewFile;
  text: string;
  error?: string;
  busy?: boolean;
  changedExternally?: boolean;
  memory: YamlEditorMemory;
}
export interface OverviewState {
  directories: Record<string, OverviewDirectory>;
  directoryErrors: Record<string, string>;
  directoryBusy: Record<string, boolean>;
  files: Record<string, OverviewFileState>;
  order: string[];
  active: string | null;
  schema: SchemaCell[] | null;
  schemaError: string;
  contractCell: string | null;
  contract: CellContract | null;
  contractError: string;
  contractBusy: boolean;
  refreshing: boolean;
  stale: boolean;
  creationError: string;
}
export type OverviewFileRefreshResult =
  "refreshed" | "needs-confirmation" | "failed";
interface FileRuntime {
  edits: number;
  pending: number;
  available: boolean;
  trashed?: boolean;
  tail: Promise<unknown>;
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const dirty = (file: OverviewFileState) => file.text !== file.document.text;
const parentPath = (path: string) =>
  path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** A small owner-scoped store; disposing an owner makes all late replies inert. */
export function createOverviewStore(
  api: OverviewAPI,
  scope: ScopeRef,
  onMutation?: () => void,
) {
  let owner = typeof scope === "string" ? scope : { ...scope };
  let epoch = 0;
  let readEpoch = 0;
  let state: OverviewState = {
    directories: {},
    directoryErrors: {},
    directoryBusy: {},
    files: {},
    order: [],
    active: null,
    schema: null,
    schemaError: "",
    contractCell: null,
    contract: null,
    contractError: "",
    contractBusy: false,
    refreshing: false,
    stale: false,
    creationError: "",
  };
  let disposed = false;
  let contractRequest = 0;
  let mutations = 0;
  let refresh: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const files = new Map<string, FileRuntime>();
  const directories = new Map<string, Promise<boolean>>();
  const inScope = (requestEpoch: number) => !disposed && epoch === requestEpoch;
  const inReadScope = (requestEpoch: number, requestReadEpoch: number) =>
    inScope(requestEpoch) && readEpoch === requestReadEpoch;
  const current = (path: string, runtime: FileRuntime) =>
    !disposed && files.get(path) === runtime;
  const publish = (patch: Partial<OverviewState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const updateFile = (
    path: string,
    runtime: FileRuntime,
    patch: Partial<OverviewFileState>,
  ) => {
    if (current(path, runtime))
      publish({
        files: { ...state.files, [path]: { ...state.files[path], ...patch } },
      });
  };
  function addFile(path: string, document: OverviewFile) {
    const existing = files.get(path);
    if (existing) {
      // Creating a formerly missing destination must not destroy its open draft.
      const file = state.files[path];
      existing.available = document.exists;
      existing.trashed = false;
      updateFile(path, existing, {
        document,
        error: undefined,
        changedExternally: false,
        ...(!dirty(file)
          ? {
              text: document.text,
              memory: file.text === document.text ? file.memory : {},
            }
          : {}),
      });
      publish({ active: path });
      return existing;
    }
    const runtime: FileRuntime = {
      edits: 0,
      pending: 0,
      available: document.exists,
      tail: Promise.resolve(),
    };
    files.set(path, runtime);
    publish({
      files: {
        ...state.files,
        [path]: { document, text: document.text, memory: {}, busy: false },
      },
      order: [...state.order, path],
      active: path,
    });
    return runtime;
  }
  function withFile<T>(
    path: string,
    fallback: T,
    operation: (runtime: FileRuntime) => Promise<T>,
  ): Promise<T> {
    const runtime = files.get(path);
    if (disposed || !runtime) return Promise.resolve(fallback);
    runtime.pending++;
    updateFile(path, runtime, { busy: true });
    const result = runtime.tail.then(() =>
      current(path, runtime) ? operation(runtime) : fallback,
    );
    runtime.tail = result.catch(() => {});
    return result.finally(() => {
      runtime.pending--;
      updateFile(path, runtime, { busy: runtime.pending > 0 });
    });
  }
  function loadDirectory(path: string): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    const existing = directories.get(path);
    if (existing) return existing;
    const requestEpoch = epoch;
    const requestReadEpoch = readEpoch;
    publish({ directoryBusy: { ...state.directoryBusy, [path]: true } });
    const request = (async () => {
      try {
        const directory = await api.listOverviewDirectory(owner, path);
        if (!inReadScope(requestEpoch, requestReadEpoch)) return false;
        const errors = { ...state.directoryErrors };
        delete errors[path];
        publish({
          directories: { ...state.directories, [path]: directory },
          directoryErrors: errors,
        });
        return true;
      } catch (error) {
        if (inReadScope(requestEpoch, requestReadEpoch))
          publish({
            directoryErrors: {
              ...state.directoryErrors,
              [path]: message(error),
            },
          });
        return false;
      } finally {
        if (inReadScope(requestEpoch, requestReadEpoch)) {
          directories.delete(path);
          publish({ directoryBusy: { ...state.directoryBusy, [path]: false } });
        }
      }
    })();
    directories.set(path, request);
    return request;
  }
  function readFile(
    path: string,
    discard: boolean,
    all: boolean,
  ): Promise<OverviewFileRefreshResult> {
    const requestEpoch = epoch;
    const requestReadEpoch = readEpoch;
    const requestedEdits = files.get(path)?.edits;
    return withFile<OverviewFileRefreshResult>(
      path,
      "failed",
      async (runtime) => {
        if (!inReadScope(requestEpoch, requestReadEpoch)) return "failed";
        const before = state.files[path];
        if (!all && !discard && dirty(before)) return "needs-confirmation";
        const edits = discard ? requestedEdits : runtime.edits;
        try {
          const document = await api.readOverviewFile(owner, path);
          if (
            !inReadScope(requestEpoch, requestReadEpoch) ||
            !current(path, runtime)
          )
            return "failed";
          if (!document.exists)
            throw new Error(
              "Файл удалён или недоступен. Черновик сохранён в открытой вкладке.",
            );
          runtime.available = true;
          runtime.trashed = false;
          const latest = state.files[path];
          // Even confirmed discard is only permission for the draft seen before await.
          const preserve = runtime.edits !== edits || (all && dirty(latest));
          if (preserve) {
            updateFile(path, runtime, {
              error: undefined,
              changedExternally: document.version !== latest.document.version,
            });
          } else {
            updateFile(path, runtime, {
              document,
              text: document.text,
              error: undefined,
              changedExternally: false,
              memory: latest.text === document.text ? latest.memory : {},
            });
          }
          return "refreshed";
        } catch (error) {
          if (
            inReadScope(requestEpoch, requestReadEpoch) &&
            current(path, runtime)
          ) {
            runtime.available = false;
            updateFile(path, runtime, {
              error: message(error),
              changedExternally: true,
            });
          }
          return "failed";
        }
      },
    );
  }
  async function loadSchema(): Promise<boolean> {
    const requestEpoch = epoch;
    const requestReadEpoch = readEpoch;
    try {
      const schema = await api.readOverviewSchema(owner);
      if (!inReadScope(requestEpoch, requestReadEpoch)) return false;
      publish({ schema, schemaError: "" });
      return true;
    } catch (error) {
      if (inReadScope(requestEpoch, requestReadEpoch))
        publish({ schemaError: preparationErrorMessage(error) });
      return false;
    }
  }
  async function loadContract(cell: string): Promise<boolean> {
    const request = ++contractRequest;
    publish({ contractBusy: true, contractError: "" });
    try {
      const contract = await api.readOverviewContract(owner, cell);
      if (
        disposed ||
        request !== contractRequest ||
        state.contractCell !== cell
      )
        return false;
      publish({ contract, contractError: "" });
      return true;
    } catch (error) {
      if (
        !disposed &&
        request === contractRequest &&
        state.contractCell === cell
      )
        publish({ contractError: preparationErrorMessage(error) });
      return false;
    } finally {
      if (!disposed && request === contractRequest)
        publish({ contractBusy: false });
    }
  }
  function refreshAll(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (refresh) return refresh;
    const mutation = mutations;
    const requestEpoch = epoch;
    const requestReadEpoch = readEpoch;
    const paths = Object.keys(state.directoryBusy);
    const opened = state.order.filter((p) => !files.get(p)?.trashed);
    const cell = state.contractCell;
    publish({ refreshing: true });
    // Keep bulk refresh below the shared transport's physical-read ceiling.
    // A large expanded tree must not turn healthy folders into failed reads.
    const io = [
      ...paths.map((path) => () => loadDirectory(path)),
      ...opened.map(
        (path) => () =>
          readFile(path, false, true).then((result) => result === "refreshed"),
      ),
    ];
    const refreshIO = async () => {
      let next = 0,
        success = true;
      await Promise.all(
        Array.from({ length: Math.min(4, io.length) }, async () => {
          while (
            next < io.length &&
            inReadScope(requestEpoch, requestReadEpoch)
          ) {
            const job = io[next++];
            const result = await job();
            if (!result) success = false;
          }
        }),
      );
      return success;
    };
    const work = [
      loadSchema(),
      refreshIO(),
      ...(cell === null ? [] : [loadContract(cell)]),
    ];
    const request = Promise.all(work)
      .then((results) => {
        if (inReadScope(requestEpoch, requestReadEpoch))
          publish({
            stale: mutation !== mutations || results.some((result) => !result),
          });
      })
      .finally(() => {
        if (inReadScope(requestEpoch, requestReadEpoch)) {
          refresh = null;
          publish({ refreshing: false });
        }
      });
    refresh = request;
    return request;
  }
  async function changed(path: string) {
    if (disposed) return;
    const requestEpoch = epoch;
    mutations++;
    publish({ stale: true });
    onMutation?.();
    const parent = parentPath(path);
    if (Object.hasOwn(state.directoryBusy, parent)) {
      // A pre-write directory read is not a post-write refresh.
      const pending = directories.get(parent);
      if (pending) await pending;
      if (inScope(requestEpoch)) await loadDirectory(parent);
    }
  }
  async function create(
    path: string,
    kind: "file" | "directory",
    text?: string,
  ): Promise<boolean> {
    if (disposed) return false;
    const requestEpoch = epoch;
    publish({ creationError: "" });
    try {
      const document = await api.createOverviewEntry(owner, path, kind, text);
      if (!inScope(requestEpoch)) return false;
      if (kind === "file") {
        if (!document?.exists) throw new Error("Не удалось создать файл");
        addFile(path, document);
      }
      await changed(path);
      return !disposed;
    } catch (error) {
      if (inScope(requestEpoch)) publish({ creationError: message(error) });
      return false;
    }
  }
  return {
    getSnapshot: () => state,
    /** Revision changes retain drafts; a different logical owner needs its own store. */
    setScope(scope: ScopeRef) {
      if (disposed) return;
      if (typeof owner === "string" || typeof scope === "string") {
        if (owner !== scope)
          throw new Error(
            "Другой контекст требует отдельного состояния обзора",
          );
        return;
      }
      if (
        ["projectId", "year", "topic", "branch", "contextId"].some(
          (key) =>
            owner[key as keyof typeof owner] !==
            scope[key as keyof typeof scope],
        )
      )
        throw new Error("Другой контекст требует отдельного состояния обзора");
      if (owner.revision === scope.revision) return;
      owner = { ...scope };
      epoch++;
      contractRequest++;
      refresh = null;
      directories.clear();
      // Old queues stay attached to old tab identities, so fresh reads never wait
      // for an obsolete revision and old replies cannot clear a new busy state.
      for (const [path, runtime] of files) {
        files.set(path, { ...runtime, pending: 0, tail: Promise.resolve() });
      }
      publish({
        files: Object.fromEntries(
          Object.entries(state.files).map(([path, file]) => [
            path,
            { ...file, busy: false },
          ]),
        ),
        directoryBusy: Object.fromEntries(
          Object.keys(state.directoryBusy).map((path) => [path, false]),
        ),
        contractBusy: false,
        refreshing: false,
        stale: true,
      });
    },
    subscribe(listener: () => void) {
      if (!disposed) listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    loadDirectory,
    async open(path: string) {
      if (disposed) return;
      if (files.has(path)) {
        publish({ active: path });
        return;
      }
      addFile(path, {
        text: "",
        version: "missing",
        relativePath: path,
        exists: false,
      });
      await readFile(path, false, true);
    },
    activate(path: string) {
      if (!disposed && files.has(path) && state.active !== path)
        publish({ active: path });
    },
    edit(path: string, text: string) {
      const runtime = files.get(path);
      if (!disposed && runtime) {
        runtime.edits++;
        updateFile(path, runtime, { text });
      }
    },
    save(path: string): Promise<boolean> {
      return withFile(path, false, async (runtime) => {
        const requestEpoch = epoch;
        const file = state.files[path];
        if (!runtime.available || !file.document.exists) {
          updateFile(path, runtime, {
            error:
              file.error ||
              "Файл недоступен. Обновите его или сохраните копию.",
          });
          return false;
        }
        try {
          const document = await api.saveOverviewFile(
            owner,
            path,
            file.text,
            file.document.version,
          );
          if (!inScope(requestEpoch)) return false;
          if (current(path, runtime)) {
            runtime.available = document.exists;
            updateFile(path, runtime, {
              document,
              error: undefined,
              changedExternally: false,
            });
          }
          await changed(path);
          return !disposed;
        } catch (error) {
          updateFile(path, runtime, { error: message(error) });
          return false;
        }
      });
    },
    refreshFile(
      path: string,
      discard = false,
    ): Promise<OverviewFileRefreshResult> {
      const runtime = files.get(path);
      if (!disposed && runtime && !discard && dirty(state.files[path]))
        return Promise.resolve("needs-confirmation");
      return readFile(path, discard, false);
    },
    refreshAll,
    /** Invalidate cancelled reads synchronously, without invalidating writes or drafts. */
    suspendReads() {
      if (disposed) return;
      readEpoch++;
      contractRequest++;
      refresh = null;
      directories.clear();
      publish({
        directoryBusy: Object.fromEntries(
          Object.keys(state.directoryBusy).map((path) => [path, false]),
        ),
        contractBusy: false,
        refreshing: false,
        stale: true,
      });
    },
    showContract(cell: string): Promise<boolean> {
      if (disposed) return Promise.resolve(false);
      publish({
        contractCell: cell,
        contract: state.contractCell === cell ? state.contract : null,
        contractError: "",
      });
      return loadContract(cell);
    },
    closeContract() {
      contractRequest++;
      publish({
        contractCell: null,
        contract: null,
        contractError: "",
        contractBusy: false,
      });
    },
    close(paths: readonly string[], discard = false): boolean {
      if (disposed) return false;
      if (
        !discard &&
        paths.some((path) => files.has(path) && dirty(state.files[path]))
      )
        return false;
      const closed = new Set(paths);
      const remaining = { ...state.files };
      for (const path of paths) {
        files.delete(path);
        delete remaining[path];
      }
      const order = state.order.filter((path) => !closed.has(path));
      publish({
        files: remaining,
        order,
        active:
          state.active && !closed.has(state.active)
            ? state.active
            : (order.at(-1) ?? null),
      });
      return true;
    },
    async applyFileAction(
      kind: "trash" | "rename",
      paths: string[],
      destination?: string,
    ) {
      if (disposed || !paths.length) return;
      const requestEpoch = epoch;
      readEpoch++;
      contractRequest++;
      refresh = null;
      directories.clear();
      const inside = (p: string, root: string) =>
        p === root || p.startsWith(root + "/");
      const affected = state.order.filter((p) =>
        paths.some((root) => inside(p, root)),
      );
      const renamed = new Map<string, OverviewFile>();
      if (kind === "rename" && destination) {
        for (const p of affected) {
          const target = destination + p.slice(paths[0].length);
          try {
            renamed.set(p, await api.readOverviewFile(owner, target));
          } catch {
            /* Keep the draft, but never reuse a stale baseline. */
          }
        }
      }
      if (!inScope(requestEpoch)) return;
      const next = { ...state.files };
      let order = [...state.order],
        active = state.active;
      const collisions: string[] = [];
      for (const p of affected) {
        const file = next[p],
          runtime = files.get(p);
        if (!file || !runtime) continue;
        if (kind === "rename" && destination) {
          const target = destination + p.slice(paths[0].length);
          if (files.has(target) && !affected.includes(target)) {
            collisions.push(target);
            files.set(p, {
              ...runtime,
              available: false,
              trashed: true,
              pending: 0,
              tail: Promise.resolve(),
            });
            next[p] = {
              ...file,
              document: { ...file.document, exists: false, version: "missing" },
              busy: false,
              changedExternally: true,
              error: `Файл переименован в ${target}, но это имя уже открыто. Оба черновика сохранены; используйте «Сохранить копию».`,
            };
            continue;
          }
          const document = renamed.get(p) ?? {
            ...file.document,
            relativePath: target,
            exists: false,
            version: "missing",
          };
          files.delete(p);
          files.set(target, {
            ...runtime,
            available: document.exists,
            trashed: false,
            pending: 0,
            tail: Promise.resolve(),
          });
          delete next[p];
          next[target] = {
            ...file,
            document,
            text: dirty(file)
              ? file.text
              : document.exists
                ? document.text
                : file.text,
            busy: false,
            error: document.exists
              ? undefined
              : "Файл переименован, но не удалось прочитать его заново. Черновик сохранён; обновите файл или сохраните копию.",
            changedExternally: !document.exists,
          };
          order = order.map((v) => (v === p ? target : v));
          if (active === p) active = target;
        } else if (dirty(file)) {
          files.set(p, {
            ...runtime,
            available: false,
            trashed: true,
            pending: 0,
            tail: Promise.resolve(),
          });
          next[p] = {
            ...file,
            document: { ...file.document, exists: false, version: "missing" },
            busy: false,
            changedExternally: true,
            error:
              "Файл перемещён в Корзину. Несохранённый текст сохранён во вкладке — используйте «Сохранить копию».",
          };
        } else {
          files.delete(p);
          delete next[p];
          order = order.filter((v) => v !== p);
          if (active === p) active = null;
        }
      }
      mutations++;
      const contractAffected =
        state.contractCell &&
        paths.some((root) => inside(state.contractCell!, root));
      publish({
        ...(contractAffected
          ? {
              contractCell:
                kind === "rename" && destination
                  ? destination + state.contractCell!.slice(paths[0].length)
                  : null,
              contract: null,
              contractError: "",
            }
          : {}),
        files: next,
        order,
        active: active ?? order.at(-1) ?? null,
        stale: true,
        refreshing: false,
        contractBusy: false,
        directories: Object.fromEntries(
          Object.entries(state.directories).filter(
            ([p]) => !paths.some((root) => inside(p, root)),
          ),
        ),
        directoryBusy: Object.fromEntries(
          Object.keys(state.directoryBusy)
            .filter((p) => !paths.some((root) => inside(p, root)))
            .map((p) => [p, false]),
        ),
        directoryErrors: {},
      });
      onMutation?.();
      for (const p of new Set([
        ...paths.map(parentPath),
        ...(destination ? [parentPath(destination)] : []),
      ]))
        await loadDirectory(p);
      await refreshAll();
      if (collisions.length)
        throw Error(
          "Файл переименован, но совпавшие открытые черновики оставлены отдельно. Сохраните их копии перед закрытием вкладок.",
        );
    },
    create,
    saveCopy(path: string, destination: string): Promise<boolean> {
      return withFile(path, false, async (runtime) => {
        const text = state.files[path].text;
        const created = await create(destination, "file", text);
        if (!created && current(path, runtime))
          updateFile(path, runtime, { error: state.creationError });
        return created;
      });
    },
    dispose() {
      disposed = true;
      contractRequest++;
      listeners.clear();
      files.clear();
    },
  };
}
export type OverviewStore = ReturnType<typeof createOverviewStore>;

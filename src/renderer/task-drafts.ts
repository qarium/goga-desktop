import { preparationErrorMessage } from "./preparation-error";
import { readWithSignal } from "./read-request";
import { useEffect, useReducer, useRef } from "react";
import type { TopicTaskDocument, TopicTaskRequest } from "../shared/types";
export interface TaskDraft {
  text: string;
  document?: TopicTaskDocument;
  status: "loading" | "ready" | "error";
  error: string;
}
export interface FormDraft {
  profile?: string;
  mode: "existing" | "new";
  branch: string;
  topic?: string;
  name: string;
  baseRef: string;
}
export function createDraftStore() {
  return {
    tasks: new Map<string, TaskDraft>(),
    forms: new Map<string, FormDraft>(),
    listeners: new Set<() => void>(),
  };
}
export type DraftStore = ReturnType<typeof createDraftStore>;
const taskReads = new WeakMap<DraftStore, Map<string, AbortController>>();
export function useTaskDraft(
  store: DraftStore,
  key: string | null,
  request: TopicTaskRequest | null,
  isNew: boolean,
  suspended = false,
) {
  if (!taskReads.has(store)) taskReads.set(store, new Map());
  const reads = taskReads.get(store)!;
  const [, refresh] = useReducer((n) => n + 1, 0);
  useEffect(() => {
    store.listeners.add(refresh);
    return () => {
      store.listeners.delete(refresh);
    };
  }, [store]);
  const notify = () => store.listeners.forEach((fn) => fn());
  useEffect(() => {
    if (!key || store.tasks.has(key)) return;
    const entry: TaskDraft = {
      text: "",
      status: isNew ? "ready" : "loading",
      error: "",
    };
    store.tasks.set(key, entry);
    notify();
    if (isNew || !request) return;
    // Keep a completed snapshot in the memory store even after navigation,
    // but never apply a late result to another entry or replace edited text.
    const controller = new AbortController();
    reads.set(key, controller);
    readWithSignal(controller.signal, "readTopicTask", request)
      .then(
        (doc) => {
          if (store.tasks.get(key) !== entry) return;
          store.tasks.set(key, {
            ...entry,
            document: doc,
            text: doc.text,
            status: "ready",
          });
          notify();
        },
        (error) => {
          if (store.tasks.get(key) !== entry) return;
          store.tasks.set(key, {
            ...entry,
            status: "error",
            error: preparationErrorMessage(error),
          });
          notify();
        },
      )
      .then(() => {
        if (reads.get(key) === controller) reads.delete(key);
      });
  }, [key, store]);
  // Rereads are scoped to this mounted editor, unlike its initial background read.
  const scope = useRef<{ key: string | null; store: DraftStore } | null>(null);
  const pendingReload = useRef<{
    key: string;
    entry: TaskDraft;
    previous: TaskDraft;
    controller: AbortController;
  } | null>(null);
  useEffect(() => {
    scope.current = suspended ? null : { key, store };
    return () => {
      scope.current = null;
      const pending = pendingReload.current;
      pendingReload.current = null;
      pending?.controller.abort();
      if (pending && store.tasks.get(pending.key) === pending.entry) {
        store.tasks.set(pending.key, pending.previous);
        notify();
      }
    };
  }, [key, store, suspended]);
  const draft = key ? store.tasks.get(key) : undefined;
  const dirty = !!draft && draft.text !== (draft.document?.text ?? "");
  function edit(text: string) {
    if (!key || !draft || draft.status !== "ready") return;
    store.tasks.set(key, { ...draft, text });
    notify();
  }
  async function reload(expected = draft, replacePending = false) {
    if (
      !key ||
      !request ||
      !expected ||
      (expected.status === "loading" && !replacePending) ||
      scope.current?.key !== key ||
      scope.current.store !== store ||
      store.tasks.get(key) !== expected ||
      (pendingReload.current && !replacePending)
    )
      return;
    // An explicit retry replaces an unanswered dependency; it never waits for
    // that attempt's old loading flag or permits its late callback to publish.
    if (replacePending) {
      pendingReload.current?.controller.abort();
      reads.get(key)?.abort();
    }
    const previous: TaskDraft =
      expected.status === "loading"
        ? {
            ...expected,
            status: expected.document ? "ready" : "error",
            error: expected.document
              ? ""
              : "Предыдущее чтение отменено. Повторите загрузку задачи.",
          }
        : expected;
    const entry: TaskDraft = { ...previous, status: "loading", error: "" };
    const operation = {
      key,
      entry,
      previous,
      controller: new AbortController(),
    };
    pendingReload.current = operation;
    store.tasks.set(key, entry);
    notify();
    try {
      const doc = await readWithSignal(
        operation.controller.signal,
        "readTopicTask",
        request,
      );
      if (pendingReload.current === operation && store.tasks.get(key) === entry)
        store.tasks.set(key, {
          ...entry,
          document: doc,
          text: doc.text,
          status: "ready",
        });
    } catch (error) {
      if (pendingReload.current === operation && store.tasks.get(key) === entry)
        store.tasks.set(key, {
          ...previous,
          // A failed reread does not invalidate an already loaded snapshot.
          status: previous.document ? "ready" : "error",
          error: preparationErrorMessage(error),
        });
    } finally {
      if (pendingReload.current === operation) {
        pendingReload.current = null;
        notify();
      }
    }
  }

  return {
    draft,
    dirty,
    edit,
    reload,
    retry: () => reload(draft, true),
    ready: draft?.status === "ready",
    clear: () => {
      if (key && store.tasks.get(key) === draft) store.tasks.delete(key);
    },
  };
}

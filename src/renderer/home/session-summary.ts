import { useLayoutEffect, useState } from "react";
import type { ScopeRef } from "../../shared/context";
import type { Project } from "../../shared/types";
import { contextKey, contextRef, contextRequestKey } from "../topic-context";
import { documentScopeId, type SettingsDocuments } from "../settings-documents";
import type { OverviewStore } from "../overview/store";
import { overviewLeaveFile } from "../overview-leave-drafts";
import type { WorkspaceLeaveFile } from "../workspace-leave";
import type { HomeTarget, SessionEntry, WorkspaceAddress } from "./types";

export type DocumentTarget = Extract<HomeTarget, { kind: "document" }>;
type Destination =
  { page: "overview" } | { page: "project-settings"; tab: string };
type Handle = {
  target: DocumentTarget;
  busy: boolean;
  read: () => string | null;
  reveal: () => Destination | null;
  leaveFile?: (scope: ScopeRef) => WorkspaceLeaveFile;
};
const address = (scope: ScopeRef): WorkspaceAddress =>
  typeof scope === "string"
    ? { kind: "primary", projectId: scope }
    : { kind: "topic", ref: contextRef(scope) };
const ownerKey = (owner: WorkspaceAddress, exact: boolean) =>
  owner.kind === "primary"
    ? ["primary", owner.projectId]
    : ["topic", exact ? contextRequestKey(owner.ref) : contextKey(owner.ref)];
const idOf = (t: DocumentTarget) =>
  JSON.stringify([
    ownerKey(t.owner, true),
    t.source,
    t.retainedViewKey,
    t.relativePath,
    t.key,
  ]);

/** Count physical file names within the captured workspace without collapsing
 * editor targets. A different revision may still have a separate editable buffer. */
export function distinctSessionFiles(
  entries: readonly SessionEntry[],
): { key: string; entries: SessionEntry[] }[] {
  const groups = new Map<string, SessionEntry[]>();
  for (const entry of entries) {
    const t = entry.target;
    if (t.kind !== "document" || !entry.dirty) continue;
    const key = JSON.stringify([ownerKey(t.owner, false), t.relativePath]);
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  return [...groups].map(([key, items]) => ({ key, entries: items }));
}

/** Owns lightweight addresses only. Neither the dashboard nor the MRU sees text.
 * The explicit buffer viewer subscribes independently, so typing in an already
 * dirty editor does not rerender the sidebar or Home for every character. */
export function createHomeSessions() {
  const listeners = new Set<() => void>(),
    bufferListeners = new Set<() => void>();
  const sources = new Map<string, { ticket: symbol; handles: Handle[] }>();
  let handles = new Map<string, Handle>(),
    snapshot: SessionEntry[] = [];
  const ids = new WeakMap<object, number>();
  let nextId = 0;
  const lifeId = (identity: object) => {
    let i = ids.get(identity);
    if (i === undefined) {
      i = ++nextId;
      ids.set(identity, i);
    }
    return String(i);
  };
  const subscribe = (set: Set<() => void>, listener: () => void) => {
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  };
  function refresh() {
    const byId = new Map(snapshot.map((e) => [e.id, e]));
    const next: SessionEntry[] = [];
    const live = new Map<string, Handle>();
    for (const { handles: batch } of sources.values())
      for (const h of batch) {
        const id = idOf(h.target);
        live.set(id, h);
        const prev = byId.get(id);
        next.push(
          prev && prev.busy === h.busy
            ? prev
            : {
                id,
                target: h.target,
                busy: h.busy,
                dirty: true,
                touchedAt: prev?.touchedAt ?? Date.now(),
              },
        );
      }
    handles = live;
    if (
      next.length !== snapshot.length ||
      next.some((e, i) => e !== snapshot[i])
    ) {
      snapshot = next;
      listeners.forEach((fn) => fn());
    }
    bufferListeners.forEach((fn) => fn());
  }
  function attach(
    key: string,
    listen: (fn: () => void) => () => void,
    collect: (attached: () => boolean) => Handle[],
    fileMetadata?: () => object,
  ) {
    const ticket = Symbol(key);
    const attached = () => sources.get(key)?.ticket === ticket;
    let previousMetadata: object | undefined;
    const publish = () => {
      if (sources.get(key)?.ticket !== ticket) return;
      if (fileMetadata) {
        const metadata = fileMetadata();
        if (metadata === previousMetadata) {
          // A live buffer handle reads through to the current store. Only a
          // subscribed buffer viewer needs this notification, not the catalog.
          bufferListeners.forEach((fn) => fn());
          return;
        }
        previousMetadata = metadata;
      }
      sources.set(key, { ticket, handles: collect(attached) });
      refresh();
    };
    sources.set(key, { ticket, handles: [] });
    const off = listen(publish);
    publish();
    return () => {
      off();
      if (sources.get(key)?.ticket !== ticket) return;
      sources.delete(key);
      refresh();
    };
  }
  return {
    subscribe: (fn: () => void) => subscribe(listeners, fn),
    subscribeBuffer: (fn: () => void) => subscribe(bufferListeners, fn),
    getSnapshot: () => snapshot,
    has: (t: DocumentTarget) => handles.has(idOf(t)),
    readBuffer: (t: DocumentTarget) => handles.get(idOf(t))?.read() ?? null,
    reveal: (t: DocumentTarget) => handles.get(idOf(t))?.reveal() ?? null,
    overviewLeaveFiles(scope: ScopeRef): WorkspaceLeaveFile[] {
      const owner = address(scope);
      return [...handles.values()].flatMap((h) => {
        const other = h.target.owner;
        const same =
          owner.kind === "primary" && other.kind === "primary"
            ? owner.projectId === other.projectId
            : owner.kind === "topic" &&
              other.kind === "topic" &&
              contextKey(owner.ref) === contextKey(other.ref);
        return same && h.leaveFile ? [h.leaveFile(scope)] : [];
      });
    },
    attachOverview(
      store: OverviewStore,
      retainedViewKey: string,
      onReveal: (path: string) => void,
    ) {
      return attach("overview:" + retainedViewKey, store.subscribe, (attached) => {
        const state = store.getPresentation();
        const result: Handle[] = [];
        for (const path of state.order) {
          const file = state.files[path];
          if (!file.dirty) continue;
          const scope = file.dirtyOrigin ?? store.sessionScope();
          const memory = file.memory;
          result.push({
            target: {
              kind: "document",
              source: "overview",
              owner: address(scope),
              key: lifeId(memory),
              retainedViewKey,
              relativePath: path,
            },
            busy: !!file.busy,
            leaveFile: (owner) => overviewLeaveFile(store, path, owner, memory, attached, onReveal),
            read: () => {
              const current = store.getSnapshot().files[path];
              return current?.memory === memory ? current.text : null;
            },
            reveal: () => {
              if (
                documentScopeId(scope) !==
                  documentScopeId(store.sessionScope()) ||
                store.getSnapshot().files[path]?.memory !== memory
              )
                return null;
              onReveal(path);
              return { page: "overview" };
            },
          });
        }
        return result;
      }, () => store.getPresentation().files);
    },
    attachSettings(documents: SettingsDocuments, projects: readonly Project[]) {
      const known = new Map(projects.map((p) => [p.id, p]));
      return attach("project-documents", documents.subscribe, () => {
        const result: Handle[] = [];
        for (const meta of documents.dirtyProjectDocuments()) {
          const src = meta.source,
            p = known.get(src.projectId);
          if (!p) continue;
          const scope = src.context ?? p.id;
          const retainedViewKey = JSON.stringify([
            p.id,
            p.path,
            "settings",
            src.context ? contextKey(src.context) : "primary",
          ]);
          result.push({
            target: {
              kind: "document",
              source: "project",
              owner: address(scope),
              key: lifeId(meta.instance),
              retainedViewKey,
              relativePath: meta.relativePath,
            },
            busy: meta.busy,
            read: () => documents.readSessionBuffer(src, meta.instance),
            reveal: () => {
              const tab = documents.revealSessionDocument(src, meta.instance);
              return tab ? { page: "project-settings", tab } : null;
            },
          });
        }
        return result;
      });
    },
  };
}
export type HomeSessions = ReturnType<typeof createHomeSessions>;

export function useHomeSessions(
  documents: SettingsDocuments,
  projects: readonly Project[],
) {
  const [sessions] = useState(createHomeSessions);
  useLayoutEffect(
    () => sessions.attachSettings(documents, projects),
    [sessions, documents, projects],
  );
  return sessions;
}

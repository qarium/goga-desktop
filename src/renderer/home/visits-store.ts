import { z } from "zod";
import { topicContextRefSchema } from "../../shared/worktrees";
import type { HomeTarget, ProjectVisit } from "./types";
import { contextRequestKey } from "../topic-context";

const KEY = "goga.desktop.homeVisits.v1";
const id = z.string().min(1).max(256);
const owner = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("primary"), projectId: id }).strict(),
  z.object({ kind: z.literal("topic"), ref: topicContextRefSchema }).strict(),
]);
const persisted = z
  .object({
    schemaVersion: z.literal(1),
    visits: z
      .array(
        z
          .object({
            projectId: id,
            visitedAt: z.number().finite(),
            previousSessionOnly: z.literal(true).optional(),
            target: z.discriminatedUnion("kind", [
              z
                .object({
                  kind: z.literal("section"),
                  section: z.enum([
                    "overview",
                    "project-settings",
                    "terminal",
                    "topics",
                    "commits",
                    "context-runs",
                  ]),
                  owner,
                })
                .strict(),
              z.object({ kind: z.literal("changes"), owner }).strict(),
              z.object({ kind: z.literal("run"), owner, runId: id }).strict(),
            ]),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
const projectOf = (target: HomeTarget) =>
  target.owner.kind === "primary"
    ? target.owner.projectId
    : target.owner.ref.projectId;
function persistable(target: HomeTarget): HomeTarget {
  return target.kind === "draft" || target.kind === "document"
    ? { kind: "section", owner: target.owner, section: "overview" }
    : target;
}
export function createHomeVisits(input?: Storage) {
  let storage: Storage | undefined,
    writable = true,
    visits: ProjectVisit[] = [];
  const listeners = new Set<() => void>();
  try {
    storage = input ?? window.localStorage;
    const raw = storage.getItem(KEY);
    if (raw !== null) {
      if (raw.length > 256_000) throw Error("Invalid preferences");
      const rows = persisted.parse(JSON.parse(raw)).visits;
      if (
        rows.some((v) => v.projectId !== projectOf(v.target)) ||
        new Set(rows.map((v) => v.projectId)).size !== rows.length
      )
        throw Error("Invalid ownership");
      visits = rows;
    }
  } catch {
    writable = false;
  }
  function change(next: ProjectVisit[]) {
    visits = next;
    if (writable)
      try {
        const record = persisted.parse({
          schemaVersion: 1,
          visits: next.map((v) => ({
            ...v,
            target: persistable(v.target),
            previousSessionOnly:
              v.previousSessionOnly ||
              (v.target.kind === "draft" || v.target.kind === "document"
                ? true
                : undefined),
          })),
        });
        storage?.setItem(KEY, JSON.stringify(record));
      } catch {
        /* A preference failure must not block the workspace. */
      }
    listeners.forEach((fn) => fn());
  }
  return {
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    getSnapshot: () => visits,
    remember(target: HomeTarget) {
      const projectId = projectOf(target);
      if (
        visits[0]?.projectId === projectId &&
        !visits[0].previousSessionOnly &&
        JSON.stringify(visits[0].target) === JSON.stringify(target)
      )
        return;
      change(
        [
          { projectId, target, visitedAt: Date.now() },
          ...visits.filter((v) => v.projectId !== projectId),
        ].slice(0, 20),
      );
    },
    // A completed preparation changes what this slot points to, not when
    // the user last visited it. Never revive a forgotten or overwritten slot.
    replaceDraft(
      source: Extract<HomeTarget, { kind: "draft" }>,
      run: Extract<HomeTarget, { kind: "run" }>,
    ) {
      const pid = projectOf(source);
      if (pid !== projectOf(run)) return;
      const index = visits.findIndex((v) => v.projectId === pid);
      const old = visits[index]?.target;
      if (
        old?.kind !== "draft" ||
        old.key !== source.key ||
        old.draftKind !== source.draftKind ||
        old.owner.kind !== source.owner.kind ||
        (old.owner.kind === "topic" &&
          (source.owner.kind !== "topic" ||
            contextRequestKey(old.owner.ref) !==
              contextRequestKey(source.owner.ref)))
      )
        return;
      const next = [...visits];
      next[index] = { ...visits[index], target: run };
      change(next);
    },
    retain(projectIds: readonly string[]) {
      const ids = new Set(projectIds),
        next = visits.filter((v) => ids.has(v.projectId));
      if (next.length !== visits.length) change(next);
    },
    forget(projectId: string) {
      const next = visits.filter((v) => v.projectId !== projectId);
      if (next.length !== visits.length) change(next);
    },
  };
}

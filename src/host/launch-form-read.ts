import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import type { ScopeRef } from "../shared/context";
import type { WorktreeRecord } from "../shared/worktrees";
import { guardedProject, taskPath } from "./topic-task";

/** Only routing and membership evidence for the first two display reads.
 * No task text, stages, status reports, secrets or write capabilities. */
export interface FormRead {
  projectPath: string;
  binding?: WorktreeRecord;
  epoch: number;
  settingsVersion: string;
  year: string;
  currentBranch: string;
  currentTopicCount: number;
  /** Off-checkout topic membership, never used for writes. */
  members?: ReadonlyMap<string, { topic: string; oid: string }>;
}

function scopeKey(scope: ScopeRef) {
  return JSON.stringify(typeof scope === "string" ? [scope] :
    [scope.projectId, scope.year, scope.topic, scope.branch, scope.contextId, scope.revision]);
}

export class LaunchFormReads {
  private readonly entries = new Map<string, {
    scope: string; expires: number; value: FormRead; claimed: Set<"task" | "preview">;
  }>();
  issue(scope: ScopeRef, value: FormRead) {
    const now = Date.now();
    for (const [id, item] of this.entries) {
      if (item.expires <= now) this.entries.delete(id);
    }
    if (this.entries.size >= 16) this.entries.delete(this.entries.keys().next().value!);
    const id = randomUUID();
    this.entries.set(id, {scope: scopeKey(scope), expires: now + 30_000, value, claimed: new Set()});
    return id;
  }
  claim(id: string, scope: ScopeRef, phase: "task" | "preview"): FormRead | undefined {
    const item = this.entries.get(id);
    if (!item) return;
    if (item.expires <= Date.now()) { this.entries.delete(id); return; }
    if (item.scope !== scopeKey(scope) || item.claimed.has(phase)) return;
    item.claimed.add(phase);
    if (item.claimed.size === 2) this.entries.delete(id);
    return item.value;
  }
}

/** For the checked-out topic Goga tests this exact directory, not todo.md.
 * Reject redirected/non-directory ancestors rather than following them. */
export async function hasLocalTopicMetadata(root: string, year: string, topic: string) {
  await guardedProject(root);
  let at = root;
  for (const part of path.dirname(taskPath(topic, year)).split(path.sep)) {
    at = path.join(at, part);
    try {
      const info = await lstat(at);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw Error("Недопустимый путь каталога топика.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}

import { z } from "zod";
import { topicContextRefSchema, type TopicContextRef } from "./worktrees";
/** A string is the explicit existing primary/admin mode, never an invalid-context fallback. */
export type ScopeRef = string | TopicContextRef;
export const scopeRefSchema = z.union([
  z.string().min(1).max(256),
  topicContextRefSchema,
]);
export const scopeProjectId = (scope: ScopeRef) =>
  typeof scope === "string" ? scope : scope.projectId;

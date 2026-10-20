import { randomUUID } from "node:crypto";
import type {
  DeletableDocument,
  DeletionTicket,
} from "../shared/document-deletion";
import type { GuardedDocumentDeletion } from "./project-documents";
interface PendingDeletion {
  source: DeletableDocument;
  guard: GuardedDocumentDeletion;
  created: number;
}
/** In-memory, bounded, short-lived capabilities. Taking consumes even expired tickets. */
export class DocumentDeletionTickets {
  private pending = new Map<string, PendingDeletion>();
  isCurrent(item: PendingDeletion): boolean {
    const age = Date.now() - item.created;
    return age >= 0 && age <= 5 * 60 * 1000;
  }
  private prune() {
    for (const [token, value] of this.pending)
      if (!this.isCurrent(value)) this.pending.delete(token);
  }
  issue(
    source: DeletableDocument,
    guard: GuardedDocumentDeletion,
  ): DeletionTicket {
    this.prune();
    while (this.pending.size >= 128)
      this.pending.delete(this.pending.keys().next().value!);
    const token = randomUUID();
    this.pending.set(token, {
      source: structuredClone(source),
      guard,
      created: Date.now(),
    });
    const name =
      source.scope === "home"
        ? source.name
        : source.target.kind === "tool"
          ? source.target.path.split("/").at(-1)!
          : source.target.name;
    return { token, name, relativePath: guard.relativePath };
  }
  take(token: string): PendingDeletion | undefined {
    const item = this.pending.get(token);
    this.pending.delete(token);
    this.prune();
    return item && this.isCurrent(item) ? item : undefined;
  }
}

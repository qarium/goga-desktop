import { t as msg } from "../shared/i18n";
import { z } from "zod";
import {
  applyOrganizationCommand,
  emptyOrganization,
  orderedProjectIds,
  reconcileOrganization,
  validGroupName,
  type OrganizationCommand,
  type ProjectOrganization,
} from "./project-organization-model";

export const organizationKey = "goga.desktop.projectOrganization.v1";
const id = z.string().min(1).max(256);
const schema = z
  .object({
    schemaVersion: z.literal(1),
    groups: z.array(
      z
        .object({
          id,
          name: z.string().refine(validGroupName),
          collapsed: z.boolean(),
          projectIds: z.array(id),
        })
        .strict(),
    ),
    ungroupedProjectIds: z.array(id),
  })
  .strict()
  .refine((o) => {
    const ids = orderedProjectIds(o);
    return (
      new Set(ids).size === ids.length &&
      new Set(o.groups.map((g) => g.id)).size === o.groups.length &&
      new Set(o.groups.map((g) => g.name.toLocaleLowerCase())).size ===
        o.groups.length
    );
  });

type Issue = { kind: "unsaved" | "protected"; message: string };
type Snapshot = { organization: ProjectOrganization; issue: Issue | null };
type StorageAccess = Pick<Storage, "getItem" | "setItem">;
const protectedIssue: Issue = {
  kind: "protected",
  get message() { return msg("workspace.couldNotReadTheLayoutThisWindowIsUsingA"); },
};
const unsavedIssue: Issue = {
  kind: "unsaved",
  get message() { return msg("workspace.projectOrderWasNotSavedYourChangesRemainUntilYou"); },
};
/** Sole writer for sidebar preferences. Mutations run against current state, not
 * captured React snapshots. A corrupt/future version requires explicit recovery. */
export function createOrganizationStore(storage: () => StorageAccess) {
  let snapshot: Snapshot = { organization: emptyOrganization(), issue: null };
  let catalog: readonly string[] = [],
    catalogReady = false,
    hadRecord = false,
    sessionEdits = false;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((fn) => fn());
  function read() {
    try {
      const raw = storage().getItem(organizationKey);
      const parsed =
        raw === null ? emptyOrganization() : schema.parse(JSON.parse(raw));
      hadRecord = raw !== null;
      snapshot = {
        organization: reconcileOrganization(parsed, catalog, catalogReady),
        issue: null,
      };
    } catch {
      snapshot = {
        organization: reconcileOrganization(
          emptyOrganization(),
          catalog,
          catalogReady,
        ),
        issue: protectedIssue,
      };
    }
  }
  read();
  function save(o: ProjectOrganization, force = false) {
    let issue = snapshot.issue;
    if (issue?.kind !== "protected" || force) {
      try {
        storage().setItem(organizationKey, JSON.stringify(o));
        hadRecord = true;
        issue = null;
        sessionEdits = false;
      } catch {
        issue =
          snapshot.issue?.kind === "protected" ? protectedIssue : unsavedIssue;
      }
    }
    snapshot = { organization: o, issue };
    notify();
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    setCatalog(ids: readonly string[], ready: boolean) {
      catalog = ids;
      catalogReady = ready;
      const next = reconcileOrganization(snapshot.organization, ids, ready);
      if (next === snapshot.organization) return;
      if (hadRecord || sessionEdits) save(next);
      else {
        snapshot = { ...snapshot, organization: next };
        notify();
      }
    },
    dispatch(command: OrganizationCommand) {
      if (!catalogReady) throw Error(msg("workspace.waitForTheProjectListToLoad"));
      const next = applyOrganizationCommand(snapshot.organization, command);
      if (next !== snapshot.organization) {
        sessionEdits = true;
        save(next);
      }
    },
    retry() {
      if (snapshot.issue?.kind === "unsaved" && catalogReady)
        save(snapshot.organization);
    },
    recover() {
      if (snapshot.issue?.kind === "protected" && catalogReady)
        save(snapshot.organization, true);
    },
    reload() {
      if (sessionEdits && snapshot.issue) return;
      read();
      notify();
    },
  };
}

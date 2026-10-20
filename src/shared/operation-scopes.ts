/** New IPC entrypoints must declare an explicit scope. A selector is never authority. */
export type OperationScope =
  | "transport"
  | "topic-or-primary-admin"
  | "catalog"
  | "context-lifecycle"
  | "sync"
  | "owner-ticket"
  | "run"
  | "home"
  | "desktop-project";
export const IPC_SCOPES: Readonly<Record<string, OperationScope>> = {
  "prepare-build-repeat":"run",
  "reconcile-run":"run",
  "cancel-read": "transport",
  "read-request": "transport",
  "ensure-topic-context": "context-lifecycle",
  "resolve-topic-context": "context-lifecycle",
  "check-topic-context-readiness": "topic-or-primary-admin",
  "list-topic-contexts": "catalog",
  "create-topic-context": "context-lifecycle",
  "migrate-topic-context": "context-lifecycle",
  "select-topic-context": "context-lifecycle",
  "sync-topic-context": "sync",
  "topic-sync-status": "sync",
  "retry-context-sync": "sync",
  "prepare-context-apply": "sync",
  "apply-context": "sync",
  "context-deletion-recovery": "context-lifecycle",
  "prepare-context-deletion": "context-lifecycle",
  "delete-context": "owner-ticket",
  "build-context": "topic-or-primary-admin",
  "list-build-files": "topic-or-primary-admin",
  "read-build-plan": "topic-or-primary-admin",
  "launch-build": "topic-or-primary-admin",
  "read-topic-board": "topic-or-primary-admin",
  "read-topic-details": "topic-or-primary-admin",
  "prepare-topic-operation": "topic-or-primary-admin",
  "execute-topic-operation": "owner-ticket",
  "prepare-document-deletion": "owner-ticket",
  "delete-document": "owner-ticket",
  "list-projects": "catalog",
  "choose-project": "catalog",
  "list-project-profiles": "topic-or-primary-admin",
  "list-project-tools": "topic-or-primary-admin",
  "list-project-pipelines": "topic-or-primary-admin",
  "list-project-workflows": "topic-or-primary-admin",
  "list-workflow-suggestions": "topic-or-primary-admin",
  "read-project-document": "topic-or-primary-admin",
  "save-project-document": "topic-or-primary-admin",
  "checkout-branch": "topic-or-primary-admin",
  "read-project-settings": "desktop-project",
  "save-project-settings": "desktop-project",
  discover: "topic-or-primary-admin",
  "read-topic-task": "topic-or-primary-admin",
  preview: "topic-or-primary-admin",
  launch: "topic-or-primary-admin",
  runs: "run",
  "select-run": "run",
  "close-run": "run",
  "stop-run": "run",
  "repeat-build": "run",
  "list-settings": "home",
  "read-settings": "home",
  "save-settings": "home",
};

// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useGitSequencerOperation } from "../src/renderer/GitSequencerOperation";
import { GitWorkspace } from "../src/renderer/GitWorkspace";
let api: any,
  portal: HTMLDivElement,
  operation: "cherry-pick" | "revert" = "cherry-pick";
const revision = "a".repeat(64),
  head = "b".repeat(40),
  original = "c".repeat(40);
const snapshot = (scope = "p") => ({
  scope,
  root: "/fixture/" + scope,
  revision,
  head,
  branch: "main",
  operation,
  upstream: null,
  ahead: 0,
  behind: 0,
  files: [],
});
const preview = (r: any) => ({
  ...r,
  root: "/fixture/" + r.scope,
  token: "d".repeat(64),
  branch: "main",
  head,
  original,
  current: "e".repeat(40),
  paths: ["file"],
  discardedResolutionPaths: [],
  hooks: "disabled",
  effects: "Подтверждённые изменения",
  expiresAt: Date.now() + 300000,
  requiresCommitWarning: r.operation === "revert" && r.action === "continue",
});
const result = (action = "continue", status = "success") => ({
  scope: "p",
  operation,
  action,
  status,
  changed: true,
  mutationStarted: true,
  worktreeRestored: action === "abort",
  worktreeUpdated: action === "continue",
  indexPublished: true,
  branchPublished: true,
  metadataPublished: true,
  metadataCleared: status !== "conflict",
  objectsPublished: action === "continue",
  publishedObjectCount: action === "continue" ? 3 : 0,
  recoveryStatus: "retained",
  recoveryPath: "/fixture/recovery",
  lastKnownRecoveryPath: "/fixture/recovery",
  lockRetained: false,
  retainedLocks: [],
  uncheckedLocks: [],
  message: "Verified",
  log: "Native log",
});
beforeEach(() => {
  operation = "cherry-pick";
  portal = document.createElement("div");
  document.body.append(portal);
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  api = {
    readGitWorkspace: vi.fn(async (s: string) => snapshot(s)),
    readGitDiff: vi.fn(async () => ({
      staged: { kind: "empty", text: "" },
      unstaged: { kind: "empty", text: "" },
    })),
    prepareGitSequencerOperation: vi.fn(async (r) => preview(r)),
    executeGitSequencerOperation: vi.fn(async () => result()),
    prepareGitCommit: vi.fn(),
    executeGitCommit: vi.fn(),
    cancelRead: vi.fn(async () => {}),
  };
  window.goga = api;
});
afterEach(() => {
  cleanup();
  portal.remove();
});
const view = (props: any = {}) => (
  <GitWorkspace
    scope="p"
    open
    bodyContainer={portal}
    onOpen={() => {}}
    onClose={() => {}}
    revision={0}
    {...props}
  />
);
async function start(action = "continue") {
  const label =
    action === "continue" ? `Продолжить ${operation}` : `Отменить ${operation}`;
  const button = await screen.findByRole("button", { name: label + "…" });
  await waitFor(() => expect(button).toHaveProperty("disabled", false));
  fireEvent.click(button);
  const dialog = await screen.findByRole("dialog", {
    name: label + (action === "abort" ? "?" : ""),
  });
  await within(dialog).findByRole("button", { name: label });
  return { dialog, label };
}
for (const op of ["cherry-pick", "revert"] as const) {
  it.each(["continue", "abort"])(
    `${op}: exact operation and token-only confirmed %s`,
    async (action) => {
      operation = op;
      api.executeGitSequencerOperation.mockImplementation(async () =>
        result(action),
      );
      const changed = vi.fn();
      render(view({ onChanged: changed }));
      const { dialog, label } = await start(action);
      expect(api.prepareGitSequencerOperation).toHaveBeenCalledWith({
        scope: "p",
        revision,
        operation: op,
        action,
      });
      expect(api.executeGitSequencerOperation).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole("button", { name: label }));
      await screen.findByRole("dialog", { name: `Результат операции ${op}` });
      expect(api.executeGitSequencerOperation).toHaveBeenCalledExactlyOnceWith(
        "d".repeat(64),
      );
      expect(changed).toHaveBeenCalled();
    },
  );
  it(`${op}: closed preview does not execute`, async () => {
    operation = op;
    render(view());
    const { dialog } = await start();
    fireEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));
    expect(api.executeGitSequencerOperation).not.toHaveBeenCalled();
  });
  it(`${op}: prepare error ends loading and log can close`, async () => {
    operation = op;
    api.prepareGitSequencerOperation.mockRejectedValue(
      Error("fixture read failure"),
    );
    render(view());
    const button = await screen.findByRole("button", {
      name: `Продолжить ${op}…`,
    });
    // The operation appears with the snapshot; the read's finally still has to
    // enable it. A disabled click is intentionally ignored by the component.
    await waitFor(() => expect(button).toHaveProperty("disabled", false));
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog", {
      name: `Результат операции ${op}`,
    });
    expect(within(dialog).getByText(/fixture read failure/)).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: `Закрыть результат ${op}` }),
    );
    expect(api.executeGitSequencerOperation).not.toHaveBeenCalled();
  });
  it(`${op}: foreign operation preview is not authority`, async () => {
    operation = op;
    api.prepareGitSequencerOperation.mockImplementation(async (r: any) => ({
      ...preview(r),
      operation: op === "revert" ? "cherry-pick" : "revert",
    }));
    render(view());
    const button = await screen.findByRole("button", {
      name: `Продолжить ${op}…`,
    });
    // The operation appears with the snapshot; the read's finally still has to
    // enable it. A disabled click is intentionally ignored by the component.
    await waitFor(() => expect(button).toHaveProperty("disabled", false));
    fireEvent.click(button);
    await screen.findByRole("dialog", { name: `Результат операции ${op}` });
    expect(api.executeGitSequencerOperation).not.toHaveBeenCalled();
  });
  it(`${op}: foreign result is not displayed or treated as success`, async () => {
    operation = op;
    api.executeGitSequencerOperation.mockResolvedValue({
      ...result(),
      scope: "other",
      log: "SECRET-OTHER-OWNER",
    });
    const changed = vi.fn();
    render(view({ onChanged: changed }));
    const { dialog, label } = await start();
    fireEvent.click(within(dialog).getByRole("button", { name: label }));
    await screen.findByRole("dialog", { name: `Результат операции ${op}` });
    expect(screen.queryByText(/SECRET-OTHER-OWNER/)).toBeNull();
    expect(changed).not.toHaveBeenCalled();
  });
}
it("single revert warns explicitly that continuing creates a commit despite unknown --no-commit", async () => {
  operation = "revert";
  render(view());
  const { dialog } = await start();
  expect(
    within(dialog).getByText(
      /Будет создан коммит; исходный --no-commit определить невозможно/,
    ),
  ).toBeTruthy();
});
it("next cherry-pick conflict is a verified transition, not completion", async () => {
  api.executeGitSequencerOperation.mockResolvedValue(
    result("continue", "conflict"),
  );
  const changed = vi.fn();
  render(view({ onChanged: changed }));
  const { dialog, label } = await start();
  fireEvent.click(within(dialog).getByRole("button", { name: label }));
  const log = await screen.findByRole("dialog", {
    name: "Результат операции cherry-pick",
  });
  expect(within(log).getByText(/Следующий конфликт/)).toBeTruthy();
  expect(changed).toHaveBeenCalled();
});
it("uncertain result keeps drafts and never retries execution", async () => {
  api.executeGitSequencerOperation.mockResolvedValue({
    ...result(),
    status: "uncertain",
    branchPublished: false,
    lockRetained: true,
    retainedLocks: ["index.lock"],
  });
  const changed = vi.fn();
  render(view({ onChanged: changed }));
  const { dialog, label } = await start();
  fireEvent.click(within(dialog).getByRole("button", { name: label }));
  await screen.findByRole("dialog", { name: "Результат операции cherry-pick" });
  expect(changed).not.toHaveBeenCalled();
  expect(api.executeGitSequencerOperation).toHaveBeenCalledTimes(1);
});
it("late execution result never appears in a different owner reusing the hook", async () => {
  let resolve!: (r: unknown) => void;
  api.executeGitSequencerOperation.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const succeeded = vi.fn();
  const hook = renderHook(
    ({ scope }) =>
      useGitSequencerOperation({
        scope,
        snapshot: snapshot(scope) as any,
        visible: true,
        ready: true,
        blocked: false,
        unresolved: false,
        freshness: scope,
        readVersion: 1,
        getIssuedReadVersion: () => 1,
        onSucceeded: succeeded,
      }),
    { initialProps: { scope: "p" } },
  );
  await act(async () => {
    await hook.result.current.prepare("continue");
  });
  let flight!: Promise<void>;
  act(() => {
    flight = hook.result.current.execute();
  });
  hook.rerender({ scope: "other" });
  await act(async () => {
    resolve({ ...result(), log: "LATE ORIGINAL OWNER LOG" });
    await flight;
  });
  expect(hook.result.current.result).toBe("");
  expect(succeeded).not.toHaveBeenCalled();
});

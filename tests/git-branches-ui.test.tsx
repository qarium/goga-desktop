// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { GitBranchPicker } from "../src/renderer/GitBranchPicker";
import { RetainedViews } from "../src/renderer/RetainedViews";
const rev = "a".repeat(64),
  oid = "b".repeat(40);
const branch = (name: string, remote = false) => ({
  name,
  ref: (remote ? "refs/remotes/" : "refs/heads/") + name,
  oid,
  upstream: null,
  checkedOut: false,
});
let api: any, inventory: any;
const deferred = () => {
  let resolve!: (v: any) => void;
  const promise = new Promise((r) => (resolve = r));
  return { resolve, promise };
};
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  inventory = {
    projectId: "p",
    root: "/fixture/p",
    revision: rev,
    head: oid,
    branch: "main",
    upstream: "refs/remotes/origin/main",
    operation: "none",
    dirty: false,
    local: [branch("main"), branch("feature")],
    remote: [branch("origin/main", true), branch("origin/feature", true)],
  };
  api = {
    readGitBranches: vi.fn(async () => inventory),
    prepareGitBranch: vi.fn(async (r: any) => ({
      token: "c".repeat(64),
      projectId: r.projectId,
      root: "/fixture/p",
      action: r.action,
      fromRef: "refs/heads/main",
      fromOid: oid,
      toRef: r.ref ?? "refs/heads/" + r.name,
      toOid: oid,
      remote: r.action === "pull" || r.action === "fetch" ? "origin" : null,
      createsBranch: r.action === "create" || r.action === "switch-remote",
      switchesBranch: r.action.startsWith("switch") || r.switch,
      hooks: "disabled",
      expiresAt: Date.now() + 300000,
    })),
    executeGitBranch: vi.fn(async () => ({
      projectId: "p",
      action: "switch-local",
      status: "success",
      changed: true,
      message: "Готово",
      log: "",
    })),
  };
  Object.defineProperty(window, "goga", { value: api, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function view(props: any = {}) {
  return (
    <GitBranchPicker
      projectId="p"
      branch="main"
      revision={0}
      onChanged={() => {}}
      {...props}
    />
  );
}
async function open() {
  fireEvent.click(screen.getByRole("button", { name: "Ветка: main" }));
  await screen.findByRole("button", { name: "feature" });
}
it("separates local/remote and filters substring without remote IO on open", async () => {
  render(view());
  await open();
  expect(screen.queryByText("origin/feature")).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Remote" }));
  expect(screen.queryByRole("button", { name: "feature" })).toBeNull();
  expect(screen.getByRole("button", { name: /origin\/feature/ })).toBeTruthy();
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "feature" },
  });
  expect(screen.queryByRole("button", { name: /origin\/main/ })).toBeNull();
  expect(api.prepareGitBranch).not.toHaveBeenCalled();
  expect(api.executeGitBranch).not.toHaveBeenCalled();
});
it("creates while dirty but unchecks and blocks automatic switching", async () => {
  inventory.dirty = true;
  render(view());
  await open();
  expect(
    (screen.getByRole("button", { name: "feature" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Создать ветку…" }));
  const checkbox = await screen.findByRole("checkbox", {
    name: "Переключиться на новую ветку",
  });
  expect((checkbox as HTMLInputElement).checked).toBe(false);
  expect((checkbox as HTMLInputElement).disabled).toBe(true);
  fireEvent.change(screen.getByRole("textbox", { name: "Название ветки" }), {
    target: { value: "new-feature" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
  await waitFor(() =>
    expect(api.prepareGitBranch).toHaveBeenCalledWith({
      projectId: "p",
      revision: rev,
      action: "create",
      name: "new-feature",
      switch: false,
    }),
  );
});
it("executes only preview ticket, refreshes owner and renders closable log on errors", async () => {
  const changed = vi.fn();
  api.executeGitBranch.mockResolvedValue({
    projectId: "p",
    action: "switch-local",
    status: "error",
    changed: false,
    message: "Ветка занята",
    log: "native refusal",
  });
  render(view({ onChanged: changed }));
  await open();
  fireEvent.click(screen.getByRole("button", { name: "feature" }));
  fireEvent.click(await screen.findByRole("button", { name: "Подтвердить" }));
  expect(await screen.findByText(/native refusal/)).toBeTruthy();
  expect(api.executeGitBranch).toHaveBeenCalledExactlyOnceWith("c".repeat(64));
  fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
  expect(screen.queryByText(/native refusal/)).toBeNull();
  expect(changed).toHaveBeenCalledWith("p");
});
it("keeps completion attached to original project while navigating", async () => {
  const d = deferred();
  api.executeGitBranch.mockReturnValue(d.promise);
  const changed = vi.fn();
  const { rerender } = render(
    <RetainedViews activeKey="p">{view({ onChanged: changed })}</RetainedViews>,
  );
  await open();
  fireEvent.click(screen.getByRole("button", { name: "feature" }));
  fireEvent.click(await screen.findByRole("button", { name: "Подтвердить" }));
  rerender(
    <RetainedViews activeKey="q">
      <p>Other</p>
    </RetainedViews>,
  );
  await act(async () =>
    d.resolve({
      projectId: "p",
      action: "switch-local",
      status: "success",
      changed: true,
      message: "Готово",
      log: "",
    }),
  );
  expect(changed).toHaveBeenCalledWith("p");
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("releases read loader on error and supports retry without executing an action", async () => {
  api.readGitBranches.mockRejectedValueOnce(Error("no branches"));
  render(view());
  fireEvent.click(screen.getByRole("button", { name: "Ветка: main" }));
  await screen.findByText(/no branches/);
  expect(screen.queryByRole("status")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
  await open();
  expect(api.executeGitBranch).not.toHaveBeenCalled();
});
it("hides mutations in unresolved state and keeps refresh inventory available", async () => {
  inventory.operation = "merge";
  render(view());
  await open();
  expect(
    (screen.getByRole("button", { name: "feature" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (
      screen.getByRole("button", {
        name: "Создать ветку…",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(screen.getByText(/Завершите текущую операцию Git/)).toBeTruthy();
});
it("never exposes primary branch actions for topic clones", async () => {
  const { GitWorkspace } = await import("../src/renderer/GitWorkspace");
  api.readGitWorkspace = vi.fn(async (scope) => ({
    scope,
    root: "/fixture/clone",
    revision: rev,
    head: oid,
    branch: "topic",
    upstream: null,
    ahead: 0,
    behind: 0,
    operation: "none",
    files: [],
  }));
  render(
    <GitWorkspace
      scope={
        {
          projectId: "p",
          year: "2026",
          topic: "t",
          branch: "topic",
          contextId: "c",
          revision: 1,
        } as any
      }
      open={false}
      bodyContainer={null}
      revision={0}
      onOpen={() => {}}
      onClose={() => {}}
    />,
  );
  await screen.findByLabelText("Ветка: topic");
  expect(screen.queryByRole("button", { name: "Ветка: topic" })).toBeNull();
  expect(api.readGitBranches).not.toHaveBeenCalled();
});
it("offers branch management beside changes only for the primary project", async () => {
  const { GitWorkspace } = await import("../src/renderer/GitWorkspace");
  api.readGitWorkspace = vi.fn(async () => ({
    scope: "p",
    root: "/fixture/p",
    revision: rev,
    head: oid,
    branch: "main",
    upstream: null,
    ahead: 0,
    behind: 0,
    operation: "none",
    files: [],
  }));
  render(
    <GitWorkspace
      scope="p"
      open={false}
      bodyContainer={null}
      revision={0}
      onOpen={() => {}}
      onClose={() => {}}
    />,
  );
  await screen.findByRole("button", { name: "Ветка: main" });
  expect(screen.getByRole("button", { name: /Изменения/ })).toBeTruthy();
});
it("reports modal coverage to hide native terminal/dashboard, including cancellation", async () => {
  const overlay = vi.fn(),
    busy = vi.fn();
  const { unmount } = render(
    view({ onOverlayChange: overlay, onBusyChange: busy }),
  );
  await open();
  fireEvent.click(screen.getByRole("button", { name: "feature" }));
  await screen.findByRole("button", { name: "Подтвердить" });
  expect(overlay).toHaveBeenLastCalledWith("p", true);
  fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  await waitFor(() => expect(overlay).toHaveBeenLastCalledWith("p", false));
  unmount();
  expect(overlay).toHaveBeenLastCalledWith("p", false);
});
it("a late preparation cannot reopen a modal after switching projects", async () => {
  const d = deferred();
  api.prepareGitBranch.mockReturnValue(d.promise);
  const { rerender } = render(
    <RetainedViews activeKey="p">{view()}</RetainedViews>,
  );
  await open();
  fireEvent.click(screen.getByRole("button", { name: "feature" }));
  await screen.findByRole("status", { name: "Проверяем операцию Git…" });
  rerender(
    <RetainedViews activeKey="q">
      <p>Other</p>
    </RetainedViews>,
  );
  await act(async () =>
    d.resolve({
      projectId: "p",
      action: "switch-local",
      token: "c".repeat(64),
    }),
  );
  rerender(<RetainedViews activeKey="p">{view()}</RetainedViews>);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
it("exits an inventory timeout and allows closing the error", async () => {
  vi.useFakeTimers();
  api.readGitBranches.mockReturnValue(new Promise(() => {}));
  render(view());
  fireEvent.click(screen.getByRole("button", { name: "Ветка: main" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30001);
  });
  expect(screen.queryByRole("status")).toBeNull();
  expect(
    screen.getByRole("dialog", { name: "Результат операции Git" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("shows the actual upstream rather than calling the current local branch the source", async () => {
  api.prepareGitBranch.mockResolvedValue({
    projectId: "p",
    root: "/fixture/p",
    action: "pull",
    token: "c".repeat(64),
    fromRef: "refs/heads/main",
    fromOid: oid,
    toRef: "refs/heads/main",
    toOid: oid,
    sourceRef: "refs/remotes/origin/release",
    remote: "origin",
    createsBranch: false,
    switchesBranch: false,
    hooks: "disabled",
    expiresAt: Date.now() + 300000,
  });
  render(view());
  await open();
  fireEvent.click(
    screen.getByRole("button", { name: "Подтянуть текущую ветку" }),
  );
  await screen.findByRole("button", { name: "Подтвердить" });
  expect(screen.getByText("origin/release")).toBeTruthy();
  expect(screen.getByText(/Последний известный коммит/)).toBeTruthy();
});

it("keeps inventory readable after a sequencer refresh failure without enabling writes", async () => {
  const { GitWorkspace } = await import("../src/renderer/GitWorkspace");
  const portal = document.createElement("div");
  document.body.append(portal);
  api.readGitSummary = vi.fn(async () => ({
    scope: "p",
    branch: "main",
    changedFiles: 0,
    conflicts: 0,
  }));
  api.readGitWorkspace = vi.fn(async () => ({
    scope: "p",
    root: "/fixture/p",
    revision: rev,
    head: oid,
    branch: "main",
    upstream: null,
    ahead: 0,
    behind: 0,
    operation: "cherry-pick",
    files: [],
  }));
  api.prepareGitSequencerOperation = vi.fn(async (request: any) => ({
    ...request,
    root: "/fixture/p",
    token: "d".repeat(64),
    branch: "main",
    head: oid,
    original: "c".repeat(40),
    current: "e".repeat(40),
    paths: ["file"],
    discardedResolutionPaths: [],
    hooks: "disabled",
    effects: "Подтверждённые изменения",
    expiresAt: Date.now() + 300000,
    requiresCommitWarning: false,
  }));
  api.executeGitSequencerOperation = vi.fn(async () => {
    throw Error("fixture uncertain execution");
  });
  const workspace = (open: boolean, revision: number) => (
    <GitWorkspace
      scope="p"
      open={open}
      bodyContainer={portal}
      revision={revision}
      onOpen={() => {}}
      onClose={() => {}}
    />
  );
  try {
    const { rerender } = render(workspace(true, 0));
    fireEvent.click(
      await screen.findByRole("button", { name: "Продолжить cherry-pick…" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Продолжить cherry-pick" }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Закрыть результат cherry-pick",
      }),
    );
    api.readGitWorkspace.mockRejectedValue(Error("fixture refresh failure"));
    rerender(workspace(true, 1));
    await screen.findByText(/fixture refresh failure/);
    rerender(workspace(false, 1));
    expect(screen.getByRole("button", { name: "Ветка: main" })).toHaveProperty(
      "disabled",
      false,
    );
    await open();
    expect(api.readGitWorkspace).toHaveBeenCalledTimes(2);
    expect(api.readGitBranches).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(/Обновите изменения Git перед изменением веток/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "feature" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      screen.getByRole("button", { name: "Создать ветку…" }),
    ).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("tab", { name: "Remote" }));
    expect(
      screen.getByRole("button", { name: "Обновить список из remote" }),
    ).toHaveProperty("disabled", true);
    expect(api.prepareGitBranch).not.toHaveBeenCalled();
    expect(api.executeGitBranch).not.toHaveBeenCalled();
  } finally {
    portal.remove();
  }
});

it("revokes a branch confirmation when a workspace mutation fence appears", async () => {
  const { rerender } = render(view());
  await open();
  fireEvent.click(screen.getByRole("button", { name: "feature" }));
  await screen.findByRole("button", { name: "Подтвердить" });
  rerender(
    view({
      mutationBlockedReason: "Обновите изменения Git перед изменением веток.",
    }),
  );
  expect(screen.queryByRole("button", { name: "Подтвердить" })).toBeNull();
  await open();
  expect(screen.getByRole("button", { name: "feature" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(api.executeGitBranch).not.toHaveBeenCalled();
  rerender(view());
  expect(screen.getByRole("button", { name: "feature" })).toHaveProperty(
    "disabled",
    false,
  );
});

it("renders a readable branch SVG without a dropdown arrow and retains menu semantics", async () => {
  render(view());
  const trigger = screen.getByRole("button", { name: "Ветка: main" });
  expect(trigger.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  expect(trigger.textContent).toBe("main");
  expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
  await open();
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
});

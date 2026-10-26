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
  within,
} from "@testing-library/react";
import { GitMergeSource } from "../src/renderer/GitMergeDialogs";
import { GitBranchPicker } from "../src/renderer/GitBranchPicker";
import { GitWorkspace } from "../src/renderer/GitWorkspace";
import { RetainedViews } from "../src/renderer/RetainedViews";

const revision = "a".repeat(64),
  head = "b".repeat(40),
  sourceOid = "c".repeat(40);
const row = (name: string, remote = false) => ({
  name,
  ref: (remote ? "refs/remotes/" : "refs/heads/") + name,
  oid: sourceOid,
  upstream: null,
  checkedOut: false,
});
let api: any, inventory: any, portal: HTMLDivElement;
beforeEach(() => {
  portal = document.createElement("div");
  document.body.append(portal);
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  inventory = {
    projectId: "p",
    root: "/fixture/p",
    revision,
    head,
    branch: "main",
    upstream: null,
    dirty: true,
    operation: "none",
    local: [row("main"), row("feature")],
    remote: [row("origin/feature", true)],
  };
  api = {
    readGitBranches: vi.fn(async () => inventory),
    prepareGitBranch: vi.fn(async (r: any) => ({
      ...r,
      token: "d".repeat(64),
      root: "/fixture/p",
      fromRef: "refs/heads/main",
      fromOid: head,
      toRef: "refs/heads/main",
      toOid: head,
      sourceRef: r.ref ?? null,
      sourceOid,
      mergeMode: r.action === "merge" ? "ff-or-commit" : "abort",
      autoCommit: r.action === "merge",
      remote: null,
      createsBranch: false,
      switchesBranch: false,
      hooks: "disabled",
      expiresAt: Date.now() + 300000,
    })),
    executeGitBranch: vi.fn(async () => ({
      projectId: "p",
      action: "merge",
      status: "success",
      changed: true,
      message: "Готово",
      log: "",
    })),
    readGitWorkspace: vi.fn(async () => ({
      scope: "p",
      root: "/fixture/p",
      revision,
      head,
      branch: "main",
      upstream: null,
      ahead: 0,
      behind: 0,
      operation: inventory.operation,
      files:
        inventory.operation === "merge"
          ? [
              {
                path: "conflict.txt",
                kind: "conflict",
                indexStatus: "U",
                worktreeStatus: "U",
                submodule: false,
              },
            ]
          : [],
    })),
  };
  Object.defineProperty(window, "goga", { value: api, configurable: true });
});
afterEach(() => {
  cleanup();
  portal.remove();
  vi.useRealTimers();
});
const picker = (props: any = {}) => (
  <GitBranchPicker
    projectId="p"
    branch="main"
    revision={0}
    onChanged={() => {}}
    {...props}
  />
);
async function menu() {
  fireEvent.click(screen.getByRole("button", { name: "Ветка: main" }));
  await screen.findByRole("button", { name: "feature" });
}
async function chooseSource(remote = false) {
  await menu();
  fireEvent.click(
    screen.getByRole("button", { name: "Влить ветку в текущую…" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Влить ветку в текущую",
  });
  if (remote)
    fireEvent.click(within(dialog).getByRole("tab", { name: "Remote" }));
  expect(within(dialog).queryByRole("combobox")).toBeNull();
  expect(
    within(dialog).getByRole("searchbox", { name: "Найти ветку-источник" }),
  ).toBeTruthy();
  expect(within(dialog).queryByRole("option", { name: "main" })).toBeNull();
  expect(
    within(dialog).queryByRole("option", {
      name: remote ? "feature" : "origin/feature",
    }),
  ).toBeNull();
  fireEvent.click(
    within(dialog).getByRole("option", {
      name: remote ? "origin/feature" : "feature",
    }),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Продолжить" }));
  return screen.findByRole("dialog", { name: "Подтвердить слияние" });
}

it.each([false, true])(
  "allows dirty merge but not switch, separates sources, previews exact source → current (%s)",
  async (remote) => {
    render(picker());
    const dialog = await chooseSource(remote);
    expect(api.prepareGitBranch).toHaveBeenCalledExactlyOnceWith({
      projectId: "p",
      revision,
      action: "merge",
      ref: remote ? "refs/remotes/origin/feature" : "refs/heads/feature",
    });
    expect(dialog.textContent).toContain("cccccccc");
    expect(dialog.textContent).toContain("bbbbbbbb");
    expect(dialog.textContent).toContain("merge-коммит");
    expect(dialog.textContent).toContain("Git-хуки отключены");
    expect(api.executeGitBranch).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Влить в main" }),
    );
    await waitFor(() =>
      expect(api.executeGitBranch).toHaveBeenCalledExactlyOnceWith(
        "d".repeat(64),
      ),
    );
  },
);

it("shows a genuine conflict result with read-only navigation, not auto abort or commit", async () => {
  const open = vi.fn(),
    changed = vi.fn();
  api.executeGitBranch.mockResolvedValue({
    projectId: "p",
    action: "merge",
    status: "conflict",
    changed: true,
    conflictCount: 1,
    message: "Есть конфликты",
    log: "CONFLICT fixture",
  });
  render(picker({ onShowChanges: open, onChanged: changed }));
  const dialog = await chooseSource();
  fireEvent.click(within(dialog).getByRole("button", { name: "Влить в main" }));
  const result = await screen.findByRole("dialog", {
    name: "Слияние остановлено: конфликты",
  });
  expect(result.textContent).toContain("CONFLICT fixture");
  const actions = within(result).getByRole("button", {
    name: "Просмотреть конфликты",
  }).parentElement!;
  expect(actions.classList.contains("git-branch-dialog-actions")).toBe(true);
  expect(within(actions).getByRole("button", { name: "Закрыть" })).toBeTruthy();
  fireEvent.click(
    within(result).getByRole("button", { name: "Просмотреть конфликты" }),
  );
  expect(open).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenCalledWith("p");
  expect(api.executeGitBranch).toHaveBeenCalledTimes(1);
});

it("keeps the legacy branch-menu abort with explicit preview", async () => {
  inventory.operation = "merge";
  api.executeGitBranch.mockResolvedValue({
    projectId: "p",
    action: "abort-merge",
    status: "success",
    changed: true,
    message: "Отменено",
    log: "",
  });
  render(picker());
  await menu();
  fireEvent.click(
    await screen.findByRole("button", { name: "Отменить слияние…" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Отменить слияние?",
  });
  expect(dialog.textContent).toContain(
    "Ручные решения конфликтов будут потеряны",
  );
  expect(api.prepareGitBranch).toHaveBeenCalledExactlyOnceWith({
    projectId: "p",
    revision,
    action: "abort-merge",
  });
  expect(api.executeGitBranch).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));
  expect(api.executeGitBranch).not.toHaveBeenCalled();
  await menu();
  fireEvent.click(screen.getByRole("button", { name: "Отменить слияние…" }));
  const again = await screen.findByRole("dialog", {
    name: "Отменить слияние?",
  });
  fireEvent.click(
    within(again).getByRole("button", { name: "Отменить слияние" }),
  );
  await waitFor(() => expect(api.executeGitBranch).toHaveBeenCalledOnce());
});

it("does not offer merge abort for rebase", async () => {
  inventory.operation = "rebase";
  render(picker());
  await menu();
  expect(
    screen.queryByRole("button", { name: "Отменить слияние…" }),
  ).toBeNull();
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Влить ветку в текущую…",
    }).disabled,
  ).toBe(true);
});

it("does not offer primary merge/abort controls for a topic clone with conflicts", async () => {
  const scope = {
    projectId: "p",
    year: "2026",
    topic: "t",
    branch: "topic",
    contextId: "clone",
    revision: "1",
  };
  api.readGitWorkspace.mockResolvedValue({
    scope,
    root: "/fixture/clone",
    revision,
    head,
    branch: "topic",
    upstream: null,
    ahead: 0,
    behind: 0,
    operation: "merge",
    files: [],
  });
  render(
    <GitWorkspace
      scope={scope}
      open
      bodyContainer={portal}
      onOpen={() => {}}
      onClose={() => {}}
      revision={0}
    />,
  );
  await screen.findByText(/Незавершённое слияние/);
  expect(
    screen.queryByRole("button", { name: "Отменить слияние…" }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: /Ветка:/ })).toBeNull();
  expect(api.readGitBranches).not.toHaveBeenCalled();
});

it("does not label a later read failure as a merge conflict", async () => {
  api.executeGitBranch.mockResolvedValue({
    projectId: "p",
    action: "merge",
    status: "conflict",
    changed: true,
    conflictCount: 1,
    message: "Есть конфликты",
    log: "CONFLICT fixture",
  });
  render(picker());
  const confirmation = await chooseSource();
  fireEvent.click(
    within(confirmation).getByRole("button", { name: "Влить в main" }),
  );
  await screen.findByRole("dialog", { name: "Слияние остановлено: конфликты" });
  fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
  api.readGitBranches.mockRejectedValueOnce(new Error("read failed"));
  fireEvent.click(screen.getByRole("button", { name: "Ветка: main" }));
  expect(
    await screen.findByRole("dialog", { name: "Результат операции Git" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Просмотреть конфликты" }),
  ).toBeNull();
});

it("finishes the abort preview loader on a stalled read without performing a mutation", async () => {
  vi.useFakeTimers();
  api.readGitBranches.mockImplementation(() => new Promise(() => {}));
  render(picker({ operation: "merge", abortContainer: portal }));
  fireEvent.click(screen.getByRole("button", { name: "Отменить слияние…" }));
  expect(
    screen.getByRole("status", { name: "Проверяем операцию Git…" }),
  ).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30001);
  });
  expect(
    screen.queryByRole("status", { name: "Проверяем операцию Git…" }),
  ).toBeNull();
  expect(screen.getByRole("dialog").textContent).toContain("Превышено время");
  fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.executeGitBranch).not.toHaveBeenCalled();
});

it("ignores a late abort inventory after leaving its owner", async () => {
  let finish!: (v: any) => void;
  api.readGitBranches.mockImplementation(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const view = render(
    <RetainedViews activeKey="p">
      {picker({ operation: "merge", abortContainer: portal })}
    </RetainedViews>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Отменить слияние…" }));
  await waitFor(() => expect(api.readGitBranches).toHaveBeenCalled());
  view.rerender(
    <RetainedViews activeKey="q">
      <p>Другой проект</p>
    </RetainedViews>,
  );
  await act(async () => finish(inventory));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.prepareGitBranch).not.toHaveBeenCalled();
});
it.each(["success", "error", "uncertain"])(
  "preserves legacy abort diagnostics including unknown locks on %s",
  async (status) => {
    inventory.operation = "merge";
    api.executeGitBranch.mockResolvedValue({
      projectId: "p",
      action: "abort-merge",
      status,
      changed: true,
      nativeWarning: true,
      lockRetained: true,
      retainedLocks: ["index.lock"],
      uncheckedLocks: ["HEAD.lock"],
      recoveryPath: "/fixture/recovery",
      recoveryUnverified: true,
      message: "Abort outcome",
      log: "native diagnostic",
    });
    render(picker());
    await menu();
    fireEvent.click(screen.getByRole("button", { name: "Отменить слияние…" }));
    const confirm = await screen.findByRole("dialog", {
      name: "Отменить слияние?",
    });
    fireEvent.click(
      within(confirm).getByRole("button", { name: "Отменить слияние" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Результат операции Git",
    });
    for (const text of [
      "/fixture/recovery",
      "Наличие материалов восстановления не проверено",
      "Сохранённые блокировки: index.lock",
      "Непроверенные блокировки: HEAD.lock",
      "native diagnostic",
    ])
      expect(dialog.textContent).toContain(text);
    fireEvent.click(within(dialog).getByRole("button", { name: "Закрыть" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  },
);

it("keeps the searchable merge list open, separates groups and requires explicit continuation", async () => {
  inventory.local.push(
    ...Array.from({ length: 40 }, (_, i) => row("feature/" + i)),
  );
  const select = vi.fn();
  render(
    <GitMergeSource
      inventory={inventory}
      onClose={vi.fn()}
      onSelect={select}
    />,
  );
  const dialog = await screen.findByRole("dialog");
  const ui = within(dialog);
  expect(ui.getAllByRole("option")).toHaveLength(41);
  const search = ui.getByRole("searchbox", { name: "Найти ветку-источник" });
  fireEvent.change(search, { target: { value: "FEATURE/39" } });
  expect(ui.getAllByRole("option")).toHaveLength(1);
  fireEvent.click(ui.getByRole("option", { name: "feature/39" }));
  expect(select).not.toHaveBeenCalled();
  fireEvent.change(search, { target: { value: "absent" } });
  expect(ui.queryAllByRole("option")).toHaveLength(0);
  expect(ui.getByText("Нет доступных веток")).toBeTruthy();
  fireEvent.click(ui.getByRole("tab", { name: "Remote" }));
  expect((search as HTMLInputElement).value).toBe("");
  expect(ui.getAllByRole("option")).toHaveLength(1);
  expect(
    (ui.getByRole("button", { name: "Продолжить" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(ui.getByRole("option", { name: "origin/feature" }));
  fireEvent.click(ui.getByRole("button", { name: "Продолжить" }));
  expect(select).toHaveBeenCalledExactlyOnceWith("refs/remotes/origin/feature");
});
it("supports keyboard movement inside the source list without starting merge", async () => {
  inventory.local.push(row("second"));
  const select = vi.fn();
  render(
    <GitMergeSource
      inventory={inventory}
      onClose={vi.fn()}
      onSelect={select}
    />,
  );
  await screen.findByRole("dialog");
  const first = screen.getByRole("option", { name: "feature" });
  fireEvent.keyDown(first, { key: "ArrowDown" });
  expect(document.activeElement).toBe(
    screen.getByRole("option", { name: "second" }),
  );
  fireEvent.keyDown(document.activeElement!, { key: "Home" });
  expect(document.activeElement).toBe(first);
  expect(select).not.toHaveBeenCalled();
});

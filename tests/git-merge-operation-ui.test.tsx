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
import { GitWorkspace } from "../src/renderer/GitWorkspace";
import { RetainedViews } from "../src/renderer/RetainedViews";
import type { ScopeRef } from "../src/shared/context";
import { contextKey } from "../src/renderer/topic-context";
const revision = "a".repeat(64),
  head = "b".repeat(40),
  sourceOid = "c".repeat(40);
const topic = {
  projectId: "p",
  year: "2026",
  topic: "t",
  branch: "topic",
  contextId: "ctx-" + "1".repeat(64),
  revision: "11111111-1111-4111-8111-111111111111",
};
let api: any, portal: HTMLDivElement;
const root = (scope: ScopeRef) =>
  typeof scope === "string"
    ? `/fixture/${scope}`
    : `/fixture/${scope.contextId}`;
const snapshot = (scope: ScopeRef = "p") => ({
  scope,
  root: root(scope),
  revision,
  head,
  branch: typeof scope === "string" ? "main" : scope.branch,
  operation: "merge",
  upstream: null,
  ahead: 0,
  behind: 0,
  files: [],
});
const preview = (r: any) => ({
  scope: r.scope,
  token: "d".repeat(64),
  root: root(r.scope),
  operation: "merge",
  action: r.action,
  head,
  sourceOid,
  branch: typeof r.scope === "string" ? "main" : r.scope.branch,
  paths: ["resolved.txt"],
  effects: "Only verified merge paths",
  message: r.message ?? "Merge incoming",
  author: "Fixture <f@example.invalid>",
  committer: "Committer <c@example.invalid>",
  signing: true,
  hooks: "disabled",
  expiresAt: Date.now() + 300000,
});
const result = (scope: ScopeRef = "p", action = "continue") => ({
  scope,
  operation: "merge",
  action,
  status: "success",
  changed: true,
  lockRetained: false,
  retainedLocks: [],
  uncheckedLocks: [],
  native: {
    operationId: "11111111-1111-4111-8111-111111111111",
    outcome: "completed",
    exitCode: 0,
    signal: null,
    beforeHead: head,
    afterHead: action === "abort" ? head : "e".repeat(40),
    conflicts: [],
    verifiedUnrelatedData: true,
    processSettled: true,
    recovery: "removed",
  },
  message: "Done",
  log: "",
});
const deferred = () => {
  let resolve!: (value: any) => void;
  let reject!: (reason: any) => void;
  const promise = new Promise((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
};
beforeEach(() => {
  portal = document.createElement("div");
  document.body.append(portal);
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  api = {
    readGitWorkspace: vi.fn(async (s: ScopeRef) => snapshot(s)),
    readGitDiff: vi.fn(async (r: any) => ({
      ...r,
      staged: { kind: "empty", text: "" },
      unstaged: { kind: "empty", text: "" },
    })),
    prepareGitMergeOperation: vi.fn(async (r: any) => preview(r)),
    executeGitMergeOperation: vi.fn(async () => result()),
    prepareGitCommit: vi.fn(),
    executeGitCommit: vi.fn(),
    cancelRead: vi.fn(async () => {}),
  };
  window.goga = api;
});
afterEach(() => {
  cleanup();
  portal.remove();
  vi.useRealTimers();
});
const view = (scope: ScopeRef = "p", props: any = {}) => (
  <GitWorkspace
    scope={scope}
    open
    bodyContainer={portal}
    onOpen={vi.fn()}
    onClose={vi.fn()}
    revision={0}
    {...props}
  />
);
async function readyButton(name: string) {
  const button = await screen.findByRole("button", { name });
  await waitFor(() => expect(button).toHaveProperty("disabled", false));
  return button;
}
const start = async (action = "continue") => {
  const button = await screen.findByRole("button", {
    name: action === "continue" ? "Завершить слияние…" : "Отменить слияние…",
  });
  await waitFor(() => expect(button).toHaveProperty("disabled", false));
  fireEvent.click(button);
  return screen.findByRole("dialog", {
    name: action === "continue" ? "Завершить слияние" : "Отменить слияние?",
  });
};
const execute = (dialog: HTMLElement, action = "continue") =>
  fireEvent.click(
    within(dialog).getByRole("button", {
      name: action === "continue" ? "Создать merge-коммит" : "Отменить слияние",
    }),
  );
it.each(["p", topic])(
  "completes a no-files merge for exact scope %j only after confirmation",
  async (scope) => {
    const changed = vi.fn();
    api.executeGitMergeOperation.mockResolvedValue(result(scope));
    render(view(scope, { onChanged: changed }));
    const dialog = await start();
    await within(dialog).findByRole("button", { name: "Создать merge-коммит" });
    expect(api.prepareGitMergeOperation).toHaveBeenCalledExactlyOnceWith({
      scope,
      revision,
      action: "continue",
    });
    for (const text of [
      root(scope),
      head,
      sourceOid,
      "resolved.txt",
      "Only verified merge paths",
      "Fixture <f@example.invalid>",
      "Committer <c@example.invalid>",
    ])
      expect(dialog.textContent).toContain(text);
    expect(dialog.textContent).toMatch(/хуки.*отключены/i);
    expect(dialog.textContent).toMatch(/не публикуется/);
    expect(
      screen.queryByRole("button", { name: "Создать коммит…" }),
    ).toBeNull();
    expect(api.executeGitMergeOperation).not.toHaveBeenCalled();
    execute(dialog);
    await waitFor(() =>
      expect(changed).toHaveBeenCalledWith(
        typeof scope === "string" ? scope : scope.projectId,
        scope,
      ),
    );
    expect(api.executeGitMergeOperation).toHaveBeenCalledExactlyOnceWith(
      "d".repeat(64),
    );
  },
);
it.each(["p", topic])(
  "previews scoped abort with manual resolution warning %j",
  async (scope) => {
    api.executeGitMergeOperation.mockResolvedValue(result(scope, "abort"));
    render(view(scope));
    const dialog = await start("abort");
    await within(dialog).findByRole("button", { name: "Отменить слияние" });
    expect(dialog.textContent).toContain(
      "Ручные решения конфликтов будут потеряны",
    );
    expect(api.prepareGitMergeOperation).toHaveBeenCalledExactlyOnceWith({
      scope,
      revision,
      action: "abort",
    });
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    execute(dialog, "abort");
    await waitFor(() =>
      expect(api.executeGitMergeOperation).toHaveBeenCalledOnce(),
    );
  },
);
it("invalidates the token after editing and re-prepares exact text", async () => {
  render(view());
  const dialog = await start();
  const input = await within(dialog).findByRole("textbox", {
    name: "Сообщение merge-коммита",
  });
  fireEvent.change(input, { target: { value: "Edited merge" } });
  expect(
    within(dialog).getByRole("button", { name: "Создать merge-коммит" }),
  ).toHaveProperty("disabled", true);
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Проверить сообщение" }),
  );
  await waitFor(() =>
    expect(api.prepareGitMergeOperation).toHaveBeenLastCalledWith({
      scope: "p",
      revision,
      action: "continue",
      message: "Edited merge",
    }),
  );
  await waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "Создать merge-коммит" }),
    ).toHaveProperty("disabled", false),
  );
  execute(dialog);
  await waitFor(() =>
    expect(api.executeGitMergeOperation).toHaveBeenCalledOnce(),
  );
});
it.each(["", "   ", "x".repeat(16385), "bad\0text"])(
  "blocks invalid edited message %#",
  async (message) => {
    render(view());
    const dialog = await start();
    fireEvent.change(await within(dialog).findByRole("textbox"), {
      target: { value: message },
    });
    execute(dialog);
    expect(api.executeGitMergeOperation).not.toHaveBeenCalled();
    expect(
      within(dialog).getByRole("button", { name: "Проверить сообщение" }),
    ).toHaveProperty("disabled", true);
  },
);
it.each(["rebase", "cherry-pick", "revert", "unknown"])(
  "never offers merge API for %s",
  async (operation) => {
    api.readGitWorkspace.mockResolvedValue({ ...snapshot(), operation });
    render(view());
    await screen.findByText(/Закрытие просмотра/);
    expect(
      screen.queryByRole("button", { name: "Завершить слияние…" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Отменить слияние…" }),
    ).toBeNull();
    expect(
      screen.getByText(
        /Продолжение и отмена этой операции здесь не поддерживаются/,
      ),
    ).toBeTruthy();
    expect(api.prepareGitMergeOperation).not.toHaveBeenCalled();
  },
);
it("blocks completion while any disk unmerged path remains, permits abort", async () => {
  api.readGitWorkspace.mockResolvedValue({
    ...snapshot(),
    files: [
      {
        path: "conflict.txt",
        kind: "conflict",
        indexStatus: "U",
        worktreeStatus: "U",
        submodule: false,
      },
    ],
  });
  render(view());
  expect(
    await screen.findByRole("button", { name: "Завершить слияние…" }),
  ).toHaveProperty("disabled", true);
  expect(
    screen.getByRole("button", { name: "Отменить слияние…" }),
  ).toHaveProperty("disabled", false);
});
it.each([
  "scope",
  "action",
  "operation",
  "root",
  "head",
  "branch",
  "token",
  "expiresAt",
  "message",
  "hooks",
])("rejects mismatched/expired preview %s", async (field) => {
  api.prepareGitMergeOperation.mockImplementation(async (r: any) => ({
    ...preview(r),
    [field]:
      field === "expiresAt"
        ? Date.now() - 1
        : field === "message"
          ? " "
          : "wrong",
  }));
  render(view());
  fireEvent.click(await readyButton("Завершить слияние…"));
  expect(
    await screen.findByRole("dialog", { name: "Результат операции слияния" }),
  ).toBeTruthy();
  expect(api.executeGitMergeOperation).not.toHaveBeenCalled();
});
it.each(["scope", "action", "operation"])(
  "treats mismatched execute %s as unknown",
  async (field) => {
    api.executeGitMergeOperation.mockResolvedValue({
      ...result(),
      [field]: "wrong",
    });
    const changed = vi.fn();
    render(view("p", { onChanged: changed }));
    const dialog = await start();
    await within(dialog).findByRole("textbox");
    execute(dialog);
    const message = await screen.findByRole("dialog", {
      name: "Результат операции слияния",
    });
    expect(message.textContent).toMatch(/Проверьте состояние Git/);
    expect(changed).not.toHaveBeenCalled();
  },
);
it.each(["hide", "revision", "scope-revision"])(
  "cancels late prepare on %s",
  async (change) => {
    const pending = deferred();
    api.prepareGitMergeOperation.mockReturnValue(pending.promise);
    const rendered = render(view(topic));
    fireEvent.click(await readyButton("Завершить слияние…"));
    rendered.rerender(
      view(
        change === "scope-revision"
          ? { ...topic, revision: "22222222-2222-4222-8222-222222222222" }
          : topic,
        { open: change !== "hide", revision: change === "revision" ? 1 : 0 },
      ),
    );
    await act(async () =>
      pending.resolve(preview({ scope: topic, action: "continue" })),
    );
    rendered.rerender(view(topic));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.cancelRead).toHaveBeenCalled();
    expect(api.executeGitMergeOperation).not.toHaveBeenCalled();
  },
);
it("bounds hung prepare with closable log", async () => {
  api.prepareGitMergeOperation.mockReturnValue(new Promise(() => {}));
  render(view());
  await readyButton("Завершить слияние…");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fireEvent.click(screen.getByRole("button", { name: "Завершить слияние…" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30001);
  });
  const dialog = screen.getByRole("dialog", {
    name: "Результат операции слияния",
  });
  expect(dialog.textContent).toContain("Превышено время ожидания");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Закрыть результат слияния" }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.executeGitMergeOperation).not.toHaveBeenCalled();
});
it.each(["p", topic])(
  "retains pending write %j across navigation, one flight and owner-only notification",
  async (scope) => {
    const pending = deferred(),
      changed = vi.fn(),
      overlay = vi.fn();
    api.executeGitMergeOperation.mockReturnValue(pending.promise);
    const original = () =>
      view(scope, { onChanged: changed, onOverlayChange: overlay });
    const rendered = render(
      <RetainedViews activeKey="p">{original()}</RetainedViews>,
    );
    const dialog = await start();
    await within(dialog).findByRole("textbox");
    const button = within(dialog).getByRole("button", {
      name: "Создать merge-коммит",
    });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(api.executeGitMergeOperation).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "Отменить слияние…" }),
    ).toHaveProperty("disabled", true);
    expect(
      screen.getByRole("button", { name: "Закрыть изменения" }),
    ).toHaveProperty("disabled", false);
    rendered.rerender(
      <RetainedViews activeKey="q">
        {view("q", { onChanged: changed })}
      </RetainedViews>,
    );
    await screen.findByRole("button", { name: "Завершить слияние…" });
    await act(async () => pending.resolve(result(scope)));
    expect(changed).toHaveBeenCalledExactlyOnceWith(
      typeof scope === "string" ? scope : scope.projectId,
      scope,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(overlay).toHaveBeenLastCalledWith(
      typeof scope === "string" ? scope : scope.projectId,
      false,
      typeof scope === "string" ? scope : contextKey(scope),
    );
  },
);
it("preserves unknown result, Escape closes only popup and reread is required", async () => {
  api.executeGitMergeOperation.mockRejectedValue(Error("IPC lost"));
  const close = vi.fn();
  render(view("p", { onClose: close }));
  const confirm = await start();
  await within(confirm).findByRole("textbox");
  execute(confirm);
  const dialog = await screen.findByRole("dialog", {
    name: "Результат операции слияния",
  });
  expect(dialog.textContent).toContain("Проверьте состояние Git");
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(close).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "Завершить слияние…" }),
  ).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Обновить изменения" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Завершить слияние…" }),
    ).toHaveProperty("disabled", false),
  );
  const again = await start();
  expect(await within(again).findByRole("textbox")).toHaveProperty(
    "value",
    "Merge incoming",
  );
});
it.each(["error", "uncertain", "success"])(
  "shows all recovery/native diagnostics for %s",
  async (status) => {
    api.executeGitMergeOperation.mockResolvedValue({
      ...result(),
      status,
      commit: "e".repeat(40),
      recoveryPath: "/fixture/recovery",
      recoveryUnverified: true,
      nativeWarning: true,
      lockRetained: true,
      retainedLocks: ["index.lock"],
      uncheckedLocks: ["HEAD.lock"],
      log: "native warning log",
    });
    render(view());
    const confirm = await start();
    await within(confirm).findByRole("textbox");
    execute(confirm);
    const dialog = await screen.findByRole("dialog", {
      name: "Результат операции слияния",
    });
    for (const text of [
      "e".repeat(40),
      "/fixture/recovery",
      "Наличие материалов восстановления не проверено",
      "Сохранённые блокировки: index.lock",
      "Непроверенные блокировки: HEAD.lock",
      "native warning log",
    ])
      expect(dialog.textContent).toContain(text);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Закрыть результат слияния" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  },
);
it("reports overlays only for visible active modal, not footer write progress", async () => {
  const overlay = vi.fn(),
    pending = deferred();
  api.executeGitMergeOperation.mockReturnValue(pending.promise);
  const rendered = render(view("p", { onOverlayChange: overlay }));
  const dialog = await start();
  await within(dialog).findByRole("textbox");
  expect(overlay).toHaveBeenLastCalledWith("p", true, "p");
  execute(dialog);
  expect(overlay).toHaveBeenLastCalledWith("p", false, "p");
  rendered.rerender(view("p", { open: false, onOverlayChange: overlay }));
  await act(async () =>
    pending.resolve({ ...result(), status: "error", log: "hidden log" }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(overlay).toHaveBeenLastCalledWith("p", false, "p");
  rendered.rerender(view("p", { onOverlayChange: overlay }));
  await screen.findByText(/hidden log/);
  expect(overlay).toHaveBeenLastCalledWith("p", true, "p");
});
it.each([
  { native: undefined },
  { native: { ...result().native, processSettled: false } },
  { native: { ...result().native, verifiedUnrelatedData: false } },
  { native: { ...result().native, beforeHead: "f".repeat(40) } },
  { native: { ...result().native, exitCode: 1 } },
  {
    native: {
      ...result().native,
      recovery: "retained",
      recoveryPath: "/fixture/recovery",
    },
  },
  { lockRetained: true },
  { retainedLocks: ["index.lock"] },
  { uncheckedLocks: ["HEAD.lock"] },
  { recoveryUnverified: true },
])(
  "does not discard drafts or report confirmed success with incomplete proof %j",
  async (facts) => {
    const changed = vi.fn();
    api.executeGitMergeOperation.mockResolvedValue({ ...result(), ...facts });
    render(view("p", { onChanged: changed }));
    let dialog = await start();
    fireEvent.change(await within(dialog).findByRole("textbox"), {
      target: { value: "Keep this draft" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Проверить сообщение" }),
    );
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Создать merge-коммит" }),
      ).toHaveProperty("disabled", false),
    );
    execute(dialog);
    dialog = await screen.findByRole("dialog", {
      name: "Результат операции слияния",
    });
    expect(changed).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Закрыть результат слияния" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Обновить изменения" }));
    dialog = await start();
    expect(await within(dialog).findByRole("textbox")).toHaveProperty(
      "value",
      "Keep this draft",
    );
  },
);
it("keeps a same-owner message across navigation and freshness changes but requires fresh preview", async () => {
  const rendered = render(view(topic));
  const dialog = await start();
  fireEvent.change(await within(dialog).findByRole("textbox"), {
    target: { value: "Topic draft" },
  });
  rendered.rerender(view(topic, { open: false }));
  const next = { ...topic, revision: "22222222-2222-4222-8222-222222222222" };
  rendered.rerender(view(next));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const fresh = await start();
  expect(await within(fresh).findByRole("textbox")).toHaveProperty(
    "value",
    "Topic draft",
  );
  expect(api.prepareGitMergeOperation).toHaveBeenLastCalledWith({
    scope: next,
    revision,
    action: "continue",
    message: "Topic draft",
  });
});
it("expires a confirmation and refuses stale token even before the timer runs", async () => {
  render(view());
  const dialog = await start();
  await within(dialog).findByRole("textbox");
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 600000);
  execute(dialog);
  expect(api.executeGitMergeOperation).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
it("cancels explicit preview and ignores its late answer", async () => {
  const pending = deferred();
  api.prepareGitMergeOperation.mockReturnValue(pending.promise);
  render(view());
  const dialog = await start("abort");
  fireEvent.click(
    within(dialog).getByRole("button", {
      name: "Закрыть подтверждение слияния",
    }),
  );
  await act(async () =>
    pending.resolve(preview({ scope: "p", action: "abort" })),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.executeGitMergeOperation).not.toHaveBeenCalled();
  expect(api.cancelRead).toHaveBeenCalledOnce();
});
it("does not reinterpret a stalled write as cancelled or timed out", async () => {
  const pending = deferred();
  api.executeGitMergeOperation.mockReturnValue(pending.promise);
  render(view());
  const dialog = await start();
  await within(dialog).findByRole("textbox");
  execute(dialog);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600000);
  });
  expect(screen.getByRole("status").textContent).toContain(
    "Выполняется операция слияния",
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.cancelRead).not.toHaveBeenCalled();
  await act(async () => pending.resolve(result()));
  expect(api.executeGitMergeOperation).toHaveBeenCalledOnce();
});
it("routes an inactive owner's late error to only that owner and preserves other draft", async () => {
  const pending = deferred(),
    changed = vi.fn(),
    overlay = vi.fn();
  api.executeGitMergeOperation.mockReturnValueOnce(pending.promise);
  const p = () => view("p", { onChanged: changed, onOverlayChange: overlay });
  const rendered = render(<RetainedViews activeKey="p">{p()}</RetainedViews>);
  const dialog = await start();
  await within(dialog).findByRole("textbox");
  execute(dialog);
  rendered.rerender(<RetainedViews activeKey="q">{view("q")}</RetainedViews>);
  const q = await start();
  fireEvent.change(await within(q).findByRole("textbox"), {
    target: { value: "Only Q" },
  });
  await act(async () =>
    pending.resolve({
      ...result(),
      status: "uncertain",
      log: "Only P failure",
    }),
  );
  expect(q.textContent).not.toContain("Only P failure");
  expect(within(q).getByRole("textbox")).toHaveProperty("value", "Only Q");
  expect(changed).not.toHaveBeenCalled();
  rendered.rerender(<RetainedViews activeKey="p">{p()}</RetainedViews>);
  expect(await screen.findByText(/Only P failure/)).toBeTruthy();
  expect(overlay).toHaveBeenLastCalledWith("p", true, "p");
});
it("invalidates an already-open preview when workspace freshness changes", async () => {
  const rendered = render(view());
  const dialog = await start();
  await within(dialog).findByRole("textbox");
  rendered.rerender(view("p", { revision: 1 }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.executeGitMergeOperation).not.toHaveBeenCalled();
});
it("expires the active token at its finite deadline and offers only rechecking", async () => {
  render(view());
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Завершить слияние…" }),
    ).toHaveProperty("disabled", false),
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  fireEvent.click(screen.getByRole("button", { name: "Завершить слияние…" }));
  await act(async () => {});
  expect(
    screen.getByRole("button", { name: "Создать merge-коммит" }),
  ).toHaveProperty("disabled", false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300001);
  });
  expect(screen.getByText(/Срок подтверждения истёк/)).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Создать merge-коммит" }),
  ).toHaveProperty("disabled", true);
  expect(api.executeGitMergeOperation).not.toHaveBeenCalled();
});
it("rejects a preview bound to a different edited message", async () => {
  render(view());
  const dialog = await start();
  fireEvent.change(await within(dialog).findByRole("textbox"), {
    target: { value: "Exact message" },
  });
  api.prepareGitMergeOperation.mockImplementation(async (r: any) => ({
    ...preview(r),
    message: "Old message",
  }));
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Проверить сообщение" }),
  );
  expect(
    await screen.findByRole("dialog", { name: "Результат операции слияния" }),
  ).toBeTruthy();
  expect(api.executeGitMergeOperation).not.toHaveBeenCalled();
});
it("offers one scoped footer abort, disables branch operations during the write and does not use legacy API", async () => {
  api.readGitBranches = vi.fn();
  api.prepareGitBranch = vi.fn();
  api.executeGitBranch = vi.fn();
  const pending = deferred();
  api.executeGitMergeOperation.mockReturnValue(pending.promise);
  render(view());
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Отменить слияние…" }),
    ).toHaveProperty("disabled", false),
  );
  expect(
    screen.getAllByRole("button", { name: "Отменить слияние…" }),
  ).toHaveLength(1);
  const dialog = await start("abort");
  await within(dialog).findByRole("button", { name: "Отменить слияние" });
  execute(dialog, "abort");
  expect(screen.getByRole("button", { name: "Ветка: main" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(api.prepareGitBranch).not.toHaveBeenCalled();
  expect(api.executeGitBranch).not.toHaveBeenCalled();
  await act(async () => pending.resolve(result("p", "abort")));
});
it("keeps an invalid message draft editable after closing and reopening confirmation", async () => {
  render(view());
  const dialog = await start();
  fireEvent.change(await within(dialog).findByRole("textbox"), {
    target: { value: "" },
  });
  fireEvent.click(
    within(dialog).getByRole("button", {
      name: "Закрыть подтверждение слияния",
    }),
  );
  const again = await start();
  expect(within(again).getByRole("textbox")).toHaveProperty("value", "");
  expect(api.prepareGitMergeOperation).toHaveBeenCalledOnce();
  expect(api.executeGitMergeOperation).not.toHaveBeenCalled();
  fireEvent.change(within(again).getByRole("textbox"), {
    target: { value: "Fixed message" },
  });
  fireEvent.click(
    within(again).getByRole("button", { name: "Проверить сообщение" }),
  );
  await waitFor(() =>
    expect(
      within(again).getByRole("button", { name: "Создать merge-коммит" }),
    ).toHaveProperty("disabled", false),
  );
});
it.each([
  ["read-first", "uncertain"],
  ["write-first", "uncertain"],
  ["read-first", "rejected"],
  ["write-first", "rejected"],
])(
  "requires a successful read started after the write result, not a pre-result read (%s, %s)",
  async (order, outcome) => {
    const read = deferred(),
      write = deferred();
    api.executeGitMergeOperation.mockReturnValue(write.promise);
    const rendered = render(view());
    const dialog = await start();
    await within(dialog).findByRole("textbox");
    execute(dialog);
    rendered.rerender(view("p", { open: false }));
    api.readGitWorkspace.mockReturnValueOnce(read.promise);
    rendered.rerender(view());
    await waitFor(() => expect(api.readGitWorkspace).toHaveBeenCalledTimes(2));
    // Keep both replies in one React batch, but drain read transport promises
    // to prove that neither response order may bypass the post-result fence.
    await act(async () => {
      if (order === "read-first") {
        read.resolve(snapshot());
        for (let i = 0; i < 10; i++) await Promise.resolve();
      }
      if (outcome === "rejected") write.reject(Error("IPC lost"));
      else
        write.resolve({
          ...result(),
          status: "uncertain",
          changed: true,
          log: "Check Git",
        });
      if (order === "write-first") {
        for (let i = 0; i < 10; i++) await Promise.resolve();
        read.resolve(snapshot());
      }
    });
    fireEvent.click(await readyButton("Закрыть результат слияния"));
    expect(
      screen.getByRole("button", { name: "Завершить слияние…" }),
    ).toHaveProperty("disabled", true);
    expect(api.readGitWorkspace).toHaveBeenCalledTimes(2);
    expect(api.executeGitMergeOperation).toHaveBeenCalledOnce();
    // A failed post-result read is not sufficient either.
    api.readGitWorkspace.mockRejectedValueOnce(Error("Fresh read failed"));
    fireEvent.click(await readyButton("Обновить изменения"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Закрыть ошибку Git" }),
    );
    expect(
      screen.getByRole("button", { name: "Завершить слияние…" }),
    ).toHaveProperty("disabled", true);
    expect(api.readGitWorkspace).toHaveBeenCalledTimes(3);
    // Only this successful read, started after the result, authorizes reprepare.
    fireEvent.click(await readyButton("Обновить изменения"));
    await readyButton("Завершить слияние…");
    expect(api.readGitWorkspace).toHaveBeenCalledTimes(4);
    const fresh = await start();
    await within(fresh).findByRole("textbox");
    expect(api.prepareGitMergeOperation).toHaveBeenCalledTimes(2);
    expect(api.executeGitMergeOperation).toHaveBeenCalledOnce();
  },
);

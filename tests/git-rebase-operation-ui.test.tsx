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
import { EditorView } from "@codemirror/view";
import { GitWorkspace } from "../src/renderer/GitWorkspace";
import { useGitRebaseOperation } from "../src/renderer/GitRebaseOperation";
import { RetainedViews } from "../src/renderer/RetainedViews";
import type { ScopeRef } from "../src/shared/context";
const revision = "a".repeat(64),
  head = "b".repeat(40),
  original = "c".repeat(40);
const topic = {
  projectId: "p",
  year: "2026",
  topic: "t",
  branch: "topic",
  contextId: "ctx-" + "1".repeat(64),
  revision: "11111111-1111-4111-8111-111111111111",
};
let api: any, portal: HTMLDivElement;
const root = (s: ScopeRef) =>
  `/fixture/${typeof s === "string" ? s : s.contextId}`;
const snapshot = (scope: ScopeRef = "p") => ({
  scope,
  root: root(scope),
  revision,
  head,
  branch: null,
  operation: "rebase",
  upstream: null,
  ahead: 0,
  behind: 0,
  files: [] as any[],
});
const preview = (r: any) => ({
  scope: r.scope,
  token: "d".repeat(64),
  root: root(r.scope),
  operation: "rebase",
  backend: "merge",
  action: r.action,
  head,
  original,
  branch: typeof r.scope === "string" ? "host-original-branch" : r.scope.branch,
  paths: ["resolved.txt"],
  discardedResolutionPaths: r.action === "abort" ? ["resolved.txt"] : [],
  effects: "Only verified rebase paths",
  hooks: "disabled",
  expiresAt: Date.now() + 300000,
});
const result = (
  scope: ScopeRef = "p",
  action = "continue",
  conflict = false,
) => ({
  scope,
  operation: "rebase",
  action,
  status: conflict ? "conflict" : "success",
  changed: true,
  mutationStarted: true,
  worktreeRestored: action === "abort",
  indexPublished: true,
  headPublished: true,
  metadataCleared: !conflict,
  ...(action === "continue"
    ? {
        worktreeUpdated: true,
        objectsPublished: true,
        publishedObjectCount: 3,
        branchPublished: !conflict,
        metadataPublished: true,
      }
    : {}),
  recoveryStatus: "retained",
  recoveryPath: "/fixture/recovery",
  lockRetained: false,
  retainedLocks: [],
  uncheckedLocks: [],
  message: conflict ? "Next conflict" : "Done",
  log: "Verified journal",
});
const deferred = () => {
  let resolve!: (v: any) => void, reject!: (v: any) => void;
  const promise = new Promise((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
};
const conflictFile = {
  path: "resolved.txt",
  kind: "conflict",
  indexStatus: "U",
  worktreeStatus: "U",
  submodule: false,
};
const conflictDoc = (r: any) => ({
  ...r,
  fingerprint: "e".repeat(64),
  base: { kind: "text", text: "base", oid: head, mode: "100644" },
  current: { kind: "text", text: "ours", oid: head, mode: "100644" },
  incoming: { kind: "text", text: "theirs", oid: original, mode: "100644" },
  working: { kind: "text", text: "manual draft" },
  generated: {
    kind: "text",
    text: "generated",
    requiresExplicitReconstruction: true,
    blocks: [],
  },
});
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
    readGitConflict: vi.fn(async (r: any) => conflictDoc(r)),
    prepareGitRebaseOperation: vi.fn(async (r: any) => preview(r)),
    executeGitRebaseOperation: vi.fn(async () => result()),
    prepareGitMergeOperation: vi.fn(),
    executeGitMergeOperation: vi.fn(),
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
const label = (a = "continue") =>
  a === "continue" ? "Продолжить rebase" : "Отменить rebase";
async function readyButton(name: string) {
  const b = await screen.findByRole("button", { name });
  await waitFor(() => expect(b).toHaveProperty("disabled", false));
  return b;
}
async function start(a = "continue") {
  fireEvent.click(await readyButton(label(a) + "…"));
  const d = await screen.findByRole("dialog", {
    name: label(a) + (a === "abort" ? "?" : ""),
  });
  await within(d).findByRole("button", { name: label(a) });
  return d;
}
const execute = (d: HTMLElement, a = "continue") =>
  fireEvent.click(within(d).getByRole("button", { name: label(a) }));
const logDialog = () =>
  screen.findByRole("dialog", { name: "Результат операции rebase" });
function pane() {
  return [...portal.querySelectorAll(".yaml-code-editor")]
    .map((h) =>
      h.shadowRoot?.querySelector('[aria-label="Результат разрешения"]'),
    )
    .filter(Boolean)
    .map((n) => EditorView.findFromDOM(n as HTMLElement))[0];
}
it.each(["p", topic])(
  "uses host branch for detached owner %j and token only after confirmation",
  async (scope) => {
    const changed = vi.fn();
    api.executeGitRebaseOperation.mockResolvedValue(result(scope));
    render(view(scope, { onChanged: changed }));
    const d = await start();
    expect(api.prepareGitRebaseOperation).toHaveBeenCalledExactlyOnceWith({
      scope,
      revision,
      action: "continue",
    });
    for (const t of [
      root(scope),
      head,
      original,
      preview({ scope }).branch,
      "resolved.txt",
      "Only verified rebase paths",
      "histogram",
      "reflog",
    ])
      expect(d.textContent).toContain(t);
    expect(d.textContent).toMatch(/автор.*сообщение/i);
    expect(d.textContent).toMatch(/не публикуется/);
    expect(d.textContent).toMatch(/до 128 picks/);
    expect(d.textContent).not.toMatch(/не более одного/);
    expect(within(d).queryByRole("textbox")).toBeNull();
    expect(api.executeGitRebaseOperation).not.toHaveBeenCalled();
    execute(d);
    await waitFor(() =>
      expect(changed).toHaveBeenCalledExactlyOnceWith("p", scope),
    );
    expect(api.executeGitRebaseOperation).toHaveBeenCalledExactlyOnceWith(
      "d".repeat(64),
    );
    expect(api.prepareGitMergeOperation).not.toHaveBeenCalled();
    expect(api.executeGitMergeOperation).not.toHaveBeenCalled();
    expect((await logDialog()).textContent).toContain("/fixture/recovery");
  },
);
it.each(["p", topic])(
  "previews abort with explicit loss of conflict resolutions without commit editor %j",
  async (scope) => {
    api.executeGitRebaseOperation.mockResolvedValue(result(scope, "abort"));
    const changed = vi.fn();
    render(view(scope, { onChanged: changed }));
    const d = await start("abort");
    expect(api.prepareGitRebaseOperation).toHaveBeenCalledExactlyOnceWith({
      scope,
      revision,
      action: "abort",
    });
    expect(d.textContent).toMatch(/решения.*будут.*удалены/i);
    expect(d.textContent).toMatch(/Посторонние правки блокируют отмену/i);
    expect(
      within(d).getByLabelText("Решения, которые будут удалены").textContent,
    ).toContain("resolved.txt");
    expect(d.textContent).toMatch(/черновики.*только.*успешной отмен/i);
    expect(within(d).queryByRole("textbox")).toBeNull();
    execute(d, "abort");
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  },
);
it.each(["merge", "cherry-pick", "revert", "unknown", "none"])(
  "never routes operation %s to rebase",
  async (operation) => {
    api.readGitWorkspace.mockResolvedValue({ ...snapshot(), operation });
    render(view());
    await screen.findByText("Нет изменений для просмотра");
    expect(
      screen.queryByRole("button", { name: "Продолжить rebase…" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Отменить rebase…" }),
    ).toBeNull();
    expect(api.prepareGitRebaseOperation).not.toHaveBeenCalled();
  },
);
it("reports missing protocol without rebase actions", async () => {
  delete api.prepareGitRebaseOperation;
  render(view());
  expect(
    await screen.findByText(/Продолжение и отмена rebase недоступны/),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Продолжить rebase…" }),
  ).toBeNull();
});
it.each([
  "scope",
  "root",
  "head",
  "original",
  "action",
  "operation",
  "backend",
  "hooks",
  "token",
  "expiresAt",
  "paths",
  "branch",
])("rejects unsafe preview %s", async (field) => {
  api.prepareGitRebaseOperation.mockImplementation(async (r: any) => ({
    ...preview(r),
    [field]:
      field === "expiresAt"
        ? Date.now() - 1
        : field === "paths"
          ? [17]
          : "wrong",
  }));
  render(view(topic));
  fireEvent.click(await readyButton("Продолжить rebase…"));
  expect((await logDialog()).textContent).toMatch(/Подтверждение/);
  expect(api.executeGitRebaseOperation).not.toHaveBeenCalled();
});
it("does not start for invalid HEAD", async () => {
  api.readGitWorkspace.mockResolvedValue({ ...snapshot(), head: "invalid" });
  render(view());
  expect(
    await screen.findByRole("button", { name: "Продолжить rebase…" }),
  ).toHaveProperty("disabled", true);
  expect(api.prepareGitRebaseOperation).not.toHaveBeenCalled();
});
it.each(["hide", "revision", "scope-revision", "close", "owner"])(
  "cancels late prepare on %s without sticky busy state",
  async (change) => {
    const pending = deferred();
    api.prepareGitRebaseOperation.mockReturnValueOnce(pending.promise);
    const rendered = render(view(topic));
    fireEvent.click(await readyButton("Продолжить rebase…"));
    await screen.findByRole("status", { name: "Проверяем операцию rebase…" });
    if (change === "close")
      fireEvent.click(
        screen.getByRole("button", { name: "Закрыть подтверждение rebase" }),
      );
    else
      rendered.rerender(
        view(
          change === "owner"
            ? "q"
            : change === "scope-revision"
              ? { ...topic, revision: "22222222-2222-4222-8222-222222222222" }
              : topic,
          { open: change !== "hide", revision: change === "revision" ? 1 : 0 },
        ),
      );
    await act(async () =>
      pending.resolve(preview({ scope: topic, action: "continue" })),
    );
    rendered.rerender(view(topic));
    await readyButton("Продолжить rebase…");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.cancelRead).toHaveBeenCalled();
    expect(api.executeGitRebaseOperation).not.toHaveBeenCalled();
  },
);
it("invalidates an open preview after a fresh workspace read", async () => {
  const r = render(view());
  await start();
  r.rerender(view("p", { revision: 1 }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.executeGitRebaseOperation).not.toHaveBeenCalled();
});
it("bounds hung prepare and releases loader to a closable error", async () => {
  api.prepareGitRebaseOperation.mockReturnValue(new Promise(() => {}));
  render(view());
  await readyButton("Продолжить rebase…");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fireEvent.click(screen.getByRole("button", { name: "Продолжить rebase…" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30001);
  });
  const d = screen.getByRole("dialog", { name: "Результат операции rebase" });
  expect(d.textContent).toContain("Превышено время ожидания");
  fireEvent.click(
    within(d).getByRole("button", { name: "Закрыть результат rebase" }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Продолжить rebase…" }),
  ).toHaveProperty("disabled", false);
  expect(api.prepareGitRebaseOperation).toHaveBeenCalledOnce();
});
it("expires a token and never automatically repeats prepare/write", async () => {
  render(view());
  await readyButton("Продолжить rebase…");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  fireEvent.click(screen.getByRole("button", { name: "Продолжить rebase…" }));
  await act(async () => {});
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300001);
  });
  expect(screen.getByText(/Срок подтверждения истёк/)).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Продолжить rebase" }),
  ).toHaveProperty("disabled", true);
  expect(api.executeGitRebaseOperation).not.toHaveBeenCalled();
});
it.each(["p", topic])(
  "retains uncancelled single-flight execute and owner diagnostics across navigation %j",
  async (scope) => {
    const pending = deferred(),
      changed = vi.fn(),
      busy = vi.fn(),
      overlay = vi.fn();
    api.executeGitRebaseOperation.mockReturnValue(pending.promise);
    const p = () =>
      view(scope, {
        onChanged: changed,
        onBranchBusyChange: busy,
        onOverlayChange: overlay,
      });
    const r = render(<RetainedViews activeKey="p">{p()}</RetainedViews>);
    const d = await start();
    const b = within(d).getByRole("button", { name: "Продолжить rebase" });
    fireEvent.click(b);
    fireEvent.click(b);
    expect(api.executeGitRebaseOperation).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "Отменить rebase…" }),
    ).toHaveProperty("disabled", true);
    expect(busy.mock.calls.at(-1)?.[1]).toBe(true);
    expect(overlay.mock.calls.at(-1)?.[1]).toBe(false);
    r.rerender(<RetainedViews activeKey="q">{view("q")}</RetainedViews>);
    await readyButton("Продолжить rebase…");
    await act(async () =>
      pending.resolve({
        ...result(scope),
        status: "uncertain",
        log: "Only original owner",
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(changed).not.toHaveBeenCalled();
    r.rerender(<RetainedViews activeKey="p">{p()}</RetainedViews>);
    expect((await logDialog()).textContent).toContain("Only original owner");
    expect(overlay.mock.calls.at(-1)?.[1]).toBe(true);
  },
);
it.each([
  "scope",
  "action",
  "operation",
  "mutationStarted",
  "changed",
  "worktreeUpdated",
  "objectsPublished",
  "publishedObjectCount",
  "indexPublished",
  "headPublished",
  "branchPublished",
  "metadataPublished",
  "metadataCleared",
  "recoveryStatus",
  "recoveryPath",
  "lockRetained",
  "retainedLocks",
  "uncheckedLocks",
])("refuses incomplete or incoherent success %s", async (field) => {
  const invalid: any = {
    scope: "q",
    action: "abort",
    operation: "merge",
    publishedObjectCount: -1,
    recoveryStatus: "missing",
    recoveryPath: undefined,
    lockRetained: true,
    retainedLocks: ["index.lock"],
    uncheckedLocks: ["HEAD.lock"],
  };
  api.executeGitRebaseOperation.mockResolvedValue({
    ...result(),
    [field]: field in invalid ? invalid[field] : false,
  });
  const changed = vi.fn();
  render(view("p", { onChanged: changed }));
  execute(await start());
  expect((await logDialog()).textContent).toMatch(/не подтвержд|не определён/);
  expect(changed).not.toHaveBeenCalled();
});
it.each([
  "mutationStarted",
  "worktreeRestored",
  "indexPublished",
  "headPublished",
  "metadataCleared",
])("refuses abort lacking %s", async (field) => {
  const changed = vi.fn();
  api.executeGitRebaseOperation.mockResolvedValue({
    ...result("p", "abort"),
    [field]: false,
  });
  render(view("p", { onChanged: changed }));
  execute(await start("abort"), "abort");
  await logDialog();
  expect(changed).not.toHaveBeenCalled();
});
it.each(["branchPublished", "metadataCleared", "metadataPublished"])(
  "rejects incoherent next-conflict %s",
  async (field) => {
    const changed = vi.fn(),
      value = result("p", "continue", true);
    api.executeGitRebaseOperation.mockResolvedValue({
      ...value,
      [field]: !value[field as keyof typeof value],
    });
    render(view("p", { onChanged: changed }));
    execute(await start());
    await logDialog();
    expect(changed).not.toHaveBeenCalled();
  },
);
it.each(["missing", "unverified", "not-created"])(
  "reports real partial publication and %s recovery without asserting retained",
  async (recoveryStatus) => {
    api.executeGitRebaseOperation.mockResolvedValue({
      ...result(),
      status: "uncertain",
      objectsPublished: false,
      publishedObjectCount: 2,
      headPublished: false,
      metadataPublished: false,
      recoveryStatus,
      recoveryPath: undefined,
      lastKnownRecoveryPath: "/fixture/last-known",
      lockRetained: true,
      retainedLocks: ["index.lock"],
      uncheckedLocks: ["HEAD.lock"],
      log: "Partial write log",
    });
    render(view());
    execute(await start());
    const d = await logDialog();
    for (const text of [
      "Опубликованных файлов объектов: 2",
      "Шаг публикации объектов: нет",
      "HEAD опубликован: нет",
      "index.lock",
      "HEAD.lock",
      "/fixture/last-known",
      "Partial write log",
    ])
      expect(d.textContent).toContain(text);
    expect(d.textContent).toMatch(/последн.*известн/i);
    expect(d.textContent).not.toContain(
      "Проверенные материалы восстановления:",
    );
  },
);
it.each(["read-first", "write-first"])(
  "fences every pre-result read (%s), Escape only closes diagnostics",
  async (order) => {
    const read = deferred(),
      write = deferred(),
      close = vi.fn();
    api.executeGitRebaseOperation.mockReturnValue(write.promise);
    const r = render(view("p", { onClose: close }));
    execute(await start());
    r.rerender(view("p", { open: false, onClose: close }));
    api.readGitWorkspace.mockReturnValueOnce(read.promise);
    r.rerender(view("p", { onClose: close }));
    await waitFor(() => expect(api.readGitWorkspace).toHaveBeenCalledTimes(2));
    await act(async () => {
      if (order === "read-first") {
        read.resolve(snapshot());
        for (let i = 0; i < 10; i++) await Promise.resolve();
      }
      write.reject(Error("IPC lost"));
      if (order === "write-first") {
        for (let i = 0; i < 10; i++) await Promise.resolve();
        read.resolve(snapshot());
      }
    });
    fireEvent.keyDown(await logDialog(), { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Продолжить rebase…" }),
    ).toHaveProperty("disabled", true);
    expect(api.executeGitRebaseOperation).toHaveBeenCalledOnce();
    api.readGitWorkspace.mockRejectedValueOnce(Error("read failed"));
    fireEvent.click(await readyButton("Обновить изменения"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Закрыть ошибку Git" }),
    );
    expect(
      screen.getByRole("button", { name: "Продолжить rebase…" }),
    ).toHaveProperty("disabled", true);
    fireEvent.click(await readyButton("Обновить изменения"));
    await readyButton("Продолжить rebase…");
  },
);
it("blocks continue for unmerged paths and retained unsaved drafts, clears drafts only after verified abort", async () => {
  api.readGitWorkspace.mockResolvedValueOnce({
    ...snapshot(),
    files: [conflictFile],
  });
  render(view());
  expect(
    await screen.findByRole("button", { name: "Продолжить rebase…" }),
  ).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "resolved.txt" }));
  await waitFor(() => expect(pane()).toBeTruthy());
  act(() => pane()!.dispatch({ changes: { from: 0, insert: "my solution " } }));
  fireEvent.click(await readyButton("Обновить изменения"));
  await waitFor(() => expect(api.readGitWorkspace).toHaveBeenCalledTimes(2));
  expect(
    screen.getByRole("button", { name: "Продолжить rebase…" }),
  ).toHaveProperty("disabled", true);
  api.executeGitRebaseOperation.mockResolvedValueOnce({
    ...result("p", "abort"),
    status: "uncertain",
  });
  execute(await start("abort"), "abort");
  fireEvent.keyDown(await logDialog(), { key: "Escape" });
  expect(pane()!.state.doc.toString()).toContain("my solution");
  fireEvent.click(await readyButton("Обновить изменения"));
  api.executeGitRebaseOperation.mockResolvedValueOnce(result("p", "abort"));
  execute(await start("abort"), "abort");
  await logDialog();
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "resolved.txt" })).toBeNull(),
  );
});
it("verified next conflict refreshes exact owner and reads a fresh resolver document", async () => {
  const changed = vi.fn();
  api.executeGitRebaseOperation.mockImplementation(async () => {
    api.readGitWorkspace.mockResolvedValue({
      ...snapshot(),
      revision: "f".repeat(64),
      files: [conflictFile],
    });
    return result("p", "continue", true);
  });
  render(view("p", { onChanged: changed }));
  execute(await start());
  fireEvent.keyDown(await logDialog(), { key: "Escape" });
  await waitFor(() =>
    expect(changed).toHaveBeenCalledExactlyOnceWith("p", "p"),
  );
  fireEvent.click(await screen.findByRole("button", { name: "resolved.txt" }));
  await waitFor(() => expect(pane()).toBeTruthy());
  expect(api.readGitConflict).toHaveBeenCalledExactlyOnceWith({
    scope: "p",
    path: "resolved.txt",
    revision: "f".repeat(64),
  });
  expect(
    screen.getByRole("button", { name: "Продолжить rebase…" }),
  ).toHaveProperty("disabled", true);
});
it("overlay consumes confirmation Escape without closing workspace or writing", async () => {
  const overlay = vi.fn(),
    close = vi.fn();
  render(view("p", { onOverlayChange: overlay, onClose: close }));
  const d = await start();
  expect(overlay).toHaveBeenLastCalledWith("p", true, "p");
  fireEvent.keyDown(d, { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(overlay).toHaveBeenLastCalledWith("p", false, "p");
  expect(api.executeGitRebaseOperation).not.toHaveBeenCalled();
});
it.each(["scope", "action", "operation"])(
  "does not disclose diagnostics belonging to another %s",
  async (field) => {
    api.executeGitRebaseOperation.mockResolvedValue({
      ...result(),
      [field]: field === "action" ? "abort" : "foreign",
      log: "FOREIGN PRIVATE LOG",
      message: "FOREIGN PRIVATE MESSAGE",
      recoveryPath: "/foreign/private/recovery",
      retainedLocks: ["foreign-private.lock"],
    });
    const changed = vi.fn();
    render(view("p", { onChanged: changed }));
    execute(await start());
    const d = await logDialog();
    expect(d.textContent).toMatch(/не подтвержд/);
    for (const text of ["FOREIGN", "/foreign/", "foreign-private.lock"])
      expect(d.textContent).not.toContain(text);
    expect(changed).not.toHaveBeenCalled();
  },
);
it("rejects another freshness revision within the same managed owner", async () => {
  api.prepareGitRebaseOperation.mockImplementation(async (r: any) => ({
    ...preview(r),
    scope: { ...r.scope, revision: "22222222-2222-4222-8222-222222222222" },
  }));
  render(view(topic));
  fireEvent.click(await readyButton("Продолжить rebase…"));
  await logDialog();
  expect(api.executeGitRebaseOperation).not.toHaveBeenCalled();
});
it.each([
  "mutationStarted",
  "worktreeUpdated",
  "objectsPublished",
  "publishedObjectCount",
  "indexPublished",
  "headPublished",
  "branchPublished",
  "metadataPublished",
  "metadataCleared",
  "lockRetained",
  "retainedLocks",
  "uncheckedLocks",
  "recoveryStatus",
])("missing required result fact %s is not completion", async (field) => {
  const v: any = result();
  delete v[field];
  api.executeGitRebaseOperation.mockResolvedValue(v);
  const changed = vi.fn();
  render(view("p", { onChanged: changed }));
  execute(await start());
  expect((await logDialog()).textContent).toMatch(/не подтвержд/);
  expect(changed).not.toHaveBeenCalled();
});
it("shows unsupported histogram prepare as a closable log, never execute or retry", async () => {
  api.prepareGitRebaseOperation.mockRejectedValue(
    Error("Git histogram capability unavailable"),
  );
  const close = vi.fn();
  render(view("p", { onClose: close }));
  fireEvent.click(await readyButton("Продолжить rebase…"));
  const d = await logDialog();
  expect(d.textContent).toContain("Git histogram capability unavailable");
  fireEvent.keyDown(d, { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
  await readyButton("Продолжить rebase…");
  expect(api.prepareGitRebaseOperation).toHaveBeenCalledOnce();
  expect(api.executeGitRebaseOperation).not.toHaveBeenCalled();
});
it("new same-path conflict replaces completed saved document, not the old resolver", async () => {
  api.readGitWorkspace.mockResolvedValueOnce({
    ...snapshot(),
    files: [conflictFile],
  });
  api.prepareGitConflictSave = vi.fn(async (r: any) => ({
    token: "f".repeat(64),
    scope: r.scope,
    path: r.path,
    branch: "host-original-branch",
    resolution: r.resolution.kind,
    bytes: 4,
    expiresAt: Date.now() + 60000,
    hooks: "disabled",
    canonicalization: "git-text-attributes",
  }));
  api.executeGitConflictSave = vi.fn(async () => ({
    scope: "p",
    path: "resolved.txt",
    status: "saved",
    worktreePublished: true,
    indexPublished: true,
    lockRetained: false,
    message: "Saved",
    log: "",
  }));
  render(view());
  fireEvent.click(await screen.findByRole("button", { name: "resolved.txt" }));
  await waitFor(() => expect(pane()).toBeTruthy());
  fireEvent.click(
    screen.getByRole("button", { name: "Принять текущий файл…" }),
  );
  const save = await screen.findByRole("dialog", {
    name: "Подтвердить разрешение файла",
  });
  fireEvent.click(
    within(save).getByRole("button", { name: "Записать файл и индекс" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Закрыть результат разрешения" }),
  );
  api.executeGitRebaseOperation.mockImplementation(async () => {
    api.readGitWorkspace.mockResolvedValue({
      ...snapshot(),
      revision: "f".repeat(64),
      files: [conflictFile],
    });
    api.readGitConflict.mockImplementation(async (r: any) => ({
      ...conflictDoc(r),
      working: { kind: "text", text: "new next conflict" },
    }));
    return result("p", "continue", true);
  });
  execute(await start());
  fireEvent.keyDown(await logDialog(), { key: "Escape" });
  fireEvent.click(await screen.findByRole("button", { name: "resolved.txt" }));
  await waitFor(() =>
    expect(pane()?.state.doc.toString()).toBe("new next conflict"),
  );
  expect(api.readGitConflict).toHaveBeenCalledTimes(2);
});
it("a pre-result read cannot enable a different operation after uncertain rebase", async () => {
  const write = deferred();
  api.executeGitRebaseOperation.mockReturnValue(write.promise);
  const r = render(view());
  execute(await start());
  r.rerender(view("p", { open: false }));
  api.readGitWorkspace.mockResolvedValue({
    ...snapshot(),
    operation: "merge",
    branch: "main",
  });
  r.rerender(view());
  const merge = await screen.findByRole("button", {
    name: "Завершить слияние…",
  });
  expect(merge).toHaveProperty("disabled", true);
  await act(async () => write.reject(Error("ACK lost")));
  fireEvent.keyDown(await logDialog(), { key: "Escape" });
  expect(merge).toHaveProperty("disabled", true);
  expect(api.prepareGitMergeOperation).not.toHaveBeenCalled();
  fireEvent.click(await readyButton("Обновить изменения"));
  await readyButton("Завершить слияние…");
});
it("write outlives prepare budget and closed panel without cancellation or retry", async () => {
  const write = deferred();
  api.executeGitRebaseOperation.mockReturnValue(write.promise);
  const changed = vi.fn(),
    r = render(view("p", { onChanged: changed }));
  const d = await start();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  execute(d);
  const cancelCount = api.cancelRead.mock.calls.length;
  r.rerender(view("p", { open: false, onChanged: changed }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120001);
  });
  expect(api.executeGitRebaseOperation).toHaveBeenCalledOnce();
  expect(api.cancelRead.mock.calls.length).toBe(cancelCount);
  expect(changed).not.toHaveBeenCalled();
  await act(async () => write.resolve(result()));
  expect(changed).toHaveBeenCalledExactlyOnceWith("p", "p");
});
it("late verified completion notifies original managed revision, never current owner", async () => {
  const write = deferred(),
    changed = vi.fn();
  api.executeGitRebaseOperation.mockReturnValue(write.promise);
  const r = render(
    <RetainedViews activeKey="p">
      {view(topic, { onChanged: changed })}
    </RetainedViews>,
  );
  execute(await start());
  r.rerender(
    <RetainedViews activeKey="q">
      {view("q", { onChanged: changed })}
    </RetainedViews>,
  );
  await readyButton("Продолжить rebase…");
  await act(async () => write.resolve(result(topic)));
  expect(changed).toHaveBeenCalledExactlyOnceWith("p", topic);
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("abort does not claim continuation-only histogram or remaining-pick restrictions", async () => {
  render(view());
  const d = await start("abort");
  expect(d.textContent).not.toContain("histogram");
  expect(d.textContent).not.toContain("не более одного");
  expect(d.textContent).not.toContain("текущий pick");
  expect(d.textContent).toContain("apply");
});
it("does not claim verified recovery for contradictory retained/last-known paths", async () => {
  const changed = vi.fn();
  api.executeGitRebaseOperation.mockResolvedValue({
    ...result(),
    lastKnownRecoveryPath: "/fixture/elsewhere",
  });
  render(view("p", { onChanged: changed }));
  execute(await start());
  const d = await logDialog();
  expect(changed).not.toHaveBeenCalled();
  expect(d.textContent).not.toContain("Проверенные материалы восстановления:");
  expect(d.textContent).toContain("/fixture/elsewhere");
});
it("partial object count does not imply completed or durable object publication", async () => {
  api.executeGitRebaseOperation.mockResolvedValue({
    ...result(),
    status: "uncertain",
    objectsPublished: false,
    publishedObjectCount: 2,
  });
  render(view());
  execute(await start());
  expect((await logDialog()).textContent).toMatch(/включает.*ошибк.*fsync/);
});

it("consumes confirmation synchronously so a stale execute closure cannot reuse its token", async () => {
  const hook = renderHook(() =>
    useGitRebaseOperation({
      scope: "p",
      snapshot: snapshot() as any,
      visible: true,
      ready: true,
      blocked: false,
      unresolved: false,
      freshness: "fixed",
      readVersion: 1,
      getIssuedReadVersion: () => 1,
      onSucceeded: vi.fn(),
    }),
  );
  await act(async () => hook.result.current.prepare("continue"));
  const staleExecute = hook.result.current.execute;
  await act(async () => {
    await staleExecute();
    await staleExecute();
  });
  expect(api.executeGitRebaseOperation).toHaveBeenCalledExactlyOnceWith(
    "d".repeat(64),
  );
});
it("preserves both contradictory recovery paths as unconfirmed observations", async () => {
  const changed = vi.fn();
  api.executeGitRebaseOperation.mockResolvedValue({
    ...result(),
    recoveryPath: "/fixture/observed-recovery",
    lastKnownRecoveryPath: "/fixture/previous-recovery",
  });
  render(view("p", { onChanged: changed }));
  execute(await start());
  const diagnostic = (await logDialog()).textContent;
  expect(diagnostic).toContain("/fixture/observed-recovery");
  expect(diagnostic).toContain("/fixture/previous-recovery");
  expect(diagnostic).toMatch(
    /Наблюдаемый путь восстановления.*сохранность не подтверждена/,
  );
  expect(diagnostic).not.toContain("Проверенные материалы восстановления:");
  expect(diagnostic).not.toContain("Завершение rebase подтверждено.");
  expect(changed).not.toHaveBeenCalled();
  expect(api.executeGitRebaseOperation).toHaveBeenCalledOnce();
});
it.each(["retainedLocks", "uncheckedLocks"])(
  "preserves observed names from malformed %s without asserting complete inventory or clearing drafts",
  async (field) => {
    const changed = vi.fn();
    api.readGitWorkspace.mockResolvedValueOnce({
      ...snapshot(),
      files: [conflictFile],
    });
    api.executeGitRebaseOperation.mockResolvedValue({
      ...result("p", "abort"),
      [field]: ["observed-owned.lock", null],
    });
    render(view("p", { onChanged: changed }));
    fireEvent.click(
      await screen.findByRole("button", { name: "resolved.txt" }),
    );
    await waitFor(() => expect(pane()).toBeTruthy());
    act(() =>
      pane()!.dispatch({ changes: { from: 0, insert: "keep my draft " } }),
    );
    execute(await start("abort"), "abort");
    const dialog = await logDialog();
    expect(dialog.textContent).toContain("observed-owned.lock");
    expect(dialog.textContent).toMatch(
      /наблюдаемые имена.*observed-owned\.lock/i,
    );
    expect(dialog.textContent).toMatch(/список неполон или не проверен/i);
    expect(dialog.textContent).not.toContain("Отмена rebase подтверждена.");
    expect(changed).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(pane()!.state.doc.toString()).toContain("keep my draft");
    expect(api.executeGitRebaseOperation).toHaveBeenCalledOnce();
  },
);
it.each(["continue", "abort"])(
  "accepts only host-issued apply %s preview and shows its actual backend",
  async (action) => {
    const changed = vi.fn();
    api.prepareGitRebaseOperation.mockImplementation(async (r: any) => ({
      ...preview(r),
      backend: "apply",
    }));
    api.executeGitRebaseOperation.mockResolvedValue(result("p", action));
    render(view("p", { onChanged: changed }));
    const d = await start(action);
    expect(d.textContent).toContain("rebase --apply");
    expect(d.textContent).not.toContain("--apply не поддерживается");
    expect(api.executeGitRebaseOperation).not.toHaveBeenCalled();
    execute(d, action);
    await logDialog();
    expect(api.executeGitRebaseOperation).toHaveBeenCalledExactlyOnceWith(
      "d".repeat(64),
    );
    expect(changed).toHaveBeenCalledExactlyOnceWith("p", "p");
  },
);

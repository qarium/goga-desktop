// @vitest-environment jsdom
import React from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { GitWorkspace } from "../src/renderer/GitWorkspace";
import { useGitCommit } from "../src/renderer/GitCommit";
import type { ScopeRef } from "../src/shared/context";
import type { GitWorkspaceSnapshot } from "../src/shared/git-workspace";
let portal: HTMLDivElement, api: any;
const rev = "a".repeat(64);
function snapshot(scope: ScopeRef = "p"): GitWorkspaceSnapshot {
  return {
    scope,
    root: "/fixture/" + scope,
    revision: rev,
    head: "b".repeat(40),
    branch: "main",
    upstream: null,
    ahead: 0,
    behind: 0,
    operation: "none",
    files: ["one.txt", "other.txt"].map((path) => ({
      path,
      indexStatus: "M",
      worktreeStatus: "M",
      kind: "tracked",
      submodule: false,
    })),
  };
}
function preview(r: any) {
  return {
    ...r,
    token: "1".repeat(64),
    root: "/fixture/" + r.scope,
    branch: "main",
    deletedCount: 0,
    author: "Fixture <fixture@example.invalid>",
    committer: "Fixture <fixture@example.invalid>",
    signing: false,
    hooks: "disabled",
    expiresAt: Date.now() + 300000,
  };
}
const deferred = () => {
  let resolve!: (v: any) => void;
  const promise = new Promise((r) => (resolve = r));
  return { resolve, promise };
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
    readGitWorkspace: vi.fn(async (s: string) => snapshot(s)),
    readGitDiff: vi.fn(async (r: any) => ({
      ...r,
      changes: { kind: "patch", text: "@@ -1 +1 @@\n-base\n+final " + r.path },
    })),
    prepareGitCommit: vi.fn(async (r: any) => preview(r)),
    executeGitCommit: vi.fn(async () => ({
      scope: "p",
      status: "committed",
      commit: "c".repeat(40),
      indexPublished: true,
      message: "Коммит создан",
      log: "",
    })),
  };
  window.goga = api;
});
afterEach(() => {
  cleanup();
  portal.remove();
  vi.useRealTimers();
});
const view = (
  scope: ScopeRef = "p",
  open = true,
  revision = 0,
  disabled = false,
) => (
  <GitWorkspace
    scope={scope}
    open={open}
    bodyContainer={portal}
    onOpen={vi.fn()}
    onClose={vi.fn()}
    revision={revision}
    disabled={disabled}
  />
);
async function draft() {
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "Выбрать файл: other.txt" }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Сообщение коммита" }), {
    target: { value: "Selected files" },
  });
}
it("previews only checked whole files and commits only after explicit confirmation", async () => {
  render(view());
  await draft();
  fireEvent.click(screen.getByRole("button", { name: "one.txt" }));
  await waitFor(() => expect(portal.textContent).toContain("+final one.txt"));
  expect(
    screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Выбрать файл: other.txt",
    }).checked,
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Создать коммит…" }));
  expect(
    await screen.findByRole("dialog", { name: "Подтвердить коммит" }),
  ).toBeTruthy();
  expect(api.prepareGitCommit).toHaveBeenCalledWith({
    scope: "p",
    revision: rev,
    paths: ["one.txt"],
    message: "Selected files",
  });
  expect(screen.getByText(/полное текущее содержимое/i)).toBeTruthy();
  expect(screen.queryByText(/только подготовленные строки/)).toBeNull();
  expect(screen.getByText(/хуки.*не запускаются/i)).toBeTruthy();
  expect(api.executeGitCommit).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Создать локальный коммит" }),
  );
  await waitFor(() =>
    expect(api.executeGitCommit).toHaveBeenCalledWith("1".repeat(64)),
  );
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: "Сообщение коммита",
      }).value,
    ).toBe(""),
  );
  expect(
    screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Выбрать файл: one.txt",
    }).checked,
  ).toBe(false);
  expect(api.readGitWorkspace).toHaveBeenCalledTimes(2);
});
it("retains draft and selection after failed prepare and failed execution; errors close", async () => {
  api.prepareGitCommit.mockRejectedValueOnce(Error("Снимок устарел"));
  render(view());
  await draft();
  fireEvent.click(screen.getByRole("button", { name: "Создать коммит…" }));
  expect(await screen.findByText(/Снимок устарел/)).toBeTruthy();
  fireEvent.click(
    await screen.findByRole("button", { name: "Закрыть результат коммита" }),
  );
  expect(
    screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Сообщение коммита",
    }).value,
  ).toBe("Selected files");
  api.executeGitCommit.mockRejectedValueOnce(Error("Не удалось подписать"));
  fireEvent.click(screen.getByRole("button", { name: "Создать коммит…" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Создать локальный коммит" }),
  );
  expect(await screen.findByText(/Не удалось подписать/)).toBeTruthy();
  fireEvent.click(
    await screen.findByRole("button", { name: "Закрыть результат коммита" }),
  );
  expect(
    screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Выбрать файл: one.txt",
    }).checked,
  ).toBe(true);
});
it("keeps drafts on close/reopen and never sends a prior owner selection into another owner", async () => {
  const v = render(view());
  await draft();
  v.rerender(view("p", false));
  v.rerender(view());
  expect(
    screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Сообщение коммита",
    }).value,
  ).toBe("Selected files");
  v.rerender(view("q"));
  expect(
    await screen.findByRole("checkbox", { name: "Выбрать файл: one.txt" }),
  ).toBeTruthy();
  expect(
    screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Сообщение коммита",
    }).value,
  ).toBe("");
  expect(
    screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Выбрать файл: one.txt",
    }).checked,
  ).toBe(true);
});
it("does not offer a repeat after uncertain outcome and retains the draft with closable log", async () => {
  api.executeGitCommit.mockResolvedValueOnce({
    scope: "p",
    status: "uncertain",
    message: "Проверьте состояние Git; коммит мог быть создан",
    log: "recovery saved",
  });
  render(view());
  await draft();
  fireEvent.click(screen.getByRole("button", { name: "Создать коммит…" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Создать локальный коммит" }),
  );
  expect(await screen.findByText(/recovery saved/)).toBeTruthy();
  fireEvent.click(
    await screen.findByRole("button", { name: "Закрыть результат коммита" }),
  );
  expect(
    screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Сообщение коммита",
    }).value,
  ).toBe("Selected files");
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Создать коммит…" })
      .disabled,
  ).toBe(true);
});
it("ignores delayed preview of an unmounted owner", async () => {
  const pending = deferred();
  api.prepareGitCommit.mockImplementationOnce(() => pending.promise);
  const v = render(view());
  await draft();
  fireEvent.click(screen.getByRole("button", { name: "Создать коммит…" }));
  v.rerender(view("q"));
  await act(async () =>
    pending.resolve(
      preview({ scope: "p", paths: ["one.txt"], message: "Selected files" }),
    ),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.executeGitCommit).not.toHaveBeenCalled();
});
it("ends a timed-out preview without executing or losing the draft", async () => {
  render(view());
  await draft();
  vi.useFakeTimers();
  api.prepareGitCommit.mockImplementationOnce(() => new Promise(() => {}));
  fireEvent.click(screen.getByRole("button", { name: "Создать коммит…" }));
  expect(screen.getByRole("status").textContent).toContain("Проверяем");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30001);
  });
  vi.useRealTimers();
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByText(/Превышено время ожидания/)).toBeTruthy();
  fireEvent.click(
    await screen.findByRole("button", { name: "Закрыть результат коммита" }),
  );
  expect(
    screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Сообщение коммита",
    }).value,
  ).toBe("Selected files");
  expect(api.executeGitCommit).not.toHaveBeenCalled();
});
it("does not send a second write while one is pending and keeps the workspace closable", async () => {
  const pending = deferred();
  api.executeGitCommit.mockImplementationOnce(() => pending.promise);
  const v = render(view());
  await draft();
  fireEvent.click(screen.getByRole("button", { name: "Создать коммит…" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Создать локальный коммит" }),
  );
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Создать коммит…" })
      .disabled,
  ).toBe(true);
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Закрыть изменения" })
      .disabled,
  ).toBe(false);
  v.rerender(view("p", false));
  await act(async () =>
    pending.resolve({
      scope: "p",
      status: "not-committed",
      message: "Коммит не создан",
      log: "Signer failed",
    }),
  );
  v.rerender(view());
  expect(await screen.findByText(/Signer failed/)).toBeTruthy();
  expect(api.executeGitCommit).toHaveBeenCalledOnce();
});
it("shows retained recovery diagnostics even when the commit and index were published", async () => {
  api.executeGitCommit.mockResolvedValueOnce({
    scope: "p",
    status: "committed",
    commit: "c".repeat(40),
    indexPublished: true,
    message: "Коммит создан; завершение записи требует проверки",
    log: "fsync journal failed",
    recoveryPath: "/fixture/p/.git/goga-commit-fixture",
  });
  render(view());
  await draft();
  fireEvent.click(screen.getByRole("button", { name: "Создать коммит…" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Создать локальный коммит" }),
  );
  expect(await screen.findByText(/fsync journal failed/)).toBeTruthy();
  expect(
    screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Сообщение коммита",
    }).value,
  ).toBe("");
  fireEvent.click(
    await screen.findByRole("button", { name: "Закрыть результат коммита" }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("blocks a new attempt when a failed commit still leaves a recovery lock", async () => {
  api.executeGitCommit.mockResolvedValueOnce({
    scope: "p",
    status: "not-committed",
    indexPublished: false,
    message: "Коммит не создан; не удалось снять блокировку",
    log: "cleanup failed",
    recoveryPath: "/fixture/p/.git/goga-commit-fixture",
  });
  render(view());
  await draft();
  fireEvent.click(screen.getByRole("button", { name: "Создать коммит…" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Создать локальный коммит" }),
  );
  expect(await screen.findByText(/cleanup failed/)).toBeTruthy();
  fireEvent.click(
    await screen.findByRole("button", { name: "Закрыть результат коммита" }),
  );
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Создать коммит…" })
      .disabled,
  ).toBe(true);
  expect(
    screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Сообщение коммита",
    }).value,
  ).toBe("Selected files");
});

it("discards the shared selection without a commit message and excludes concurrent mutations", async () => {
  api.prepareGitDiscard = vi.fn(async (r: any) => ({
    token: "e".repeat(64),
    scope: r.scope,
    root: "/fixture/p",
    branch: "main",
    head: "b".repeat(40),
    paths: r.paths,
    items: r.paths.map((path: string) => ({ path, action: "restore" })),
    expiresAt: Date.now() + 300000,
  }));
  const pending = deferred();
  api.executeGitDiscard = vi.fn(() => pending.promise);
  render(
    <GitWorkspace
      scope="p"
      open
      revision={0}
      bodyContainer={portal}
      onOpen={() => {}}
      onClose={() => {}}
    />,
  );
  fireEvent.click(await screen.findByRole("checkbox", { name: /other.txt/ }));
  expect(
    screen.getByRole("button", { name: "Создать коммит…" }),
  ).toHaveProperty("disabled", true);
  const cancel = screen.getByRole("button", { name: "Отменить изменения…" });
  expect(cancel).toHaveProperty("disabled", false);
  fireEvent.click(cancel);
  const dialog = await screen.findByRole("dialog", {
    name: "Подтвердить отмену изменений",
  });
  expect(api.prepareGitDiscard).toHaveBeenCalledWith({
    scope: "p",
    revision: rev,
    paths: ["one.txt"],
  });
  expect(screen.getByRole("checkbox", { name: /other.txt/ })).toHaveProperty(
    "disabled",
    true,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Отменить выбранные изменения" }),
  );
  expect(api.executeGitDiscard).toHaveBeenCalledWith("e".repeat(64));
  expect(
    screen.getByRole("button", { name: "Обновить изменения" }),
  ).toHaveProperty("disabled", true);
  await act(async () =>
    pending.resolve({
      scope: "p",
      status: "discarded",
      changedPaths: ["one.txt"],
      trashedPaths: [],
      indexPublished: true,
      worktreePublished: true,
      message: "Готово",
      log: "",
    }),
  );
  await waitFor(() =>
    expect(api.readGitWorkspace.mock.calls.length).toBeGreaterThan(1),
  );
  expect(screen.getByRole("checkbox", { name: /one.txt/ })).toHaveProperty(
    "checked",
    false,
  );
});

it("retains selection after uncertain discard and unlocks only after a successful explicit refresh", async () => {
  api.prepareGitDiscard = vi.fn(async (r: any) => ({
    token: "e".repeat(64),
    scope: r.scope,
    root: "/fixture/p",
    branch: "main",
    head: "b".repeat(40),
    paths: r.paths,
    items: r.paths.map((path: string) => ({ path, action: "restore" })),
    expiresAt: Date.now() + 300000,
  }));
  api.executeGitDiscard = vi.fn(async () => ({
    scope: "p",
    status: "uncertain",
    changedPaths: ["one.txt"],
    trashedPaths: [],
    indexPublished: false,
    worktreePublished: true,
    recoveryPath: "/fixture/recovery",
    message: "Проверьте состояние",
    log: "partial",
  }));
  render(view());
  await draft();
  fireEvent.click(screen.getByRole("button", { name: "Отменить изменения…" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Отменить выбранные изменения" }),
  );
  await screen.findByRole("dialog", { name: "Результат отмены изменений" });
  await waitFor(() => expect(api.readGitWorkspace).toHaveBeenCalledTimes(2));
  fireEvent.click(
    screen.getByRole("button", { name: "Закрыть результат отмены" }),
  );
  expect(screen.getByRole("checkbox", { name: /one.txt/ })).toHaveProperty(
    "checked",
    true,
  );
  expect(
    screen.getByRole("button", { name: "Создать коммит…" }),
  ).toHaveProperty("disabled", true);
  api.readGitWorkspace.mockRejectedValueOnce(Error("read failed"));
  fireEvent.click(screen.getByRole("button", { name: "Обновить изменения" }));
  await screen.findByRole("dialog", { name: "Не удалось прочитать изменения" });
  fireEvent.click(screen.getByRole("button", { name: "Закрыть ошибку Git" }));
  expect(
    screen.getByRole("button", { name: "Создать коммит…" }),
  ).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Обновить изменения" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Создать коммит…" }),
    ).toHaveProperty("disabled", false),
  );
  expect(screen.getByRole("checkbox", { name: /one.txt/ })).toHaveProperty(
    "checked",
    true,
  );
  expect(api.executeGitDiscard).toHaveBeenCalledTimes(1);
});

it("selects all files initially but preserves manual deselection across reload and reopening", async () => {
  const v = render(view());
  const first = await screen.findByRole<HTMLInputElement>("checkbox", {
    name: "Выбрать файл: one.txt",
  });
  expect(first.checked).toBe(true);
  expect(
    screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Выбрать файл: other.txt",
    }).checked,
  ).toBe(true);
  fireEvent.click(first);
  v.rerender(view("p", false));
  v.rerender(view());
  await waitFor(() => expect(api.readGitWorkspace).toHaveBeenCalledTimes(2));
  expect(
    screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Выбрать файл: one.txt",
    }).checked,
  ).toBe(false);
  expect(
    screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Выбрать файл: other.txt",
    }).checked,
  ).toBe(true);
});

it("does not select submodules by default", async () => {
  const value = snapshot();
  value.files[1].submodule = true;
  api.readGitWorkspace.mockResolvedValue(value);
  render(view());
  expect(
    (
      await screen.findByRole<HTMLInputElement>("checkbox", {
        name: "Выбрать файл: one.txt",
      })
    ).checked,
  ).toBe(true);
  const module = screen.getByRole<HTMLInputElement>("checkbox", {
    name: "Выбрать файл: other.txt",
  });
  expect(module.checked).toBe(false);
  expect(module.disabled).toBe(true);
});

it("keeps an explicitly empty selection after refreshing", async () => {
  render(view());
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "Выбрать файл: one.txt" }),
  );
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Выбрать файл: other.txt" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Обновить изменения" }));
  await waitFor(() => expect(api.readGitWorkspace).toHaveBeenCalledTimes(2));
  for (const box of screen.getAllByRole<HTMLInputElement>("checkbox"))
    expect(box.checked).toBe(false);
});

it("selects changes appearing after the first empty visit", async () => {
  api.readGitWorkspace.mockResolvedValueOnce({ ...snapshot(), files: [] });
  const v = render(view());
  await screen.findByText("Нет изменений для просмотра");
  v.rerender(view("p", false));
  v.rerender(view());
  expect(
    await screen.findByRole("checkbox", { name: "Выбрать файл: one.txt" }),
  ).toHaveProperty("checked", true);
  expect(
    screen.getByRole("checkbox", { name: "Выбрать файл: other.txt" }),
  ).toHaveProperty("checked", true);
});

it("selects newly discovered files while preserving explicit deselection of existing files", async () => {
  const v = render(view());
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "Выбрать файл: one.txt" }),
  );
  const next = snapshot();
  next.files.push({ ...next.files[0], path: "new.txt" });
  api.readGitWorkspace.mockResolvedValue(next);
  v.rerender(view("p", false));
  v.rerender(view());
  expect(
    await screen.findByRole("checkbox", { name: "Выбрать файл: new.txt" }),
  ).toHaveProperty("checked", true);
  expect(
    screen.getByRole("checkbox", { name: "Выбрать файл: one.txt" }),
  ).toHaveProperty("checked", false);
});

it("selects a new set of changes after a clean snapshot, including the same filenames", async () => {
  const v = render(view());
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "Выбрать файл: one.txt" }),
  );
  api.readGitWorkspace.mockResolvedValueOnce({ ...snapshot(), files: [] });
  fireEvent.click(screen.getByRole("button", { name: "Обновить изменения" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("checkbox", { name: "Выбрать файл: one.txt" }),
    ).toBeNull(),
  );
  v.rerender(view("p", false));
  v.rerender(view());
  expect(
    await screen.findByRole("checkbox", { name: "Выбрать файл: one.txt" }),
  ).toHaveProperty("checked", true);
});

it("does not carry deselection of a pathname into another branch", async () => {
  const v = render(view());
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "Выбрать файл: one.txt" }),
  );
  api.readGitWorkspace.mockResolvedValue({ ...snapshot(), branch: "next" });
  v.rerender(view("p", false));
  v.rerender(view());
  await waitFor(() =>
    expect(
      screen.getByRole("checkbox", { name: "Выбрать файл: one.txt" }),
    ).toHaveProperty("checked", true),
  );
});

const bulk = () =>
  screen.getByRole<HTMLInputElement>("checkbox", { name: "Выбрать все файлы" });
const row = (path: string) =>
  screen.getByRole<HTMLInputElement>("checkbox", {
    name: `Выбрать файл: ${path}`,
  });
function enableDiscard() {
  api.prepareGitDiscard = vi.fn(async (r: any) => ({
    token: "e".repeat(64),
    scope: r.scope,
    root: "/fixture/p",
    branch: "main",
    head: "b".repeat(40),
    paths: r.paths,
    items: r.paths.map((path: string) => ({ path, action: "restore" })),
    expiresAt: Date.now() + 300000,
  }));
  api.executeGitDiscard = vi.fn(async () => ({
    scope: "p",
    status: "not-discarded",
    changedPaths: [],
    trashedPaths: [],
    indexPublished: false,
    worktreePublished: false,
    message: "Без изменений",
    log: "",
  }));
}
it("uses a native all/none/mixed header without reads, draft loss or diff navigation", async () => {
  enableDiscard();
  render(view());
  await screen.findByRole("checkbox", { name: "Выбрать файл: one.txt" });
  const all = bulk();
  expect(all.type).toBe("checkbox");
  expect(all.checked).toBe(true);
  expect(all.indeterminate).toBe(false);
  expect(all.closest("label")?.title ?? all.title).toMatch(/всех страницах/i);
  expect(
    all.compareDocumentPosition(row("one.txt")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Снять выбор файлов" }),
  ).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Сообщение коммита" }), {
    target: { value: "Retained message" },
  });
  fireEvent.click(screen.getByRole("button", { name: "one.txt" }));
  await waitFor(() => expect(portal.textContent).toContain("+final one.txt"));
  fireEvent.click(all);
  expect(all.checked).toBe(false);
  expect(all.indeterminate).toBe(false);
  expect(row("one.txt").checked).toBe(false);
  expect(row("other.txt").checked).toBe(false);
  fireEvent.click(all);
  expect(all.checked).toBe(true);
  expect(row("one.txt").checked).toBe(true);
  expect(row("other.txt").checked).toBe(true);
  fireEvent.click(row("other.txt"));
  expect(all.checked).toBe(false);
  expect(all.indeterminate).toBe(true);
  fireEvent.click(all);
  expect(all.checked).toBe(true);
  expect(all.indeterminate).toBe(false);
  expect(row("other.txt").checked).toBe(true);
  expect(
    screen
      .getByRole("button", { name: "one.txt" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(portal.textContent).toContain("+final one.txt");
  expect(
    screen.getByRole("textbox", { name: "Сообщение коммита" }),
  ).toHaveProperty("value", "Retained message");
  expect(api.readGitWorkspace).toHaveBeenCalledTimes(1);
  expect(api.readGitDiff).toHaveBeenCalledTimes(1);
  expect(api.prepareGitCommit).not.toHaveBeenCalled();
  expect(api.executeGitCommit).not.toHaveBeenCalled();
  expect(api.prepareGitDiscard).not.toHaveBeenCalled();
  expect(api.executeGitDiscard).not.toHaveBeenCalled();
});
it("selects all pages for the same commit/discard selection without changing either pagination", async () => {
  enableDiscard();
  const value = snapshot();
  value.files = Array.from({ length: 203 }, (_, i) => ({
    ...value.files[0],
    path: `file-${i}.txt`,
    submodule: i === 202,
  }));
  api.readGitWorkspace.mockResolvedValue(value);
  api.readGitDiff.mockImplementation(async (r: any) => ({
    ...r,
    changes: {
      kind: "patch",
      text: Array.from({ length: 501 }, (_, i) => `+line ${i}`).join("\n"),
    },
  }));
  render(view());
  await screen.findByRole("checkbox", { name: "Выбрать файл: file-0.txt" });
  fireEvent.click(screen.getByRole("button", { name: "Следующие файлы" }));
  fireEvent.click(screen.getByRole("button", { name: "file-201.txt" }));
  await screen.findByLabelText("Различия файла");
  fireEvent.click(screen.getByRole("button", { name: "Следующие строки" }));
  expect(screen.getByLabelText("Различия файла").textContent).toBe("+line 500");
  fireEvent.click(bulk());
  expect(row("file-200.txt").checked).toBe(false);
  expect(row("file-201.txt").checked).toBe(false);
  expect(screen.getByText(/^Выбрано файлов: 0\./)).toBeTruthy();
  expect(screen.getByText(/Файлы 201–203 из 203/)).toBeTruthy();
  expect(screen.getByLabelText("Различия файла").textContent).toBe("+line 500");
  fireEvent.click(bulk());
  expect(row("file-201.txt").checked).toBe(true);
  expect(row("file-202.txt").checked).toBe(false);
  expect(row("file-202.txt").disabled).toBe(true);
  fireEvent.change(screen.getByRole("textbox", { name: "Сообщение коммита" }), {
    target: { value: "All pages" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Создать коммит…" }));
  await screen.findByRole("dialog", { name: "Подтвердить коммит" });
  const paths = value.files
    .filter((file) => !file.submodule)
    .map((file) => file.path);
  expect(api.prepareGitCommit).toHaveBeenCalledWith({
    scope: "p",
    revision: rev,
    paths,
    message: "All pages",
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Закрыть подтверждение коммита" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Отменить изменения…" }));
  await screen.findByRole("dialog", { name: "Подтвердить отмену изменений" });
  expect(api.prepareGitDiscard).toHaveBeenCalledWith({
    scope: "p",
    revision: rev,
    paths,
  });
  expect(api.executeGitCommit).not.toHaveBeenCalled();
  expect(api.executeGitDiscard).not.toHaveBeenCalled();
  expect(api.readGitWorkspace).toHaveBeenCalledTimes(1);
  expect(api.readGitDiff).toHaveBeenCalledTimes(1);
});
it("excludes submodules and offers shared bulk selection when only discard is supported", async () => {
  enableDiscard();
  delete api.prepareGitCommit;
  delete api.executeGitCommit;
  const value = snapshot();
  value.files[1].submodule = true;
  api.readGitWorkspace.mockResolvedValue(value);
  render(view());
  await screen.findByRole("checkbox", { name: "Выбрать файл: one.txt" });
  expect(bulk().checked).toBe(true);
  fireEvent.click(bulk());
  fireEvent.click(bulk());
  expect(bulk().checked).toBe(true);
  expect(bulk().indeterminate).toBe(false);
  expect(row("other.txt").checked).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Отменить изменения…" }));
  await screen.findByRole("dialog", { name: "Подтвердить отмену изменений" });
  expect(api.prepareGitDiscard).toHaveBeenCalledWith({
    scope: "p",
    revision: rev,
    paths: ["one.txt"],
  });
});
it("disables bulk selection when every changed entry is a submodule", async () => {
  const value = snapshot();
  value.files.forEach((file) => {
    file.submodule = true;
  });
  api.readGitWorkspace.mockResolvedValue(value);
  render(view());
  await screen.findByRole("checkbox", { name: "Выбрать файл: one.txt" });
  expect(bulk().disabled).toBe(true);
  expect(bulk().checked).toBe(false);
  expect(bulk().indeterminate).toBe(false);
  fireEvent.click(bulk());
  expect(row("one.txt").checked).toBe(false);
  expect(row("other.txt").checked).toBe(false);
});
it.each(["merge", "rebase", "cherry-pick", "revert", "unknown"] as const)(
  "blocks bulk selection during %s even without conflict rows",
  async (operation) => {
    api.readGitWorkspace.mockResolvedValue({ ...snapshot(), operation });
    render(view());
    await screen.findByRole("checkbox", { name: "Выбрать файл: one.txt" });
    expect(bulk().disabled).toBe(true);
    fireEvent.click(bulk());
    expect(row("one.txt").checked).toBe(false);
    expect(api.prepareGitCommit).not.toHaveBeenCalled();
  },
);
it("blocks bulk selection for a conflict anywhere in the snapshot", async () => {
  const value = snapshot();
  value.files[1].kind = "conflict";
  api.readGitWorkspace.mockResolvedValue(value);
  render(view());
  await screen.findByRole("checkbox", { name: "Выбрать файл: one.txt" });
  expect(bulk().disabled).toBe(true);
  fireEvent.click(bulk());
  expect(row("one.txt").checked).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "other.txt" }));
  expect(
    screen.queryByRole("checkbox", { name: "Выбрать все файлы" }),
  ).toBeNull();
});
it("does not offer bulk selection for unsupported, loading, failed or unavailable workspaces", async () => {
  delete api.prepareGitCommit;
  delete api.executeGitCommit;
  const v = render(view());
  await screen.findByRole("button", { name: "one.txt" });
  expect(
    screen.queryByRole("checkbox", { name: "Выбрать все файлы" }),
  ).toBeNull();
  api.prepareGitCommit = vi.fn(async (r: any) => preview(r));
  api.executeGitCommit = vi.fn();
  v.rerender(view("p", true, 0, true));
  expect(
    screen.queryByRole("checkbox", { name: "Выбрать все файлы" }),
  ).toBeNull();
  const pending = deferred();
  api.readGitWorkspace.mockImplementationOnce(() => pending.promise);
  v.rerender(view());
  expect(
    screen.getByRole("status", { name: "Загрузка изменений" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("checkbox", { name: "Выбрать все файлы" }),
  ).toBeNull();
  await act(async () => pending.resolve(snapshot()));
  expect(bulk().checked).toBe(true);
  api.readGitWorkspace.mockRejectedValueOnce(Error("read unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Обновить изменения" }));
  await screen.findByRole("dialog", { name: "Не удалось прочитать изменения" });
  expect(
    screen.queryByRole("checkbox", { name: "Выбрать все файлы" }),
  ).toBeNull();
});
it.each(["commit", "discard"] as const)(
  "keeps bulk selection inert during %s prepare, confirmation and execution",
  async (kind) => {
    const user = userEvent.setup();
    enableDiscard();
    const preparing = deferred(),
      executing = deferred();
    const prepareMethod =
      kind === "commit" ? api.prepareGitCommit : api.prepareGitDiscard;
    const executeMethod =
      kind === "commit" ? api.executeGitCommit : api.executeGitDiscard;
    prepareMethod.mockImplementationOnce(() => preparing.promise);
    executeMethod.mockImplementationOnce(() => executing.promise);
    render(view());
    await draft();
    expect(bulk().indeterminate).toBe(true);
    const start = kind === "commit" ? "Создать коммит…" : "Отменить изменения…";
    const confirm =
      kind === "commit"
        ? "Создать локальный коммит"
        : "Отменить выбранные изменения";
    fireEvent.click(screen.getByRole("button", { name: start }));
    const assertInert = async () => {
      expect(bulk().disabled).toBe(true);
      await user.click(bulk());
      expect(row("one.txt").checked).toBe(true);
      expect(row("other.txt").checked).toBe(false);
      expect(bulk().indeterminate).toBe(true);
    };
    await assertInert();
    const request = prepareMethod.mock.calls[0][0];
    await act(async () =>
      preparing.resolve(
        kind === "commit"
          ? preview(request)
          : {
              ...request,
              token: "e".repeat(64),
              root: "/fixture/p",
              branch: "main",
              head: "b".repeat(40),
              items: [{ path: "one.txt", action: "restore" }],
              expiresAt: Date.now() + 300000,
            },
      ),
    );
    await assertInert();
    fireEvent.click(screen.getByRole("button", { name: confirm }));
    await assertInert();
    await act(async () =>
      executing.resolve(
        kind === "commit"
          ? {
              scope: "p",
              status: "not-committed",
              indexPublished: false,
              message: "Без изменений",
              log: "",
            }
          : {
              scope: "p",
              status: "not-discarded",
              indexPublished: false,
              worktreePublished: false,
              changedPaths: [],
              trashedPaths: [],
              message: "Без изменений",
              log: "",
            },
      ),
    );
    expect(prepareMethod).toHaveBeenCalledTimes(1);
    expect(executeMethod).toHaveBeenCalledTimes(1);
  },
);
it("retains bulk-empty and partial intent across reopening, revisions and file changes", async () => {
  const scope = {
    projectId: "p",
    year: "2026",
    topic: "feature",
    branch: "main",
    contextId: "ctx-" + "a".repeat(64),
    revision: "11111111-1111-4111-8111-111111111111",
  };
  api.readGitWorkspace.mockImplementation(async (s: ScopeRef) => snapshot(s));
  const v = render(view(scope));
  await screen.findByRole("checkbox", { name: "Выбрать файл: one.txt" });
  fireEvent.click(bulk());
  fireEvent.change(screen.getByRole("textbox", { name: "Сообщение коммита" }), {
    target: { value: "Keep owner" },
  });
  v.rerender(view(scope, false));
  v.rerender(view(scope));
  await screen.findByRole("checkbox", { name: "Выбрать файл: one.txt" });
  expect(bulk().checked).toBe(false);
  expect(bulk().indeterminate).toBe(false);
  const newerScope = {
    ...scope,
    revision: "22222222-2222-4222-8222-222222222222",
  };
  v.rerender(view(newerScope, true, 1));
  await screen.findByRole("checkbox", { name: "Выбрать файл: one.txt" });
  expect(row("one.txt").checked).toBe(false);
  expect(row("other.txt").checked).toBe(false);
  expect(
    screen.getByRole("textbox", { name: "Сообщение коммита" }),
  ).toHaveProperty("value", "Keep owner");
  fireEvent.click(row("other.txt"));
  const next = snapshot(newerScope);
  next.files = [next.files[0], { ...next.files[0], path: "new.txt" }];
  api.readGitWorkspace.mockResolvedValue(next);
  fireEvent.click(screen.getByRole("button", { name: "Обновить изменения" }));
  await screen.findByRole("checkbox", { name: "Выбрать файл: new.txt" });
  expect(row("one.txt").checked).toBe(false);
  expect(row("new.txt").checked).toBe(true);
  expect(bulk().indeterminate).toBe(true);
  expect(screen.getByText(/^Выбрано файлов: 1\./)).toBeTruthy();
  fireEvent.click(bulk());
  expect(bulk().checked).toBe(true);
  fireEvent.click(row("new.txt"));
  api.readGitWorkspace.mockResolvedValue({ ...next, branch: "next" });
  fireEvent.click(screen.getByRole("button", { name: "Обновить изменения" }));
  await screen.findByRole("checkbox", { name: "Выбрать файл: new.txt" });
  expect(bulk().checked).toBe(true);
  expect(row("new.txt").checked).toBe(true);
});
it("never transfers bulk-empty intent or draft to another exact context owner", async () => {
  const scope = {
    projectId: "p",
    year: "2026",
    topic: "feature",
    branch: "main",
    contextId: "ctx-" + "a".repeat(64),
    revision: "11111111-1111-4111-8111-111111111111",
  };
  api.readGitWorkspace.mockImplementation(async (s: ScopeRef) => snapshot(s));
  const v = render(view(scope));
  await screen.findByRole("checkbox", { name: "Выбрать файл: one.txt" });
  fireEvent.click(bulk());
  fireEvent.change(screen.getByRole("textbox", { name: "Сообщение коммита" }), {
    target: { value: "Owner a" },
  });
  v.rerender(view({ ...scope, contextId: "ctx-" + "b".repeat(64) }));
  await screen.findByRole("checkbox", { name: "Выбрать файл: one.txt" });
  expect(bulk().checked).toBe(true);
  expect(row("one.txt").checked).toBe(true);
  expect(
    screen.getByRole("textbox", { name: "Сообщение коммита" }),
  ).toHaveProperty("value", "");
});

// Exercise the retained hook's public selection command independently of disabled DOM controls.
let retainedCommit: ReturnType<typeof useGitCommit>;
function CommitSelectionOwner({ scope = "p" }: { scope?: ScopeRef }) {
  retainedCommit = useGitCommit(scope, () => {});
  return <output>{retainedCommit.paths.join(",")}</output>;
}
it("defends bulk selection itself against foreign snapshots, operations, conflicts and stale owners", () => {
  const v = render(<CommitSelectionOwner />);
  act(() => retainedCommit.initializeSelection(snapshot()));
  const before = retainedCommit;
  act(() => retainedCommit.toggleAll(snapshot("q")));
  expect(screen.getByRole("status").textContent).toBe("one.txt,other.txt");
  act(() => retainedCommit.toggleAll({ ...snapshot(), operation: "merge" }));
  const conflict = snapshot();
  conflict.files[1].kind = "conflict";
  act(() => retainedCommit.toggleAll(conflict));
  expect(retainedCommit.paths).toEqual(["one.txt", "other.txt"]);
  v.rerender(<CommitSelectionOwner scope="q" />);
  act(() => before.toggleAll(snapshot()));
  expect(retainedCommit.paths).toEqual(["one.txt", "other.txt"]);
  v.unmount();
  act(() => before.toggleAll(snapshot()));
  expect(api.prepareGitCommit).not.toHaveBeenCalled();
});
it("defends the bulk command against synchronous prepare/execute flight and an open preview", async () => {
  const preparing = deferred(),
    executing = deferred();
  api.prepareGitCommit.mockImplementationOnce(() => preparing.promise);
  api.executeGitCommit.mockImplementationOnce(() => executing.promise);
  render(<CommitSelectionOwner />);
  act(() => retainedCommit.initializeSelection(snapshot()));
  act(() => retainedCommit.toggle("other.txt"));
  const beforePrepare = retainedCommit;
  act(() => {
    void beforePrepare.prepare(snapshot());
    beforePrepare.toggleAll(snapshot());
  });
  expect(retainedCommit.paths).toEqual(["one.txt"]);
  await act(async () =>
    preparing.resolve(preview({ scope: "p", paths: ["one.txt"], message: "" })),
  );
  act(() => retainedCommit.toggleAll(snapshot()));
  expect(retainedCommit.paths).toEqual(["one.txt"]);
  act(() => beforePrepare.toggleAll(snapshot()));
  expect(retainedCommit.paths).toEqual(["one.txt"]);
  act(() => {
    void retainedCommit.execute();
    retainedCommit.toggleAll(snapshot());
  });
  expect(retainedCommit.paths).toEqual(["one.txt"]);
  await act(async () =>
    executing.resolve({
      scope: "p",
      status: "not-committed",
      indexPublished: false,
      message: "Без изменений",
      log: "",
    }),
  );
});

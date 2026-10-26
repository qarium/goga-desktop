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
import { GitWorkspace } from "../src/renderer/GitWorkspace";
let portal: HTMLDivElement, api: any;
const rev = "a".repeat(64);
function snapshot(scope = "p") {
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
      staged: { kind: "empty", text: "" },
      unstaged: { kind: "empty", text: "" },
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
const view = (scope = "p", open = true) => (
  <GitWorkspace
    scope={scope}
    open={open}
    bodyContainer={portal}
    onOpen={vi.fn()}
    onClose={vi.fn()}
    revision={0}
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
    screen.getByRole("button", { name: "Закрыть результат коммита" }),
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

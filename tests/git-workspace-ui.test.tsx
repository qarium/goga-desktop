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
import type { GitWorkspaceSnapshot } from "../src/shared/git-workspace";
let portal: HTMLDivElement, api: any;
const snapshot = (scope = "p"): GitWorkspaceSnapshot => ({
  scope,
  root: "/fixture/" + scope,
  revision: "a".repeat(64),
  head: "b".repeat(40),
  branch: "main",
  upstream: null,
  ahead: 0,
  behind: 0,
  operation: "none",
  files: [
    {
      path: "file.txt",
      indexStatus: ".",
      worktreeStatus: "M",
      kind: "tracked",
      submodule: false,
    },
    {
      path: "other.txt",
      indexStatus: "A",
      worktreeStatus: ".",
      kind: "tracked",
      submodule: false,
    },
  ],
});
function diff(path = "file.txt", scope = "p") {
  return {
    scope,
    path,
    revision: "a".repeat(64),
    staged:
      path === "other.txt"
        ? { kind: "patch", text: "@@ -0,0 +1 @@\n+" + scope + " " + path }
        : { kind: "empty", text: "" },
    unstaged: {
      kind: "patch",
      text: "@@ -1 +1 @@\n-base\n+" + scope + " " + path,
    },
  };
}
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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
    readGitWorkspace: vi.fn(async (scope: string) => snapshot(scope)),
    readGitDiff: vi.fn(async (r: any) => diff(r.path, r.scope)),
  };
  window.goga = api;
});
afterEach(() => {
  cleanup();
  portal.remove();
  vi.useRealTimers();
});
function view(scope = "p", open = true, onClose = vi.fn()) {
  return (
    <GitWorkspace
      scope={scope}
      open={open}
      bodyContainer={portal}
      onOpen={vi.fn()}
      onClose={onClose}
      revision={0}
    />
  );
}
it("shows branch and changes without a Git main tab, file list and staged/working diff", async () => {
  render(view());
  expect(await screen.findByText("main")).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: /file.txt/ }));
  await waitFor(() => expect(portal.textContent).toContain("+p file.txt"));
  expect(screen.getByRole("button", { name: "Рабочая папка" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Подготовлено" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Создать коммит/ })).toBeNull();
  expect(api.readGitWorkspace).toHaveBeenCalledTimes(1);
});
it("keeps selection when closed and reopened, refreshes status and allows Escape", async () => {
  const close = vi.fn();
  const v = render(view("p", true, close));
  fireEvent.click(await screen.findByRole("button", { name: /other.txt/ }));
  await waitFor(() => expect(portal.textContent).toContain("+p other.txt"));
  v.rerender(view("p", false, close));
  expect(screen.queryByRole("region", { name: "Изменения Git" })).toBeNull();
  v.rerender(view("p", true, close));
  await waitFor(() => expect(api.readGitWorkspace).toHaveBeenCalledTimes(2));
  expect(
    screen
      .getByRole("button", { name: /other.txt/ })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  fireEvent.keyDown(screen.getByRole("region", { name: "Изменения Git" }), {
    key: "Escape",
  });
  expect(close).toHaveBeenCalledOnce();
});
it("ignores a delayed previous file/context result", async () => {
  const first = deferred<any>();
  api.readGitDiff.mockImplementationOnce(() => first.promise);
  const v = render(view());
  fireEvent.click(await screen.findByRole("button", { name: /file.txt/ }));
  await waitFor(() => expect(api.readGitDiff).toHaveBeenCalled());
  v.rerender(view("q"));
  fireEvent.click(await screen.findByRole("button", { name: /other.txt/ }));
  await waitFor(() => expect(portal.textContent).toContain("+q other.txt"));
  await act(async () => first.resolve(diff()));
  expect(portal.textContent).not.toContain("+p file.txt");
});
it("stops loader on error and the log popup can be closed without leaving workspace", async () => {
  api.readGitWorkspace.mockRejectedValueOnce(Error("fixture read failed"));
  render(view());
  expect(await screen.findByRole("dialog")).toBeTruthy();
  expect(screen.getByText(/fixture read failed/)).toBeTruthy();
  expect(
    screen.queryByRole("status", { name: "Загрузка изменений" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Закрыть ошибку Git" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Обновить изменения" }));
  expect(await screen.findByRole("button", { name: /file.txt/ })).toBeTruthy();
});
it("bounds an unanswered initial read rather than leaving an eternal spinner", async () => {
  vi.useFakeTimers();
  api.readGitWorkspace.mockImplementation(() => new Promise(() => {}));
  render(view());
  expect(
    screen.getByRole("status", { name: "Загрузка изменений" }),
  ).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30001);
  });
  expect(
    screen.queryByRole("status", { name: "Загрузка изменений" }),
  ).toBeNull();
  expect(screen.getByRole("dialog").textContent).toContain("Превышено время");
});
it("does not label unmerged files as ordinary modifications", async () => {
  const data = snapshot();
  data.operation = "merge";
  data.files[0].kind = "conflict";
  api.readGitWorkspace.mockResolvedValue(data);
  render(view());
  expect(
    await screen.findByRole("button", { name: "Конфликты · 1" }),
  ).toBeTruthy();
  expect(screen.getByText(/Незавершённое слияние/)).toBeTruthy();
});
it("does not promise a clean repository when submodule worktrees are not scanned", async () => {
  api.readGitWorkspace.mockResolvedValue({ ...snapshot(), files: [] });
  render(view());
  expect(await screen.findByText("Нет изменений для просмотра")).toBeTruthy();
  expect(
    screen.getByText(/Рабочие копии подмодулей не проверяются/),
  ).toBeTruthy();
  expect(screen.queryByText(/совпадают с текущим коммитом/)).toBeNull();
});
it("bounds rendered diff lines and lets readers reach every page without truncation", async () => {
  api.readGitDiff.mockResolvedValue({
    ...diff(),
    unstaged: {
      kind: "text",
      text: Array.from({ length: 1201 }, (_, i) => `line ${i + 1}`).join("\n"),
    },
  });
  render(view());
  fireEvent.click(await screen.findByRole("button", { name: /file.txt/ }));
  await screen.findByText("line 1");
  expect(
    portal.querySelectorAll(".git-diff-code > span").length,
  ).toBeLessThanOrEqual(500);
  expect(screen.getByText("Строки 1–500 из 1201")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Следующие строки" }));
  expect(screen.getByText("line 501")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Следующие строки" }));
  expect(screen.getByText("line 1201")).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "Следующие строки" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Предыдущие строки" }));
  expect(screen.getByText("line 501")).toBeTruthy();
});
it("pages a large changed-file list while preserving file access and total count", async () => {
  const data = snapshot();
  data.files = Array.from({ length: 401 }, (_, i) => ({
    ...data.files[0],
    path: `file-${i + 1}.txt`,
  }));
  api.readGitWorkspace.mockResolvedValue(data);
  render(view());
  await screen.findByRole("button", { name: "file-1.txt" });
  expect(
    portal.querySelectorAll(".git-workspace-files button[aria-pressed]").length,
  ).toBeLessThanOrEqual(200);
  expect(screen.getByText("Файлы 1–200 из 401")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Следующие файлы" }));
  expect(screen.getByRole("button", { name: "file-201.txt" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Следующие файлы" }));
  fireEvent.click(screen.getByRole("button", { name: "file-401.txt" }));
  await waitFor(() => expect(portal.textContent).toContain("+p file-401.txt"));
  expect(api.readGitDiff).toHaveBeenCalledWith(
    expect.objectContaining({ path: "file-401.txt" }),
  );
});
it("renders a one-MiB newline file with a bounded DOM and an explicit complete line count", async () => {
  api.readGitDiff.mockResolvedValue({
    ...diff(),
    unstaged: { kind: "text", text: "\n".repeat(1024 * 1024) },
  });
  render(view());
  fireEvent.click(await screen.findByRole("button", { name: /file.txt/ }));
  await screen.findByText("Строки 1–500 из 1048577");
  expect(portal.querySelectorAll(".git-diff-code > span")).toHaveLength(500);
  fireEvent.click(screen.getByRole("button", { name: "Следующие строки" }));
  expect(screen.getByText("Строки 501–1000 из 1048577")).toBeTruthy();
});
it("detects yesterday's partial discard when Changes opens and completes explicit recovery without Refresh", async () => {
  api.prepareGitDiscard = vi.fn();
  api.executeGitDiscard = vi.fn();
  let recovered = false;
  api.inspectGitDiscardRecovery = vi.fn(async () => ({
    scope: "p",
    revision: snapshot().revision,
    state: recovered ? "clear" : "partial",
    message: recovered
      ? "Прежняя отмена проверена"
      : "Прежняя отмена завершилась частично",
    paths: [{ path: "file.txt", state: "restored" }],
  }));
  api.prepareGitDiscardRecovery = vi.fn(async () => ({
    token: "2".repeat(64),
    scope: "p",
    root: snapshot().root,
    revision: snapshot().revision,
    paths: [{ path: "file.txt", state: "restored" }],
    message: "Завершить проверку без создания архива",
    expiresAt: Date.now() + 300000,
  }));
  api.executeGitDiscardRecovery = vi.fn(async () => {
    recovered = true;
    return {
      scope: "p",
      status: "recovered",
      message: "Готово",
    };
  });
  const v = render(view("p", false));
  await waitFor(() => expect(api.readGitWorkspace).toHaveBeenCalled());
  expect(api.inspectGitDiscardRecovery).not.toHaveBeenCalled();
  v.rerender(view());
  const action = await screen.findByRole("button", {
    name: "Оставить текущее состояние…",
  });
  await waitFor(() =>
    expect((action as HTMLButtonElement).disabled).toBe(false),
  );
  expect(api.inspectGitDiscardRecovery).toHaveBeenCalledTimes(2);
  fireEvent.click(action);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Оставить текущее состояние и продолжить",
    }),
  );
  await screen.findByText("Прежняя отмена проверена");
  expect(api.executeGitDiscardRecovery).toHaveBeenCalledExactlyOnceWith(
    "2".repeat(64),
  );
  expect(api.executeGitDiscard).not.toHaveBeenCalled();
  expect(api.readGitWorkspace).toHaveBeenCalledTimes(3);
  expect(
    screen.queryByRole("button", { name: "Оставить текущее состояние…" }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Закрыть результат отмены" }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});

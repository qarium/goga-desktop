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
import { GitHistory } from "../src/renderer/GitHistory";
const oid = "a".repeat(40),
  parent = "b".repeat(40),
  other = "c".repeat(40);
const entry = (id = oid) => ({
  oid: id,
  parents: [parent, other],
  subject: "Merge feature",
  author: "Автор",
  authoredAt: "2026-10-27T12:00:00+03:00",
  committedAt: "2026-10-27T12:00:00+03:00",
  refs: ["refs/heads/main"],
});
let api: any;
const click = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));
const view = (open = true, revision = 0) => (
  <GitHistory scope="p" open={open} revision={revision} onClose={vi.fn()} />
);
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  api = {
    readGitHistoryRefs: vi.fn(async (scope: string) => ({
      scope,
      currentBranch: "main",
      local: [
        { name: "main", ref: "refs/heads/main" },
        { name: "feature", ref: "refs/heads/feature" },
      ],
      remote: [{ name: "origin/main", ref: "refs/remotes/origin/main" }],
    })),
    readGitHistory: vi.fn(async (r: any) => ({
      scope: r.scope,
      ref: r.ref,
      tip: oid,
      commits: [entry()],
      nextOffset: null,
    })),
    readGitCommit: vi.fn(async (r: any) => ({
      ...r,
      commit: entry(r.commit),
      parent: r.parentIndex ? other : parent,
      message: "Merge feature\n\nПолное сообщение",
      files: [
        {
          path: r.parentIndex ? "second.txt" : "first.txt",
          status: "M",
          additions: 1,
          deletions: 1,
        },
      ],
      nextFileOffset: null,
    })),
    readGitCommitDiff: vi.fn(async (r: any) => ({
      ...r,
      parent: r.parentIndex ? other : parent,
      part: { kind: "patch", text: "@@ -1 +1 @@\n-old\n+" + r.path },
    })),
    executeGitBranch: vi.fn(),
    runRepositoryAction: vi.fn(),
  };
  window.goga = api;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("initially loads only the list; a file and commit have independent close controls", async () => {
  render(view());
  await screen.findByRole("button", { name: /Merge feature/ });
  expect(api.readGitCommit).not.toHaveBeenCalled();
  expect(api.readGitCommitDiff).not.toHaveBeenCalled();
  click(/Merge feature/);
  await screen.findByRole("button", { name: /first.txt/ });
  expect(screen.getByText("Полное сообщение", { exact: false })).toBeTruthy();
  expect(api.readGitCommitDiff).not.toHaveBeenCalled();
  click(/first.txt/);
  await screen.findByLabelText("Различия файла");
  click("Закрыть файл first.txt");
  expect(screen.queryByLabelText("Различия файла")).toBeNull();
  expect(screen.getByRole("button", { name: /first.txt/ })).toBeTruthy();
  click("Закрыть детали коммита");
  expect(screen.queryByRole("button", { name: /first.txt/ })).toBeNull();
});
it("follows current HEAD with a non-interactive branch indicator and no separate selector", async () => {
  api.readGitHistory.mockImplementation(async (r: any) => ({
    scope: r.scope,
    ref: r.ref,
    tip: oid,
    currentBranch: "feature/current",
    commits: [entry()],
    nextOffset: null,
  }));
  render(view());
  await screen.findByRole("button", { name: /Merge feature/ });
  expect(screen.queryByRole("button", { name: /Ветка просмотра/ })).toBeNull();
  expect(screen.getByLabelText("Текущее состояние Git").textContent).toContain(
    "feature/current",
  );
  expect(api.readGitHistory).toHaveBeenLastCalledWith({
    scope: "p",
    ref: "HEAD",
    offset: 0,
  });
  expect(api.readGitHistoryRefs).not.toHaveBeenCalled();
});
it("switches merge parent without keeping the previous file or applying late diff", async () => {
  let finish!: (v: any) => void;
  api.readGitCommitDiff.mockImplementation(
    (r: any) =>
      new Promise((resolve) => {
        finish = () =>
          resolve({
            ...r,
            parent,
            part: { kind: "patch", text: "+OLD PARENT" },
          });
      }),
  );
  render(view());
  await screen.findByRole("button", { name: /Merge feature/ });
  click(/Merge feature/);
  click(
    await screen
      .findByRole("button", { name: /first.txt/ })
      .then((b) => b.getAttribute("aria-label") || "first.txt"),
  );
  fireEvent.change(
    screen.getByRole("combobox", { name: "Родитель для сравнения" }),
    { target: { value: "1" } },
  );
  await screen.findByRole("button", { name: /second.txt/ });
  await act(async () => finish({}));
  expect(screen.queryByText(/OLD PARENT/)).toBeNull();
  expect(api.readGitCommit).toHaveBeenLastCalledWith(
    expect.objectContaining({ parentIndex: 1 }),
  );
});
it("keeps opened content on hide/return without reading again", async () => {
  const ui = render(view());
  await screen.findByRole("button", { name: /Merge feature/ });
  click(/Merge feature/);
  await screen.findByRole("button", { name: /first.txt/ });
  click(/first.txt/);
  await screen.findByLabelText("Различия файла");
  ui.rerender(view(false));
  ui.rerender(view(true));
  expect(screen.getByLabelText("Различия файла")).toBeTruthy();
  expect(api.readGitHistory).toHaveBeenCalledTimes(1);
  expect(api.readGitCommitDiff).toHaveBeenCalledTimes(1);
});
it("pages without reloading the selection and supports the keyboard splitter", async () => {
  api.readGitHistory.mockImplementation(async (r: any) => ({
    scope: r.scope,
    ref: r.ref,
    tip: oid,
    commits: [r.offset ? { ...entry(other), subject: "Older" } : entry()],
    nextOffset: r.offset ? null : 50,
  }));
  render(view());
  await screen.findByRole("button", { name: /Merge feature/ });
  click(/Merge feature/);
  await screen.findByRole("button", { name: /first.txt/ });
  const separator = screen.getByRole("separator", {
    name: "Размер списка коммитов",
  });
  const before = Number(separator.getAttribute("aria-valuenow"));
  fireEvent.keyDown(separator, { key: "ArrowDown" });
  expect(Number(separator.getAttribute("aria-valuenow"))).toBeGreaterThan(
    before,
  );
  click("Ещё коммиты");
  await screen.findByRole("button", { name: /Older/ });
  expect(api.readGitHistory).toHaveBeenLastCalledWith({
    scope: "p",
    ref: "HEAD",
    offset: 50,
    tip: oid,
  });
  expect(screen.getByRole("button", { name: /first.txt/ })).toBeTruthy();
  expect(api.readGitCommit).toHaveBeenCalledTimes(1);
});
it("finishes loading on error and offers a dismissible error instead of an endless spinner", async () => {
  api.readGitHistory.mockRejectedValue(Error("Fixture read failed"));
  render(view());
  await screen.findByText("Fixture read failed");
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  click("Закрыть ошибку истории");
  expect(screen.queryByText("Fixture read failed")).toBeNull();
  expect(
    (
      screen.getByRole("button", {
        name: "Обновить историю коммитов",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  expect(api.readGitHistory).toHaveBeenCalledTimes(1);
});
it("does not display a response for another owner", async () => {
  api.readGitHistory.mockResolvedValue({
    scope: "other",
    ref: "HEAD",
    tip: oid,
    commits: [entry()],
    nextOffset: null,
  });
  render(view());
  await screen.findByText(/другому контексту/);
  expect(screen.queryByRole("button", { name: /Merge feature/ })).toBeNull();
});

it("refreshes HEAD after a branch operation, discarding the old branch selection", async () => {
  const ui = render(view());
  await screen.findByRole("button", { name: /Merge feature/ });
  click(/Merge feature/);
  await screen.findByRole("button", { name: /first.txt/ });
  api.readGitHistory.mockResolvedValue({
    scope: "p",
    ref: "HEAD",
    tip: other,
    currentBranch: "next",
    commits: [{ ...entry(other), subject: "Next branch" }],
    nextOffset: null,
  });
  ui.rerender(view(true, 1));
  await screen.findByRole("button", { name: /Next branch/ });
  expect(screen.queryByRole("button", { name: /Merge feature/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /first.txt/ })).toBeNull();
  expect(screen.getByLabelText("Текущее состояние Git").textContent).toContain(
    "next",
  );
  expect(api.readGitHistory).toHaveBeenLastCalledWith({
    scope: "p",
    ref: "HEAD",
    offset: 0,
  });
});
it("a silent transport times out without keeping a loader", async () => {
  vi.useFakeTimers();
  api.readGitHistory.mockReturnValue(new Promise(() => {}));
  render(view());
  expect(
    screen.getByRole("status", { name: "Загрузка истории коммитов" }),
  ).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30001);
  });
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByText(/Превышено время ожидания/)).toBeTruthy();
  click("Закрыть ошибку истории");
  expect(
    (
      screen.getByRole("button", {
        name: "Обновить историю коммитов",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

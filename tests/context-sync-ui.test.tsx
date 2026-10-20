// @vitest-environment jsdom
import React from "react";
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { TopicSyncActions } from "../src/renderer/TopicSyncActions";
const owner = {
  projectId: "p",
  year: "2026",
  topic: "a",
  branch: "a",
  contextId: "ctx-" + "a".repeat(64),
  revision: "00000000-0000-4000-8000-000000000001",
};
const state = {
  ...owner,
  status: "new",
  waitingRunIds: [],
  reasons: [],
  updatedAt: "now",
};
let api: any;
beforeEach(() => {
  api = {
    topicSyncStatus: vi.fn(async () => state),
    syncTopicContext: vi.fn(async () => ({
      ...state,
      status: "waiting",
      waitingRunIds: ["run"],
    })),
    retryContextSync: vi.fn(async () => ({ ...state, status: "synced" })),
    prepareContextApply: vi.fn(async () => ({
      ...owner,
      token: "token-a",
      sourceOid: "aaa",
      targetBranch: "main",
      targetOid: "bbb",
      canApply: true,
      files: ["docs/a.md"],
    })),
    applyContext: vi.fn(async () => ({})),
  };
  window.goga = api;
});
afterEach(cleanup);
it("shows queued synchronization without changing run outcome and retries a recorded error", async () => {
  render(<TopicSyncActions owner={owner} onChanged={() => {}} />);
  await screen.findByText("Ещё не синхронизировано");
  fireEvent.click(screen.getByRole("button", { name: "Синхронизировать" }));
  await screen.findByText(/Ожидает завершения запуска/);
  expect(api.syncTopicContext).toHaveBeenCalledWith(owner);
  cleanup();
  api.topicSyncStatus.mockResolvedValue({
    ...state,
    status: "error",
    error: "Import failed",
  });
  render(<TopicSyncActions owner={owner} onChanged={() => {}} />);
  await screen.findByText("Import failed");
  fireEvent.click(
    screen.getByRole("button", { name: "Повторить синхронизацию" }),
  );
  await screen.findByText("Синхронизировано");
  expect(api.retryContextSync).toHaveBeenCalledWith(owner);
});
it("previews immutable source and target before an explicit apply confirmation", async () => {
  render(<TopicSyncActions owner={owner} onChanged={() => {}} />);
  await screen.findByText("Ещё не синхронизировано");
  fireEvent.click(screen.getByRole("button", { name: "Применить в базу…" }));
  await screen.findByText("docs/a.md");
  expect(screen.getByText(/main/)).toBeTruthy();
  expect(api.applyContext).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Подтвердить применение" }),
  );
  await waitFor(() =>
    expect(api.applyContext).toHaveBeenCalledWith({
      projectId: "p",
      token: "token-a",
      confirmed: true,
    }),
  );
});

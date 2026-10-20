// @vitest-environment jsdom
import React from "react";
import { it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { ContextMigration } from "../src/renderer/ContextMigration";
const legacy: any = {
  projectId: "p",
  year: "2026",
  topic: "a",
  branch: "a",
  contextId: "ctx-" + "a".repeat(64),
  revision: "00000000-0000-4000-8000-000000000001",
  storageKind: "linked",
  ownership: "managed",
  state: "ready",
  path: "/legacy",
};
afterEach(cleanup);
it("requires explicit consent and creates a new clone without changing or deleting the legacy copy", async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const next = { ...legacy, storageKind: "clone", path: "/clone" };
  const api: any = { migrateTopicContext: vi.fn(async () => next) };
  window.goga = api;
  const onMigrated = vi.fn();
  render(<ContextMigration record={legacy} onMigrated={onMigrated} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Создать автономный клон…" }),
  );
  expect(api.migrateTopicContext).not.toHaveBeenCalled();
  expect(
    screen.getByText(/Старая linked-копия останется без изменений/),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Подтвердить создание клона" }),
  );
  await waitFor(() => expect(onMigrated).toHaveBeenCalledWith(next));
  expect(api.migrateTopicContext).toHaveBeenCalledWith({
    projectId: "p",
    year: "2026",
    topic: "a",
    branch: "a",
  });
});

// @vitest-environment jsdom
import "./helpers/overview-browser-fixture";
import React from "react";
import { it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  act,
  render,
  screen,
  fireEvent,
  cleanup,
  within,
} from "@testing-library/react";
import { App } from "../src/renderer/App";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});
const project = { id: "p", name: "Synthetic", path: "/fixture/p" };
const ref = {
  projectId: "p",
  year: "2026",
  topic: "design",
  branch: "design",
  contextId: "ctx-" + "a".repeat(64),
  revision: "00000000-0000-4000-8000-000000000001",
};
const row = {
  ...ref,
  projectPath: project.path,
  gitCommonDir: "/git",
  path: "/fixture/clone",
  repositoryKey: "b".repeat(64),
  state: "ready",
  ownership: "managed",
  storageKind: "clone",
};
it.each([
  { closeFirst: false, fail: false },
  { closeFirst: true, fail: false },
  { closeFirst: true, fail: true },
])(
  "a group dialog supersedes a pending Home shortcut, even after dismissal ($closeFirst, rejected $fail)",
  async ({ closeFirst, fail }) => {
    let finish!: (v: typeof row) => void, reject!: (error: Error) => void;
    const pending = new Promise<typeof row>((yes, no) => {
      finish = yes;
      reject = no;
    });
    const resolveTopicContext = vi.fn(() => pending),
      listTopicContexts = vi.fn(async () => []);
    localStorage.setItem(
      "goga.desktop.homeVisits.v1",
      JSON.stringify({
        schemaVersion: 1,
        visits: [
          {
            projectId: "p",
            visitedAt: 1,
            target: { kind: "changes", owner: { kind: "topic", ref } },
          },
        ],
      }),
    );
    window.goga = {
      listProjects: async () => [project],
      runs: async () => [],
      onRuns: () => () => {},
      onFocusRun: () => () => {},
      onViewError: () => () => {},
      selectRun: async () => {},
      resolveTopicContext,
      listTopicContexts,
    } as any;
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Продолжить Synthetic · design · Изменения",
      }),
    );
    expect(resolveTopicContext).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Создать группу" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Создать группу",
    });
    if (closeFirst)
      fireEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));
    await act(async () => {
      if (fail) reject(Error("Не удалось проверить рабочую копию"));
      else finish(row);
    });
    expect(screen.queryByRole("heading", { name: "Главная" })).not.toBeNull();
    expect(
      screen.queryByRole("dialog", { name: "Создать группу" }) !== null,
    ).toBe(!closeFirst);
    expect(screen.queryByText(/Не удалось проверить рабочую копию/)).toBeNull();
    expect(listTopicContexts).not.toHaveBeenCalled();
  },
);

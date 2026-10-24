import { installHistoryWorker } from "./helpers/history-worker";
// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { TopicOverview } from "../src/renderer/TopicOverview";
import { ProjectSettings } from "../src/renderer/ProjectSettings";
const project = { id: "p", name: "Fixture", path: "/fixture" };
const target = { topic: "alpha", branch: "alpha", remote: false };
let api: any;
beforeEach(() => {
  installHistoryWorker();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  api = {
    readProjectSettings: vi.fn(async () => ({
      value: { executable: "goga", profile: "", env: [] },
      version: "v",
      profiles: [],
    })),
    listHistoryYears: vi.fn(async () => ["2026"]),
    listHistoryEntries: vi.fn(async () => ["alpha"]),
    listHistoryArtifacts: vi.fn(async () => [
      { path: "plan.md", kind: "file", readable: true },
    ]),
    readHistoryArtifact: vi.fn(async () => ({
      relativePath: ".goga/history/2026/alpha/plan.md",
      text: "# Артефакт",
      format: "markdown",
    })),
    readTopicOverview: vi.fn(async () => ({
      projectId: "p",
      year: "2026",
      target,
      text: "# Задача",
      exists: true,
      version: "v",
      editable: false,
    })),
  };
  window.goga = api;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("History is between Image and Tools in project and uses the approved browser", async () => {
  render(
    <ProjectSettings
      project={project}
      onBack={vi.fn()}
      onSaved={vi.fn()}
      guard={{ current: null }}
      onBusy={vi.fn()}
    />,
  );
  const tabs = within(
    screen.getByRole("navigation", { name: "Разделы настроек проекта" }),
  )
    .getAllByRole("button")
    .map((e) => e.textContent);
  expect(
    tabs.slice(tabs.indexOf("Образ"), tabs.indexOf("Инструменты") + 1),
  ).toEqual(["Образ", "История", "Инструменты"]);
  fireEvent.click(screen.getByRole("button", { name: "История" }));
  const entry = await screen.findByLabelText("Запись истории");
  await waitFor(() =>
    expect((entry as HTMLSelectElement).disabled).toBe(false),
  );
  fireEvent.click(entry);
  fireEvent.click(screen.getByRole("option", { name: "alpha" }));
  fireEvent.click(await screen.findByRole("button", { name: "Файл plan.md" }));
  await screen.findByRole("heading", { name: "Артефакт" });
  expect(api.listHistoryYears).toHaveBeenCalledWith("p");
});
it("selector card has lazy Artifacts immediately after Task; default table card does not", async () => {
  const props = {
    project,
    year: "2026",
    target,
    board: null,
    onClose: vi.fn(),
    onChanged: vi.fn(),
  };
  const view = render(<TopicOverview {...props} />);
  await waitFor(() => expect(api.readTopicOverview).toHaveBeenCalled());
  expect(screen.queryByRole("tab", { name: "Артефакты" })).toBeNull();
  view.rerender(<TopicOverview {...props} showArtifacts />);
  const tabs = within(
    screen.getByRole("tablist", { name: "Информация о топике" }),
  ).getAllByRole("tab");
  expect(tabs.map((e) => e.textContent)).toEqual([
    "Задача",
    "Артефакты",
    "Размещение по веткам",
  ]);
  expect(api.listHistoryArtifacts).not.toHaveBeenCalled();
  fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
  await screen.findByText("Выберите файл");
  expect(document.activeElement?.textContent).toBe("Артефакты");
  expect(api.readHistoryArtifact).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Файл plan.md" }));
  await screen.findByRole("heading", { name: "Артефакт" });
  expect(api.listHistoryArtifacts).toHaveBeenCalledWith(
    "p",
    "2026",
    "alpha",
    target,
  );
  expect(
    screen.getByRole("button", { name: "Удалить топик…" }).closest("footer"),
  ).toBeTruthy();
  expect(api.listHistoryYears).not.toHaveBeenCalled();
});
it("does not read artifacts from primary while clone ownership is uncertain", async () => {
  const props = {
    project,
    year: "2026",
    target,
    board: null,
    onClose: vi.fn(),
    onChanged: vi.fn(),
    showArtifacts: true,
  };
  const view = render(<TopicOverview {...props} ownerReadState="loading" />);
  fireEvent.click(screen.getByRole("tab", { name: "Артефакты" }));
  expect(api.listHistoryArtifacts).not.toHaveBeenCalled();
  view.rerender(
    <TopicOverview
      {...props}
      ownerReadState="error"
      ownerReadError="Нет доступа к копии"
    />,
  );
  await screen.findAllByText("Нет доступа к копии");
  expect(screen.queryByRole("status")).toBeNull();
  expect(api.listHistoryArtifacts).not.toHaveBeenCalled();
});

it("refreshes reads but keeps History selection when the same context gets a new revision", async () => {
  const owner = {
    projectId: "p",
    year: "2026",
    topic: "alpha",
    branch: "alpha",
    contextId: "ctx-" + "a".repeat(64),
    revision: "old",
  };
  const props = {
    project,
    owner,
    onBack: vi.fn(),
    onSaved: vi.fn(),
    guard: { current: null },
    onBusy: vi.fn(),
  };
  const view = render(<ProjectSettings {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "История" }));
  const entry = await screen.findByLabelText("Запись истории");
  await waitFor(() =>
    expect((entry as HTMLSelectElement).disabled).toBe(false),
  );
  fireEvent.click(entry);
  fireEvent.click(screen.getByRole("option", { name: "alpha" }));
  fireEvent.click(await screen.findByRole("button", { name: "Файл plan.md" }));
  await screen.findByRole("heading", { name: "Артефакт" });
  view.rerender(
    <ProjectSettings {...props} owner={{ ...owner, revision: "new" }} />,
  );
  await waitFor(() =>
    expect(api.readHistoryArtifact).toHaveBeenLastCalledWith(
      { ...owner, revision: "new" },
      "2026",
      "alpha",
      "plan.md",
      undefined,
    ),
  );
  await screen.findByRole("heading", { name: "Артефакт" });
});

it("opens artifact reader from a selector card mounted beside main-area as in App", async () => {
  const close = vi.fn();
  render(
    <div className="app-shell">
      <main className="main-area" />
      <TopicOverview
        project={project}
        year="2026"
        target={target}
        board={null}
        showArtifacts
        onClose={close}
        onChanged={() => {}}
      />
    </div>,
  );
  fireEvent.click(screen.getByRole("tab", { name: "Артефакты" }));
  fireEvent.click(await screen.findByRole("button", { name: "Файл plan.md" }));
  await screen.findByRole("heading", { name: "Артефакт" });
  fireEvent.click(screen.getByRole("button", { name: "Развернуть документ" }));
  const reader = screen.getByRole("dialog", { name: "Просмотр plan.md" });
  expect(
    screen.queryByText("Не удалось определить рабочую область для просмотра."),
  ).toBeNull();
  fireEvent(reader, new Event("cancel", { bubbles: true, cancelable: true }));
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "alpha" })).toBeTruthy();
});

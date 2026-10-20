// @vitest-environment jsdom
import React from "react";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  within,
} from "@testing-library/react";
import { BuildForm, createBuildDrafts } from "../src/renderer/BuildForm";
import { LaunchForm } from "../src/renderer/LaunchForm";
import { createDraftStore } from "../src/renderer/task-drafts";
import {
  createSettingsDocuments,
  documentKey,
} from "../src/renderer/settings-documents";
import {
  contextKey,
  contextRequestKey,
  draftKey,
} from "../src/renderer/topic-context";
const project = { id: "p", name: "Project", path: "/primary" };
const a = {
  projectId: "p",
  year: "2026",
  topic: "a",
  branch: "a",
  contextId: "ctx-" + "a".repeat(64),
  revision: "00000000-0000-4000-8000-000000000001",
};
const b = { ...a, topic: "b", branch: "b", contextId: "ctx-" + "b".repeat(64) };
let api: any;
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  api = {
    buildContext: vi.fn(async (scope: any) => ({
      revision: "build-rev",
      branch: scope.branch,
      capabilities: [],
      defaults: { skipReview: false, profile: "" },
      branches: ["main"],
      workflows: [],
      profiles: [],
      historyPlan: { path: "docs/plan.md" },
    })),
    readBuildPlan: vi.fn(async (scope: any, path: string) => ({
      path,
      text: "Plan " + scope.topic,
      version: scope.topic,
    })),
    listBuildFiles: vi.fn(async () => ({ directory: "", entries: [] })),
    launchBuild: vi.fn(async (request: any) => ({
      id: "build",
      projectId: "p",
      ...request,
    })),
    discover: vi.fn(async (scope: any) => ({
      pipelines: [
        { id: "verify", name: "Verify", description: "From " + scope.topic },
      ],
      topics: [],
      currentBranch: scope.branch,
      workflows: [],
      profiles: [],
      branches: ["main"],
    })),
    preview: vi.fn(async () => ({
      token: "preview",
      stages: [{ id: "one", title: "One" }],
      workflow: null,
      profile: null,
    })),
    readTopicTask: vi.fn(async (request: any) => ({
      text: "Task " + request.context.topic,
      exists: true,
      version: "v",
      path: "todo.md",
    })),
    checkoutBranch: vi.fn(async (scope: any) => scope.branch),
    launch: vi.fn(async (request: any) => ({ id: "pipeline", ...request })),
    readProjectDocument: vi.fn(async (scope: any) => ({
      text: "Config " + scope.topic,
      exists: true,
      version: scope.topic,
      relativePath: ".goga/config.yml",
    })),
    saveProjectDocument: vi.fn(
      async (scope: any, _target: any, text: string) => ({
        text,
        exists: true,
        version: scope.topic + "-saved",
      }),
    ),
  };
  window.goga = api;
});
afterEach(cleanup);
it("separates stable owner keys from revision-aware request keys", () => {
  const revised = { ...a, revision: "new" };
  expect(contextKey(a)).toBe(contextKey(revised));
  expect(contextRequestKey(a)).not.toBe(contextRequestKey(revised));
});
it("binds every build read, chooser and launch to the narrow owner reference", async () => {
  render(
    <BuildForm
      project={project}
      owner={a}
      onCancel={() => {}}
      onLaunched={() => {}}
    />,
  );
  await screen.findByText("План доступен");
  expect(api.buildContext).toHaveBeenCalledWith(a, expect.anything());
  expect(api.readBuildPlan).toHaveBeenCalledWith(a, "docs/plan.md");
  fireEvent.click(screen.getByRole("button", { name: "Выбрать файл…" }));
  await waitFor(() => expect(api.listBuildFiles).toHaveBeenCalledWith(a, ""));
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Отмена" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  await waitFor(() => expect(api.launchBuild).toHaveBeenCalled());
  expect(api.launchBuild.mock.calls[0][0].context).toEqual(a);
  expect(api.launchBuild.mock.calls[0][0].planVersion).toBe("a");
});
it("preserves independent build drafts for two clones of the same project", async () => {
  const drafts = createBuildDrafts();
  const form = render(
    <BuildForm
      key="a"
      project={project}
      owner={a}
      drafts={drafts}
      onCancel={() => {}}
      onLaunched={() => {}}
    />,
  );
  await screen.findByText("План доступен");
  fireEvent.change(screen.getByLabelText("План сборки"), {
    target: { value: "a.md" },
  });
  form.rerender(
    <BuildForm
      key="b"
      project={project}
      owner={b}
      drafts={drafts}
      onCancel={() => {}}
      onLaunched={() => {}}
    />,
  );
  await screen.findByText("План доступен");
  expect((screen.getByLabelText("План сборки") as HTMLInputElement).value).toBe(
    "docs/plan.md",
  );
  expect(drafts.has(draftKey(a, "build"))).toBe(true);
});
it("uses contextual catalog/task/preview/branch without offering another topic selection", async () => {
  render(
    <LaunchForm
      project={project}
      owner={a}
      onCancel={() => {}}
      onLaunched={() => {}}
    />,
  );
  const task = await screen.findByRole("textbox", {
    name: "Что нужно сделать?",
  });
  await waitFor(() =>
    expect((task as HTMLTextAreaElement).value).toBe("Task a"),
  );
  expect(api.discover).toHaveBeenCalledWith(a);
  expect(
    api.preview.mock.calls.every(
      ([request]: any[]) => request.context?.contextId === a.contextId,
    ),
  ).toBe(true);
  expect(screen.queryByText("Существующий")).toBeNull();
  expect(screen.queryByText("Создать новый")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  await waitFor(() => expect(api.launch).toHaveBeenCalled());
  expect(api.checkoutBranch).toHaveBeenCalledWith(a);
  expect(api.launch.mock.calls[0][0]).toMatchObject({
    context: a,
    topic: { mode: "existing", branch: "a", topic: "a" },
  });
});
it("keeps contextual document drafts and saves separate from primary and another clone", async () => {
  const docs = createSettingsDocuments();
  const sourceA = {
    scope: "project" as const,
    projectId: "p",
    context: a,
    target: { kind: "config" as const },
  };
  const sourceB = { ...sourceA, context: b };
  expect(documentKey(sourceA)).not.toBe(documentKey(sourceB));
  expect(documentKey(sourceA)).not.toBe(
    documentKey({ ...sourceA, context: undefined }),
  );
  await docs.open(sourceA);
  await docs.open(sourceB);
  docs.edit(sourceA, "Edited A");
  await docs.save(sourceA);
  expect(api.readProjectDocument).toHaveBeenCalledWith(a, { kind: "config" });
  expect(api.saveProjectDocument).toHaveBeenCalledWith(
    a,
    { kind: "config" },
    "Edited A",
    "a",
  );
  expect(docs.get(sourceB).text).toBe("Config b");
  expect(docs.projectRevision(a)).toBe(1);
  expect(docs.projectRevision(b)).toBe(0);
});
it("keeps contextual document catalog and suggestions in the same clone", async () => {
  const { ContextDocuments } = await import("../src/renderer/ContextDocuments");
  api.listProjectWorkflows = vi.fn(async () => []);
  api.listWorkflowSuggestions = vi.fn(async () => []);
  render(
    <ContextDocuments
      project={project}
      owner={a}
      store={createSettingsDocuments()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Рабочие процессы" }));
  await waitFor(() => expect(api.listProjectWorkflows).toHaveBeenCalledWith(a));
  fireEvent.click(
    screen.getByRole("button", { name: "Создать рабочий процесс" }),
  );
  await waitFor(() =>
    expect(api.listWorkflowSuggestions).toHaveBeenCalledWith(a),
  );
});
it("does not publish a late plan from A into B with the same relative filename", async () => {
  let resolveA: (doc: any) => void = () => {};
  api.readBuildPlan.mockImplementation((scope: any, path: string) =>
    scope.contextId === a.contextId
      ? new Promise((resolve) => {
          resolveA = resolve;
        })
      : Promise.resolve({ path, text: "Plan B", version: "b" }),
  );
  const form = render(
    <BuildForm
      key="a"
      project={project}
      owner={a}
      onCancel={() => {}}
      onLaunched={() => {}}
    />,
  );
  await waitFor(() =>
    expect(api.readBuildPlan).toHaveBeenCalledWith(a, "docs/plan.md"),
  );
  form.rerender(
    <BuildForm
      key="b"
      project={project}
      owner={b}
      onCancel={() => {}}
      onLaunched={() => {}}
    />,
  );
  await screen.findByText("План доступен");
  resolveA({ path: "docs/plan.md", text: "Late plan A", version: "a" });
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  await waitFor(() => expect(api.launchBuild).toHaveBeenCalled());
  expect(api.launchBuild.mock.calls[0][0]).toMatchObject({
    context: b,
    planVersion: "b",
  });
});

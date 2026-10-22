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
import { EditorView } from "@codemirror/view";
import { ContextDocuments } from "../src/renderer/ContextDocuments";
import { ProjectSettings } from "../src/renderer/ProjectSettings";
import { ProjectDocuments } from "../src/renderer/ProjectDocuments";
import {
  createSettingsDocuments,
  documentKey,
} from "../src/renderer/settings-documents";
const project = { id: "p", name: "P", path: "/p" };
let api: any;
const view = () => {
  const el = document
    .querySelector(".yaml-code-editor")
    ?.shadowRoot?.querySelector(".cm-content");
  return el ? EditorView.findFromDOM(el as HTMLElement)! : null;
};
beforeEach(() => {
  api = {
    resolveProjectDockerfile: vi.fn(async () => ({
      relativePath: ".goga/Dockerfile",
      configured: false,
    })),
    readProjectDocument: vi.fn(async () => ({
      relativePath: ".goga/Dockerfile",
      exists: false,
      text: "",
      version: "v",
    })),
    saveProjectDocument: vi.fn(
      async (_id: any, _target: any, text: string) => ({
        text,
        version: "v2",
        exists: true,
        relativePath: ".goga/Dockerfile",
      }),
    ),
  };
  window.goga = api;
});
afterEach(cleanup);
it("resolves only active image tab and creates raw plain text only on Save with manual configuration notice", async () => {
  const store = createSettingsDocuments();
  const rendered = render(
    <ProjectDocuments project={project} tab="launch" store={store} />,
  );
  expect(api.resolveProjectDockerfile).not.toHaveBeenCalled();
  rendered.rerender(
    <ProjectDocuments project={project} tab="image" store={store} />,
  );
  await screen.findByText(/подключить вручную/i);
  expect(screen.queryByRole("button", { name: "Обновить путь Dockerfile" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Открыть редактор" }));
  await waitFor(() => expect(view()).not.toBeNull());
  expect(api.saveProjectDocument).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Удалить" })).toBeNull();
  expect(view()!.contentDOM.getAttribute("aria-label")).toBe("Dockerfile");
  const text = "FROM alpine\r\nRUN {{ [ no yaml\r\n";
  act(() => view()!.dispatch({ changes: { from: 0, insert: text } }));
  expect(view()!.contentDOM.querySelector(".dockerfile-keyword")?.textContent).toBe("FROM");
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await waitFor(() =>
    expect(api.saveProjectDocument).toHaveBeenCalledWith(
      "p",
      { kind: "dockerfile", path: ".goga/Dockerfile" },
      text,
      "v",
    ),
  );
});
it("retains dirty old source across tabs when config changes, and explicitly discards to new source", async () => {
  const store = createSettingsDocuments();
  const rendered = render(
    <ProjectDocuments project={project} tab="image" store={store} />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Открыть редактор" }),
  );
  await waitFor(() => expect(view()).not.toBeNull());
  act(() => view()!.dispatch({ changes: { from: 0, insert: "FROM draft" } }));
  rendered.rerender(
    <ProjectDocuments project={project} tab="launch" store={store} />,
  );
  api.resolveProjectDockerfile.mockResolvedValue({
    relativePath: "new/Dockerfile",
    configured: true,
  });
  rendered.rerender(
    <ProjectDocuments project={project} tab="image" store={store} />,
  );
  await screen.findByText(/Конфигурация Dockerfile изменилась/);
  expect(view()!.state.doc.toString()).toBe("FROM draft");
  expect(
    screen.getByRole("button", { name: "Сохранить" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(
    screen.getByRole("button", {
      name: "Отбросить черновик и открыть актуальный файл",
    }),
  );
  await screen.findByText("new/Dockerfile");
  expect(view()).toBeNull();
});
it("keys drafts by exact context and selected path", () => {
  const source = {
    scope: "project" as const,
    projectId: "p",
    target: { kind: "dockerfile" as const, path: "one" },
  };
  expect(documentKey(source)).not.toBe(
    documentKey({ ...source, target: { kind: "dockerfile", path: "two" } }),
  );
});
it("ignores late metadata from another owner and keeps source reads and drafts isolated", async () => {
  let resolveOld!: (value: any) => void;
  api.resolveProjectDockerfile.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  const store = createSettingsDocuments();
  const rendered = render(
    <ProjectDocuments project={project} tab="image" store={store} />,
  );
  await waitFor(() =>
    expect(api.resolveProjectDockerfile).toHaveBeenCalledTimes(1),
  );
  const other = { id: "q", name: "Q", path: "/q" };
  api.resolveProjectDockerfile.mockResolvedValue({
    relativePath: "Q.Dockerfile",
    configured: true,
  });
  rendered.rerender(
    <ProjectDocuments project={other} tab="image" store={store} />,
  );
  await screen.findByText("Q.Dockerfile");
  await act(async () =>
    resolveOld({ relativePath: "OLD.Dockerfile", configured: true }),
  );
  expect(screen.queryByText("OLD.Dockerfile")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Открыть редактор" }));
  await waitFor(() => expect(view()).not.toBeNull());
  expect(api.readProjectDocument).toHaveBeenCalledWith("q", {
    kind: "dockerfile",
    path: "Q.Dockerfile",
  });
  act(() => view()!.dispatch({ changes: { from: 0, insert: "FROM q draft" } }));
  rendered.rerender(
    <ProjectDocuments project={project} tab="image" store={store} />,
  );
  await screen.findByRole("button", { name: "Открыть редактор" });
  expect(view()).toBeNull();
});

it("places image immediately after pipelines and before tools in both settings contexts", async () => {
  api.readProjectSettings = vi.fn(async () => ({
    version: "s",
    profiles: [],
    value: {
      executable: "goga",
      profile: "",
      env: [],
      startupTimeoutMinutes: 5,
    },
  }));
  api.listSettings = vi.fn(async () => []);
  api.listProjectProfiles = vi.fn(async () => []);
  const store = createSettingsDocuments();
  const first = render(
    <ProjectSettings
      project={project}
      documents={store}
      guard={{ current: null }}
      onBack={() => {}}
      onSaved={() => {}}
      onBusy={() => {}}
    />,
  );
  const check = (label: string) => {
    const nav = screen.getByRole("navigation", { name: label });
    const labels = Array.from(nav.querySelectorAll("button")).map(
      (x) => x.textContent,
    );
    expect(labels[labels.indexOf("Конвейеры") + 1]).toBe("Образ");
    expect(labels.indexOf("Образ")).toBeLessThan(labels.indexOf("Инструменты"));
  };
  check("Разделы настроек проекта");
  first.unmount();
  const owner = {
    projectId: "p",
    year: "2026",
    topic: "topic",
    branch: "branch",
    contextId: "ctx-" + "a".repeat(64),
    revision: "00000000-0000-4000-8000-000000000001",
  };
  render(<ContextDocuments project={project} store={store} owner={owner} />);
  check("Файлы топика");
  expect(api.resolveProjectDockerfile).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Образ" }));
  await waitFor(() =>
    expect(api.resolveProjectDockerfile).toHaveBeenCalledWith(owner),
  );
});

it("retains a dirty fallback when null becomes an explicit selection of the same path", async () => {
  const store = createSettingsDocuments();
  const rendered = render(<ProjectDocuments project={project} tab="image" store={store} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Открыть редактор" }),
  );
  await waitFor(() => expect(view()).not.toBeNull());
  act(() =>
    view()!.dispatch({ changes: { from: 0, insert: "FROM fallback draft" } }),
  );
  api.resolveProjectDockerfile.mockResolvedValue({
    relativePath: ".goga/Dockerfile",
    configured: true,
  });
  rendered.rerender(<ProjectDocuments project={project} tab="launch" store={store} />);
  rendered.rerender(<ProjectDocuments project={project} tab="image" store={store} />);
  await waitFor(() => expect(api.resolveProjectDockerfile).toHaveBeenCalledTimes(2));
  await screen.findByText(/Конфигурация Dockerfile изменилась/);
  expect(view()!.state.doc.toString()).toBe("FROM fallback draft");
  expect(
    screen.getByRole("button", { name: "Сохранить" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(api.saveProjectDocument).not.toHaveBeenCalled();
});
it("does not leak a late metadata rejection into a different context of the same project", async () => {
  const first = {
    projectId: "p",
    year: "2026",
    topic: "one",
    branch: "one",
    contextId: "ctx-" + "a".repeat(64),
    revision: "00000000-0000-4000-8000-000000000001",
  };
  const second = {
    ...first,
    topic: "two",
    branch: "two",
    contextId: "ctx-" + "b".repeat(64),
  };
  let rejectOld!: (reason: Error) => void;
  api.resolveProjectDockerfile.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectOld = reject;
      }),
  );
  const store = createSettingsDocuments();
  const rendered = render(
    <ProjectDocuments
      project={project}
      owner={first}
      tab="image"
      store={store}
    />,
  );
  await waitFor(() =>
    expect(api.resolveProjectDockerfile).toHaveBeenCalledTimes(1),
  );
  api.resolveProjectDockerfile.mockResolvedValue({
    relativePath: "second/Dockerfile",
    configured: true,
  });
  rendered.rerender(
    <ProjectDocuments
      project={project}
      owner={second}
      tab="image"
      store={store}
    />,
  );
  await screen.findByText("second/Dockerfile");
  await act(async () => rejectOld(Error("Old owner failure")));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(api.resolveProjectDockerfile).toHaveBeenLastCalledWith(second);
});

it("automatically rereads path on reopening an image tab with a clean document", async () => {
  const store = createSettingsDocuments();
  const rendered = render(<ProjectDocuments project={project} tab="image" store={store} />);
  fireEvent.click(await screen.findByRole("button", { name: "Открыть редактор" }));
  await waitFor(() => expect(view()).not.toBeNull());
  rendered.rerender(<ProjectDocuments project={project} tab="launch" store={store} />);
  api.resolveProjectDockerfile.mockResolvedValue({ relativePath: "next/Dockerfile", configured: true });
  rendered.rerender(<ProjectDocuments project={project} tab="image" store={store} />);
  await screen.findByText("next/Dockerfile");
  expect(api.resolveProjectDockerfile).toHaveBeenCalledTimes(2);
  expect(view()).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

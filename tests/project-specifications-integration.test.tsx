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
import { ProjectSpecifications } from "../src/renderer/ProjectSpecifications";
import { ProjectDocuments } from "../src/renderer/ProjectDocuments";
import { RetainedViews } from "../src/renderer/RetainedViews";
import { createSpecificationsState } from "../src/renderer/project-specifications-state";
import { createSettingsDocuments } from "../src/renderer/settings-documents";
import {
  specificationAPI,
  specificationFiles,
  specificationProject as project,
} from "./helpers/project-specifications";
import { installHistoryWorker } from "./helpers/history-worker";
const owner = {
  projectId: "p",
  year: "2026",
  topic: "feature",
  branch: "feature/test",
  contextId: "ctx-" + "a".repeat(64),
  revision: "00000000-0000-4000-8000-000000000001",
};
const catalog = {
  exists: true,
  paths: Object.keys(specificationFiles),
  skippedUnsupported: 0,
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (e: Error) => void;
  const promise = new Promise<T>((y, n) => {
    resolve = y;
    reject = n;
  });
  return { promise, resolve, reject };
}
let api: ReturnType<typeof specificationAPI>;
beforeEach(() => {
  installHistoryWorker();
  api = specificationAPI();
  window.goga = api as any;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const ready = () => screen.findByRole("heading", { name: "Спецификации" });
const click = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }));
it("ignores a late file response after choosing a different path", async () => {
  const slow = deferred<any>();
  api.readProjectSpecification.mockImplementationOnce(() => slow.promise);
  render(<ProjectSpecifications project={project} />);
  await screen.findByRole("treeitem", { name: "Файл blank.md" });
  fireEvent.click(screen.getByRole("treeitem", { name: "Файл blank.md" }));
  await screen.findByText("Файл пуст");
  await act(async () =>
    slow.resolve({ path: "README.md", exists: true, text: "# LATE wrong" }),
  );
  expect(screen.queryByText("LATE wrong")).toBeNull();
});
it.each([false, true])(
  "ignores late previous-owner catalog success/error=%s",
  async (fail) => {
    const slow = deferred<any>();
    api.listProjectSpecifications.mockImplementationOnce(() => slow.promise);
    const f = render(<ProjectSpecifications project={project} />);
    f.rerender(<ProjectSpecifications project={project} owner={owner} />);
    await ready();
    await act(async () => {
      if (fail) slow.reject(Error("LATE failure"));
      else slow.resolve({ exists: false, paths: [], skippedUnsupported: 0 });
    });
    expect(screen.queryByText("LATE failure")).toBeNull();
    expect(screen.getByRole("heading", { name: "Спецификации" })).toBeTruthy();
    expect(api.readProjectSpecification).toHaveBeenLastCalledWith(
      owner,
      "README.md",
    );
  },
);
it("keeps selection/query through a revision remount but hides unverified old contents", async () => {
  const store = createSpecificationsState();
  const f = render(
    <ProjectSpecifications
      key="r1"
      project={project}
      owner={owner}
      stateStore={store}
    />,
  );
  await ready();
  click("Вложенный документ");
  await screen.findByRole("heading", { name: "API usage" });
  fireEvent.change(
    screen.getByRole("textbox", { name: "Найти спецификацию" }),
    { target: { value: "usage" } },
  );
  const slow = deferred<any>();
  api.listProjectSpecifications.mockImplementationOnce(() => slow.promise);
  const next = { ...owner, revision: "00000000-0000-4000-8000-000000000002" };
  f.rerender(
    <ProjectSpecifications
      key="r2"
      project={project}
      owner={next}
      stateStore={store}
    />,
  );
  expect(screen.queryByRole("heading", { name: "API usage" })).toBeNull();
  await act(async () => slow.resolve(catalog));
  await screen.findByRole("heading", { name: "API usage" });
  expect(
    (
      screen.getByRole("textbox", {
        name: "Найти спецификацию",
      }) as HTMLInputElement
    ).value,
  ).toBe("usage");
  expect(api.readProjectSpecification).toHaveBeenLastCalledWith(
    next,
    "api/usage.md",
  );
});
it("retains source reading state separately from topic and another project", async () => {
  const store = createSpecificationsState();
  const f = render(
    <ProjectSpecifications key="p" project={project} stateStore={store} />,
  );
  await ready();
  click("Вложенный документ");
  await screen.findByRole("heading", { name: "API usage" });
  fireEvent.change(
    screen.getByRole("textbox", { name: "Найти спецификацию" }),
    { target: { value: "api" } },
  );
  f.rerender(
    <ProjectSpecifications
      key="topic"
      project={project}
      owner={owner}
      stateStore={store}
    />,
  );
  await ready();
  expect(
    (
      screen.getByRole("textbox", {
        name: "Найти спецификацию",
      }) as HTMLInputElement
    ).value,
  ).toBe("");
  f.rerender(
    <ProjectSpecifications
      key="q"
      project={{ ...project, id: "q" }}
      stateStore={store}
    />,
  );
  await ready();
  expect(api.readProjectSpecification).toHaveBeenLastCalledWith(
    "q",
    "README.md",
  );
  f.rerender(
    <ProjectSpecifications key="p2" project={project} stateStore={store} />,
  );
  await screen.findByRole("heading", { name: "API usage" });
  expect(
    (
      screen.getByRole("textbox", {
        name: "Найти спецификацию",
      }) as HTMLInputElement
    ).value,
  ).toBe("api");
});
it("refreshes automatically on retained-tab return, preserving selected file", async () => {
  const store = createSpecificationsState();
  const view = (active: boolean) => (
    <RetainedViews activeKey={active ? "spec" : null}>
      <ProjectSpecifications project={project} stateStore={store} />
    </RetainedViews>
  );
  const f = render(view(true));
  await ready();
  click("Вложенный документ");
  await screen.findByRole("heading", { name: "API usage" });
  const before = api.readProjectSpecification.mock.calls.length;
  f.rerender(view(false));
  expect(screen.queryByRole("textbox")).toBeNull();
  f.rerender(view(true));
  await screen.findByRole("heading", { name: "API usage" });
  await waitFor(() =>
    expect(api.readProjectSpecification.mock.calls.length).toBeGreaterThan(
      before,
    ),
  );
  expect(api.readProjectSpecification).toHaveBeenLastCalledWith(
    "p",
    "api/usage.md",
  );
});
it("rereads catalog and selected file through the existing global project refresh", async () => {
  const documents = createSettingsDocuments();
  render(
    <ProjectDocuments
      project={project}
      tab="specifications"
      store={documents}
    />,
  );
  await ready();
  api.readProjectSpecification.mockResolvedValueOnce({
    path: "README.md",
    exists: true,
    text: "# Changed on disk",
  });
  await act(async () => {
    await documents.refreshProject("p");
  });
  await screen.findByRole("heading", { name: "Changed on disk" });
  expect(api.listProjectSpecifications).toHaveBeenCalledTimes(2);
  expect(api.readProjectSpecification).toHaveBeenCalledTimes(2);
});
it("marks retained text as not refreshed when catalog refresh fails and recovers", async () => {
  render(<ProjectSpecifications project={project} />);
  await ready();
  api.listProjectSpecifications.mockRejectedValueOnce(
    Error("Disk unavailable"),
  );
  click("Обновить спецификации");
  await screen.findByRole("alert");
  expect(screen.getByText(/Спецификации не обновлены/)).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Спецификации" })).toBeTruthy();
  click("Повторить загрузку");
  await waitFor(() =>
    expect(api.listProjectSpecifications).toHaveBeenCalledTimes(3),
  );
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});
it("preserves prior text on file refresh failure with an explicit warning", async () => {
  render(<ProjectSpecifications project={project} />);
  await ready();
  api.readProjectSpecification.mockRejectedValueOnce(Error("File busy"));
  click("Обновить спецификации");
  await screen.findByRole("alert");
  expect(screen.getByText(/Документ не обновлён/)).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Спецификации" })).toBeTruthy();
  click("Повторить загрузку");
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});
it("rejects mismatched document path instead of displaying it under the selected name", async () => {
  api.readProjectSpecification.mockResolvedValueOnce({
    path: "wrong.md",
    exists: true,
    text: "# Wrong owner",
  });
  render(<ProjectSpecifications project={project} />);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "другой спецификации",
  );
  expect(screen.queryByText("Wrong owner")).toBeNull();
});
it("recovers a failed primary context by selecting a valid topic automatically", async () => {
  api.listProjectSpecifications.mockRejectedValueOnce(Error("Primary failed"));
  const f = render(<ProjectSpecifications project={project} />);
  await screen.findByRole("alert");
  f.rerender(<ProjectSpecifications project={project} owner={owner} />);
  await ready();
  expect(screen.queryByText("Primary failed")).toBeNull();
});
it("records tree scroll separately and supports folder keyboard controls", async () => {
  const state = createSpecificationsState();
  render(<ProjectSpecifications project={project} stateStore={state} />);
  await ready();
  const region = screen.getByRole("region", { name: "Дерево спецификаций" });
  region.scrollTop = 77;
  region.scrollLeft = 21;
  fireEvent.scroll(region);
  expect(state.get("p").treePositions.get("tree")).toEqual({
    top: 77,
    left: 21,
  });
  const folder = screen.getByRole("treeitem", { name: "Папка api" });
  fireEvent.keyDown(folder, { key: "ArrowLeft" });
  expect(folder.getAttribute("aria-expanded")).toBe("false");
  fireEvent.keyDown(folder, { key: "ArrowRight" });
  expect(folder.getAttribute("aria-expanded")).toBe("true");
  click("Свернуть все папки");
  expect(
    screen.queryByRole("treeitem", { name: "Файл api/usage.md" }),
  ).toBeNull();
  click("Раскрыть все папки");
  expect(
    screen.getByRole("treeitem", { name: "Файл api/usage.md" }),
  ).toBeTruthy();
});

it("keeps the Specifications subtab when an exact owner remounts ProjectSettings", async () => {
  const { ProjectSettings } = await import("../src/renderer/ProjectSettings");
  Object.assign(api, {
    readProjectSettings: vi.fn(async () => ({
      value: { executable: "goga", profile: "", env: [] },
      version: "v1",
      profiles: [],
    })),
  });
  const store = createSpecificationsState();
  function Fixture({ context }: { context?: typeof owner }) {
    const [tab, setTab] = React.useState("launch");
    return (
      <ProjectSettings
        key={context?.revision ?? "source"}
        project={project}
        owner={context}
        selectedTab={tab}
        onTabChange={setTab}
        specificationsState={store}
        onBack={() => {}}
        onSaved={() => {}}
        guard={{ current: null }}
        onBusy={() => {}}
      />
    );
  }
  const f = render(<Fixture />);
  click("Спецификации");
  await ready();
  f.rerender(<Fixture context={owner} />);
  await ready();
  expect(api.readProjectSpecification).toHaveBeenLastCalledWith(
    owner,
    "README.md",
  );
  expect(
    screen
      .getByRole("button", { name: "Спецификации" })
      .getAttribute("aria-current"),
  ).toBe("page");
});

it("keeps known documents navigable after a background catalog failure", async () => {
  render(<ProjectSpecifications project={project} />);
  await ready();
  api.listProjectSpecifications.mockRejectedValueOnce(
    Error("Catalog unavailable"),
  );
  click("Обновить спецификации");
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("treeitem", { name: "Файл blank.md" }));
  await screen.findByText("Файл пуст");
  expect(api.readProjectSpecification).toHaveBeenLastCalledWith(
    "p",
    "blank.md",
  );
  expect(screen.getByText(/Спецификации не обновлены/)).toBeTruthy();
});

it("cancels an unsettled retained read on leaving and ignores its late result", async () => {
  const slow = deferred<any>();
  api.readProjectSpecification.mockImplementationOnce(() => slow.promise);
  const cancelRead = vi.fn(async () => {});
  Object.assign(api, { cancelRead });
  const view = (active: boolean) => (
    <RetainedViews activeKey={active ? "spec" : null}>
      <ProjectSpecifications project={project} />
    </RetainedViews>
  );
  const f = render(view(true));
  await waitFor(() =>
    expect(api.readProjectSpecification).toHaveBeenCalledTimes(1),
  );
  f.rerender(view(false));
  await waitFor(() => expect(cancelRead).toHaveBeenCalled());
  f.rerender(view(true));
  await ready();
  await act(async () =>
    slow.resolve({
      path: "README.md",
      exists: true,
      text: "# Late after cancellation",
    }),
  );
  expect(screen.queryByText("Late after cancellation")).toBeNull();
});

it("restores numerical document scroll through a revision remount", async () => {
  const state = createSpecificationsState();
  const f = render(
    <ProjectSpecifications
      key="r1"
      project={project}
      owner={owner}
      stateStore={state}
    />,
  );
  await ready();
  const reader = screen.getByRole("region", { name: "Содержимое артефакта" });
  fireEvent.wheel(reader, { deltaY: 400 });
  reader.scrollTop = 388;
  fireEvent.scroll(reader);
  expect([...state.get(owner).documentPositions.values()]).toContainEqual({
    top: 388,
    left: 0,
  });
  f.rerender(
    <ProjectSpecifications
      key="r2"
      project={project}
      owner={{ ...owner, revision: "new-revision" }}
      stateStore={state}
    />,
  );
  await ready();
  await waitFor(() =>
    expect(
      screen.getByRole("region", { name: "Содержимое артефакта" }).scrollTop,
    ).toBe(388),
  );
});

it("retains manual folder expansion independently of initially collapsed projects and topics", async () => {
  const store = createSpecificationsState();
  const view = (key: string, target = project, topic?: typeof owner) => (
    <ProjectSpecifications
      key={key}
      project={target}
      owner={topic}
      stateStore={store}
    />
  );
  const f = render(view("source"));
  await ready();
  const expanded = (name: string) =>
    screen
      .getByRole("treeitem", { name: `Папка ${name}` })
      .getAttribute("aria-expanded");
  expect(expanded("api")).toBe("false");
  fireEvent.click(screen.getByRole("treeitem", { name: "Папка api" }));
  expect(expanded("api")).toBe("true");
  f.rerender(view("topic", project, owner));
  await ready();
  expect(expanded("api")).toBe("false");
  fireEvent.click(screen.getByRole("treeitem", { name: "Папка other" }));
  expect(expanded("other")).toBe("true");
  f.rerender(view("other-project", { ...project, id: "q" }));
  await ready();
  expect(expanded("api")).toBe("false");
  expect(expanded("other")).toBe("false");
  f.rerender(view("return-source"));
  await ready();
  expect(expanded("api")).toBe("true");
  expect(expanded("other")).toBe("false");
  f.rerender(view("return-topic", project, owner));
  await ready();
  expect(expanded("api")).toBe("false");
  expect(expanded("other")).toBe("true");
});

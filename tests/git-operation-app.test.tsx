import "./helpers/overview-browser-fixture";
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
import { openFirstProject } from "./helpers/open-first-project";
import { App } from "../src/renderer/App";
import { useTopicRepository } from "../src/renderer/topic-repository";
import { documentScopeId } from "../src/renderer/settings-documents";
import type { ScopeRef } from "../src/shared/context";

const fixture = vi.hoisted(() => ({
  props: new Map<string, any>(),
  realWorkspace: false,
  refresh: vi.fn(async (_scope: unknown) => {}),
}));
vi.mock("../src/renderer/GitWorkspace", async (importOriginal) => {
  const { GitWorkspace } =
    await importOriginal<typeof import("../src/renderer/GitWorkspace")>();
  return {
    GitWorkspace: (props: any) => {
      fixture.props.set(
        typeof props.scope === "string" ? props.scope : props.scope.contextId,
        props,
      );
      return fixture.realWorkspace ? (
        <GitWorkspace {...props} />
      ) : (
        <span data-testid="git-revision">{props.revision}</span>
      );
    },
  };
});
vi.mock("../src/renderer/ProjectSettings", () => ({
  ProjectSettings: () => <div>Fixture settings</div>,
  ProjectSettingsConfirmation: () => null,
}));
vi.mock("../src/renderer/TerminalWorkspace", () => ({
  TerminalWorkspace: ({ obscured }: any) => (
    <div data-testid="terminal-obscured">{String(obscured)}</div>
  ),
}));
vi.mock("../src/renderer/RepositoryActions", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/renderer/RepositoryActions")
  >()),
  RepositoryActions: ({ disabled }: any) => (
    <button disabled={disabled}>Fixture repository action</button>
  ),
}));
vi.mock("../src/renderer/settings-documents", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/renderer/settings-documents")>();
  return {
    ...original,
    createSettingsDocuments: () => ({
      ...original.createSettingsDocuments(),
      refreshProject: fixture.refresh,
    }),
  };
});
const topic: Exclude<ScopeRef, string> = {
  projectId: "p",
  year: "2026",
  topic: "feature",
  branch: "feature",
  contextId: "ctx-" + "c".repeat(64),
  revision: "00000000-0000-4000-8000-000000000001",
};
let api: any;
beforeEach(() => {
  fixture.props.clear();
  fixture.realWorkspace = false;
  fixture.refresh.mockClear();
  localStorage.clear();
  api = {
    terminal: {},
    listProjects: vi.fn(async () => [
      { id: "p", name: "Alpha", path: "/fixture/p" },
      { id: "q", name: "Beta", path: "/fixture/q" },
    ]),
    runs: vi.fn(async () => []),
    selectRun: vi.fn(async () => {}),
    onRuns: () => () => {},
    onFocusRun: () => () => {},
    onViewError: () => () => {},
    readGitWorkspace: vi.fn(),
  };
  window.goga = api;
});
afterEach(cleanup);
async function open() {
  render(<App />);
  await openFirstProject();
  fireEvent.click(await screen.findByRole("button", { name: "Проект" }));
  await screen.findByText("Fixture settings");
}
function repositoryDisabled() {
  return (
    screen.getByRole("button", {
      name: "Fixture repository action",
    }) as HTMLButtonElement
  ).disabled;
}

it("keeps project actions busy until every retained context has finished", async () => {
  await open();
  const primary = documentScopeId("p"),
    clone = documentScopeId(topic);
  act(() => fixture.props.get("p").onBranchBusyChange("p", true, primary));
  expect(repositoryDisabled()).toBe(true);
  act(() => fixture.props.get("p").onBranchBusyChange("p", false, clone));
  expect(repositoryDisabled()).toBe(true);
  act(() => fixture.props.get("p").onBranchBusyChange("p", true, clone));
  act(() => fixture.props.get("p").onBranchBusyChange("p", false, primary));
  expect(repositoryDisabled()).toBe(true);
  act(() => fixture.props.get("p").onBranchBusyChange("p", false, clone));
  expect(repositoryDisabled()).toBe(false);
});
it("an inactive context cleanup cannot expose native content below another modal", async () => {
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Терминал" }));
  const primary = documentScopeId("p"),
    clone = documentScopeId(topic);
  act(() => fixture.props.get("p").onOverlayChange("p", true, primary));
  expect(screen.getByTestId("terminal-obscured").textContent).toBe("true");
  act(() => fixture.props.get("p").onOverlayChange("p", false, clone));
  expect(screen.getByTestId("terminal-obscured").textContent).toBe("true");
  act(() => fixture.props.get("p").onOverlayChange("p", false, primary));
  expect(screen.getByTestId("terminal-obscured").textContent).toBe("false");
});
it("refreshes the exact clone documents, without invalidating the primary Git view", async () => {
  await open();
  const revision = fixture.props.get("p").revision;
  await act(async () => fixture.props.get("p").onChanged("p", topic));
  expect(fixture.refresh).toHaveBeenCalledExactlyOnceWith(topic);
  expect(fixture.props.get("p").revision).toBe(revision);
});
it("a late result refreshes the issuing scope, not the newly active project", async () => {
  await open();
  const changed = fixture.props.get("p").onChanged;
  fireEvent.click(screen.getByRole("button", { name: "Beta" }));
  fireEvent.click(screen.getByRole("button", { name: "Проект" }));
  await screen.findByText("Fixture settings");
  const revision = fixture.props.get("q").revision;
  await act(async () => changed("p", topic));
  expect(fixture.refresh).toHaveBeenCalledExactlyOnceWith(topic);
  expect(fixture.props.get("q").revision).toBe(revision);
});
it("keeps primary callers compatible and rejects a mismatched project/scope notification", async () => {
  await open();
  await act(async () => fixture.props.get("p").onChanged("q", topic));
  expect(fixture.refresh).not.toHaveBeenCalled();
  const revision = fixture.props.get("p").revision;
  await act(async () => fixture.props.get("p").onChanged("p"));
  expect(fixture.refresh).toHaveBeenCalledExactlyOnceWith("p");
  expect(fixture.props.get("p").revision).toBe(revision + 1);
});
it("keeps catalog failures after a primary Git operation local to topic selection", async () => {
  api.readTopicCatalog = vi.fn(async (projectId: string, year: string) => ({
    projectId,
    year,
    entries: [],
    currentTopic: null,
  }));
  await open();
  expect(screen.getByRole("button", { name: "Без топика" })).toBeTruthy();
  api.readTopicCatalog.mockRejectedValue(
    new Error("Catalog changed during merge"),
  );
  await act(async () => fixture.props.get("p").onChanged("p"));
  expect(screen.queryByText("Catalog changed during merge")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Повторить загрузку топиков" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Выбрать другой топик" }));
  expect(await screen.findByText("Catalog changed during merge")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Повторить загрузку топиков" }),
  ).toBeTruthy();
});

it("refreshes only Git references without reloading topic contexts or project documents", async () => {
  api.ensureTopicContext = vi.fn();
  api.listTopicContexts = vi.fn(async () => []);
  await open();
  await waitFor(() => expect(fixture.props.get("p").disabled).toBe(false));
  const revision = fixture.props.get("p").revision;
  await act(async () =>
    fixture.props.get("p").onChanged("p", "p", "references-only"),
  );
  expect(fixture.props.get("p").revision).toBe(revision + 1);
  expect(api.listTopicContexts).toHaveBeenCalledTimes(1);
  expect(fixture.refresh).not.toHaveBeenCalled();
  expect(fixture.props.get("p").disabled).toBe(false);
});

it.each(["success", "error"])(
  "keeps the real branch popup open after fetch %s through App invalidation",
  async (status) => {
    fixture.realWorkspace = true;
    const oid = "b".repeat(40),
      revision = "a".repeat(64);
    const row = (name: string, remote = false) => ({
      name,
      ref: `${remote ? "refs/remotes/" : "refs/heads/"}${name}`,
      oid,
      checkedOut: false,
      upstream: null,
    });
    let inventory = {
      projectId: "p",
      root: "/fixture/p",
      revision,
      head: oid,
      branch: "main",
      upstream: null,
      operation: "none",
      dirty: false,
      local: [row("main"), row("feature")],
      remote: [row("origin/main", true)],
    };
    let release!: (value: any) => void;
    api.ensureTopicContext = vi.fn();
    api.listTopicContexts = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockImplementation(() => new Promise(() => {}));
    api.readGitSummary = vi.fn(async () => ({
      scope: "p",
      branch: "main",
      changedFiles: 0,
      conflicts: 0,
    }));
    api.readGitBranches = vi.fn(async () => inventory);
    api.prepareGitBranch = vi.fn(async () => ({
      projectId: "p",
      action: "fetch",
      remote: "origin",
      token: "c".repeat(64),
    }));
    api.executeGitBranch = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Ветка: main" }));
    await screen.findByRole("button", { name: "feature" });
    fireEvent.click(screen.getByRole("tab", { name: "Удалённые" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Найти ветку" }), {
      target: { value: "fresh" },
    });
    const popup = screen.getByRole("dialog", { name: "Выбор ветки" });
    fireEvent.click(screen.getByRole("button", { name: "Обновить из origin" }));
    await waitFor(() => expect(api.executeGitBranch).toHaveBeenCalledOnce());
    expect(screen.getByRole("dialog", { name: "Выбор ветки" })).toBe(popup);
    inventory = {
      ...inventory,
      remote: [...inventory.remote, row("origin/fresh", true)],
    };
    await act(async () =>
      release({
        projectId: "p",
        action: "fetch",
        status,
        changed: status === "success",
        message: status === "success" ? "Готово" : "Сеть недоступна",
        log: "",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Выбор ветки" })).toBe(popup),
    );
    expect(
      screen.getByRole("searchbox", { name: "Найти ветку" }),
    ).toHaveProperty("value", "fresh");
    expect(
      screen
        .getByRole("tab", { name: "Удалённые" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("button", { name: "origin/fresh" })).toBeTruthy();
    expect(api.listTopicContexts).toHaveBeenCalledTimes(1);
    expect(fixture.refresh).not.toHaveBeenCalled();
    if (status === "error")
      expect(screen.getByRole("alert").textContent).toContain(
        "Сеть недоступна",
      );
    else expect(screen.getByText("Список веток обновлён.")).toBeTruthy();
  },
);

it("disables header Git actions for a plain folder, without affecting another project", async () => {
  fixture.realWorkspace = true;
  api.readGitSummary = vi.fn(async (scope: string) => ({
    scope,
    branch: scope === "p" ? null : "main",
    changedFiles: 0,
    conflicts: 0,
    ...(scope === "p" ? { repository: "missing" } : {}),
  }));
  await open();
  await screen.findByText("Git не инициализирован");
  expect(repositoryDisabled()).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Beta" }));
  await screen.findByLabelText("Ветка: main");
  expect(repositoryDisabled()).toBe(false);
});
it("keeps missing-Git indicators scoped to their exact owner", async () => {
  await open();
  act(() => fixture.props.get("p").onRepositoryStateChange(topic, "missing"));
  expect(repositoryDisabled()).toBe(false);
  act(() => fixture.props.get("p").onRepositoryStateChange("p", "missing"));
  expect(repositoryDisabled()).toBe(true);
  act(() => fixture.props.get("p").onRepositoryStateChange(topic, "ready"));
  expect(repositoryDisabled()).toBe(true);
  act(() => fixture.props.get("p").onRepositoryStateChange("p", "ready"));
  expect(repositoryDisabled()).toBe(false);
});

it("shows the same explanation in the picker and Topics for a plain folder, without loading topics", async () => {
  fixture.realWorkspace = true;
  let initialized = false;
  api.readGitSummary = vi.fn(async (scope: string) => ({
    scope,
    branch: scope === "p" && !initialized ? null : "main",
    changedFiles: 0,
    conflicts: 0,
    ...(scope === "p" && !initialized ? { repository: "missing" } : {}),
  }));
  api.readTopicCatalog = vi.fn(async (id: string, year: string) => ({
    projectId: id,
    year,
    entries: [],
    currentTopic: null,
  }));
  api.ensureTopicContext = vi.fn();
  api.listTopicContexts = vi.fn(async () => []);
  api.readTopicTable = vi
    .fn()
    .mockRejectedValue(Error("Настоящая ошибка каталога"));
  await open();
  await screen.findByText("Git не инициализирован");
  fireEvent.click(screen.getByRole("button", { name: "Топики" }));
  const page = await screen.findByRole("region", { name: "Топики проекта" });
  const title = "Топики доступны только в Git-репозитории";
  expect(await within(page).findByText(title)).toBeTruthy();
  expect(within(page).queryByRole("alert")).toBeNull();
  expect(within(page).queryByRole("button")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Выбрать другой топик" }));
  const picker = screen.getByRole("region", { name: "Выбор топика" });
  expect(within(picker).getByText(title)).toBeTruthy();
  expect(within(picker).queryByRole("combobox")).toBeNull();
  expect(within(picker).queryByRole("alert")).toBeNull();
  expect(within(picker).queryByText(/текущая ветка|Повторить/)).toBeNull();
  expect(api.readTopicCatalog).not.toHaveBeenCalled();
  expect(api.readTopicTable).not.toHaveBeenCalled();
  expect(api.listTopicContexts).not.toHaveBeenCalled();
  fireEvent.keyDown(picker, { key: "Escape" });
  expect(screen.queryByRole("region", { name: "Выбор топика" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Beta" }));
  await waitFor(() =>
    expect(api.readTopicCatalog).toHaveBeenCalledWith("q", expect.any(String)),
  );
  fireEvent.click(screen.getByRole("button", { name: "Топики" }));
  expect(await screen.findByText("Настоящая ошибка каталога")).toBeTruthy();
  expect(screen.queryByText(title)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
  await screen.findByText(title);
  initialized = true;
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  await waitFor(() =>
    expect(api.readTopicCatalog).toHaveBeenCalledWith("p", expect.any(String)),
  );
  expect(await screen.findByText("Настоящая ошибка каталога")).toBeTruthy();
  expect(screen.queryByText(title)).toBeNull();
});

it.each(["unborn", "failed"] as const)(
  "waits for the primary Git check; %s is not a missing repository",
  async (kind) => {
    fixture.realWorkspace = true;
    let resolve!: (value: unknown) => void, reject!: (reason: Error) => void;
    api.readGitSummary = vi.fn(
      () =>
        new Promise((ok, no) => {
          resolve = ok;
          reject = no;
        }),
    );
    api.readTopicCatalog = vi
      .fn()
      .mockRejectedValue(Error("Не удалось загрузить каталог"));
    api.readTopicTable = vi
      .fn()
      .mockRejectedValue(Error("Не удалось загрузить таблицу"));
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Топики" }));
    await screen.findByRole("status", { name: "Проверяем Git в проекте" });
    expect(api.readTopicCatalog).not.toHaveBeenCalled();
    expect(api.readTopicTable).not.toHaveBeenCalled();
    await act(async () => {
      if (kind === "unborn")
        resolve({ scope: "p", branch: null, changedFiles: 0, conflicts: 0 });
      else reject(Error("Нет доступа"));
    });
    await screen.findByText("Не удалось загрузить таблицу");
    fireEvent.click(
      screen.getByRole("button", { name: "Выбрать другой топик" }),
    );
    await screen.findByText("Не удалось загрузить каталог");
    expect(
      screen.queryByText("Топики доступны только в Git-репозитории"),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Повторить загрузку топиков" }),
    ).toBeTruthy();
  },
);

it("checks the original project even if its Git bar has no subscriber (a clone is visible)", async () => {
  let missing = true;
  api.readGitSummary = vi.fn(async (scope: string) => ({
    scope,
    branch: null,
    changedFiles: 0,
    conflicts: 0,
    ...(missing ? { repository: "missing" } : {}),
  }));
  function Probe() {
    return <span>{useTopicRepository("p")}</span>;
  }
  render(<Probe />);
  await screen.findByText("missing");
  expect(api.readGitSummary).toHaveBeenCalledExactlyOnceWith("p");
  missing = false;
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  await screen.findByText("available");
});

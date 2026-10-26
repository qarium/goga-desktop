// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { App } from "../src/renderer/App";
import { documentScopeId } from "../src/renderer/settings-documents";
import type { ScopeRef } from "../src/shared/context";

const fixture = vi.hoisted(() => ({
  props: new Map<string, any>(),
  refresh: vi.fn(async (_scope: unknown) => {}),
}));
vi.mock("../src/renderer/GitWorkspace", () => ({
  GitWorkspace: (props: any) => {
    fixture.props.set(
      typeof props.scope === "string" ? props.scope : props.scope.contextId,
      props,
    );
    return <span data-testid="git-revision">{props.revision}</span>;
  },
}));
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

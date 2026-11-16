// @vitest-environment jsdom
import "./helpers/overview-browser-fixture";
import React from "react";
import { it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  within,
  waitFor,
} from "@testing-library/react";
import { App } from "../src/renderer/App";
afterEach(() => {
  cleanup();
  localStorage.clear();
});
it("starts on Home without loading topics; visiting a project enables its reads and returning retains its context", async () => {
  const project = { id: "sample", name: "Synthetic", path: "/fixture/sample" };
  const catalog = vi.fn(async () => ({
    projectId: "sample",
    year: String(new Date().getFullYear()),
    entries: [],
    currentTopic: null,
  }));
  window.goga = {
    listProjects: async () => [project],
    runs: async () => [],
    onRuns: () => () => {},
    onFocusRun: () => () => {},
    onViewError: () => () => {},
    selectRun: async () => {},
    readTopicCatalog: catalog,
  } as any;
  render(<App />);
  const side = within(screen.getByRole("complementary"));
  const open = await side.findByRole("button", { name: "Synthetic" });
  expect(screen.queryByRole("heading", { name: "Главная" })).toBeTruthy();
  expect(catalog).not.toHaveBeenCalled();
  fireEvent.click(open);
  await screen.findByRole("heading", { name: "Synthetic" });
  await waitFor(() => expect(catalog).toHaveBeenCalledTimes(1));
  fireEvent.click(side.getByRole("button", { name: "Главная" }));
  await screen.findByRole("heading", { name: "Недавние проекты" });
  expect(catalog).toHaveBeenCalledTimes(1);
});

it("opens Changes for the recent card owner, never the previously selected run", async () => {
  const a = { id: "a", name: "Alpha", path: "/fixture/a" },
    b = { id: "b", name: "Beta", path: "/fixture/b" };
  const run = {
    id: "r-b",
    projectId: "b",
    pipeline: "compile beta",
    kind: "build",
    topic: "",
    branch: "main",
    status: "running",
    profile: null,
    workflow: null,
    startedAt: "2026-11-14T07:20:00.000Z",
    output: { text: "build", truncated: false },
  };
  const workspace = vi.fn(async (scope: string) => ({
    scope,
    root: "/fixture/" + scope,
    revision: "a".repeat(64),
    head: "b".repeat(40),
    branch: "main",
    upstream: null,
    ahead: 0,
    behind: 0,
    operation: "none",
    files: [],
  }));
  window.goga = {
    listProjects: async () => [a, b],
    runs: async () => [run],
    onRuns: () => () => {},
    onFocusRun: () => () => {},
    onViewError: () => () => {},
    selectRun: async () => {},
    readGitWorkspace: workspace,
    readGitSummary: async (scope: string) => ({
      scope,
      branch: "main",
      changedFiles: 0,
      conflicts: 0,
    }),
  } as any;
  render(<App />);
  const side = within(screen.getByRole("complementary"));
  fireEvent.click(await side.findByRole("button", { name: "Alpha" }));
  await screen.findByRole("heading", { name: "Alpha" });
  fireEvent.click(side.getByRole("button", { name: "Главная" }));
  fireEvent.click(await screen.findByRole("button", { name: "compile beta" }));
  await screen.findByRole("heading", { name: "Beta" });
  fireEvent.click(side.getByRole("button", { name: "Главная" }));
  const recent = within(
    screen.getByRole("region", { name: "Недавние проекты" }),
  );
  const tile = recent
    .getByRole("button", { name: /^Продолжить Alpha/ })
    .closest("article")!;
  fireEvent.click(
    await within(tile).findByRole("button", { name: /Открыть изменения/ }),
  );
  await screen.findByRole("region", { name: "Изменения Git" });
  expect(workspace).toHaveBeenLastCalledWith("a");
  expect(
    screen.queryByRole("tab", { selected: true, name: /compile beta/ }),
  ).toBeNull();
});

it("opens an explicitly attached observer under its own project, without treating it as a managed process",async()=>{
  const a={id:"a",name:"Alpha",path:"/test/a"}, b={id:"b",name:"Beta",path:"/test/b"};
  const row={id:"attached:test-id",name:"Editor from AFM",runId:"external-1",url:"http://localhost:55321",owner:{projectId:"b"}};
  let changed:((rows:any[])=>void)|undefined;
  const select=vi.fn(async()=>{}),refresh=vi.fn(async()=>{}),detach=vi.fn(async()=>{changed?.([])});
  const stop=vi.fn(),managedSelect=vi.fn(async()=>{});
  window.goga={listProjects:async()=>[a,b],runs:async()=>[],onRuns:()=>()=>{},onFocusRun:()=>()=>{},onViewError:()=>()=>{},
    selectRun:managedSelect,stopRun:stop,listAttachedDashboards:async()=>[row],onAttachedDashboards:(cb:any)=>{changed=cb;return ()=>{}},
    selectAttachedDashboard:select,refreshDashboard:refresh,detachDashboard:detach
  } as any;
  render(<App/>);
  const open=await screen.findByRole("button",{name:"Открыть панель Editor from AFM"});
  expect(within(open.closest("article")!).queryByText("Без топика")).toBeNull();
  fireEvent.click(open);await screen.findByRole("heading",{name:"Beta"});
  await waitFor(()=>expect(select).toHaveBeenCalledWith("b",row.id));
  expect(managedSelect).not.toHaveBeenCalledWith(row.id);
  expect(screen.queryByRole("button",{name:"Остановить"})).toBeNull();
  fireEvent.keyDown(window,{key:"F5"});
  await waitFor(()=>expect(refresh).toHaveBeenCalledWith(row.id,"b",false));
  const side=within(screen.getByRole("complementary"));
  fireEvent.click(side.getByRole("button",{name:"Alpha"}));await screen.findByRole("heading",{name:"Alpha"});
  expect(screen.queryByRole("tab",{name:/Editor from AFM/})).toBeNull();
  fireEvent.click(side.getByRole("button",{name:"Главная"}));
  fireEvent.click(await screen.findByRole("button",{name:"Отключить панель Editor from AFM"}));
  await waitFor(()=>expect(detach).toHaveBeenCalledWith("b",row.id));
  expect(stop).not.toHaveBeenCalled();
});

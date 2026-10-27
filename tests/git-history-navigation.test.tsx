// @vitest-environment jsdom
import React, { useEffect, useState } from "react";
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
import { GitHistory } from "../src/renderer/GitHistory";
import { GitWorkspace } from "../src/renderer/GitWorkspace";
import { RetainedViews } from "../src/renderer/RetainedViews";
import { App } from "../src/renderer/App";
import { useViewActive } from "../src/renderer/RetainedViews";
vi.mock("../src/renderer/ProjectSettings", () => ({
  ProjectSettings: ({ guard }: any) => {
    const [value, setValue] = useState("");
    const active = useViewActive();
    useEffect(() => {
      if (!active) return;
      const current = {
        dirty: !!value,
        busy: value === "busy",
        save: async () => true,
        discard: () => setValue(""),
      };
      guard.current = current;
      return () => {
        if (guard.current === current) guard.current = null;
      };
    }, [active, value, guard]);
    return (
      <input
        aria-label="Fixture draft"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
    );
  },
  ProjectSettingsConfirmation: () => null,
}));
vi.mock("../src/renderer/TerminalWorkspace", () => ({
  TerminalWorkspace: () => {
    const active = useViewActive();
    const [value, setValue] = useState("");
    return (
      <div data-active={active}>
        <input
          aria-label="Fixture terminal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
    );
  },
}));
let api: any;
beforeEach(() => {
  api = {
    terminal: {},
    listProjects: vi.fn(async () => [
      { id: "p", name: "Alpha", path: "/fixture/a" },
      { id: "q", name: "Beta", path: "/fixture/b" },
    ]),
    runs: vi.fn(async () => []),
    selectRun: vi.fn(async () => {}),
    onRuns: () => () => {},
    onFocusRun: () => () => {},
    onViewError: () => () => {},
    readGitWorkspace: vi.fn(async (scope: string) => ({
      scope,
      root: "/fixture/" + scope,
      revision: "a".repeat(64),
      head: "b".repeat(40),
      branch: "main-" + scope,
      upstream: null,
      ahead: 0,
      behind: 0,
      operation: "none",
      files: [
        {
          path: scope + ".txt",
          indexStatus: ".",
          worktreeStatus: "M",
          kind: "tracked",
          submodule: false,
        },
      ],
    })),
    readGitDiff: vi.fn(async (r: any) => ({
      ...r,
      staged: { kind: "empty", text: "" },
      unstaged: { kind: "patch", text: "+" + r.scope + " content" },
    })),
  };
  window.goga = api;
});
afterEach(cleanup);
const click = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));

const historyView = () =>
  within(screen.getByRole("region", { name: "История коммитов" }));
const oid = "a".repeat(40);
const commit = (scope: any) => ({
  oid,
  parents: [],
  subject: "Commit " + (typeof scope === "string" ? scope : scope.topic),
  author: "Fixture",
  authoredAt: "2026-10-27T12:00:00+03:00",
  committedAt: "2026-10-27T12:00:00+03:00",
  refs: [],
});
beforeEach(() => {
  Object.assign(api, {
    readGitHistory: vi.fn(async (r: any) => ({
      scope: r.scope,
      ref: r.ref,
      tip: oid,
      commits: [commit(r.scope)],
      nextOffset: null,
    })),
    readGitCommit: vi.fn(async (r: any) => ({
      ...r,
      commit: commit(r.scope),
      parent: null,
      message: "Fixture",
      files: [{ path: "history.txt", status: "A", additions: 1, deletions: 0 }],
      nextFileOffset: null,
    })),
    readGitCommitDiff: vi.fn(async (r: any) => ({
      ...r,
      parent: null,
      part: {
        kind: "patch",
        text:
          "+history " + (typeof r.scope === "string" ? r.scope : r.scope.topic),
      },
    })),
  });
});
it("embeds commits beside changes, preserving project draft, terminal, file and scroll across projects", async () => {
  render(<App />);
  await screen.findByLabelText("Fixture draft");
  click("Терминал");
  fireEvent.change(screen.getByLabelText("Fixture terminal"), {
    target: { value: "shell stays" },
  });
  click("Проект");
  fireEvent.change(screen.getByLabelText("Fixture draft"), {
    target: { value: "unsaved" },
  });
  click("Коммиты");
  await screen.findByRole("region", { name: "История коммитов" });
  expect(screen.queryByRole("tab", { name: "Коммиты" })).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: /Commit p/ }));
  click(
    await screen
      .findByRole("button", { name: /Файл history.txt/ })
      .then((b) => b.getAttribute("aria-label")!),
  );
  await screen.findByLabelText("Различия файла");
  const scroll = historyView().getByTestId("git-history-diff-scroll");
  scroll.scrollTop = 75;
  click(/^Изменения/);
  await screen.findByRole("region", { name: "Изменения Git" });
  click("Коммиты");
  expect(historyView().getByLabelText("Различия файла").textContent).toContain(
    "+history p",
  );
  expect(historyView().getByTestId("git-history-diff-scroll").scrollTop).toBe(
    75,
  );
  click("Beta");
  await screen.findByLabelText("Fixture draft");
  click("Коммиты");
  await screen.findByRole("button", { name: /Commit q/ });
  expect(historyView().queryByLabelText("Различия файла")).toBeNull();
  click("Alpha");
  await waitFor(() =>
    expect(
      historyView().getByLabelText("Различия файла").textContent,
    ).toContain("+history p"),
  );
  expect(historyView().getByTestId("git-history-diff-scroll").scrollTop).toBe(
    75,
  );
  expect(api.readGitHistory).toHaveBeenCalledTimes(2);
  expect(api.readGitCommitDiff).toHaveBeenCalledTimes(1);
  click("Закрыть историю коммитов");
  expect(
    (screen.getByLabelText("Fixture draft") as HTMLInputElement).value,
  ).toBe("unsaved");
  fireEvent.change(screen.getByLabelText("Fixture draft"), {
    target: { value: "" },
  });
  click("Терминал");
  expect(
    (screen.getByLabelText("Fixture terminal") as HTMLInputElement).value,
  ).toBe("shell stays");
});
it("keeps primary and topic histories separate and returns without reload", async () => {
  const topic = {
    projectId: "p",
    topic: "feature",
    branch: "feature",
    year: "2026",
    contextId: `ctx-${"b".repeat(64)}`,
    revision: "00000000-0000-4000-8000-000000000000",
  };
  function View() {
    const [scope, setScope] = useState<any>(topic);
    return (
      <>
        <button
          onClick={() => setScope(typeof scope === "string" ? topic : "p")}
        >
          Context
        </button>
        <RetainedViews
          activeKey={typeof scope === "string" ? "primary" : "topic"}
        >
          <GitHistory scope={scope} open revision={0} onClose={() => {}} />
        </RetainedViews>
      </>
    );
  }
  render(<View />);
  await screen.findByRole("button", { name: /Commit feature/ });
  fireEvent.click(screen.getByRole("button", { name: /Commit feature/ }));
  click(
    await screen
      .findByRole("button", { name: /Файл history.txt/ })
      .then((b) => b.getAttribute("aria-label")!),
  );
  await screen.findByLabelText("Различия файла");
  click("Context");
  await screen.findByRole("button", { name: /Commit p/ });
  expect(historyView().queryByLabelText("Различия файла")).toBeNull();
  click("Context");
  expect(historyView().getByLabelText("Различия файла").textContent).toContain(
    "+history feature",
  );
  expect(api.readGitHistory).toHaveBeenCalledTimes(2);
});

it("refreshes retained HEAD history on return after a successful commit", async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  api.prepareGitCommit = vi.fn(async (r: any) => ({
    ...r,
    token: "1".repeat(64),
    root: "/fixture/p",
    branch: "main",
    deletedCount: 0,
    author: "Fixture",
    committer: "Fixture",
    signing: false,
    hooks: "disabled",
    expiresAt: Date.now() + 300000,
  }));
  api.executeGitCommit = vi.fn(async () => ({
    scope: "p",
    status: "committed",
    commit: "c".repeat(40),
    indexPublished: true,
    message: "Коммит создан",
    log: "",
  }));
  const changed = vi.fn();
  function View() {
    const [stage, setStage] = useState<HTMLDivElement | null>(null);
    const [history, setHistory] = useState(true),
      [revision, setRevision] = useState(0);
    return (
      <>
        <div ref={setStage} />
        <GitWorkspace
          bodyContainer={stage}
          scope="p"
          open={!history}
          revision={revision}
          historyOpen={history}
          onHistoryOpen={() => setHistory(true)}
          onOpen={() => setHistory(false)}
          onClose={() => setHistory(true)}
          onChanged={(id, owner) => {
            changed(id, owner);
            setRevision((n) => n + 1);
          }}
        />
        <GitHistory
          scope="p"
          open={history}
          revision={revision}
          onClose={() => setHistory(false)}
        />
      </>
    );
  }
  render(<View />);
  await screen.findByRole("button", { name: /Commit p/ });
  click("Изменения");
  await screen.findByRole("checkbox", { name: "Выбрать файл: p.txt" });
  fireEvent.change(screen.getByRole("textbox", { name: "Сообщение коммита" }), {
    target: { value: "Fixture commit" },
  });
  click("Создать коммит…");
  fireEvent.click(
    await screen.findByRole("button", { name: "Создать локальный коммит" }),
  );
  await waitFor(() => expect(api.executeGitCommit).toHaveBeenCalledTimes(1));
  click("Коммиты");
  await waitFor(() => expect(api.readGitHistory).toHaveBeenCalledTimes(2));
  expect(changed).toHaveBeenCalledWith("p", "p");
  expect(api.readGitHistory).toHaveBeenCalledTimes(2);
});

it("updates the current HEAD history when the shared branch indicator observes an external switch", async () => {
  let branch = "main";
  api.readGitSummary = vi.fn(async (scope: string) => ({
    scope,
    branch,
    changedFiles: 0,
    conflicts: 0,
  }));
  api.readGitHistory.mockImplementation(async (r: any) => ({
    scope: r.scope,
    ref: r.ref,
    tip: oid,
    currentBranch: branch,
    commits: [{ ...commit(r.scope), subject: "History of " + branch }],
    nextOffset: null,
  }));
  render(<App />);
  await screen.findByLabelText("Fixture draft");
  await waitFor(() => expect(api.readGitSummary).toHaveBeenCalled());
  click("Коммиты");
  await screen.findByRole("button", { name: /History of main/ });
  branch = "next";
  fireEvent(window, new Event("focus"));
  await screen.findByRole("button", { name: /History of next/ });
  expect(
    historyView().queryByRole("button", { name: /History of main/ }),
  ).toBeNull();
  expect(api.readGitHistory).toHaveBeenLastCalledWith({
    scope: "p",
    ref: "HEAD",
    offset: 0,
  });
});

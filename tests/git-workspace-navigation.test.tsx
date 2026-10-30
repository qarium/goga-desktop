import "./helpers/overview-browser-fixture";
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
} from "@testing-library/react";
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
it("opens changes in place, does not add a main tab, and restores the exact project draft", async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Проект" }));
  fireEvent.change(await screen.findByLabelText("Fixture draft"), {
    target: { value: "not saved" },
  });
  expect(
    await screen.findByRole("button", { name: /^Изменения/ }),
  ).toBeTruthy();
  click(/^Изменения/);
  expect(
    await screen.findByRole("region", { name: "Изменения Git" }),
  ).toBeTruthy();
  expect(screen.queryByLabelText("Fixture draft")).toBeNull();
  expect(screen.queryByRole("tab", { name: /Git|Изменения/ })).toBeNull();
  click("Закрыть изменения");
  expect(
    (screen.getByLabelText("Fixture draft") as HTMLInputElement).value,
  ).toBe("not saved");
});
it("retains terminal screen and context-specific Git selection across projects", async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Проект" }));
  await screen.findByLabelText("Fixture draft");
  click("Терминал");
  fireEvent.change(screen.getByLabelText("Fixture terminal"), {
    target: { value: "shell screen" },
  });
  click(/^Изменения/);
  click(
    await screen
      .findByRole("button", { name: "p.txt" })
      .then((x) => x.getAttribute("aria-label")!),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Различия файла").textContent).toContain(
      "+p content",
    ),
  );
  click("Beta");
  click("Проект");
  await screen.findByLabelText("Fixture draft");
  click(/^Изменения/);
  click(
    await screen
      .findByRole("button", { name: "q.txt" })
      .then((x) => x.getAttribute("aria-label")!),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Различия файла").textContent).toContain(
      "+q content",
    ),
  );
  click("Alpha");
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "p.txt" })
        .getAttribute("aria-pressed"),
    ).toBe("true"),
  );
  expect(screen.queryByText("+q content")).toBeNull();
  click("Закрыть изменения");
  expect(
    (screen.getByLabelText("Fixture terminal") as HTMLInputElement).value,
  ).toBe("shell screen");
});
it("preserves busy navigation guards even for the read-only changes view", async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Проект" }));
  fireEvent.change(await screen.findByLabelText("Fixture draft"), {
    target: { value: "busy" },
  });
  click(/^Изменения/);
  expect(screen.queryByRole("region", { name: "Изменения Git" })).toBeNull();
  expect(
    (screen.getByLabelText("Fixture draft") as HTMLInputElement).value,
  ).toBe("busy");
});

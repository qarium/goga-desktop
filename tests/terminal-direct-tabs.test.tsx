// @vitest-environment jsdom
import React, { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TerminalTabs } from "../src/renderer/TerminalTabs";
afterEach(cleanup);
it("double click waits for its own pending selection before capturing rename revision", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    changes: any[] = [];
  function Fixture() {
    const [state, setState] = useState<any>({
      revision: "old",
      context: { kind: "primary", projectId: "p" },
      selectedId: "a",
      tabs: ["a", "b"].map((id) => ({
        id,
        name: id,
        projectId: "p",
        scope: { kind: "common" },
      })),
    });
    const [busy, setBusy] = useState(false);
    return (
      <TerminalTabs
        scope="p"
        state={state}
        busy={busy}
        locked={false}
        refreshDisabled={false}
        onError={() => {}}
        onClose={() => {}}
        onRefresh={() => {}}
        onChange={async (r) => {
          changes.push(r);
          if (r.kind === "select") {
            setBusy(true);
            await gate;
            setState((s: any) => ({
              ...s,
              revision: "selected",
              selectedId: r.tabId,
            }));
            setBusy(false);
          }
          return true;
        }}
      />
    );
  }
  render(<Fixture />);
  const tab = screen.getByRole("tab", { name: "b — Общий терминал" });
  fireEvent.click(tab);
  fireEvent.click(tab);
  fireEvent.doubleClick(tab);
  await act(async () => {
    release();
    await gate;
  });
  const input = await screen.findByRole("textbox", { name: "Имя терминала" });
  fireEvent.change(input, { target: { value: "renamed" } });
  fireEvent.submit(input.closest("form")!);
  await waitFor(() =>
    expect(changes).toContainEqual(
      expect.objectContaining({
        kind: "rename",
        tabId: "b",
        revision: "selected",
      }),
    ),
  );
  expect(changes.filter((r) => r.kind === "select")).toHaveLength(1);
});

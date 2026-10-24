// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LoadingBoundary } from "../src/renderer/LoadingBoundary";
import { ProjectDockerfile } from "../src/renderer/ProjectDockerfile";
import { createSettingsDocuments } from "../src/renderer/settings-documents";
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it.each([false, true])(
  "spinner has accessible label but no visible loading text (background=%s)",
  (background) => {
    const view = render(
      <LoadingBoundary pending background={background} label="Чтение">
        <input defaultValue="draft" />
      </LoadingBoundary>,
    );
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-label")).toBe("Чтение");
    expect(status.textContent).toBe("");
    expect(status.querySelector(".loading-spinner")).toBeTruthy();
    view.rerender(
      <LoadingBoundary pending={false} background={background} label="Чтение">
        <input defaultValue="draft" />
      </LoadingBoundary>,
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("textbox")).toBeTruthy();
  },
);
it("a terminal loading error takes precedence over an obsolete pending flag", () => {
  render(
    <LoadingBoundary pending error="Read failed" label="Чтение">
      <span />
    </LoadingBoundary>,
  );
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByRole("alert").textContent).toBe("Read failed");
});
it.each(["reject", "timeout"])(
  "Dockerfile settles spinner on %s",
  async (outcome) => {
    vi.useFakeTimers();
    let reject!: (e: Error) => void;
    window.goga = {
      resolveProjectDockerfile: vi.fn(
        () => new Promise((_, no) => (reject = no)),
      ),
    } as any;
    render(
      <ProjectDockerfile
        project={{ id: "p", name: "Fixture", path: "/fixture" }}
        store={createSettingsDocuments()}
      />,
    );
    expect(
      screen.getByRole("status").querySelector(".loading-spinner"),
    ).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("");
    await act(async () => {
      if (outcome === "reject") reject(Error("No config"));
      else await vi.advanceTimersByTimeAsync(30001);
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("alert")).toBeTruthy();
  },
);
it.each(["workflow", "pipeline", "profile"] as const)(
  "project %s catalog stops its spinner on the read deadline",
  async (kind) => {
    vi.useFakeTimers();
    const method =
      kind === "workflow"
        ? "listProjectWorkflows"
        : kind === "pipeline"
          ? "listProjectPipelines"
          : "listProjectProfiles";
    window.goga = { [method]: vi.fn(() => new Promise(() => {})) } as any;
    const { ProjectFlatDocuments } =
      await import("../src/renderer/ProjectFlatDocuments");
    render(
      <ProjectFlatDocuments
        kind={kind}
        project={{ id: "p", name: "Fixture", path: "/fixture" }}
        store={createSettingsDocuments()}
      />,
    );
    expect(
      screen.getByRole("status").querySelector(".loading-spinner"),
    ).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30001);
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Превышено время");
    expect(
      screen.getByRole("button", { name: "Повторить загрузку" }),
    ).toBeTruthy();
  },
);
it("project catalog uses the same blocking spinner on first open and return", async () => {
  const { ProjectFlatDocuments } =
    await import("../src/renderer/ProjectFlatDocuments");
  const { RetainedViews } = await import("../src/renderer/RetainedViews");
  let resolve!: (value: any) => void;
  window.goga = {
    listProjectPipelines: vi.fn(
      () =>
        new Promise((yes) => {
          resolve = yes;
        }),
    ),
  } as any;
  const store = createSettingsDocuments();
  const section = (
    <ProjectFlatDocuments
      kind="pipeline"
      project={{ id: "p", name: "Fixture", path: "/fixture" }}
      store={store}
    />
  );
  const view = render(
    <RetainedViews activeKey="pipeline">{section}</RetainedViews>,
  );
  const firstClass = screen.getByRole("status").className;
  await act(async () => resolve([]));
  view.rerender(
    <RetainedViews activeKey="other">
      <div>Other</div>
    </RetainedViews>,
  );
  view.rerender(<RetainedViews activeKey="pipeline">{section}</RetainedViews>);
  expect(screen.getByRole("status").className).toBe(firstClass);
  expect(document.querySelector(".loading-background")).toBeNull();
  expect(
    document.querySelector(".workflow-controls")?.closest("[hidden]"),
  ).toBeTruthy();
  await act(async () => resolve([]));
  expect(screen.queryByRole("status")).toBeNull();
});

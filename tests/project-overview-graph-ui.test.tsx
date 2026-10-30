// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
const mocks = vi.hoisted(() => ({
  nodes: [] as any[],
  flow: { fitView: vi.fn(async () => {}), zoomIn: vi.fn(), zoomOut: vi.fn() },
}));
vi.mock("@xyflow/react", () => ({
  ReactFlowProvider: ({ children }: any) => children,
  ReactFlow: ({ nodes }: any) => {
    mocks.nodes.push(nodes);
    return null;
  },
  Background: () => null,
  Handle: () => null,
  Position: { Left: "left", Right: "right" },
  MarkerType: { ArrowClosed: "arrowclosed" },
  useReactFlow: () => mocks.flow,
}));
import { SchemaGraph } from "../src/renderer/overview/SchemaGraph";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("does not discard React Flow node measurements when only parent callbacks change", () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const schema = [
    {
      cell: "src",
      description: "",
      types: [],
      usages: [],
      dependencies: {},
      children: [],
    },
  ];
  const first = vi.fn(),
    second = vi.fn(),
    onDrill = vi.fn();
  const view = render(
    <SchemaGraph
      schema={schema}
      scope="@project"
      selection={null}
      onDrill={onDrill}
      onContract={first}
    />,
  );
  const initial = mocks.nodes.at(-1);
  view.rerender(
    <SchemaGraph
      schema={schema}
      scope="@project"
      selection={null}
      onDrill={onDrill}
      onContract={second}
    />,
  );
  expect(mocks.nodes.at(-1)).toBe(initial);
  initial[0].data.onContract("src");
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledWith("src");
});

function resizingGraph() {
  let notify: () => void = () => {};
  let size = { width: 700, height: 300 };
  const bounds = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(() => ({
      ...size,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: size.width,
      bottom: size.height,
      toJSON() {},
    }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  mocks.flow.fitView.mockClear();
  const schema = [
    {
      cell: "src",
      description: "",
      types: [],
      usages: [],
      dependencies: {},
      children: [],
    },
  ];
  const props = {
    schema,
    scope: "@project",
    selection: null,
    onDrill: vi.fn(),
    onContract: vi.fn(),
  };
  const view = render(<SchemaGraph {...props} />);
  const settle = () =>
    act(async () => {
      await new Promise(requestAnimationFrame);
    });
  return {
    view,
    props,
    bounds,
    settle,
    resize: (width: number, height: number) => {
      size = { width, height };
      act(() => notify());
    },
  };
}
it("preserves the user's pan and zoom across a hidden collapse/restore without model changes", async () => {
  const graph = resizingGraph();
  try {
    await graph.settle();
    expect(mocks.flow.fitView).toHaveBeenCalledTimes(1);
    graph.resize(0, 0);
    await graph.settle();
    graph.resize(700, 300);
    await graph.settle();
    expect(mocks.flow.fitView).toHaveBeenCalledTimes(1);
    graph.resize(800, 400);
    await graph.settle();
    expect(mocks.flow.fitView).toHaveBeenCalledTimes(2);
  } finally {
    graph.bounds.mockRestore();
  }
});
it("defers fitting a changed graph while hidden and fits it once on restore", async () => {
  const graph = resizingGraph();
  try {
    await graph.settle();
    graph.resize(0, 0);
    await graph.settle();
    graph.view.rerender(
      <SchemaGraph
        {...graph.props}
        schema={[
          ...graph.props.schema,
          { ...graph.props.schema[0], cell: "test" },
        ]}
      />,
    );
    await graph.settle();
    expect(mocks.flow.fitView).toHaveBeenCalledTimes(1);
    graph.resize(700, 300);
    await graph.settle();
    expect(mocks.flow.fitView).toHaveBeenCalledTimes(2);
  } finally {
    graph.bounds.mockRestore();
  }
});

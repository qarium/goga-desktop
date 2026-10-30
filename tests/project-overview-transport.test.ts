// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createOverviewTransport } from "../src/renderer/overview/transport";
it("uses bounded read transport, cancels a previous contract and never cancels writes", async () => {
  const requests: any[] = [];
  const api = {
    readRequest: vi.fn(
      (id, method, args) =>
        new Promise((resolve) => requests.push({ id, method, args, resolve })),
    ),
    cancelRead: vi.fn(async () => {}),
    saveOverviewFile: vi.fn(async () => ({ text: "saved" })),
  } as any;
  const transport = createOverviewTransport(api);
  const first = transport.api
    .readOverviewContract("p", "a")
    .catch((e) => e.message);
  const second = transport.api.readOverviewContract("p", "b");
  await vi.waitFor(() => expect(requests.length).toBe(2));
  expect(api.cancelRead).toHaveBeenCalledWith(requests[0].id);
  requests[1].resolve({ B: {} });
  expect(await second).toEqual({ B: {} });
  expect(await first).toMatch(/отмен/);
  const save = transport.api.saveOverviewFile("p", "a", "x", "v");
  transport.dispose();
  expect(await save).toEqual({ text: "saved" });
  requests[0].resolve({ A: {} });
});

it("loads a large expanded tree without flooding the bounded transport", async () => {
  const React = await import("react");
  const { render, cleanup } = await import("@testing-library/react");
  const { FileTree } = await import("../src/renderer/overview/FileTree");
  const { ReadCoordinator } = await import("../src/shared/read-deadlines");
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const paths = Array.from({ length: 80 }, (_, i) => "dir-" + i);
  const reads = new ReadCoordinator(),
    failed: unknown[] = [];
  let completed = 0;
  const load = async (p: string) => {
    try {
      await reads.run(
        p,
        1000,
        () => new Promise((resolve) => setTimeout(resolve, 1)),
        () => {},
      );
    } catch (e) {
      failed.push(e);
    }
    completed++;
  };
  try {
    render(
      React.createElement(FileTree, {
        scope: "",
        directories: {
          "": {
            path: "",
            truncated: false,
            entries: paths.map((p) => ({
              path: p,
              name: p,
              kind: "directory" as const,
            })),
          },
        },
        expanded: paths,
        setExpanded: () => {},
        selection: null,
        onFile: () => {},
        onFolder: () => {},
        onContract: () => {},
        hasContract: () => false,
        load,
        dirty: [],
      }),
    );
    await vi.waitFor(() => expect(completed).toBe(80));
    expect(failed).toEqual([]);
  } finally {
    cleanup();
    vi.unstubAllGlobals();
  }
});

it("starts fresh scoped reads after disposal without reusing a cancelled schema result", async () => {
  const requests: any[] = [];
  const api = {
    readRequest: vi.fn(
      (id, method, args) =>
        new Promise((resolve, reject) =>
          requests.push({ id, method, args, resolve, reject }),
        ),
    ),
    cancelRead: vi.fn(async () => {}),
  } as any;
  const transport = createOverviewTransport(api);
  const scope = {
    projectId: "p",
    year: "2026",
    topic: "alpha",
    branch: "feature/alpha",
    contextId: `ctx-${"a".repeat(64)}`,
    revision: "00000000-0000-4000-8000-000000000001",
  };
  const old = transport.api.readOverviewSchema(scope).catch((e) => e.message);
  transport.dispose();
  const current = transport.api.readOverviewSchema(scope);
  expect(requests).toHaveLength(2);
  expect(api.cancelRead).toHaveBeenCalledWith(requests[0].id);
  expect(requests[1].args).toEqual([scope]);
  requests[1].resolve([]);
  expect(await current).toEqual([]);
  expect(await old).toMatch(/отменено/);
  requests[0].reject(Error("old schema failure"));
  await Promise.resolve();
  transport.dispose();
});

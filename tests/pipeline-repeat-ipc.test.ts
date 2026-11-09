import { expect, it, vi } from "vitest";
import { registerIPC } from "../src/main/ipc";
import { IPC_SCOPES } from "../src/shared/operation-scopes";
const event = {
  sender: { id: 1 },
  senderFrame: { url: "file:///app/index.html", parent: null },
};
it("exposes a run-scoped, trusted, ID-only repeat handler", async () => {
  const repeatPipeline = vi.fn(async (id: string) => ({
    id: "new",
    source: id,
  }));
  const handlers = new Map<string, Function>();
  registerIPC(
    {
      handle: (channel: string, fn: Function) => handlers.set(channel, fn),
    } as any,
    {
      service: { repeatPipeline },
      settings: {},
      window: { webContents: { id: 1 } },
      shellURL: "file:///app/index.html",
    } as any,
  );
  expect(IPC_SCOPES["repeat-pipeline"]).toBe("run");
  const handler = handlers.get("goga:repeat-pipeline")!;
  await expect(handler(event, "source")).resolves.toEqual({
    id: "new",
    source: "source",
  });
  expect(repeatPipeline).toHaveBeenCalledExactlyOnceWith("source");
  for (const bad of ["", {}, null, "x".repeat(300)])
    expect(() => handler(event, bad)).toThrow();
  expect(() => handler({ ...event, sender: { id: 9 } }, "source")).toThrow(
    /IPC/,
  );
  expect(() =>
    handler(
      { ...event, senderFrame: { ...event.senderFrame, parent: {} } },
      "source",
    ),
  ).toThrow(/IPC/);
  expect(repeatPipeline).toHaveBeenCalledTimes(1);
});
it("preload forwards only the source ID using the dedicated IPC channel", async () => {
  const invoke = vi.fn(async () => ({ id: "new" }));
  let bridge: any;
  vi.doMock("electron", () => ({
    contextBridge: {
      exposeInMainWorld: (_name: string, value: unknown) => {
        bridge = value;
      },
    },
    ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
  }));
  await import("../src/main/preload");
  expect(typeof bridge.repeatPipeline).toBe("function");
  await bridge.repeatPipeline("source");
  expect(invoke).toHaveBeenCalledWith("goga:repeat-pipeline", "source");
  vi.doUnmock("electron");
});

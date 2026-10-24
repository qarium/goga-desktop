import { expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  invoke: vi.fn(async () => {}),
  on: vi.fn(),
  removeListener: vi.fn(),
  expose: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcRenderer: fake,
  contextBridge: { exposeInMainWorld: fake.expose },
}));
it("bridges popup bounds, close and removable close notification", async () => {
  await import("../src/main/preload");
  const api = fake.expose.mock.calls[0][1];
  expect(typeof api.setTopicPopupBounds).toBe("function");
  const bounds = { x: 1, y: 2, width: 3, height: 4 };
  await api.setTopicPopupBounds("uuid", bounds);
  expect(fake.invoke).toHaveBeenLastCalledWith(
    "goga:set-topic-popup-bounds",
    "uuid",
    bounds,
  );
  await api.closeTopicPopup("uuid");
  expect(fake.invoke).toHaveBeenLastCalledWith(
    "goga:close-topic-popup",
    "uuid",
  );
  const listener = vi.fn();
  const unsubscribe = api.onTopicPopupClosed(listener);
  const [channel, callback] = fake.on.mock.calls.at(-1)!;
  expect(channel).toBe("goga:topic-popup-closed");
  callback({}, "uuid");
  expect(listener).toHaveBeenCalledExactlyOnceWith("uuid");
  unsubscribe();
  expect(fake.removeListener).toHaveBeenCalledExactlyOnceWith(
    channel,
    callback,
  );
});

it("exposes the primary lightweight catalog read without changing full board", async () => {
  vi.resetModules();
  await import("../src/main/preload");
  const api = fake.expose.mock.calls[0][1];
  expect(typeof api.readTopicCatalog).toBe("function");
  await api.readTopicCatalog("p", "2026");
  expect(fake.invoke).toHaveBeenLastCalledWith(
    "goga:read-topic-catalog",
    "p",
    "2026",
  );
  expect(typeof api.readTopicBoard).toBe("function");
});
it("exposes a lazy terminal bridge only in the main API, without spawning or connecting on load", async () => {
  vi.resetModules();
  fake.invoke.mockClear();
  await import("../src/main/preload");
  const api = fake.expose.mock.calls[0][1];
  expect(api.terminal).toBeDefined();
  expect(fake.invoke).not.toHaveBeenCalled();
  fake.invoke
    .mockResolvedValueOnce("00000000-0000-4000-8000-000000000001" as any)
    .mockResolvedValueOnce(null as any);
  await api.terminal.request({ kind: "hide" });
  expect(fake.invoke).toHaveBeenLastCalledWith("goga:terminal-request", {
    documentId: "00000000-0000-4000-8000-000000000001",
    request: { kind: "hide" },
  });
});

it("exposes separate display table and task-only overview reads", async () => {
  vi.resetModules();
  await import("../src/main/preload");
  const api = fake.expose.mock.calls[0][1];
  expect(typeof api.readTopicTable).toBe("function");
  expect(typeof api.readTopicOverview).toBe("function");
  await api.readTopicTable("p", "2026");
  expect(fake.invoke).toHaveBeenLastCalledWith("goga:read-topic-table", "p", "2026");
  const target = { topic: "topic", branch: "topic", remote: false };
  await api.readTopicOverview("p", "2026", target);
  expect(fake.invoke).toHaveBeenLastCalledWith("goga:read-topic-overview", "p", "2026", target);
});

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

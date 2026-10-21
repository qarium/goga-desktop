import { expect, it, vi } from "vitest";
import { registerIPC } from "../src/main/ipc";
const ID = "11111111-1111-4111-8111-111111111111";
const bounds = { x: 30, y: 100, width: 400, height: 300 };
function fixture() {
  const handlers = new Map<string, Function>();
  const topicPopup = { setBounds: vi.fn(), close: vi.fn() };
  registerIPC(
    { handle: (key: string, fn: Function) => handlers.set(key, fn) } as any,
    {
      service: {},
      settings: {},
      window: { webContents: { id: 1 } },
      shellURL: "file:///app/index.html",
      topicPopup,
    } as any,
  );
  const event = {
    sender: { id: 1 },
    senderFrame: { url: "file:///app/index.html", parent: null },
  };
  return { handlers, topicPopup, event };
}
it("registers bounded popup transport for verified shell only and no privileged popup IPC", () => {
  const { handlers, topicPopup, event } = fixture();
  expect(handlers.has("goga:set-topic-popup-bounds")).toBe(true);
  expect(handlers.has("goga:close-topic-popup")).toBe(true);
  handlers.get("goga:set-topic-popup-bounds")!(event, ID, bounds);
  handlers.get("goga:close-topic-popup")!(event, ID);
  expect(topicPopup.setBounds).toHaveBeenCalledExactlyOnceWith(ID, bounds);
  expect(topicPopup.close).toHaveBeenCalledExactlyOnceWith(ID);
  for (const [name, handler] of handlers) {
    expect(
      () =>
        handler(
          {
            ...event,
            sender: { id: 10 },
            senderFrame: { url: "about:blank", parent: null },
          },
          ID,
          bounds,
        ),
      name,
    ).toThrow("IPC");
  }
  expect(() =>
    handlers.get("goga:close-topic-popup")!(
      { ...event, senderFrame: { ...event.senderFrame, parent: {} } },
      ID,
    ),
  ).toThrow("IPC");
});
it("rejects invalid ids and bounds without coercion or unknown fields", () => {
  const { handlers, topicPopup, event } = fixture();
  expect(handlers.has("goga:set-topic-popup-bounds")).toBe(true);
  for (const id of ["x", `goga-topic-picker:${ID}`, null, 1])
    expect(() => handlers.get("goga:close-topic-popup")!(event, id)).toThrow();
  for (const bad of [
    null,
    {},
    { ...bounds, x: -1 },
    { ...bounds, width: 0 },
    { ...bounds, height: Infinity },
    { ...bounds, x: 0.1 },
    { ...bounds, y: "1" },
    { ...bounds, width: 100001 },
    { ...bounds, extra: 1 },
  ])
    expect(() =>
      handlers.get("goga:set-topic-popup-bounds")!(event, ID, bad),
    ).toThrow();
  expect(topicPopup.setBounds).not.toHaveBeenCalled();
  expect(topicPopup.close).not.toHaveBeenCalled();
});

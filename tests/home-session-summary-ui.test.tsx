// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  act,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionBuffer } from "../src/renderer/home/SessionBuffer";
import { createHomeSessions } from "../src/renderer/home/session-summary";
import { createSettingsDocuments } from "../src/renderer/settings-documents";
afterEach(cleanup);
it("opens existing text only on explicit access, read-only, without reading disk or writing even with the owner offline", () => {
  const proto = HTMLDialogElement.prototype;
  const previousShow = proto.showModal,
    previousClose = proto.close;
  proto.showModal = function () {
    this.open = true;
  };
  proto.close = function () {
    this.open = false;
  };
  try {
    const docs = createSettingsDocuments(),
      store = createHomeSessions();
    store.attachSettings(docs, [
      { id: "p", name: "example", path: "/fixture/example" },
    ]);
    docs.createPipeline("p", "demo", []);
    const src = {
      scope: "project",
      projectId: "p",
      target: { kind: "pipeline", name: "demo" },
    } as const;
    docs.edit(src, "unsaved draft");
    const { target } = store.getSnapshot()[0];
    if (target.kind !== "document") throw Error();
    const onClose = vi.fn();
    render(<SessionBuffer store={store} target={target} onClose={onClose} />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "unsaved draft",
    );
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).readOnly).toBe(
      true,
    );
    act(() => docs.edit(src, "changed"));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "changed",
    );
    expect(screen.queryByRole("button", { name: "Сохранить" })).toBeNull();
    act(() => docs.discard(src));
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть просмотр" }));
    expect(onClose).toHaveBeenCalledOnce();
  } finally {
    cleanup();
    proto.showModal = previousShow;
    proto.close = previousClose;
  }
});

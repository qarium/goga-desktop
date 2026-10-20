// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { undoDepth } from "@codemirror/commands";
import { SettingsDocument } from "../src/renderer/SettingsDocument";
import {
  createSettingsDocuments,
  type DocumentSource,
} from "../src/renderer/settings-documents";
const sources: DocumentSource[] = [
  { scope: "home", kind: "profile", name: "personal" },
  ...(["pipeline", "workflow", "profile"] as const).map((kind) => ({
    scope: "project" as const,
    projectId: "p",
    target: { kind, name: "sample" },
  })),
  {
    scope: "project",
    projectId: "p",
    target: { kind: "tool", tool: "review", path: "env/local.yml" },
  },
];
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
let api: any;
let store: ReturnType<typeof createSettingsDocuments>;
const editor = () => {
  const el = document
    .querySelector(".yaml-code-editor")
    ?.shadowRoot?.querySelector('[role="textbox"]');
  return el ? EditorView.findFromDOM(el as HTMLElement)! : null;
};
const documentValue = {
  text: "secret: saved\n",
  version: "a".repeat(64),
  exists: true,
  relativePath: ".goga/test.yml",
};
const ticket = {
  token: "ticket",
  name: "sample.yml",
  relativePath: ".goga/test.yml",
};
const mount = (source = sources[0]) =>
  render(
    <SettingsDocument
      store={store}
      source={source}
      path=".goga/test.yml"
      title="Document"
      description="Description"
    />,
  );
async function prepare() {
  fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
  await screen.findByRole("dialog");
}
async function confirm() {
  fireEvent.click(
    screen.getByRole("button", { name: "Переместить в корзину" }),
  );
  await waitFor(() => expect(api.deleteDocument).toHaveBeenCalled());
}
beforeEach(() => {
  store = createSettingsDocuments();
  api = {
    readSettings: vi.fn(async () => documentValue),
    readProjectDocument: vi.fn(async () => documentValue),
    saveSettings: vi.fn(async () => documentValue),
    saveProjectDocument: vi.fn(async () => documentValue),
    prepareDocumentDeletion: vi.fn(async () => ticket),
    deleteDocument: vi.fn(async () => ({ status: "trashed" })),
  };
  window.goga = api;
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(cleanup);
describe.each(sources.map((source, i) => ({ source, label: String(i) })))(
  "shared deletion $label",
  ({ source }) => {
    it("places one destructive action beside reveal inside the privacy card", () => {
      mount(source);
      const deletion = screen.getByRole("button", { name: "Удалить" });
      const reveal = screen.getByRole("button", { name: "Открыть редактор" });
      expect(deletion.closest(".privacy-note")).not.toBeNull();
      expect(deletion.parentElement).toBe(reveal.parentElement);
      expect(deletion.classList.contains("danger")).toBe(true);
      expect(screen.getAllByRole("button", { name: "Удалить" })).toHaveLength(
        1,
      );
    });
    it("places one destructive action in the bottom savebar apart from save", async () => {
      await store.open(source);
      mount(source);
      const deletion = screen.getByRole("button", { name: "Удалить" });
      const save = screen.getByRole("button", { name: "Сохранить" });
      expect(deletion.closest(".savebar")).not.toBeNull();
      expect(deletion.parentElement).not.toBe(save.parentElement);
      expect(deletion.classList.contains("danger")).toBe(true);
      expect(screen.getAllByRole("button", { name: "Удалить" })).toHaveLength(
        1,
      );
      expect(document.querySelector(".editor-pane > .form-actions")).toBeNull();
    });
    it("styles final confirmation destructive but keeps Cancel neutral and focused", async () => {
      mount(source);
      await prepare();
      expect(
        screen
          .getByRole("button", { name: "Переместить в корзину" })
          .classList.contains("danger"),
      ).toBe(true);
      const cancel = screen.getByRole("button", { name: "Отмена" });
      expect(cancel.classList.contains("danger")).toBe(false);
      expect(document.activeElement).toBe(cancel);
    });
    it("prepares hidden metadata without exposing contents, then cancels with focus", async () => {
      mount(source);
      await prepare();
      expect(api.prepareDocumentDeletion).toHaveBeenCalledWith(
        source,
        undefined,
      );
      expect(api.readSettings).not.toHaveBeenCalled();
      expect(api.readProjectDocument).not.toHaveBeenCalled();
      expect(api.deleteDocument).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Отмена" })).toBe(
        document.activeElement,
      );
      expect(screen.getByRole("dialog").textContent).toContain(
        ticket.relativePath,
      );
      fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(store.get(source).document).toBeUndefined();
    });
    it("warns about dirty text and passes only saved version; cancellation preserves editor and history", async () => {
      await store.open(source);
      mount(source);
      const view = editor()!;
      act(() => view.dispatch({ changes: { from: 0, insert: "# dirty\n" } }));
      const depth = undoDepth(view.state);
      await prepare();
      expect(api.prepareDocumentDeletion).toHaveBeenCalledWith(
        source,
        documentValue.version,
      );
      expect(screen.getByRole("dialog").textContent).toMatch(
        /Несохранённые изменения/,
      );
      expect(screen.getByRole("dialog").textContent).toMatch(/сохранённ/);
      expect(screen.getByRole("dialog").textContent).not.toContain(
        "secret: saved",
      );
      fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
      expect(editor()).toBe(view);
      expect(undoDepth(view.state)).toBe(depth);
    });
    it("removes only confirmed source after trash success", async () => {
      const other = sources.find((s) => s !== source)!;
      await store.open(source);
      await store.open(other);
      mount(source);
      await prepare();
      await confirm();
      await waitFor(() => expect(store.get(source).document).toBeUndefined());
      expect(store.get(other).document).toBeDefined();
      expect(
        source.scope === "project"
          ? store.projectRevision(source.projectId)
          : store.homeRevision(),
      ).toBeGreaterThan(0);
    });
  },
);
it.each(["not-trashed", "uncertain", "throw"])(
  "preserves text/editor/history on %s and invalidates catalog",
  async (status) => {
    const source = sources[1];
    await store.open(source);
    mount(source);
    const view = editor()!;
    act(() => view.dispatch({ changes: { from: 0, insert: "# retained\n" } }));
    const depth = undoDepth(view.state);
    api.deleteDocument.mockImplementation(async () => {
      if (status === "throw") throw Error("bridge failed");
      return { status, message: "Could not confirm" };
    });
    await prepare();
    await confirm();
    await screen.findByRole("alert");
    expect(editor()).toBe(view);
    expect(undoDepth(view.state)).toBe(depth);
    expect(store.get(source).text).toContain("retained");
    expect(store.projectRevision("p")).toBe(1);
  },
);
it("config has no destructive button", () => {
  const ui = mount({ scope: "home", kind: "config" });
  expect(screen.queryByRole("button", { name: /Удалить/ })).toBeNull();
  ui.rerender(
    <SettingsDocument
      store={store}
      source={{ scope: "project", projectId: "p", target: { kind: "config" } }}
      path="config"
      title="Config"
      description=""
    />,
  );
  expect(screen.queryByRole("button", { name: /Удалить/ })).toBeNull();
});
it.each(["profile", "pipeline", "workflow"] as const)(
  "memory-only %s survives hide and deletes without any host call",
  async (kind) => {
    const source: DocumentSource =
      kind === "profile"
        ? { scope: "home", kind, name: "new" }
        : { scope: "project", projectId: "p", target: { kind, name: "new" } };
    if (kind === "profile") store.createProfile("new");
    else if (kind === "pipeline") store.createPipeline("p", "new", []);
    else store.createWorkflow("p", "new", []);
    mount(source);
    fireEvent.click(
      screen.getByRole("button", { name: "Скрыть без сохранения" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Открыть редактор" }));
    await waitFor(() => expect(editor()).not.toBeNull());
    expect(api.readSettings).not.toHaveBeenCalled();
    expect(api.readProjectDocument).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Удалить черновик" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(dialog.querySelector("button[data-confirm-delete]")!);
    await waitFor(() => expect(store.get(source).document).toBeUndefined());
    expect(api.prepareDocumentDeletion).not.toHaveBeenCalled();
    expect(api.deleteDocument).not.toHaveBeenCalled();
  },
);
it("preparation locks edit/open/save and late ticket after source change is discarded", async () => {
  const pending = deferred<any>();
  api.prepareDocumentDeletion.mockReturnValue(pending.promise);
  const ui = mount(sources[0]);
  fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
  await act(async () => {
    await store.open(sources[0]);
    await store.save(sources[0]);
    store.edit(sources[0], "wrong");
  });
  expect(api.readSettings).not.toHaveBeenCalled();
  ui.rerender(
    <SettingsDocument
      store={store}
      source={sources[1]}
      path="new"
      title="New"
      description=""
    />,
  );
  await act(async () => pending.resolve(ticket));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(store.get(sources[0]).busy).toBe(false);
  expect(api.deleteDocument).not.toHaveBeenCalled();
});
it("actual delete locks navigation, ignores duplicate confirm and preserves new forced source", async () => {
  const pending = deferred<any>();
  api.deleteDocument.mockReturnValue(pending.promise);
  await store.open(sources[0]);
  await store.open(sources[1]);
  const ui = mount();
  await prepare();
  const button = screen.getByRole("button", { name: "Переместить в корзину" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(api.deleteDocument).toHaveBeenCalledTimes(1);
  expect(store.busy()).toBe(true);
  ui.rerender(
    <SettingsDocument
      store={store}
      source={sources[1]}
      path="new"
      title="New"
      description=""
    />,
  );
  await act(async () => pending.resolve({ status: "trashed" }));
  expect(store.get(sources[1]).document).toBeDefined();
  expect(store.get(sources[0]).document).toBeUndefined();
  expect(store.busy()).toBe(false);
});
it("preparation conflict preserves editor without catalog invalidation", async () => {
  await store.open(sources[0]);
  mount();
  const view = editor();
  api.prepareDocumentDeletion.mockRejectedValue(Error("Changed externally"));
  fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
  await screen.findByText("Changed externally");
  expect(editor()).toBe(view);
  expect(store.homeRevision()).toBe(0);
  expect(api.deleteDocument).not.toHaveBeenCalled();
});
it("pending reads and saves cannot prepare deletion", async () => {
  const pending = deferred<any>();
  api.readSettings.mockReturnValue(pending.promise);
  const opening = store.open(sources[0]);
  mount();
  expect(screen.queryByRole("button", { name: "Удалить" })).toBeNull();
  await store.prepareDeletion(sources[0]);
  expect(api.prepareDocumentDeletion).not.toHaveBeenCalled();
  await act(async () => {
    pending.resolve(documentValue);
    await opening;
  });
  const saving = deferred<any>();
  api.saveSettings.mockReturnValue(saving.promise);
  let operation: Promise<boolean>;
  act(() => {
    operation = store.save(sources[0]);
  });
  expect(
    screen.getByRole("button", { name: "Удалить" }).hasAttribute("disabled"),
  ).toBe(true);
  await act(async () => {
    saving.resolve(documentValue);
    await operation;
  });
  expect(api.prepareDocumentDeletion).not.toHaveBeenCalled();
});
it("Escape cancels consent, while committed deletion cannot be canceled", async () => {
  mount();
  await prepare();
  fireEvent(
    screen.getByRole("dialog"),
    new Event("cancel", { bubbles: true, cancelable: true }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.deleteDocument).not.toHaveBeenCalled();
  const pending = deferred<any>();
  api.deleteDocument.mockReturnValue(pending.promise);
  await prepare();
  clickConfirm();
  fireEvent(
    screen.getByRole("dialog"),
    new Event("cancel", { bubbles: true, cancelable: true }),
  );
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(store.busy()).toBe(true);
  await act(async () => pending.resolve({ status: "trashed" }));
});
function clickConfirm() {
  fireEvent.click(
    screen.getByRole("button", { name: "Переместить в корзину" }),
  );
}
it("editing invalidates the old ticket, including direct store confirmation", async () => {
  await store.open(sources[0]);
  mount();
  await prepare();
  const consent = store.get(sources[0]).deletion!;
  act(() => store.edit(sources[0], "new text"));
  expect(screen.queryByRole("dialog")).toBeNull();
  await act(async () => {
    expect(await store.delete(sources[0], consent)).toBe(false);
  });
  expect(api.deleteDocument).not.toHaveBeenCalled();
});
it("unmount invalidates pending metadata without losing loaded draft", async () => {
  await store.open(sources[0]);
  const pending = deferred<any>();
  api.prepareDocumentDeletion.mockReturnValue(pending.promise);
  const ui = mount();
  fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
  ui.unmount();
  await act(async () => pending.resolve(ticket));
  expect(store.get(sources[0]).deletion).toBeUndefined();
  expect(store.get(sources[0]).document).toBeDefined();
  expect(store.get(sources[0]).busy).toBe(false);
});
it("same filename in another project is not cleared by late committed deletion", async () => {
  const first: DocumentSource = {
    scope: "project",
    projectId: "p",
    target: { kind: "pipeline", name: "same" },
  };
  const second: DocumentSource = { ...first, projectId: "q" };
  await store.open(first);
  await store.open(second);
  store.updatePipeline("p", { selected: "same" });
  store.updatePipeline("q", { selected: "same" });
  const pending = deferred<any>();
  api.deleteDocument.mockReturnValue(pending.promise);
  const ui = mount(first);
  await prepare();
  clickConfirm();
  ui.rerender(
    <SettingsDocument
      store={store}
      source={second}
      path="q/same"
      title="Q"
      description=""
    />,
  );
  await act(async () => pending.resolve({ status: "trashed" }));
  expect(store.pipelineState("p").selected).toBe("");
  expect(store.pipelineState("q").selected).toBe("same");
  expect(store.get(second).document).toBeDefined();
});
it("saved memory draft becomes disk-backed, including after hiding", async () => {
  store.createProfile("new");
  const source: DocumentSource = {
    scope: "home",
    kind: "profile",
    name: "new",
  };
  await store.save(source);
  mount(source);
  fireEvent.click(
    screen.getByRole("button", { name: "Скрыть без сохранения" }),
  );
  await prepare();
  expect(api.prepareDocumentDeletion).toHaveBeenCalledWith(source, undefined);
  expect(screen.queryByRole("button", { name: "Удалить черновик" })).toBeNull();
});
it("loaded existing flat document is never mistaken for memory-only draft after hiding", async () => {
  await store.open(sources[1]);
  expect(store.pipelineState("p").drafts).toEqual(["sample"]);
  mount(sources[1]);
  fireEvent.click(
    screen.getByRole("button", { name: "Скрыть без сохранения" }),
  );
  await prepare();
  expect(api.prepareDocumentDeletion).toHaveBeenCalledWith(
    sources[1],
    undefined,
  );
});
it("stale canceled prepare cannot replace a newer confirmation for the same source", async () => {
  const old = deferred<any>();
  api.prepareDocumentDeletion
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce({ ...ticket, token: "new" });
  const ui = mount();
  fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
  ui.unmount();
  mount();
  await prepare();
  await act(async () => old.resolve({ ...ticket, token: "old" }));
  clickConfirm();
  await waitFor(() => expect(api.deleteDocument).toHaveBeenCalledWith("new"));
});

// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { SettingsDocument } from "../src/renderer/SettingsDocument";
import { RetainedViews } from "../src/renderer/RetainedViews";
import {
  createSettingsDocuments,
  type DocumentSource,
} from "../src/renderer/settings-documents";

const text = '\ufeff# exact 🙂\r\nunknown: "quoted"\nflag: true\r\n';
const documentValue = { text, version: "original-version", exists: true };
const targets = [
  { kind: "config" },
  { kind: "tool", tool: "review", path: "env/local.yml" },
  { kind: "profile", name: "sample" },
  { kind: "workflow", name: "sample" },
  { kind: "pipeline", name: "sample" },
  { kind: "dockerfile", path: ".goga/Dockerfile" },
] as const;
const project = (
  target: (typeof targets)[number] = targets[0],
): DocumentSource => ({ scope: "project", projectId: "p", target });
const owner = {
  projectId: "p",
  year: "2026",
  topic: "a",
  branch: "a",
  contextId: "ctx-" + "a".repeat(64),
  revision: "00000000-0000-4000-8000-000000000001",
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
let api: any;
let store: ReturnType<typeof createSettingsDocuments>;
const editor = () => {
  const el = document
    .querySelector(".yaml-code-editor")
    ?.shadowRoot?.querySelector('[role="textbox"]');
  return el ? EditorView.findFromDOM(el as HTMLElement)! : null;
};
const pane = (source: DocumentSource) => (
  <SettingsDocument
    store={store}
    source={source}
    title="Document"
    path="synthetic.yml"
    description="Description"
  />
);
const edit = () =>
  act(() =>
    editor()!.dispatch({ changes: { from: 0, insert: "# dirty\r\n" } }),
  );
async function ready() {
  await waitFor(() => expect(editor()).not.toBeNull());
  return editor()!;
}
beforeEach(() => {
  store = createSettingsDocuments();
  api = {
    readSettings: vi.fn(async () => documentValue),
    readProjectDocument: vi.fn(async () => documentValue),
    saveSettings: vi.fn(async () => documentValue),
    saveProjectDocument: vi.fn(async () => documentValue),
    prepareDocumentDeletion: vi.fn(async () => ({
      token: "ticket",
      name: "sample.yml",
      relativePath: ".goga/sample.yml",
    })),
    deleteDocument: vi.fn(async () => ({ status: "trashed" })),
  };
  window.goga = api;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(cleanup);
it.each(targets)(
  "automatically opens selected Project $kind exactly once without saving",
  async (target) => {
    const source = project(target);
    const ui = render(pane(source));
    const view = await ready();
    expect(view.state.doc.toString()).toBe(text);
    expect(api.readProjectDocument).toHaveBeenCalledExactlyOnceWith(
      "p",
      target,
    );
    expect(api.readSettings).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Открыть редактор" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Скрыть без сохранения" }),
    ).toBeNull();
    ui.rerender(pane({ ...source }));
    edit();
    expect(api.readProjectDocument).toHaveBeenCalledTimes(1);
    expect(api.saveProjectDocument).not.toHaveBeenCalled();
  },
);
it.each(["config", "profile"] as const)(
  "HOME %s remains private, manually revealed and manually hidden without automatic reread",
  async (kind) => {
    render(
      pane({
        scope: "home",
        kind,
        ...(kind === "profile" ? { name: "personal" } : {}),
      }),
    );
    await act(async () => {});
    expect(api.readSettings).not.toHaveBeenCalled();
    expect(api.readProjectDocument).not.toHaveBeenCalled();
    expect(editor()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Открыть редактор" }));
    await ready();
    fireEvent.click(
      screen.getByRole("button", { name: "Скрыть без сохранения" }),
    );
    await act(async () => {});
    expect(editor()).toBeNull();
    expect(api.readSettings).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Открыть редактор" }),
    ).toBeTruthy();
  },
);
it("preserves independent project editors and drafts across retained navigation without rereading", async () => {
  const a = project();
  const b = project(targets[1]);
  const tree = (active: string, source: DocumentSource) => (
    <RetainedViews activeKey={active === "document" ? "document" : null}>
      {pane(source)}
    </RetainedViews>
  );
  const ui = render(tree("document", a));
  await ready();
  ui.rerender(tree("away", a));
  // A retained owner can be updated while its ancestor is inactive.
  const nested = (active: string) => (
    <RetainedViews activeKey={active}>
      {active === "away" ? (
        <RetainedViews activeKey="document">{pane(b)}</RetainedViews>
      ) : (
        pane(a)
      )}
    </RetainedViews>
  );
  ui.rerender(nested("away"));
  await ready();
  const view = editor()!;
  edit();
  const reads = api.readProjectDocument.mock.calls.length;
  ui.rerender(nested("document"));
  await ready();
  ui.rerender(nested("away"));
  await ready();
  expect(editor()).toBe(view);
  expect(view.state.doc.toString()).toBe("# dirty\r\n" + text);
  expect(api.readProjectDocument).toHaveBeenCalledTimes(reads);
});
it("defers new project-source reads while an already retained pane is inactive", async () => {
  let select!: (source: DocumentSource) => void;
  function OwnedPane() {
    const [source, setSource] = React.useState(project());
    select = setSource;
    return pane(source);
  }
  const tree = (active: boolean) => (
    <RetainedViews activeKey={active ? "document" : null}>
      <OwnedPane />
    </RetainedViews>
  );
  const ui = render(tree(true));
  await ready();
  ui.rerender(tree(false));
  act(() => select(project(targets[1])));
  await act(async () => {});
  expect(api.readProjectDocument).toHaveBeenCalledTimes(1);
  ui.rerender(tree(true));
  await ready();
  expect(api.readProjectDocument).toHaveBeenCalledTimes(2);
  expect(api.readProjectDocument).toHaveBeenLastCalledWith("p", targets[1]);
});
it("isolates late reads by exact source, context and revision", async () => {
  const first = deferred<typeof documentValue>();
  api.readProjectDocument.mockReturnValueOnce(first.promise);
  const a: DocumentSource = { ...project(), context: owner } as DocumentSource;
  const revised = {
    ...owner,
    revision: "00000000-0000-4000-8000-000000000002",
  };
  const b: DocumentSource = {
    ...project(),
    context: revised,
  } as DocumentSource;
  const ui = render(pane(a));
  await waitFor(() =>
    expect(api.readProjectDocument).toHaveBeenCalledWith(owner, targets[0]),
  );
  ui.rerender(pane(b));
  const view = await ready();
  expect(api.readProjectDocument).toHaveBeenLastCalledWith(revised, targets[0]);
  edit();
  await act(async () =>
    first.resolve({ ...documentValue, text: "Late A\r\n" }),
  );
  expect(editor()).toBe(view);
  expect(view.state.doc.toString()).toBe("# dirty\r\n" + text);
  expect(store.get(a).text).toBe("Late A\r\n");
  expect(store.get(b).text).toBe("# dirty\r\n" + text);
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await waitFor(() =>
    expect(api.saveProjectDocument).toHaveBeenCalledWith(
      revised,
      targets[0],
      "# dirty\r\n" + text,
      "original-version",
    ),
  );
});
it("fails once without retry loops across renders/navigation/remount and retries only on explicit Retry", async () => {
  api.readProjectDocument.mockRejectedValueOnce(Error("Read denied"));
  const source = project();
  const tree = (active: boolean) => (
    <RetainedViews activeKey={active ? "document" : null}>
      {pane({ ...source })}
    </RetainedViews>
  );
  const ui = render(tree(true));
  expect((await screen.findByRole("alert")).textContent).toBe("Read denied");
  ui.rerender(tree(true));
  ui.rerender(tree(false));
  ui.rerender(tree(true));
  await act(async () => {});
  expect(api.readProjectDocument).toHaveBeenCalledTimes(1);
  ui.unmount();
  render(pane(source));
  await act(async () => {});
  expect(api.readProjectDocument).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку" }));
  await ready();
  expect(api.readProjectDocument).toHaveBeenCalledTimes(2);
});
it.each(targets)(
  "Project $kind Cancel resets locally, leaves editor open and retains original version for conflict detection",
  async (target) => {
    const source = project(target);
    render(pane(source));
    const view = await ready();
    edit();
    api.saveProjectDocument.mockRejectedValueOnce(
      Error("Файл изменился вне приложения"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await screen.findByRole("alert");
    const saveCount = api.saveProjectDocument.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Отменить изменения" }));
    expect(editor()).toBe(view);
    expect(view.state.doc.toString()).toBe(text);
    expect(store.get(source).document?.version).toBe("original-version");
    expect(api.readProjectDocument).toHaveBeenCalledTimes(1);
    expect(api.saveProjectDocument).toHaveBeenCalledTimes(saveCount);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(api.saveProjectDocument).toHaveBeenLastCalledWith(
        "p",
        target,
        text,
        "original-version",
      ),
    );
  },
);
it.each(targets.slice(1, 5))(
  "keeps Project $kind Delete separated in common bottom bar and never resurrects a trashed selection",
  async (target) => {
    const source = project(target);
    const ui = render(pane(source));
    await ready();
    const deletion = screen.getByRole("button", { name: "Удалить" });
    const cancel = screen.getByRole("button", { name: "Отменить изменения" });
    expect(deletion.closest(".savebar")).toBe(cancel.closest(".savebar"));
    expect(deletion.parentElement).not.toBe(cancel.parentElement);
    expect(document.querySelector(".editor-heading button")).toBeNull();
    fireEvent.click(deletion);
    await screen.findByRole("dialog");
    fireEvent.click(
      screen.getByRole("button", { name: "Переместить в корзину" }),
    );
    await waitFor(() => expect(store.get(source).document).toBeUndefined());
    ui.rerender(pane({ ...source }));
    await act(async () => {});
    expect(editor()).toBeNull();
    expect(api.readProjectDocument).toHaveBeenCalledTimes(1);
    expect(api.saveProjectDocument).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Открыть редактор" }),
    ).toBeNull();
  },
);
it.each(["not-trashed", "uncertain", "throw"])(
  "preserves Project source/draft on %s deletion without rereading",
  async (status) => {
    const source = project(targets[2]);
    render(pane(source));
    const view = await ready();
    edit();
    api.deleteDocument.mockImplementation(async () => {
      if (status === "throw") throw Error("Bridge failed");
      return { status, message: "Deletion not confirmed" };
    });
    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    await screen.findByRole("dialog");
    fireEvent.click(
      screen.getByRole("button", { name: "Переместить в корзину" }),
    );
    await screen.findByRole("alert");
    expect(editor()).toBe(view);
    expect(view.state.doc.toString()).toBe("# dirty\r\n" + text);
    expect(store.get(source).document?.version).toBe("original-version");
    expect(api.readProjectDocument).toHaveBeenCalledTimes(1);
  },
);
it("does not auto-read a source removed while its retained selection was inactive", async () => {
  let select!: (source: DocumentSource) => void;
  function OwnedPane() {
    const [source, setSource] = React.useState(project());
    select = setSource;
    return pane(source);
  }
  const tree = (active: boolean) => (
    <RetainedViews activeKey={active ? "document" : null}>
      <OwnedPane />
    </RetainedViews>
  );
  const ui = render(tree(true));
  await ready();
  ui.rerender(tree(false));
  const source = project(targets[2]);
  act(() => select(source));
  await act(async () => {
    await store.prepareDeletion(source);
    await store.delete(source, store.get(source).deletion!);
  });
  ui.rerender(tree(true));
  await act(async () => {});
  expect(editor()).toBeNull();
  expect(api.readProjectDocument).toHaveBeenCalledTimes(1);
  expect(api.saveProjectDocument).not.toHaveBeenCalled();
});
it("isolates automatic reads of identical tool basenames by their full path", async () => {
  const pending = deferred<typeof documentValue>();
  api.readProjectDocument.mockReturnValueOnce(pending.promise);
  const a = project(targets[1]);
  const b: DocumentSource = {
    scope: "project",
    projectId: "p",
    target: { kind: "tool", tool: "review", path: "ci/local.yml" },
  };
  const ui = render(pane(a));
  expect(api.readProjectDocument).toHaveBeenCalledExactlyOnceWith(
    "p",
    targets[1],
  );
  ui.rerender(pane(b));
  const view = await ready();
  edit();
  await act(async () =>
    pending.resolve({ ...documentValue, text: "# late env/local.yml\r\n" }),
  );
  expect(editor()).toBe(view);
  expect(view.state.doc.toString()).toBe("# dirty\r\n" + text);
  expect(store.get(a).text).toBe("# late env/local.yml\r\n");
  expect(api.readProjectDocument).toHaveBeenCalledTimes(2);
});
it.each(["profile", "workflow", "pipeline"] as const)(
  "Cancel preserves the missing baseline and memory-only identity of a new Project %s",
  async (kind) => {
    const source: DocumentSource = {
      scope: "project",
      projectId: "p",
      target: { kind, name: "new" },
    };
    if (kind === "profile") store.createProjectProfile("p", "new", []);
    else if (kind === "workflow") store.createWorkflow("p", "new", []);
    else store.createPipeline("p", "new", []);
    render(pane(source));
    const view = await ready();
    const original = view.state.doc.toString();
    edit();
    fireEvent.click(screen.getByRole("button", { name: "Отменить изменения" }));
    expect(editor()).toBe(view);
    expect(view.state.doc.toString()).toBe(original);
    expect(store.get(source)).toMatchObject({
      memoryOnly: true,
      document: { exists: false, version: "missing" },
    });
    expect(api.readProjectDocument).not.toHaveBeenCalled();
    expect(api.saveProjectDocument).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Удалить черновик" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(dialog.querySelector("button[data-confirm-delete]")!);
    await waitFor(() => expect(store.get(source).document).toBeUndefined());
    expect(api.prepareDocumentDeletion).not.toHaveBeenCalled();
    expect(api.deleteDocument).not.toHaveBeenCalled();
    expect(api.readProjectDocument).not.toHaveBeenCalled();
  },
);
it("local reset does not create an unread source and cannot race an in-flight save", async () => {
  const source = project();
  store.reset(source);
  expect(store.get(source).document).toBeUndefined();
  await store.open(source);
  store.edit(source, "# pending draft\r\n");
  const pending = deferred<typeof documentValue>();
  api.saveProjectDocument.mockReturnValueOnce(pending.promise);
  const saving = store.save(source);
  const entry = store.get(source);
  store.reset(source);
  expect(store.get(source)).toBe(entry);
  expect(store.get(source).text).toBe("# pending draft\r\n");
  pending.resolve(documentValue);
  await saving;
  expect(api.readProjectDocument).toHaveBeenCalledTimes(1);
});

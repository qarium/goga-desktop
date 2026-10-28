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
import { undo, undoDepth, redo } from "@codemirror/commands";
import { GitWorkspace } from "../src/renderer/GitWorkspace";
import { RetainedViews } from "../src/renderer/RetainedViews";
import type { GitConflictDocument } from "../src/shared/git-conflicts";
import type { GitWorkspaceSnapshot } from "../src/shared/git-workspace";
let portal: HTMLDivElement, api: any;
const revision = "a".repeat(64);
const source = (text: string) => ({
  kind: "text" as const,
  text,
  oid: "b".repeat(40),
  mode: "100644",
});
const generated =
  "start\r\n<<<<<<< current\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> incoming\r\nend";
function documentFor(path = "file.txt", scope = "p"): GitConflictDocument {
  return {
    scope,
    path,
    revision,
    fingerprint: "c".repeat(64),
    base: source("start\r\nbase\r\nend"),
    current: source("start\r\nours\r\nend"),
    incoming: source("start\r\ntheirs\r\nend"),
    working: {
      kind: "text",
      text: "\ufeffmanual\r\n<<<<<<< literal\r\nno final newline",
    },
    generated: {
      kind: "text",
      text: generated,
      requiresExplicitReconstruction: true,
      blocks: [
        {
          id: "h1",
          resultRange: { from: 7, to: generated.length - 3 },
          base: { text: "base\r\n", range: { from: 7, to: 13 } },
          current: { text: "ours\r\n", range: { from: 7, to: 13 } },
          incoming: { text: "theirs\r\n", range: { from: 7, to: 15 } },
        },
      ],
    },
  };
}
const snapshot = (scope = "p"): GitWorkspaceSnapshot => ({
  scope,
  root: "/fixture/" + scope,
  revision,
  head: "b".repeat(40),
  branch: "main",
  upstream: null,
  ahead: 0,
  behind: 0,
  operation: "merge",
  files: ["file.txt", "other.txt"].map((path) => ({
    path,
    kind: "conflict",
    indexStatus: "U",
    worktreeStatus: "U",
    submodule: false,
  })),
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
};
beforeEach(() => {
  portal = document.createElement("div");
  document.body.append(portal);
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  api = {
    readGitWorkspace: vi.fn(async (scope: string) => snapshot(scope)),
    readGitDiff: vi.fn(async () => {
      throw Error("must not read diff");
    }),
    readGitConflict: vi.fn(async (r: any) => ({
      ...documentFor(r.path, r.scope),
      revision: r.revision,
    })),
    prepareGitConflictSave: vi.fn(async (r: any) => ({
      token: "d".repeat(64),
      scope: r.scope,
      path: r.path,
      branch: "main",
      resolution: r.resolution.kind,
      bytes: 10,
      expiresAt: Date.now() + 60000,
      hooks: "disabled",
      canonicalization: "git-text-attributes",
    })),
    executeGitConflictSave: vi.fn(async () => ({
      scope: "p",
      path: "file.txt",
      status: "saved",
      worktreePublished: true,
      indexPublished: true,
      lockRetained: false,
      message: "Saved",
      log: "log",
    })),
  };
  window.goga = api;
});
afterEach(() => {
  cleanup();
  portal.remove();
  vi.useRealTimers();
});
function view(
  scope = "p",
  open = true,
  rev = 0,
  onClose = vi.fn(),
  onChanged = vi.fn(),
) {
  return (
    <GitWorkspace
      scope={scope}
      open={open}
      bodyContainer={portal}
      onOpen={vi.fn()}
      onClose={onClose}
      onChanged={onChanged}
      revision={rev}
    />
  );
}
function pane(label: string) {
  const hosts = [...portal.querySelectorAll(".yaml-code-editor")];
  const node = hosts
    .map((h) => h.shadowRoot?.querySelector(`[aria-label="${label}"]`))
    .find(Boolean);
  return node ? EditorView.findFromDOM(node as HTMLElement)! : null;
}
async function select(path = "file.txt") {
  fireEvent.click(await screen.findByRole("button", { name: path }));
  await waitFor(() => expect(pane("Результат разрешения")).toBeTruthy());
}
async function reconstruct() {
  fireEvent.click(screen.getByRole("button", { name: "Восстановить блоки…" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Заменить черновик реконструкцией" }),
  );
}
function arrow(label: string) {
  const nodes = [...portal.querySelectorAll(".yaml-code-editor")].flatMap(
    (h) => [...h.shadowRoot!.querySelectorAll("button")],
  );
  return nodes.find((n) => n.getAttribute("aria-label") === label)!;
}
it("reads conflicts, not diffs; opens exact working text between two immutable sources", async () => {
  render(view());
  await select();
  expect(api.readGitDiff).not.toHaveBeenCalled();
  expect(pane("Текущая версия")!.state.readOnly).toBe(true);
  expect(pane("Входящая версия")!.state.readOnly).toBe(true);
  expect(pane("Результат разрешения")!.state.readOnly).toBe(false);
  expect(pane("Результат разрешения")!.state.doc.toString()).toBe(
    documentFor().working.text,
  );
  expect(
    portal.querySelector(".git-workspace-conflicts .git-workspace-files"),
  ).toBeTruthy();
});
it("reconstructs only after confirmation and applies anchored hunks without losing outside CRLF edits", async () => {
  render(view());
  await select();
  fireEvent.click(screen.getByRole("button", { name: "Восстановить блоки…" }));
  expect(pane("Результат разрешения")!.state.doc.toString()).toBe(
    documentFor().working.text,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Заменить черновик реконструкцией" }),
  );
  const result = pane("Результат разрешения")!;
  act(() =>
    result.dispatch({ changes: { from: 0, insert: "\ufeffoutside\r\n" } }),
  );
  fireEvent.click(arrow("Блок 1: принять текущую"));
  expect(result.state.doc.toString()).toBe(
    "\ufeffoutside\r\nstart\r\nours\r\nend",
  );
  expect(
    screen.getByRole("button", { name: "Сохранить файл…" }),
  ).not.toHaveProperty("disabled", true);
});
it("retains separate per-file drafts, selection and history across hidden owner portals", async () => {
  const rendered = render(
    <RetainedViews activeKey="p">{view()}</RetainedViews>,
  );
  await select();
  const result = pane("Результат разрешения")!;
  act(() =>
    result.dispatch({
      changes: { from: 0, insert: "mine" },
      selection: { anchor: 3 },
    }),
  );
  await select("other.txt");
  expect(pane("Результат разрешения")!.state.doc.toString()).not.toContain(
    "mine",
  );
  await select();
  expect(pane("Результат разрешения")!.state.doc.toString()).toContain("mine");
  rendered.rerender(<RetainedViews activeKey="q">{view("q")}</RetainedViews>);
  await select();
  expect(pane("Результат разрешения")!.state.doc.toString()).not.toContain(
    "mine",
  );
  rendered.rerender(<RetainedViews activeKey="p">{view()}</RetainedViews>);
  await waitFor(() =>
    expect(pane("Результат разрешения")!.state.doc.toString()).toContain(
      "mine",
    ),
  );
  expect(pane("Результат разрешения")!.state.selection.main.anchor).toBe(3);
  expect(
    api.readGitConflict.mock.calls.filter((c: any) => c[0].scope === "p"),
  ).toHaveLength(2);
});
it("requires an explicit whole-file manual decision, freezes prepare preview, then saves exact text", async () => {
  const changed = vi.fn();
  render(view("p", true, 0, vi.fn(), changed));
  await select();
  expect(
    screen.getByRole("button", { name: "Сохранить файл…" }),
  ).toHaveProperty("disabled", true);
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Результат проверен вручную" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Сохранить файл…" }));
  expect(
    await screen.findByRole("heading", {
      name: "Подтвердить разрешение файла",
    }),
  ).toBeTruthy();
  expect(pane("Результат разрешения")!.state.readOnly).toBe(true);
  expect(api.prepareGitConflictSave.mock.calls[0][0].resolution).toEqual({
    kind: "text",
    text: documentFor().working.text,
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Записать файл и индекс" }),
  );
  await waitFor(() =>
    expect(api.executeGitConflictSave).toHaveBeenCalledOnce(),
  );
  await waitFor(() => expect(changed).toHaveBeenCalledWith("p", "p"));
});
it("preserves dirty draft after a new snapshot and requires explicit reload confirmation", async () => {
  const rendered = render(view());
  await select();
  act(() =>
    pane("Результат разрешения")!.dispatch({
      changes: { from: 0, insert: "mine" },
    }),
  );
  api.readGitWorkspace.mockResolvedValue({
    ...snapshot(),
    revision: "e".repeat(64),
  });
  rendered.rerender(view("p", true, 1));
  expect(
    await screen.findByText(/Черновик относится к предыдущему состоянию/),
  ).toBeTruthy();
  expect(pane("Результат разрешения")!.state.doc.toString()).toContain("mine");
  fireEvent.click(screen.getByRole("button", { name: "Перечитать файл…" }));
  expect(pane("Результат разрешения")!.state.doc.toString()).toContain("mine");
  fireEvent.click(
    screen.getByRole("button", { name: "Отбросить черновик и перечитать" }),
  );
  await waitFor(() =>
    expect(pane("Результат разрешения")!.state.doc.toString()).toBe(
      documentFor().working.text,
    ),
  );
});
it.each(["partial", "uncertain", "transport"])(
  "keeps draft and closable error after %s, never retries automatically",
  async (status) => {
    api.executeGitConflictSave.mockImplementation(async () => {
      if (status === "transport") throw Error("lost reply");
      return {
        scope: "p",
        path: "file.txt",
        status,
        worktreePublished: true,
        indexPublished: false,
        lockRetained: true,
        recoveryPath: "/fixture/recovery",
        message: "needs inspection",
        log: "details",
      };
    });
    const close = vi.fn();
    render(view("p", true, 0, close));
    await select();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Результат проверен вручную" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Сохранить файл…" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Записать файл и индекс" }),
    );
    expect(
      await screen.findByRole("heading", {
        name: "Результат разрешения файла",
      }),
    ).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
    // The result text mounts before the dialog's showModal effect exposes its controls.
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Закрыть результат разрешения",
      }),
    );
    expect(
      screen.getByRole("button", { name: "Сохранить файл…" }),
    ).toHaveProperty("disabled", true);
    expect(pane("Результат разрешения")!.state.doc.toString()).toBe(
      documentFor().working.text,
    );
    expect(api.executeGitConflictSave).toHaveBeenCalledOnce();
  },
);
it("rejects a late read for a different file without flashing its sources", async () => {
  const late = deferred<GitConflictDocument>();
  api.readGitConflict.mockImplementation((request: any) =>
    request.path === "file.txt"
      ? late.promise
      : Promise.resolve(documentFor(request.path, request.scope)),
  );
  render(view());
  fireEvent.click(await screen.findByRole("button", { name: "file.txt" }));
  expect(
    await screen.findByRole("status", { name: "Загрузка конфликта" }),
  ).toBeTruthy();
  await select("other.txt");
  await act(async () =>
    late.resolve({
      ...documentFor(),
      working: { kind: "text", text: "LATE PRIVATE" },
    }),
  );
  expect(pane("Результат разрешения")!.state.doc.toString()).not.toContain(
    "LATE PRIVATE",
  );
});
it.each(["scope", "path", "revision"])(
  "rejects wrong %s read provenance and leaves a closable read error",
  async (field) => {
    api.readGitConflict.mockResolvedValue({
      ...documentFor(),
      [field]: "wrong",
    });
    const close = vi.fn();
    render(view("p", true, 0, close));
    fireEvent.click(await screen.findByRole("button", { name: "file.txt" }));
    expect(
      await screen.findByRole("heading", {
        name: "Не удалось прочитать конфликт",
      }),
    ).toBeTruthy();
    expect(pane("Результат разрешения")).toBeNull();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Закрыть результат разрешения" }),
    );
    expect(screen.queryByText("Загрузка конфликта")).toBeNull();
  },
);
it("keeps exact stable topic owner draft on freshness revision change without rebinding its save request", async () => {
  const original = {
    projectId: "p",
    year: "2026",
    topic: "topic",
    branch: "topic-b",
    contextId: "ctx-" + "1".repeat(64),
    revision: "11111111-1111-4111-8111-111111111111",
  };
  const next = {
    ...original,
    revision: "22222222-2222-4222-8222-222222222222",
  };
  const renderScope = (scope: typeof original) => (
    <GitWorkspace
      scope={scope}
      open
      bodyContainer={portal}
      onOpen={vi.fn()}
      onClose={vi.fn()}
      revision={0}
    />
  );
  const rendered = render(renderScope(original));
  await select();
  act(() =>
    pane("Результат разрешения")!.dispatch({
      changes: { from: 0, insert: "local" },
    }),
  );
  rendered.rerender(renderScope(next));
  expect(
    await screen.findByText(/Черновик относится к предыдущему состоянию/),
  ).toBeTruthy();
  // Model the observed CI boundary: the warning can precede editor readiness.
  const findEditor = vi.spyOn(EditorView, "findFromDOM").mockReturnValueOnce(null);
  try {
    await waitFor(() =>
      expect(pane("Результат разрешения")?.state.doc.toString()).toContain("local"),
    );
  } finally {
    findEditor.mockRestore();
  }
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Результат проверен вручную" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Сохранить файл…" }));
  await screen.findByRole("heading", { name: "Подтвердить разрешение файла" });
  expect(api.prepareGitConflictSave.mock.calls[0][0].scope).toEqual(original);
  expect(api.readGitConflict).toHaveBeenCalledOnce();
});
it("cancels prepare on hiding, ignores its late preview and never executes it", async () => {
  const pending = deferred<any>();
  api.prepareGitConflictSave.mockReturnValue(pending.promise);
  const rendered = render(view());
  await select();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Результат проверен вручную" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Сохранить файл…" }));
  expect(
    await screen.findByRole("button", { name: "Отменить проверку" }),
  ).toBeTruthy();
  rendered.rerender(view("p", false));
  await act(async () =>
    pending.resolve({
      token: "d".repeat(64),
      path: "file.txt",
      scope: "p",
      resolution: "text",
      hooks: "disabled",
      canonicalization: "git-text-attributes",
    }),
  );
  rendered.rerender(view());
  await waitFor(() => expect(pane("Результат разрешения")).toBeTruthy());
  expect(
    screen.queryByRole("heading", { name: "Подтвердить разрешение файла" }),
  ).toBeNull();
  expect(api.executeGitConflictSave).not.toHaveBeenCalled();
});
it("keeps execute owner alive while hidden and consumes confirmation at most once", async () => {
  const pending = deferred<any>();
  api.executeGitConflictSave.mockReturnValue(pending.promise);
  const changed = vi.fn();
  const rendered = render(view("p", true, 0, vi.fn(), changed));
  await select();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Результат проверен вручную" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Сохранить файл…" }));
  const confirm = await screen.findByRole("button", {
    name: "Записать файл и индекс",
  });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  rendered.rerender(view("p", false, 0, vi.fn(), changed));
  await act(async () =>
    pending.resolve({
      scope: "p",
      path: "file.txt",
      status: "saved",
      worktreePublished: true,
      indexPublished: true,
      lockRetained: false,
      message: "ok",
      log: "done",
    }),
  );
  expect(changed).toHaveBeenCalledWith("p", "p");
  expect(api.executeGitConflictSave).toHaveBeenCalledOnce();
});
it.each(["scope", "path"])("rejects mismatched prepare %s", async (field) => {
  api.prepareGitConflictSave.mockImplementation(async (r: any) => ({
    token: "d".repeat(64),
    scope: r.scope,
    path: r.path,
    resolution: "text",
    hooks: "disabled",
    canonicalization: "git-text-attributes",
    [field]: "wrong",
  }));
  render(view());
  await select();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Результат проверен вручную" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Сохранить файл…" }));
  expect(
    await screen.findByRole("heading", {
      name: "Не удалось подготовить разрешение",
    }),
  ).toBeTruthy();
  expect(api.executeGitConflictSave).not.toHaveBeenCalled();
});
it("refuses unsupported content without pretending solved", async () => {
  api.readGitConflict.mockResolvedValue({
    ...documentFor(),
    current: {
      kind: "binary",
      oid: "b".repeat(40),
      mode: "100644",
      reason: "binary content",
    },
  });
  render(view());
  await select();
  expect(screen.getByText(/Этот вид конфликта не поддерживается/)).toBeTruthy();
  expect(pane("Результат разрешения")!.state.readOnly).toBe(true);
  expect(
    screen.getByRole("button", { name: "Сохранить файл…" }),
  ).toHaveProperty("disabled", true);
});
it("does not create a source arrow for ambiguous null positions", async () => {
  const doc = documentFor();
  if (doc.generated.kind !== "text") throw Error("fixture");
  api.readGitConflict.mockResolvedValue({
    ...doc,
    generated: {
      ...doc.generated,
      blocks: [
        {
          ...doc.generated.blocks[0],
          current: { text: "ours\r\n", range: null },
        },
      ],
    },
  });
  render(view());
  await select();
  await reconstruct();
  const current = arrow("Блок 1: принять текущую");
  expect(current).toBeTruthy();
  expect(
    (current.getRootNode() as ShadowRoot).host.closest(".git-conflict-result"),
  ).toBeTruthy();
  expect(arrow("Блок 1: принять входящую")).toBeTruthy();
});
it("invalidates block arrows after a cross-boundary transaction but permits explicit manual completion", async () => {
  render(view());
  await select();
  await reconstruct();
  act(() =>
    pane("Результат разрешения")!.dispatch({
      changes: { from: 0, to: 9, insert: "manual\r\n" },
    }),
  );
  expect(arrow("Блок 1: принять текущую")).toHaveProperty("disabled", true);
  expect(
    screen.getByRole("button", { name: "Сохранить файл…" }),
  ).toHaveProperty("disabled", true);
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Результат проверен вручную" }),
  );
  expect(
    screen.getByRole("button", { name: "Сохранить файл…" }),
  ).toHaveProperty("disabled", false);
});
it("supports both sides and explicit per-block manual decisions", async () => {
  render(view());
  await select();
  await reconstruct();
  fireEvent.click(arrow("Блок 1: принять обе"));
  expect(pane("Результат разрешения")!.state.doc.toString()).toBe(
    "start\r\nours\r\ntheirs\r\nend",
  );
  act(() =>
    pane("Результат разрешения")!.dispatch({
      changes: { from: 8, insert: "edited" },
    }),
  );
  expect(
    screen.getByRole("button", { name: "Сохранить файл…" }),
  ).toHaveProperty("disabled", true);
  fireEvent.click(arrow("Блок 1: решён вручную"));
  expect(
    screen.getByRole("button", { name: "Сохранить файл…" }),
  ).toHaveProperty("disabled", false);
});
it("links scroll without clamped source events snapping a longer result backwards", async () => {
  render(view());
  await select();
  const result = pane("Результат разрешения")!,
    current = pane("Текущая версия")!,
    incoming = pane("Входящая версия")!;
  for (const [view, maximum] of [
    [result, 400],
    [current, 100],
    [incoming, 200],
  ] as const) {
    let position = 0;
    Object.defineProperty(view.scrollDOM, "scrollHeight", {
      configurable: true,
      value: maximum + 100,
    });
    Object.defineProperty(view.scrollDOM, "clientHeight", {
      configurable: true,
      value: 100,
    });
    Object.defineProperty(view.scrollDOM, "scrollTop", {
      configurable: true,
      get: () => position,
      set: (value) => {
        position = Math.min(maximum, Math.max(0, value));
      },
    });
  }
  result.scrollDOM.scrollTop = 400;
  fireEvent.scroll(result.scrollDOM);
  expect(current.scrollDOM.scrollTop).toBe(100);
  fireEvent.scroll(current.scrollDOM);
  expect(result.scrollDOM.scrollTop).toBe(400);
  current.scrollDOM.scrollTop = 50;
  fireEvent.scroll(current.scrollDOM);
  expect(result.scrollDOM.scrollTop).toBe(200);
});
it("ends a hung conflict read at the finite deadline with a closable modal", async () => {
  api.readGitConflict.mockReturnValue(new Promise(() => {}));
  api.cancelRead = vi.fn(async () => {});
  render(view());
  await screen.findByRole("button", { name: "file.txt" });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fireEvent.click(screen.getByRole("button", { name: "file.txt" }));
  expect(
    screen.getByRole("status", { name: "Загрузка конфликта" }),
  ).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30001);
  });
  expect(
    screen.getByRole("heading", { name: "Не удалось прочитать конфликт" }),
  ).toBeTruthy();
  expect(screen.getByText(/Превышено время ожидания чтения/)).toBeTruthy();
  expect(api.cancelRead).toHaveBeenCalledOnce();
  fireEvent.click(
    screen.getByRole("button", { name: "Закрыть результат разрешения" }),
  );
  expect(
    screen.queryByRole("status", { name: "Загрузка конфликта" }),
  ).toBeNull();
});
it("ends a hung prepare at the finite deadline without discarding editable text", async () => {
  render(view());
  await select();
  api.prepareGitConflictSave.mockReturnValue(new Promise(() => {}));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Результат проверен вручную" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Сохранить файл…" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30001);
  });
  expect(
    screen.getByRole("heading", { name: "Не удалось подготовить разрешение" }),
  ).toBeTruthy();
  expect(pane("Результат разрешения")!.state.doc.toString()).toBe(
    documentFor().working.text,
  );
  expect(pane("Результат разрешения")!.state.readOnly).toBe(false);
  expect(api.executeGitConflictSave).not.toHaveBeenCalled();
});
it.each(["scope", "path"])(
  "treats wrong %s execute response as uncertain, not a saved file",
  async (field) => {
    api.executeGitConflictSave.mockResolvedValue({
      scope: "p",
      path: "file.txt",
      status: "saved",
      worktreePublished: true,
      indexPublished: true,
      lockRetained: false,
      message: "ok",
      log: "",
      [field]: "wrong",
    });
    const changed = vi.fn();
    render(view("p", true, 0, vi.fn(), changed));
    await select();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Результат проверен вручную" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Сохранить файл…" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Записать файл и индекс" }),
    );
    expect(
      await screen.findByText(/Ответ не подтверждает отсутствие записи/),
    ).toBeTruthy();
    expect(changed).not.toHaveBeenCalled();
    // The result text mounts before the dialog's showModal effect exposes its controls.
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Закрыть результат разрешения",
      }),
    );
    expect(
      screen.getByRole("button", { name: "Сохранить файл…" }),
    ).toHaveProperty("disabled", true);
  },
);
it.each(["binary", "symlink", "submodule", "unavailable"])(
  "does not offer whole-file resolution for unsupported %s content",
  async (kind) => {
    api.readGitConflict.mockResolvedValue({
      ...documentFor(),
      working: { kind, reason: "oversize or unsupported" },
    });
    render(view());
    fireEvent.click(await screen.findByRole("button", { name: "file.txt" }));
    expect(
      await screen.findByText(/Этот вид конфликта не поддерживается/),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Принять текущий файл…" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Сохранить файл…" }),
    ).toHaveProperty("disabled", true);
  },
);
it.each(["current", "incoming", "delete"])(
  "offers explicit %s whole-file preview for text/absent conflicts",
  async (kind) => {
    api.readGitConflict.mockResolvedValue({
      ...documentFor(),
      current: { kind: "absent", oid: null, mode: null },
      working: { kind: "absent" },
      generated: { kind: "unavailable", reason: "modify/delete" },
    });
    render(view());
    fireEvent.click(await screen.findByRole("button", { name: "file.txt" }));
    await screen.findByText("Решение для файла целиком");
    fireEvent.click(screen.getByText("Решение для файла целиком"));
    const name =
      kind === "current"
        ? "Принять текущий файл…"
        : kind === "incoming"
          ? "Принять входящий файл…"
          : "Удалить файл…";
    fireEvent.click(screen.getByRole("button", { name }));
    await screen.findByRole("heading", {
      name: "Подтвердить разрешение файла",
    });
    expect(api.prepareGitConflictSave.mock.calls[0][0].resolution).toEqual({
      kind,
    });
    expect(api.executeGitConflictSave).not.toHaveBeenCalled();
  },
);
it.each(["disappeared", "tracked"])(
  "keeps a dirty %s conflict draft reachable after a fresh snapshot until explicit reload",
  async (status) => {
    const rendered = render(view());
    await select();
    act(() =>
      pane("Результат разрешения")!.dispatch({
        changes: { from: 0, insert: "manual kept" },
      }),
    );
    const next = snapshot();
    api.readGitWorkspace.mockResolvedValue({
      ...next,
      revision: "e".repeat(64),
      files:
        status === "disappeared"
          ? next.files.filter((f) => f.path !== "file.txt")
          : next.files.map((f) =>
              f.path === "file.txt"
                ? {
                    ...f,
                    kind: "tracked",
                    indexStatus: "M",
                    worktreeStatus: ".",
                  }
                : f,
            ),
    });
    rendered.rerender(view("p", true, 1));
    await screen.findByText(/Черновик относится к предыдущему состоянию/);
    expect(pane("Результат разрешения")!.state.doc.toString()).toContain(
      "manual kept",
    );
    await select("other.txt");
    await select("file.txt");
    expect(pane("Результат разрешения")!.state.doc.toString()).toContain(
      "manual kept",
    );
    expect(api.readGitDiff).not.toHaveBeenCalled();
  },
);
it("closes a stale retained-file prepare preview on hide even if the path is no longer conflicted", async () => {
  const rendered = render(view());
  await select();
  api.readGitWorkspace.mockResolvedValue({
    ...snapshot(),
    revision: "e".repeat(64),
    files: [],
  });
  rendered.rerender(view("p", true, 1));
  await screen.findByText(/Черновик относится к предыдущему состоянию/);
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Результат проверен вручную" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Сохранить файл…" }));
  await screen.findByRole("heading", { name: "Подтвердить разрешение файла" });
  rendered.rerender(view("p", false, 1));
  rendered.rerender(view("p", true, 1));
  await waitFor(() => expect(pane("Результат разрешения")).toBeTruthy());
  expect(
    screen.queryByRole("heading", { name: "Подтвердить разрешение файла" }),
  ).toBeNull();
});
it("retains reconstruction edits, selection and undo history across file switches", async () => {
  render(view());
  await select();
  await reconstruct();
  const result = pane("Результат разрешения")!;
  act(() =>
    result.dispatch({
      changes: { from: 0, insert: "mine\r\n" },
      selection: { anchor: 3 },
    }),
  );
  expect(undoDepth(result.state)).toBe(1);
  await select("other.txt");
  await select("file.txt");
  const restored = pane("Результат разрешения")!;
  expect(restored.state.doc.toString()).toBe("mine\r\n" + generated);
  expect(restored.state.selection.main.anchor).toBe(3);
  expect(undoDepth(restored.state)).toBe(1);
  act(() => {
    expect(undo(restored)).toBe(true);
  });
  expect(restored.state.doc.toString()).toBe(generated);
});
it("reuses static CodeMirror theme classes across reconstruction and local edits", async () => {
  render(view());
  await select();
  const result = pane("Результат разрешения")!;
  const classes = result.dom.className;
  await reconstruct();
  expect(result.dom.className).toBe(classes);
  act(() => result.dispatch({ changes: { from: 0, insert: "new\r\n" } }));
  expect(result.dom.className).toBe(classes);
});
it("keeps outside editing and hunk application as separate undo events without resetting selection", async () => {
  render(view());
  await select();
  await reconstruct();
  const result = pane("Результат разрешения")!;
  act(() =>
    result.dispatch({
      changes: { from: 0, insert: "\ufeffoutside\r\n" },
      selection: { anchor: 3 },
      userEvent: "input.type",
    }),
  );
  expect(undoDepth(result.state)).toBe(1);
  fireEvent.click(arrow("Блок 1: принять текущую"));
  expect(result.state.doc.toString()).toBe(
    "\ufeffoutside\r\nstart\r\nours\r\nend",
  );
  expect(result.state.selection.main.anchor).toBe(3);
  expect(undoDepth(result.state)).toBe(2);
  act(() => {
    expect(undo(result)).toBe(true);
  });
  expect(result.state.doc.toString()).toBe("\ufeffoutside\r\n" + generated);
  act(() => {
    expect(undo(result)).toBe(true);
  });
  expect(result.state.doc.toString()).toBe(generated);
  act(() => {
    expect(redo(result)).toBe(true);
    expect(redo(result)).toBe(true);
  });
  expect(result.state.doc.toString()).toBe(
    "\ufeffoutside\r\nstart\r\nours\r\nend",
  );
});
it("makes a clean arrow text-undoable and does not add history for an identical side choice", async () => {
  render(view());
  await select();
  await reconstruct();
  const result = pane("Результат разрешения")!;
  fireEvent.click(arrow("Блок 1: принять текущую"));
  expect(undoDepth(result.state)).toBe(1);
  fireEvent.click(arrow("Блок 1: принять текущую"));
  expect(undoDepth(result.state)).toBe(1);
  act(() => {
    expect(undo(result)).toBe(true);
  });
  expect(result.state.doc.toString()).toBe(generated);
});
it("refuses a stale precise hunk update without replacing the actual editor or enabling a save", async () => {
  render(view());
  await select();
  await reconstruct();
  const result = pane("Результат разрешения")!;
  // Simulate an editor-state replacement not delivered as a normal transaction.
  // This is the mismatch guard's boundary; ordinary typing uses onUpdate.
  act(() =>
    result.setState(
      result.state.update({
        changes: { from: 0, insert: "preserve\r\n" },
        selection: { anchor: 3 },
      }).state,
    ),
  );
  const actual = result.state.doc.toString();
  const depth = undoDepth(result.state);
  fireEvent.click(arrow("Блок 1: принять текущую"));
  expect(
    await screen.findByRole("heading", { name: "Не удалось применить блок" }),
  ).toBeTruthy();
  expect(result.state.doc.toString()).toBe(actual);
  expect(result.state.selection.main.anchor).toBe(3);
  expect(undoDepth(result.state)).toBe(depth);
  fireEvent.click(
    screen.getByRole("button", { name: "Закрыть результат разрешения" }),
  );
  expect(
    screen.getByRole("button", { name: "Сохранить файл…" }),
  ).toHaveProperty("disabled", true);
  expect(arrow("Блок 1: принять текущую")).toHaveProperty("disabled", true);
  await select("other.txt");
  await select("file.txt");
  expect(pane("Результат разрешения")!.state.doc.toString()).toBe(actual);
});
it("keeps hunk undo history and a following typing event across file remounts", async () => {
  render(view());
  await select();
  await reconstruct();
  const result = pane("Результат разрешения")!;
  fireEvent.click(arrow("Блок 1: принять текущую"));
  act(() =>
    result.dispatch({
      changes: { from: 0, insert: "next\r\n" },
      selection: { anchor: 2 },
      userEvent: "input.type",
    }),
  );
  expect(undoDepth(result.state)).toBe(2);
  await select("other.txt");
  await select("file.txt");
  const restored = pane("Результат разрешения")!;
  expect(restored.state.selection.main.anchor).toBe(2);
  act(() => {
    expect(undo(restored)).toBe(true);
  });
  expect(restored.state.doc.toString()).toBe("start\r\nours\r\nend");
  act(() => {
    expect(undo(restored)).toBe(true);
  });
  expect(restored.state.doc.toString()).toBe(generated);
});
function verifiedAbortFacts() {
  return {
    retainedLocks: [],
    uncheckedLocks: [],
    native: {
      operationId: "11111111-1111-4111-8111-111111111111",
      outcome: "completed",
      exitCode: 0,
      signal: null,
      beforeHead: "b".repeat(40),
      afterHead: "b".repeat(40),
      conflicts: [],
      verifiedUnrelatedData: true,
      processSettled: true,
      recovery: "removed",
    },
  };
}
function mergeBridge() {
  api.prepareGitMergeOperation = vi.fn(async (r: any) => ({
    ...r,
    token: "d".repeat(64),
    root: "/fixture/p",
    operation: "merge",
    branch: "main",
    head: "b".repeat(40),
    sourceOid: "c".repeat(40),
    paths: ["file.txt"],
    effects: "Scoped abort",
    message: "Merge",
    author: null,
    committer: null,
    signing: false,
    hooks: "disabled",
    expiresAt: Date.now() + 60000,
  }));
  api.executeGitMergeOperation = vi.fn();
}
it("blocks completion for a retained unsaved draft even after disk unmerged paths disappear", async () => {
  mergeBridge();
  const rendered = render(view());
  await select();
  act(() =>
    pane("Результат разрешения")!.dispatch({
      changes: { from: 0, insert: "keep draft" },
    }),
  );
  api.readGitWorkspace.mockResolvedValue({
    ...snapshot(),
    revision: "e".repeat(64),
    files: [],
  });
  rendered.rerender(view("p", true, 1));
  await screen.findByText(/Черновик относится к предыдущему состоянию/);
  expect(
    screen.getByRole("button", { name: "Завершить слияние…" }),
  ).toHaveProperty("disabled", true);
  expect(
    screen.getByRole("button", { name: "Отменить слияние…" }),
  ).toHaveProperty("disabled", false);
  expect(api.prepareGitMergeOperation).not.toHaveBeenCalled();
});
it.each(["success", "error", "uncertain"])(
  "locks file saves during merge abort and clears drafts only on proven %s",
  async (status) => {
    mergeBridge();
    const pending = deferred<any>();
    api.executeGitMergeOperation.mockReturnValue(pending.promise);
    const changed = vi.fn();
    render(view("p", true, 0, vi.fn(), changed));
    await select();
    act(() =>
      pane("Результат разрешения")!.dispatch({
        changes: { from: 0, insert: "keep draft" },
      }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Результат проверен вручную" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Отменить слияние…" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Отменить слияние" }),
    );
    expect(
      screen.getByRole("button", { name: "Сохранить файл…" }),
    ).toHaveProperty("disabled", true);
    expect(pane("Результат разрешения")!.state.readOnly).toBe(true);
    if (status === "success")
      api.readGitWorkspace.mockResolvedValue({
        ...snapshot(),
        operation: "none",
        files: [],
      });
    await act(async () =>
      pending.resolve({
        scope: "p",
        operation: "merge",
        action: "abort",
        status,
        changed: status !== "error",
        ...(status === "success" ? verifiedAbortFacts() : {}),
        lockRetained: false,
        message: "Outcome",
        log: "abort log",
      }),
    );
    if (status === "success") {
      await screen.findByText("Нет изменений для просмотра");
      expect(changed).toHaveBeenCalledWith("p", "p");
      expect(screen.queryByRole("button", { name: "file.txt" })).toBeNull();
    } else {
      await screen.findByText(/abort log/);
      expect(changed).not.toHaveBeenCalled();
      expect(pane("Результат разрешения")!.state.doc.toString()).toContain(
        "keep draft",
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Закрыть результат слияния" }),
      );
      expect(pane("Результат разрешения")!.state.doc.toString()).toContain(
        "keep draft",
      );
    }
  },
);
it("refreshes the submitted topic scope after a retained save crosses freshness changes", async () => {
  const scope = {
    projectId: "p",
    year: "2026",
    topic: "t",
    branch: "topic",
    contextId: "ctx-" + "1".repeat(64),
    revision: "11111111-1111-4111-8111-111111111111",
  };
  api.readGitWorkspace.mockImplementation(async (s: any) => ({
    ...snapshot(),
    scope: s,
    branch: s.branch,
    root: "/fixture/clone",
  }));
  const pending = deferred<any>();
  api.executeGitConflictSave.mockReturnValue(pending.promise);
  const changed = vi.fn();
  const owner = (s: typeof scope) => (
    <GitWorkspace
      scope={s}
      open
      bodyContainer={portal}
      revision={0}
      onOpen={vi.fn()}
      onClose={vi.fn()}
      onChanged={changed}
    />
  );
  const rendered = render(owner(scope));
  await select();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Результат проверен вручную" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Сохранить файл…" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Записать файл и индекс" }),
  );
  rendered.rerender(
    owner({ ...scope, revision: "22222222-2222-4222-8222-222222222222" }),
  );
  await act(async () =>
    pending.resolve({
      scope,
      path: "file.txt",
      status: "saved",
      worktreePublished: true,
      indexPublished: true,
      lockRetained: false,
      message: "Saved",
      log: "",
    }),
  );
  expect(changed).toHaveBeenCalledExactlyOnceWith("p", scope);
});
it.each(["write-first", "read-first"])(
  "does not resurrect a discarded conflict when abort races a prior document read (%s)",
  async (order) => {
    mergeBridge();
    const read = deferred<GitConflictDocument>(),
      write = deferred<any>();
    api.readGitConflict.mockReturnValue(read.promise);
    api.executeGitMergeOperation.mockReturnValue(write.promise);
    api.readGitWorkspace.mockResolvedValueOnce(snapshot()).mockResolvedValue({
      ...snapshot(),
      operation: "none",
      revision: "9".repeat(64),
      files: [],
    });
    const changed = vi.fn();
    render(view("p", true, 0, vi.fn(), changed));
    fireEvent.click(await screen.findByRole("button", { name: "file.txt" }));
    await waitFor(() => expect(api.readGitConflict).toHaveBeenCalledOnce());
    const startAbort = screen.getByRole("button", {
      name: "Отменить слияние…",
    });
    await waitFor(() => expect(startAbort).toHaveProperty("disabled", false));
    fireEvent.click(startAbort);
    fireEvent.click(
      await screen.findByRole("button", { name: "Отменить слияние" }),
    );
    const done = {
      ...verifiedAbortFacts(),
      scope: "p",
      operation: "merge",
      action: "abort",
      status: "success",
      changed: true,
      lockRetained: false,
      message: "Done",
      log: "",
    };
    // Deliver both replies in the same React batch. The prior document read
    // may settle either before or after the confirmed operation clears drafts.
    await act(async () => {
      if (order === "write-first") write.resolve(done);
      read.resolve(documentFor());
      if (order === "read-first") {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        write.resolve(done);
      }
    });
    await waitFor(() => expect(api.readGitWorkspace).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "file.txt" })).toBeNull(),
    );
    expect(
      screen.queryByRole("region", { name: "Разрешение конфликта: file.txt" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Сохранить файл…" }),
    ).toBeNull();
    expect(changed).toHaveBeenCalledExactlyOnceWith("p", "p");
  },
);

it("returns to file selection and reopens the retained conflict draft without ending merge", async () => {
  const close = vi.fn();
  render(view("p", true, 0, close));
  await select();
  act(() =>
    pane("Результат разрешения")!.dispatch({
      changes: { from: 0, insert: "retained edit\n" },
    }),
  );
  const text = pane("Результат разрешения")!.state.doc.toString();
  const closeFile = screen.getByRole("button", {
    name: "Закрыть файл: file.txt",
  });
  expect(closeFile.closest(".git-file-row")?.textContent).toContain("file.txt");
  expect(screen.queryByRole("button", { name: "К списку файлов" })).toBeNull();
  fireEvent.click(closeFile);
  expect(pane("Результат разрешения")).toBeNull();
  expect(portal.querySelector(".git-workspace-conflicts")).toBeNull();
  expect(screen.getByRole("button", { name: "file.txt" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "other.txt" })).toBeTruthy();
  expect(close).not.toHaveBeenCalled();
  expect(api.prepareGitConflictSave).not.toHaveBeenCalled();
  expect(api.executeGitConflictSave).not.toHaveBeenCalled();
  await select();
  expect(pane("Результат разрешения")!.state.doc.toString()).toBe(text);
  expect(api.readGitConflict).toHaveBeenCalledTimes(1);
});
it.each([false, true])(
  "shows ordinary conflict block actions on entry and enables save (ambiguous source: %s)",
  async (ambiguous) => {
    api.readGitConflict.mockImplementation(async (r: any) => {
      const doc = documentFor(r.path, r.scope);
      const model = generated.replace(
        "=======\r\n",
        "||||||| base\r\nbase\r\n=======\r\n",
      );
      return {
        ...doc,
        working: { kind: "text", text: generated },
        generated: {
          ...doc.generated,
          kind: "text",
          text: model,
          blocks:
            doc.generated.kind === "text"
              ? doc.generated.blocks.map((block) => ({
                  ...block,
                  current: {
                    ...block.current,
                    range: ambiguous ? null : block.current.range,
                  },
                  incoming: {
                    ...block.incoming,
                    range: ambiguous ? null : block.incoming.range,
                  },
                  resultRange: { from: 7, to: model.length - 3 },
                }))
              : [],
        },
      };
    });
    render(view());
    await select();
    await waitFor(() => expect(arrow("Блок 1: принять текущую")).toBeTruthy());
    expect(pane("Результат разрешения")!.state.doc.toString()).toBe(generated);
    expect(screen.getByText("Нерешённых блоков: 1")).toBeTruthy();
    fireEvent.click(arrow("Блок 1: принять текущую"));
    expect(pane("Результат разрешения")!.state.doc.toString()).toBe(
      "start\r\nours\r\nend",
    );
    expect(
      screen.getByRole("button", { name: "Сохранить файл…" }),
    ).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить файл…" }));
    await screen.findByRole("button", { name: "Записать файл и индекс" });
    expect(api.prepareGitConflictSave).toHaveBeenCalledTimes(1);
    expect(api.executeGitConflictSave).not.toHaveBeenCalled();
  },
);
it("explains why a changed working file cannot receive automatic block mapping", async () => {
  render(view());
  await select();
  expect(
    screen.getByText(/Рабочий файл отличается от модели конфликта/),
  ).toBeTruthy();
  expect(pane("Результат разрешения")!.state.doc.toString()).toBe(
    documentFor().working.text,
  );
});

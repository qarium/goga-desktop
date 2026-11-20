// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createSettingsDocuments,
  type DocumentDraft,
  type DocumentSource,
} from "../src/renderer/settings-documents";
import { useDocumentSaveStatus } from "../src/renderer/useDocumentSaveStatus";

const clean: DocumentDraft = {
  document: { text: "value: 1\n", version: "v1", exists: true },
  text: "value: 1\n",
  busy: false,
  error: "",
  notice: "",
};
const source: DocumentSource = {
  scope: "project",
  projectId: "test",
  target: { kind: "config" },
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const advance = (time: number) =>
  act(() => {
    vi.advanceTimersByTime(time);
  });
function status(draft = clean) {
  return renderHook(
    ({ draft, enabled, identity }) =>
      useDocumentSaveStatus(draft, enabled, identity),
    { initialProps: { draft, enabled: true, identity: "file-a" } },
  );
}
it("reports dirty and new-file states without long header labels", () => {
  const ui = status({
    ...clean,
    document: { ...clean.document!, exists: false },
  });
  expect(ui.result.current).toMatchObject({
    text: "Новый файл",
    tone: "neutral",
    showSaving: false,
  });
  expect(ui.result.current.detail).toContain("будет создан");
  ui.rerender({
    draft: {
      ...clean,
      document: { ...clean.document!, exists: false },
      text: "new",
    },
    enabled: true,
    identity: "file-a",
  });
  expect(ui.result.current).toMatchObject({
    text: "Файл: есть изменения",
    tone: "dirty",
  });
  expect(ui.result.current.detail).toContain("будет создан");
});
it("delays saving progress by 250ms and cancels fast and previous writes", () => {
  const pending = { ...clean, busy: true, saving: true };
  const ui = status(pending);
  advance(249);
  expect(ui.result.current.showSaving).toBe(false);
  advance(1);
  expect(ui.result.current).toMatchObject({
    text: "Сохраняем…",
    tone: "saving",
    showSaving: true,
  });
  const next = { ...pending };
  ui.rerender({ draft: next, enabled: true, identity: "file-b" });
  expect(ui.result.current.showSaving).toBe(false);
  advance(100);
  ui.rerender({ draft: clean, enabled: true, identity: "file-b" });
  advance(500);
  expect(ui.result.current).toMatchObject({
    text: "Файл: нет изменений",
    tone: "neutral",
    showSaving: false,
  });
});
it("shows successful save for 3s from actual completion, including time zero", () => {
  const ui = status({ ...clean, noticeKind: "saved" as const, notice: "Сохранено", savedAt: 0 });
  expect(ui.result.current).toMatchObject({
    text: "Файл: сохранен",
    tone: "success",
  });
  advance(2999);
  expect(ui.result.current.text).toBe("Файл: сохранен");
  advance(1);
  expect(ui.result.current).toMatchObject({
    text: "Файл: нет изменений",
    tone: "neutral",
  });
});
it("does not replay expired success after hiding, remounting or changing source", () => {
  const saved = { ...clean, noticeKind: "saved" as const, notice: "Сохранено", savedAt: 0 };
  const ui = status(saved);
  advance(1000);
  ui.rerender({ draft: saved, enabled: false, identity: "file-a" });
  advance(3000);
  ui.rerender({ draft: saved, enabled: true, identity: "file-a" });
  expect(ui.result.current.text).toBe("Файл: нет изменений");
  ui.rerender({ draft: clean, enabled: true, identity: "file-b" });
  expect(ui.result.current.text).toBe("Файл: нет изменений");
  ui.unmount();
  expect(status(saved).result.current.text).toBe("Файл: нет изменений");
});
it("resumes only the remaining success lifetime when coming back quickly", () => {
  const saved = { ...clean, noticeKind: "saved" as const, notice: "Сохранено", savedAt: 0 };
  const ui = status(saved);
  advance(1000);
  ui.rerender({ draft: saved, enabled: false, identity: "file-a" });
  advance(1000);
  ui.rerender({ draft: saved, enabled: true, identity: "file-a" });
  expect(ui.result.current.text).toBe("Файл: сохранен");
  advance(1000);
  expect(ui.result.current.text).toBe("Файл: нет изменений");
});
it("never lets a prior success timer overwrite edits or a new success", () => {
  const ui = status({ ...clean, noticeKind: "saved" as const, notice: "Сохранено", savedAt: 0 });
  advance(2000);
  ui.rerender({
    draft: { ...clean, text: "changed" },
    enabled: true,
    identity: "file-a",
  });
  advance(1100);
  expect(ui.result.current).toMatchObject({
    text: "Файл: есть изменения",
    tone: "dirty",
  });
  ui.rerender({
    draft: { ...clean, noticeKind: "saved" as const, notice: "Сохранено", savedAt: 3100 },
    enabled: true,
    identity: "file-a",
  });
  advance(2000);
  expect(ui.result.current.text).toBe("Файл: сохранен");
  advance(1000);
  expect(ui.result.current.text).toBe("Файл: нет изменений");
});
it("does not expire or disguise real warnings and failed writes", () => {
  const warning =
    "Файлы проекта могли измениться. Ваш черновик сохранён; перед записью проверяется версия файла.";
  const ui = status({ ...clean, notice: warning, savedAt: 0 });
  advance(10000);
  expect(ui.result.current).toMatchObject({
    text: "Проверьте файл",
    tone: "warning",
    detail: warning,
  });
  ui.rerender({
    draft: { ...clean, text: "draft", error: "Файл изменён извне", savedAt: 0 },
    enabled: true,
    identity: "file-a",
  });
  advance(10000);
  expect(ui.result.current).toMatchObject({
    text: "Не сохранено",
    tone: "error",
    detail: "Файл изменён извне",
  });
});
it("timestamps only actual project success and clears it on edits/reset", async () => {
  let finish!: (value: unknown) => void;
  window.goga = {
    readProjectDocument: vi.fn(async () => clean.document),
    saveProjectDocument: vi.fn(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    ),
  } as any;
  const store = createSettingsDocuments();
  await store.open(source);
  store.edit(source, "value: 2\n");
  const saving = store.save(source);
  expect(store.get(source).savedAt).toBeUndefined();
  advance(500);
  finish({ ...clean.document, text: "value: 2\n", version: "v2" });
  await saving;
  expect(store.get(source)).toMatchObject({
    noticeKind: "saved" as const, notice: "Сохранено",
    savedAt: 500,
    busy: false,
  });
  store.edit(source, "value: 3\n");
  expect(store.get(source).savedAt).toBeUndefined();
  expect(store.get(source).notice).toBe("");
  store.reset(source);
  expect(store.get(source).savedAt).toBeUndefined();
});

it("never records success for failed saves or mutates the source when success expires", async () => {
  window.goga = {
    readProjectDocument: vi.fn(async () => clean.document),
    saveProjectDocument: vi.fn(async () => ({
      ...clean.document,
      version: "v2",
    })),
  } as any;
  const store = createSettingsDocuments();
  await store.open(source);
  await store.save(source);
  const saved = store.get(source);
  const ui = status(saved);
  advance(3000);
  expect(ui.result.current.text).toBe("Файл: нет изменений");
  expect(store.get(source)).toBe(saved);
  expect(store.get(source).notice).toBe("Сохранено");
  window.goga.saveProjectDocument = vi.fn(async () => {
    throw new Error("Внешний конфликт");
  });
  expect(await store.save(source)).toBe(false);
  expect(store.get(source).savedAt).toBeUndefined();
  expect(store.get(source).notice).toBe("");
  expect(store.get(source).error).toContain("Внешний конфликт");
});

it("does not let a delayed progress callback leak to a different active file", () => {
  const pending = { ...clean, busy: true, saving: true };
  const ui = status(pending);
  advance(200);
  ui.rerender({ draft: clean, enabled: true, identity: "another-topic/file" });
  advance(1000);
  expect(ui.result.current).toMatchObject({
    text: "Файл: нет изменений",
    tone: "neutral",
    showSaving: false,
  });
});

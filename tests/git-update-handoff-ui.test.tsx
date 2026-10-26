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
import { GitUpdateHandoff } from "../src/renderer/GitUpdateHandoff";
import type { GitUpdateHandoffCandidate } from "../src/shared/git-update-handoff";
const scope = {
  projectId: "p",
  year: "2026",
  topic: "t",
  branch: "topic",
  contextId: "ctx-" + "1".repeat(64),
  revision: "11111111-1111-4111-8111-111111111111",
};
let expiresAt: number;
const candidate = (): GitUpdateHandoffCandidate => ({
  candidateId: "a".repeat(64),
  scope,
  root: "/fixture/topic",
  targetBranch: "topic",
  targetHead: "b".repeat(40),
  sourceRef: "refs/goga/source",
  sourceOid: "c".repeat(40),
  baseRef: "main",
  strategy: "ff-else-rebase",
  algorithm: "rebase",
  conflicts: ["file.txt"],
  expiresAt,
});
const preview = (c = candidate()) => ({
  token: "d".repeat(64),
  candidate: c,
  hooks: "disabled",
  publishes: false,
  effects: "Рабочие файлы и индекс будут изменены.",
  expiresAt: c.expiresAt,
});
const result = () => ({
  scope,
  root: "/fixture/topic",
  algorithm: "rebase",
  status: "conflict",
  changed: true,
  conflicts: ["file.txt"],
  message: "Конфликт подготовлен",
  log: "native git journal",
});
let api: any;
const deferred = () => {
  let resolve!: (v: any) => void;
  const promise = new Promise<any>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
beforeEach(() => {
  expiresAt = Date.now() + 300000;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  api = {
    readGitWorkspace: vi.fn(async () => ({
      scope,
      root: "/fixture/topic",
      revision: "e".repeat(64),
      branch: "topic",
      head: "b".repeat(40),
      operation: "none",
      files: [],
    })),
    prepareGitUpdateHandoff: vi.fn(async () => preview()),
    executeGitUpdateHandoff: vi.fn(async () => result()),
    cancelRead: vi.fn(async () => {}),
  };
  window.goga = api;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function mount(c = candidate()) {
  const onChanged = vi.fn(),
    onClose = vi.fn();
  return {
    ...render(
      <GitUpdateHandoff
        candidate={c}
        onChanged={onChanged}
        onClose={onClose}
      />,
    ),
    onChanged,
    onClose,
  };
}
async function prepare() {
  fireEvent.click(
    screen.getByRole("button", { name: "Разрешить конфликт вручную…" }),
  );
  await screen.findByRole("button", {
    name: "Подтвердить переход к конфликту",
  });
}
it("не читает и не пишет до запроса; отмена подтверждения не запускает запись", async () => {
  const view = mount();
  expect(api.readGitWorkspace).not.toHaveBeenCalled();
  await prepare();
  fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  expect(view.onClose).toHaveBeenCalledOnce();
  expect(api.executeGitUpdateHandoff).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("показывает точные параметры; исполняет только токен и обновляет только подтверждённый scope", async () => {
  const c = candidate();
  api.prepareGitUpdateHandoff.mockResolvedValue(preview(c));
  const view = mount(c);
  await prepare();
  expect(api.prepareGitUpdateHandoff).toHaveBeenCalledWith({
    candidateId: c.candidateId,
    scope,
    revision: "e".repeat(64),
  });
  for (const text of [
    c.root,
    c.targetBranch,
    c.sourceOid,
    c.baseRef,
    c.strategy,
    c.algorithm,
  ])
    expect(screen.getAllByText(text).length).toBeGreaterThan(0);
  expect(screen.getByText(/Git-хуки отключены/)).toBeTruthy();
  expect(screen.getByText(/не публикуется на сервер/)).toBeTruthy();
  expect(api.executeGitUpdateHandoff).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Подтвердить переход к конфликту" }),
  );
  await waitFor(() =>
    expect(view.onChanged).toHaveBeenCalledExactlyOnceWith(scope),
  );
  expect(api.executeGitUpdateHandoff).toHaveBeenCalledExactlyOnceWith(
    "d".repeat(64),
  );
  expect(screen.getByText(/native git journal/)).toBeTruthy();
});
it.each([
  "root",
  "scope",
  "algorithm",
  "sourceOid",
  "strategy",
  "targetBranch",
])(
  "отклоняет несовпадение %s в подтверждении без раскрытия данных",
  async (field) => {
    const p = preview();
    (p.candidate as any)[field] =
      field === "scope"
        ? { ...scope, revision: "22222222-2222-4222-8222-222222222222" }
        : field === "algorithm"
          ? "merge"
          : field === "strategy"
            ? "merge"
            : field === "sourceOid"
              ? "f".repeat(40)
              : "PRIVATE-OTHER-OWNER";
    api.prepareGitUpdateHandoff.mockResolvedValue(p);
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: "Разрешить конфликт вручную…" }),
    );
    await screen.findByRole("alert");
    expect(screen.queryByText(/PRIVATE-OTHER-OWNER/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Подтвердить переход к конфликту" }),
    ).toBeNull();
    expect(api.executeGitUpdateHandoff).not.toHaveBeenCalled();
  },
);
it.each(["readGitWorkspace", "prepareGitUpdateHandoff"])(
  "ошибка %s прекращает загрузку и оставляет окно закрываемым",
  async (method) => {
    api[method].mockRejectedValue(Error("read failed"));
    const view = mount();
    fireEvent.click(
      screen.getByRole("button", { name: "Разрешить конфликт вручную…" }),
    );
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("read failed"),
    );
    expect(screen.queryByText("Проверяем состояние Git…")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Закрыть подтверждение перехода" }),
    );
    expect(view.onClose).toHaveBeenCalledOnce();
  },
);
it("не готовит подтверждение для другого корня snapshot", async () => {
  api.readGitWorkspace.mockResolvedValue({
    scope,
    root: "/other",
    revision: "e".repeat(64),
  });
  mount();
  fireEvent.click(
    screen.getByRole("button", { name: "Разрешить конфликт вручную…" }),
  );
  await screen.findByRole("alert");
  expect(api.prepareGitUpdateHandoff).not.toHaveBeenCalled();
});
it("отменяет чтение при размонтировании и игнорирует поздний preview", async () => {
  const pending = deferred();
  api.prepareGitUpdateHandoff.mockReturnValue(pending.promise);
  const view = mount();
  fireEvent.click(
    screen.getByRole("button", { name: "Разрешить конфликт вручную…" }),
  );
  await waitFor(() =>
    expect(api.prepareGitUpdateHandoff).toHaveBeenCalledOnce(),
  );
  view.unmount();
  await act(async () => pending.resolve(preview()));
  expect(api.cancelRead).toHaveBeenCalled();
  expect(view.onChanged).not.toHaveBeenCalled();
  expect(api.executeGitUpdateHandoff).not.toHaveBeenCalled();
});
it.each(["uncertain", "error"])(
  "сохраняет диагностику %s, но не объявляет подтверждённый конфликт",
  async (status) => {
    api.executeGitUpdateHandoff.mockResolvedValue({
      ...result(),
      status,
      message: "inspect manually",
      log: "retained journal",
    });
    const view = mount();
    await prepare();
    fireEvent.click(
      screen.getByRole("button", { name: "Подтвердить переход к конфликту" }),
    );
    expect(await screen.findByText(/retained journal/)).toBeTruthy();
    expect(screen.getByText(/inspect manually/)).toBeTruthy();
    expect(view.onChanged).not.toHaveBeenCalled();
    expect(api.executeGitUpdateHandoff).toHaveBeenCalledOnce();
  },
);
it.each(["scope", "root", "algorithm"])(
  "не раскрывает результат другого %s",
  async (field) => {
    const r: any = {
      ...result(),
      message: "PRIVATE-RESULT",
      log: "PRIVATE-JOURNAL",
    };
    r[field] =
      field === "scope"
        ? { ...scope, contextId: "ctx-" + "2".repeat(64) }
        : field === "algorithm"
          ? "merge"
          : "/other";
    api.executeGitUpdateHandoff.mockResolvedValue(r);
    const view = mount();
    await prepare();
    fireEvent.click(
      screen.getByRole("button", { name: "Подтвердить переход к конфликту" }),
    );
    await screen.findByRole("alert");
    expect(screen.queryByText(/PRIVATE-/)).toBeNull();
    expect(view.onChanged).not.toHaveBeenCalled();
  },
);
it("позволяет закрыть выполняющуюся запись без её отмены и позднего callback", async () => {
  const pending = deferred();
  api.executeGitUpdateHandoff.mockReturnValue(pending.promise);
  const view = mount();
  await prepare();
  fireEvent.click(
    screen.getByRole("button", { name: "Подтвердить переход к конфликту" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Закрыть подтверждение перехода" }),
  );
  expect(view.onClose).toHaveBeenCalledOnce();
  view.unmount();
  await act(async () => pending.resolve(result()));
  expect(view.onChanged).not.toHaveBeenCalled();
  expect(api.cancelRead).not.toHaveBeenCalled();
});
it("смена владельца во время записи исключает поздний callback и данные старого владельца", async () => {
  const pending = deferred();
  api.executeGitUpdateHandoff.mockReturnValue(pending.promise);
  const view = mount();
  await prepare();
  fireEvent.click(
    screen.getByRole("button", { name: "Подтвердить переход к конфликту" }),
  );
  view.rerender(
    <GitUpdateHandoff
      candidate={{ ...candidate(), scope: { ...scope, topic: "other" } }}
      onClose={view.onClose}
      onChanged={view.onChanged}
    />,
  );
  await act(async () => pending.resolve(result()));
  expect(view.onChanged).not.toHaveBeenCalled();
  expect(screen.queryByText(/native git journal/)).toBeNull();
});
it("зависшее чтение ограничено дедлайном; после таймаута поздний ответ не запускает prepare", async () => {
  vi.useFakeTimers();
  const pending = deferred();
  api.readGitWorkspace.mockReturnValue(pending.promise);
  const view = mount();
  fireEvent.click(
    screen.getByRole("button", { name: "Разрешить конфликт вручную…" }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30001);
  });
  expect(screen.getByRole("alert").textContent).toContain(
    "Превышено время ожидания",
  );
  expect(screen.queryByText("Проверяем состояние Git…")).toBeNull();
  await act(async () =>
    pending.resolve({
      scope,
      root: "/fixture/topic",
      revision: "e".repeat(64),
    }),
  );
  expect(api.prepareGitUpdateHandoff).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Закрыть подтверждение перехода" }),
  );
  expect(view.onClose).toHaveBeenCalledOnce();
});
it("истёкший preview больше не позволяет выполнить запись", async () => {
  vi.useFakeTimers();
  mount();
  fireEvent.click(
    screen.getByRole("button", { name: "Разрешить конфликт вручную…" }),
  );
  await act(async () => {});
  expect(
    screen.getByRole("button", { name: "Подтвердить переход к конфликту" }),
  ).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300001);
  });
  expect(
    screen.queryByRole("button", { name: "Подтвердить переход к конфликту" }),
  ).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain(
    "Срок подтверждения истёк",
  );
  expect(api.executeGitUpdateHandoff).not.toHaveBeenCalled();
});
it("двойное подтверждение не повторяет запись", async () => {
  const pending = deferred();
  api.executeGitUpdateHandoff.mockReturnValue(pending.promise);
  mount();
  await prepare();
  const button = screen.getByRole("button", {
    name: "Подтвердить переход к конфликту",
  });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(api.executeGitUpdateHandoff).toHaveBeenCalledOnce();
  await act(async () => pending.resolve(result()));
});
it("отклонённая запись сохраняет причину ошибки и не повторяется", async () => {
  api.executeGitUpdateHandoff.mockRejectedValue(
    Error("native launch rejected"),
  );
  const view = mount();
  await prepare();
  fireEvent.click(
    screen.getByRole("button", { name: "Подтвердить переход к конфликту" }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "native launch rejected",
  );
  expect(view.onChanged).not.toHaveBeenCalled();
  expect(api.executeGitUpdateHandoff).toHaveBeenCalledOnce();
});
it("main-shell handoff prepares on request without executing automatically", async () => {
  render(
    <GitUpdateHandoff
      candidate={candidate()}
      autoPrepare
      onClose={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
  await screen.findByRole("button", {
    name: "Подтвердить переход к конфликту",
  });
  expect(api.prepareGitUpdateHandoff).toHaveBeenCalledOnce();
  expect(api.executeGitUpdateHandoff).not.toHaveBeenCalled();
});
it("keeps handoff actions in the padded non-shrinking confirmation footer", async () => {
  mount();
  await prepare();
  const confirm = screen.getByRole("button", {
    name: "Подтвердить переход к конфликту",
  });
  const cancel = screen.getByRole("button", { name: "Отмена" });
  const actions = confirm.closest(".git-branch-dialog-actions");
  expect(actions).not.toBeNull();
  expect(
    actions?.parentElement?.classList.contains("git-merge-operation-confirm"),
  ).toBe(true);
  expect(cancel.closest(".git-merge-operation-confirm")).toBe(
    actions?.parentElement,
  );
  expect(
    actions?.parentElement?.parentElement?.classList.contains(
      "git-merge-operation-form",
    ),
  ).toBe(true);
  expect(actions?.closest(".git-merge-operation-details")).toBeNull();
});

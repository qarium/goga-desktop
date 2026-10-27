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
import { GitDiscardFooter, useGitDiscard } from "../src/renderer/GitDiscard";
import type { GitWorkspaceSnapshot } from "../src/shared/git-workspace";
import type {
  GitDiscardPreview,
  GitDiscardResult,
} from "../src/shared/git-discard";
const revision = "a".repeat(64);
const snapshot = (scope = "p"): GitWorkspaceSnapshot => ({
  scope,
  root: `/fixture/${scope}`,
  revision,
  head: "b".repeat(40),
  branch: "main",
  upstream: null,
  ahead: 0,
  behind: 0,
  operation: "none",
  files: ["one.txt", "other.txt"].map((path) => ({
    path,
    kind: "tracked",
    indexStatus: "M",
    worktreeStatus: "M",
    submodule: false,
  })),
});
const preview = (scope = "p"): GitDiscardPreview => ({
  scope,
  token: "1".repeat(64),
  root: `/fixture/${scope}`,
  branch: "main",
  head: "b".repeat(40),
  paths: ["one.txt", "old.txt", "new.txt"],
  items: [
    { path: "one.txt", action: "restore" },
    { path: "old.txt", action: "restore" },
    { path: "new.txt", action: "trash" },
  ],
  expiresAt: Date.now() + 300000,
});
const result = (
  status: GitDiscardResult["status"] = "discarded",
): GitDiscardResult => ({
  scope: "p",
  status,
  changedPaths: ["one.txt"],
  trashedPaths: [],
  indexPublished: status === "discarded",
  worktreePublished: status === "discarded",
  message: status === "discarded" ? "Изменения отменены" : "Проверьте Git",
  log: "",
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
let api: any;
let changed: ReturnType<typeof vi.fn<(paths: string[]) => void>>;
let state: ReturnType<typeof useGitDiscard>;
function View({
  scope = "p",
  disabled = false,
  visible = true,
  data = snapshot(scope),
  paths = ["one.txt"],
}: {
  scope?: string;
  disabled?: boolean;
  visible?: boolean;
  data?: GitWorkspaceSnapshot;
  paths?: string[];
}) {
  state = useGitDiscard(scope, changed);
  return (
    <GitDiscardFooter
      discard={state}
      snapshot={data}
      selectedPaths={paths}
      disabled={disabled}
      visible={visible}
    />
  );
}
const prepare = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Отменить изменения…" }));
  return screen.findByRole("button", { name: "Отменить выбранные изменения" });
};
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  changed = vi.fn();
  api = {
    prepareGitDiscard: vi.fn(async () => preview()),
    executeGitDiscard: vi.fn(async () => result()),
    cancelRead: vi.fn(async () => {}),
  };
  window.goga = api;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("prepares selected files without a commit message and shows precise expanded restore/trash consequences", async () => {
  render(<View />);
  await prepare();
  expect(api.prepareGitDiscard).toHaveBeenCalledWith({
    scope: "p",
    revision,
    paths: ["one.txt"],
  });
  expect(screen.getByText("/fixture/p")).toBeTruthy();
  expect(screen.getByText("main")).toBeTruthy();
  expect(screen.getByText("b".repeat(40))).toBeTruthy();
  expect(
    screen.getByText(/Подготовленные изменения выбранных файлов тоже/),
  ).toBeTruthy();
  expect(screen.getByText("Восстановить из HEAD")).toBeTruthy();
  expect(screen.getByText("Переместить в Корзину")).toBeTruthy();
  for (const path of preview().paths)
    expect(screen.getByText(path)).toBeTruthy();
  expect(api.executeGitDiscard).not.toHaveBeenCalled();
});
it("cancels confirmation without a mutation", async () => {
  render(<View />);
  await prepare();
  fireEvent.click(
    screen.getByRole("button", { name: "Закрыть подтверждение отмены" }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.executeGitDiscard).not.toHaveBeenCalled();
});
it.each(["merge", "rebase", "cherry-pick", "revert", "unknown"] as const)(
  "blocks discard during %s",
  (operation) => {
    render(<View data={{ ...snapshot(), operation }} />);
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Отменить изменения…",
      }).disabled,
    ).toBe(true);
  },
);
it("blocks conflict, missing selection and cross-operation locks", () => {
  const v = render(<View disabled />);
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Отменить изменения…",
    }).disabled,
  ).toBe(true);
  v.rerender(<View paths={["missing.txt"]} />);
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Отменить изменения…",
    }).disabled,
  ).toBe(true);
  v.rerender(
    <View
      data={{
        ...snapshot(),
        files: [{ ...snapshot().files[0], kind: "conflict" }],
      }}
    />,
  );
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Отменить изменения…",
    }).disabled,
  ).toBe(true);
});
it("blocks already-open confirmation after snapshot freshness changes or another mutation locks the workspace", async () => {
  const v = render(<View />);
  await prepare();
  v.rerender(<View data={{ ...snapshot(), revision: "c".repeat(64) }} />);
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Отменить выбранные изменения",
    }).disabled,
  ).toBe(true);
  v.rerender(<View disabled />);
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Отменить выбранные изменения",
    }).disabled,
  ).toBe(true);
});
it("shows a dismissible prepare error and allows a new preparation", async () => {
  api.prepareGitDiscard.mockRejectedValueOnce(Error("Снимок устарел"));
  render(<View />);
  fireEvent.click(screen.getByRole("button", { name: "Отменить изменения…" }));
  expect(await screen.findByText("Снимок устарел")).toBeTruthy();
  fireEvent.click(
    await screen.findByRole("button", { name: "Закрыть результат отмены" }),
  );
  await prepare();
  expect(api.executeGitDiscard).not.toHaveBeenCalled();
});
it("finishes preparation at its finite deadline and never writes", async () => {
  vi.useFakeTimers();
  api.prepareGitDiscard.mockImplementation(() => new Promise(() => {}));
  render(<View />);
  fireEvent.click(screen.getByRole("button", { name: "Отменить изменения…" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30001);
  });
  expect(screen.getByText(/Превышено время ожидания/)).toBeTruthy();
  expect(state.pending).toBeNull();
  expect(api.executeGitDiscard).not.toHaveBeenCalled();
  expect(api.cancelRead).toHaveBeenCalledOnce();
});
it("ignores a delayed preview after owner change and cancels only its read", async () => {
  const pending = deferred<GitDiscardPreview>();
  api.prepareGitDiscard.mockReturnValueOnce(pending.promise);
  const v = render(<View />);
  fireEvent.click(screen.getByRole("button", { name: "Отменить изменения…" }));
  v.rerender(<View scope="q" />);
  await act(async () => pending.resolve(preview()));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.cancelRead).toHaveBeenCalledOnce();
});
it("rejects a foreign preview", async () => {
  api.prepareGitDiscard.mockResolvedValueOnce(preview("q"));
  render(<View />);
  fireEvent.click(screen.getByRole("button", { name: "Отменить изменения…" }));
  expect(await screen.findByText(/другому контексту/)).toBeTruthy();
  expect(state.preview).toBeNull();
});
it("executes once with token only, stays pending beyond read timeout, refreshes and clears only approved files on success", async () => {
  const pending = deferred<GitDiscardResult>();
  api.executeGitDiscard.mockReturnValueOnce(pending.promise);
  const v = render(<View />);
  await prepare();
  vi.useFakeTimers();
  await act(async () => {
    void state.execute();
    void state.execute();
  });
  v.rerender(<View visible={false} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30001);
  });
  expect(state.pending).toBe("execute");
  expect(api.cancelRead).not.toHaveBeenCalled();
  await act(async () => pending.resolve(result()));
  vi.useRealTimers();
  expect(api.executeGitDiscard).toHaveBeenCalledExactlyOnceWith("1".repeat(64));
  expect(changed).toHaveBeenCalledExactlyOnceWith(preview().paths);
});
it.each(["uncertain", "not-discarded"] as const)(
  "refreshes after %s, retains selection and requires fresh check when partial",
  async (status) => {
    api.executeGitDiscard.mockResolvedValueOnce({
      ...result(status),
      worktreePublished: true,
    });
    render(<View />);
    fireEvent.click(await prepare());
    await waitFor(() => expect(changed).toHaveBeenCalledExactlyOnceWith([]));
    expect(state.uncertain).toBe(true);
    expect(state.locked).toBe(true);
    fireEvent.click(
      await screen.findByRole("button", { name: "Закрыть результат отмены" }),
    );
    expect(state.locked).toBe(true);
    act(() => state.manualRefresh());
    expect(state.locked).toBe(false);
  },
);
it("refreshes after transport failure without clearing selection and remains locked until checked", async () => {
  api.executeGitDiscard.mockRejectedValueOnce(Error("IPC interrupted"));
  render(<View />);
  fireEvent.click(await prepare());
  await waitFor(() => expect(changed).toHaveBeenCalledExactlyOnceWith([]));
  expect(state.uncertain).toBe(true);
  expect(screen.getByText(/IPC interrupted/)).toBeTruthy();
});
it("does not apply a late write response to a replacement owner", async () => {
  const pending = deferred<GitDiscardResult>();
  api.executeGitDiscard.mockReturnValueOnce(pending.promise);
  const v = render(<View />);
  fireEvent.click(await prepare());
  v.rerender(<View scope="q" />);
  await act(async () => pending.resolve(result()));
  expect(changed).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("never clears selection from a foreign result", async () => {
  api.executeGitDiscard.mockResolvedValueOnce({ ...result(), scope: "q" });
  render(<View />);
  fireEvent.click(await prepare());
  await waitFor(() => expect(changed).toHaveBeenCalledExactlyOnceWith([]));
  expect(state.uncertain).toBe(true);
});
it.each(["hidden", "locked"])(
  "cancels preparation when workspace becomes %s without accepting late response",
  async (reason) => {
    const pending = deferred<GitDiscardPreview>();
    api.prepareGitDiscard.mockReturnValueOnce(pending.promise);
    const v = render(<View />);
    fireEvent.click(
      screen.getByRole("button", { name: "Отменить изменения…" }),
    );
    v.rerender(
      <View visible={reason !== "hidden"} disabled={reason === "locked"} />,
    );
    await act(async () => pending.resolve(preview()));
    expect(api.cancelRead).toHaveBeenCalledOnce();
    expect(state.pending).toBeNull();
    expect(state.preview).toBeNull();
    expect(api.executeGitDiscard).not.toHaveBeenCalled();
  },
);
it("does not clear selection after a clean refusal and allows a new preparation", async () => {
  api.executeGitDiscard.mockResolvedValueOnce({
    ...result("not-discarded"),
    changedPaths: [],
  });
  render(<View />);
  fireEvent.click(await prepare());
  await waitFor(() => expect(changed).toHaveBeenCalledExactlyOnceWith([]));
  expect(state.uncertain).toBe(false);
  fireEvent.click(
    await screen.findByRole("button", { name: "Закрыть результат отмены" }),
  );
  await prepare();
});
it("treats a fully published discard with a recovery backup as success and shows the backup", async () => {
  api.executeGitDiscard.mockResolvedValueOnce({
    ...result(),
    recoveryPath: "/synthetic/recovery/backup",
  });
  render(<View />);
  fireEvent.click(await prepare());
  await waitFor(() =>
    expect(changed).toHaveBeenCalledExactlyOnceWith(preview().paths),
  );
  expect(state.uncertain).toBe(false);
  expect(
    screen.getByText(/Материалы восстановления: \/synthetic\/recovery\/backup/),
  ).toBeTruthy();
});

it("separates the destructive confirmation action from the explanation", async () => {
  render(<View />);
  await prepare();
  const button = screen.getByRole("button", {
    name: "Отменить выбранные изменения",
  });
  expect(
    button.parentElement?.classList.contains("git-discard-confirm-actions"),
  ).toBe(true);
});

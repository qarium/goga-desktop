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
import { GitBranchPicker } from "../src/renderer/GitBranchPicker";
import { RetainedViews } from "../src/renderer/RetainedViews";
const oid = "b".repeat(40),
  revision = "a".repeat(64);
const row = (name: string, remote = false, upstream: string | null = null) => ({
  name,
  ref: `${remote ? "refs/remotes/" : "refs/heads/"}${name}`,
  oid,
  upstream,
  checkedOut: false,
});
const deferred = () => {
  let resolve!: (v: any) => void;
  const promise = new Promise<any>((r) => (resolve = r));
  return { resolve, promise };
};
let inventory: any, api: any;
const success = () => ({
  projectId: "p",
  action: "fetch",
  status: "success",
  changed: true,
  message: "Обновлено",
  log: "",
});
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  inventory = {
    projectId: "p",
    root: "/fixture/p",
    revision,
    head: oid,
    branch: "main",
    upstream: "refs/remotes/origin/main",
    operation: "none",
    dirty: false,
    local: [row("main", false, "refs/remotes/origin/main"), row("feature")],
    remote: [row("origin/main", true), row("origin/legacy", true)],
  };
  api = {
    readGitBranches: vi.fn(async () => inventory),
    prepareGitBranch: vi.fn(async (r: any) => ({
      token: "c".repeat(64),
      projectId: r.projectId,
      action: r.action,
      root: "/fixture/p",
      remote: r.action === "fetch" ? "origin" : null,
      toRef: r.ref,
      fromRef: "refs/heads/main",
      fromOid: oid,
      toOid: oid,
      sourceRef: null,
      createsBranch: r.action === "switch-remote",
      switchesBranch: r.action.startsWith("switch"),
      hooks: "disabled",
      expiresAt: Date.now() + 300000,
    })),
    executeGitBranch: vi.fn(async () => success()),
  };
  Object.defineProperty(window, "goga", { value: api, configurable: true });
});
afterEach(cleanup);
const view = (props: any = {}) => (
  <GitBranchPicker
    projectId="p"
    branch="main"
    revision={0}
    onChanged={() => {}}
    {...props}
  />
);
async function open() {
  fireEvent.click(screen.getByRole("button", { name: "Ветка: main" }));
  await screen.findByRole("button", { name: "feature" });
}
const update = () =>
  fireEvent.click(screen.getByRole("button", { name: "Обновить из origin" }));
const remote = () =>
  fireEvent.click(screen.getByRole("tab", { name: "Удалённые" }));
it("updates origin in place from either tab, preserves search, guards duplicates and marks new refs", async () => {
  const flight = deferred();
  api.executeGitBranch.mockReturnValue(flight.promise);
  render(view());
  await open();
  expect(
    screen.getByRole("button", { name: "Обновить из origin" }),
  ).toBeTruthy();
  remote();
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "fresh" },
  });
  update();
  update();
  await waitFor(() => expect(api.executeGitBranch).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("dialog", { name: "Выбор ветки" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Подтвердить" })).toBeNull();
  expect(screen.getByRole("searchbox")).toHaveProperty("value", "fresh");
  expect(
    screen
      .getByRole("tab", { name: "Удалённые" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.queryByRole("status", { name: "Загружаем ветки…" })).toBeNull();
  inventory = {
    ...inventory,
    revision: "d".repeat(64),
    remote: [...inventory.remote, row("origin/fresh", true)],
  };
  await act(async () => flight.resolve(success()));
  expect(
    await screen.findByRole("button", { name: "origin/fresh" }),
  ).toBeTruthy();
  expect(screen.getByText("Новая")).toBeTruthy();
  expect(screen.getByRole("searchbox")).toHaveProperty("value", "fresh");
  expect(api.prepareGitBranch).toHaveBeenCalledWith({
    projectId: "p",
    revision,
    action: "fetch",
  });
  fireEvent.click(screen.getByRole("button", { name: "origin/fresh" }));
  await waitFor(() =>
    expect(api.prepareGitBranch).toHaveBeenLastCalledWith({
      projectId: "p",
      revision: "d".repeat(64),
      action: "switch-remote",
      ref: "refs/remotes/origin/fresh",
    }),
  );
  expect(
    await screen.findByRole("button", { name: "Подтвердить" }),
  ).toBeTruthy();
  expect(api.executeGitBranch).toHaveBeenCalledTimes(1);
});
it("keeps the local tab and explains new remote branches hidden by its filter", async () => {
  api.executeGitBranch.mockImplementation(async () => {
    inventory = {
      ...inventory,
      remote: [...inventory.remote, row("origin/fresh", true)],
    };
    return success();
  });
  render(view());
  await open();
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "not-found" },
  });
  update();
  expect(await screen.findByText(/Новые ветки скрыты/)).toBeTruthy();
  expect(
    screen
      .getByRole("tab", { name: "Локальные" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Показать новые ветки" }));
  expect(
    await screen.findByRole("button", { name: "origin/fresh" }),
  ).toBeTruthy();
  expect(screen.getByRole("searchbox")).toHaveProperty("value", "");
});
it("allows fetch with dirty files but keeps checkout disabled", async () => {
  inventory.dirty = true;
  render(view());
  await open();
  update();
  await waitFor(() => expect(api.executeGitBranch).toHaveBeenCalledOnce());
  remote();
  expect(screen.getByRole("button", { name: "origin/legacy" })).toHaveProperty(
    "disabled",
    true,
  );
});
it("shows admission and network errors inline without losing the list or issuing automatic retry", async () => {
  api.prepareGitBranch.mockRejectedValueOnce(Error("origin не настроен"));
  render(view());
  await open();
  update();
  expect((await screen.findByRole("alert")).textContent).toContain(
    "origin не настроен",
  );
  expect(screen.getByRole("button", { name: "feature" })).toBeTruthy();
  expect(api.executeGitBranch).not.toHaveBeenCalled();
  api.executeGitBranch.mockResolvedValueOnce({
    ...success(),
    status: "error",
    message: "Сеть недоступна",
  });
  update();
  expect(await screen.findByText(/Сеть недоступна/)).toBeTruthy();
  expect(screen.getByRole("dialog", { name: "Выбор ветки" })).toBeTruthy();
  expect(api.executeGitBranch).toHaveBeenCalledOnce();
});
it("does not report success if the final inventory read fails", async () => {
  api.readGitBranches
    .mockResolvedValueOnce(inventory)
    .mockResolvedValueOnce(inventory)
    .mockRejectedValueOnce(Error("Чтение не удалось"));
  render(view());
  await open();
  update();
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Чтение не удалось",
  );
  expect(screen.getByText(/Показан прежний список/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "feature" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(screen.queryByText(/Список веток обновлён/)).toBeNull();
});
it("requires explicit state verification after uncertain diagnostics, never silently retries execute", async () => {
  api.executeGitBranch.mockResolvedValueOnce({
    ...success(),
    status: "uncertain",
    message: "Проверьте Git",
    retainedLocks: ["index.lock"],
  });
  render(view());
  await open();
  update();
  expect((await screen.findByRole("alert")).textContent).toContain(
    "index.lock",
  );
  expect(
    screen.getByRole("button", { name: "Обновить из origin" }),
  ).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Проверить состояние" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Обновить из origin" }),
    ).toHaveProperty("disabled", false),
  );
  expect(api.executeGitBranch).toHaveBeenCalledOnce();
});
it("keeps a closed menu closed and discards new badges on reopening", async () => {
  const f = deferred();
  api.executeGitBranch.mockReturnValue(f.promise);
  render(view());
  await open();
  update();
  await waitFor(() => expect(api.executeGitBranch).toHaveBeenCalledOnce());
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
  inventory = {
    ...inventory,
    remote: [...inventory.remote, row("origin/fresh", true)],
  };
  await act(async () => f.resolve(success()));
  expect(screen.queryByRole("dialog", { name: "Выбор ветки" })).toBeNull();
  await open();
  remote();
  expect(screen.getByRole("button", { name: "origin/fresh" })).toBeTruthy();
  expect(screen.queryByText("Новая")).toBeNull();
});
it("does not execute a late preparation after leaving the retained owner", async () => {
  const f = deferred();
  api.prepareGitBranch.mockReturnValue(f.promise);
  const ui = render(<RetainedViews activeKey="p">{view()}</RetainedViews>);
  await open();
  update();
  await waitFor(() => expect(api.prepareGitBranch).toHaveBeenCalledOnce());
  ui.rerender(
    <RetainedViews activeKey="q">
      <p>Other owner</p>
    </RetainedViews>,
  );
  await act(async () =>
    f.resolve({
      token: "c".repeat(64),
      projectId: "p",
      action: "fetch",
      remote: "origin",
    }),
  );
  expect(api.executeGitBranch).not.toHaveBeenCalled();
});
it("attaches an executing refresh to the issuing owner instead of a newly mounted project", async () => {
  const f = deferred(),
    done = vi.fn();
  api.executeGitBranch.mockReturnValue(f.promise);
  const ui = render(view({ onChanged: done }));
  await open();
  update();
  await waitFor(() => expect(api.executeGitBranch).toHaveBeenCalledOnce());
  ui.rerender(view({ projectId: "q", onChanged: done }));
  await act(async () => f.resolve(success()));
  expect(done).toHaveBeenCalledWith("p", "references-only");
  expect(done.mock.calls.some(([id]) => id === "q")).toBe(false);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("dialog", { name: "Выбор ветки" })).toBeNull();
});
it("uses exact upstream links, offers all local candidates and never infers a link from name", async () => {
  inventory.local.push(
    row("review", false, "refs/remotes/origin/legacy"),
    row("alternate", false, "refs/remotes/origin/legacy"),
  );
  render(view());
  await open();
  remote();
  expect(
    screen.getByRole("button", { name: "Переключиться на review" }),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Переключиться на alternate" }),
  );
  await waitFor(() =>
    expect(api.prepareGitBranch).toHaveBeenCalledWith({
      projectId: "p",
      revision,
      action: "switch-local",
      ref: "refs/heads/alternate",
    }),
  );
  expect(api.executeGitBranch).not.toHaveBeenCalled();
});
it("explains unrelated local name collisions instead of attempting to recreate them", async () => {
  inventory.remote.push(row("origin/feature", true));
  render(view());
  await open();
  remote();
  expect(screen.getByRole("button", { name: "origin/feature" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(screen.getByText(/Имя feature уже занято/)).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Показать локальную feature" }),
  );
  expect(
    screen
      .getByRole("tab", { name: "Локальные" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  expect(api.prepareGitBranch).not.toHaveBeenCalled();
});

it.each(["inactive", "disabled", "blocked"])(
  "revokes a pending fetch admission permanently across temporary %s state",
  async (kind) => {
    const f = deferred();
    api.prepareGitBranch.mockReturnValue(f.promise);
    const tree = (revoked: boolean) => (
      <RetainedViews activeKey={kind === "inactive" && revoked ? "q" : "p"}>
        {view({
          disabled: kind === "disabled" && revoked,
          mutationBlockedReason:
            kind === "blocked" && revoked ? "Занято" : undefined,
        })}
      </RetainedViews>
    );
    const ui = render(tree(false));
    await open();
    update();
    await waitFor(() => expect(api.prepareGitBranch).toHaveBeenCalledOnce());
    ui.rerender(tree(true));
    ui.rerender(tree(false));
    await act(async () =>
      f.resolve({
        token: "c".repeat(64),
        projectId: "p",
        action: "fetch",
        remote: "origin",
      }),
    );
    expect(api.executeGitBranch).not.toHaveBeenCalled();
  },
);

it.each(["check", "reopen"])(
  "preserves uncertain execution evidence when a later %s fails",
  async (phase) => {
    api.executeGitBranch.mockResolvedValueOnce({
      ...success(),
      status: "uncertain",
      message: "Неопределённый результат",
      retainedLocks: ["index.lock"],
      recoveryPath: "/fixture/recovery/receipt",
    });
    render(view());
    await open();
    update();
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "/fixture/recovery/receipt",
      ),
    );
    if (phase === "check") {
      api.prepareGitBranch.mockRejectedValueOnce(
        Error("Предыдущая операция Git требует проверки"),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Проверить состояние" }),
      );
      await waitFor(() =>
        expect(screen.getByRole("alert").textContent).toContain(
          "Предыдущая операция Git требует проверки",
        ),
      );
    } else {
      fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
      api.readGitBranches.mockRejectedValueOnce(Error("Чтение не удалось"));
      fireEvent.click(screen.getByRole("button", { name: "Ветка: main" }));
      await waitFor(() =>
        expect(screen.getByRole("alert").textContent).toContain(
          "Чтение не удалось",
        ),
      );
    }
    expect(screen.getByRole("alert").textContent).toContain(
      "/fixture/recovery/receipt",
    );
    expect(screen.getByRole("alert").textContent).toContain("index.lock");
    expect(api.executeGitBranch).toHaveBeenCalledOnce();
  },
);

it.each([{ projectId: "other" }, { action: "pull" }, { remote: "upstream" }])(
  "rejects a mismatched fetch confirmation %j before execute",
  async (mismatch) => {
    api.prepareGitBranch.mockResolvedValue({
      token: "c".repeat(64),
      projectId: "p",
      action: "fetch",
      remote: "origin",
      ...mismatch,
    });
    render(view());
    await open();
    update();
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Подтверждение обновления",
      ),
    );
    expect(api.executeGitBranch).not.toHaveBeenCalled();
  },
);
it("does not guess a local collision for an unrelated slash-containing remote", async () => {
  inventory.remote.push(row("team/upstream/feature", true));
  render(view());
  await open();
  remote();
  fireEvent.click(
    screen.getByRole("button", { name: "team/upstream/feature" }),
  );
  await waitFor(() =>
    expect(api.prepareGitBranch).toHaveBeenCalledWith({
      projectId: "p",
      revision,
      action: "switch-remote",
      ref: "refs/remotes/team/upstream/feature",
    }),
  );
  expect(api.executeGitBranch).not.toHaveBeenCalled();
});

it("dismisses a settled fetch error with the menu and does not resurrect it on reopen", async () => {
  api.executeGitBranch.mockResolvedValueOnce({
    ...success(),
    status: "error",
    message: "Git отказал в обновлении",
    log: "gh-pages (non-fast-forward)",
  });
  render(view());
  await open();
  update();
  expect((await screen.findByRole("alert")).textContent).toContain(
    "non-fast-forward",
  );
  fireEvent.click(screen.getByRole("button", { name: "Закрыть меню" }));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("dialog", { name: "Выбор ветки" })).toBeNull();
  await open();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(api.executeGitBranch).toHaveBeenCalledOnce();
});
it("uses one labelled refresh icon with a fixed-size button during update", async () => {
  const f = deferred();
  api.executeGitBranch.mockReturnValue(f.promise);
  render(view());
  await open();
  const button = screen.getByRole("button", { name: "Обновить из origin" });
  fireEvent.mouseEnter(button);
  expect(button.ownerDocument.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toBe("Обновить из origin");
  expect(button.textContent).toBe("");
  const icon = button.querySelector("svg");
  expect(icon?.getAttribute("aria-hidden")).toBe("true");
  update();
  await waitFor(() => expect(api.executeGitBranch).toHaveBeenCalledOnce());
  expect(button.querySelector("svg")).toBe(icon);
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(icon?.classList.contains("git-branch-refresh-spinning")).toBe(true);
  expect(button.textContent).toBe("");
  await act(async () => f.resolve(success()));
  expect(button.getAttribute("aria-busy")).toBe("false");
  expect(icon?.classList.contains("git-branch-refresh-spinning")).toBe(false);
});

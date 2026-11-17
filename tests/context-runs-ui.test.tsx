// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContextRuns } from "../src/renderer/ContextRuns";
import { ContextLaunchMenu } from "../src/renderer/ContextLaunchMenu";
import type {
  RunWithContext,
  TopicContextIdentity,
} from "../src/renderer/topic-context";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document
    .querySelectorAll("iframe[data-launch-popup]")
    .forEach((frame) => frame.remove());
});
const a: TopicContextIdentity = {
  projectId: "p",
  repositoryKey: "repo",
  revision: "202649d6-9194-4ec2-96c5-f814f2fa4586",
  year: "2026",
  topic: "topic-a",
  branch: "topic-a",
  contextId: "copy-a",
};
const b: TopicContextIdentity = {
  ...a,
  topic: "topic-b",
  branch: "topic-b",
  contextId: "copy-b",
};
function run(
  id: string,
  overrides: Partial<RunWithContext> = {},
): RunWithContext {
  return {
    id,
    projectId: "p",
    pipeline: "develop",
    topic: "topic-a",
    branch: "topic-a",
    status: "exited",
    startedAt: "2026-10-19T12:00:00Z",
    workflow: null,
    profile: null,
    context: a,
    ...overrides,
  };
}
const build = (id: string, overrides: Partial<RunWithContext> = {}) =>
  run(id, {
    kind: "build",
    build: {
      planPath: "docs/implementation.md",
      planVersion: "v",
      clean: false,
      update: false,
      skipManifestCheck: false,
    },
    ...overrides,
  });

describe("contextual run history", () => {
  it("lists only this context, shows total pipeline count, name and description on separate lines", () => {
    const onOpen = vi.fn();
    render(
      <ContextRuns
        runs={[
          run("active", {
            status: "starting",
            pipelineName: "Разработка и ревью",
            pipelineDescription: "Проверка и реализация задачи",
          }),
          run("finished"),
          run("other", { context: b, topic: b.topic, branch: b.branch }),
          run("legacy", { context: undefined }),
          build("build"),
        ]}
        context={a}
        onOpen={onOpen}
      />,
    );
    const filter = screen.getByRole("button", { name: "Конвейеры: 2" });
    expect(within(filter).getByText("2")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Сборка" })
        .querySelector(".context-counter"),
    ).toBeNull();
    const title = screen.getByText("Разработка и ревью");
    const description = screen.getByText("Проверка и реализация задачи");
    expect(title.parentElement).toBe(description.parentElement);
    expect(title.tagName).not.toBe(description.tagName);
    expect(screen.queryByText("topic-a")).toBeNull();
    expect(screen.queryByText("topic-b")).toBeNull();
    expect(
      screen.getAllByRole("button", { name: /Открыть запуск/ }),
    ).toHaveLength(2);
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Открыть запуск Разработка и ревью" }),
    );
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("active");
  });
  it("does not invent a pipeline description when no snapshot or catalogue exists", () => {
    render(
      <ContextRuns
        runs={[run("no-description")]}
        context={a}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText("develop")).toBeTruthy();
    expect(document.querySelector(".context-run-description")).toBeNull();
  });
  it("can use existing pipeline catalogue metadata without overriding a run snapshot", () => {
    render(
      <ContextRuns
        runs={[
          run("catalogue"),
          run("snapshot", {
            pipelineName: "Снимок имени",
            pipelineDescription: "Снимок описания",
          }),
        ]}
        context={a}
        onOpen={() => {}}
        pipelines={[
          {
            id: "develop",
            name: "Имя из проекта",
            description: "Описание из проекта",
            project: true,
          },
        ]}
      />,
    );
    expect(screen.getByText("Имя из проекта")).toBeTruthy();
    expect(screen.getByText("Описание из проекта")).toBeTruthy();
    expect(screen.getByText("Снимок имени")).toBeTruthy();
    expect(screen.getByText("Снимок описания")).toBeTruthy();
  });
  it("shows actual relative build plan and honest absence for old history", () => {
    render(
      <ContextRuns
        runs={[build("planned"), build("old", { build: undefined })]}
        context={a}
        onOpen={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Сборка" }));
    expect(screen.getByText("docs/implementation.md")).toBeTruthy();
    expect(screen.getByText("План не указан")).toBeTruthy();
    expect(screen.queryByText("Сборка по плану")).toBeNull();
    expect(screen.queryByText("plan.md")).toBeNull();
  });
  it("keeps absolute technical paths in details and never presents them as a relative plan", () => {
    render(
      <ContextRuns
        runs={[
          build("absolute", {
            context: { ...a, path: "/copies/a" },
            build: {
              planPath: "/copies/a/docs/real-plan.md",
              planVersion: "v",
              clean: false,
              update: false,
              skipManifestCheck: false,
            },
          }),
        ]}
        context={a}
        onOpen={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Сборка" }));
    expect(screen.getByText("docs/real-plan.md")).toBeTruthy();
    expect(screen.getByText("/copies/a").closest("details")).toBeTruthy();
    expect(
      screen.getByText("/copies/a/docs/real-plan.md").closest("details"),
    ).toBeTruthy();
  });
  it("switches context without automatically opening a run", () => {
    const onOpen = vi.fn();
    const runs = [
      run("a"),
      run("b", {
        context: b,
        topic: b.topic,
        branch: b.branch,
        pipeline: "second",
      }),
    ];
    const view = render(
      <ContextRuns runs={runs} context={a} onOpen={onOpen} />,
    );
    view.rerender(<ContextRuns runs={runs} context={b} onOpen={onOpen} />);
    expect(screen.getByText("second")).toBeTruthy();
    expect(screen.queryByText("develop")).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe("unified preparation menu", () => {
  it("opens full preparation only after an explicit choice, without launching anything", () => {
    const onPrepare = vi.fn();
    render(<ContextLaunchMenu runs={[]} context={a} onPrepare={onPrepare} />);
    fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
    expect(onPrepare).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Конвейер/ }));
    expect(onPrepare).toHaveBeenCalledExactlyOnceWith("pipeline");
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Сборка/ }));
    expect(onPrepare).toHaveBeenLastCalledWith("build");
    expect(
      screen.getByRole("button", { name: "Запустить" }).textContent,
    ).not.toMatch(/[▾▼]/);
  });
  it.each(["starting", "running"] as const)(
    "hides the build choice for %s in this copy and explains where to open it",
    (status) => {
      const onPrepare = vi.fn();
      render(
        <ContextLaunchMenu
          runs={[build("busy", { status })]}
          context={a}
          onPrepare={onPrepare}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
      expect(screen.queryByRole("menuitem", { name: /^Сборка/ })).toBeNull();
      expect(screen.getByText("Сборка уже выполняется")).toBeTruthy();
      expect(screen.getByText(/Открыть её можно через «Запуски»/)).toBeTruthy();
      fireEvent.click(screen.getByRole("menuitem", { name: /^Конвейер/ }));
      expect(onPrepare).toHaveBeenCalledExactlyOnceWith("pipeline");
    },
  );
  it("restores build preparation for completed runs and ignores activity in other copies", () => {
    render(
      <ContextLaunchMenu
        runs={[
          build("old", { status: "failed" }),
          build("other", {
            status: "running",
            context: b,
            topic: b.topic,
            branch: b.branch,
          }),
        ]}
        context={a}
        onPrepare={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
    expect(
      screen
        .getByRole("menuitem", { name: /^Сборка/ })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(screen.queryByText("Сборка уже выполняется")).toBeNull();
  });
  it("allows both choices while another pipeline is starting in this copy", () => {
    const onPrepare = vi.fn();
    render(
      <ContextLaunchMenu
        runs={[run("busy", { status: "starting" })]}
        context={a}
        onPrepare={onPrepare}
      />,
    );
    for (const [label, kind] of [
      [/^Конвейер/, "pipeline"],
      [/^Сборка/, "build"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
      const item = screen.getByRole("menuitem", { name: label });
      expect(item.hasAttribute("disabled")).toBe(false);
      fireEvent.click(item);
      expect(onPrepare).toHaveBeenLastCalledWith(kind);
    }
  });
  it("supports keyboard choices, Escape focus restoration, Tab and outside dismissal", async () => {
    const user = userEvent.setup();
    const onPrepare = vi.fn();
    render(
      <>
        <ContextLaunchMenu runs={[]} context={a} onPrepare={onPrepare} />
        <button>Снаружи</button>
      </>,
    );
    const trigger = screen.getByRole("button", { name: "Запустить" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: /^Конвейер/ }),
    );
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: /^Сборка/ }),
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: /^Сборка/ }),
    );
    await user.keyboard("{Home}{Enter}");
    expect(onPrepare).toHaveBeenCalledExactlyOnceWith("pipeline");
    fireEvent.click(trigger);
    await user.tab();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Снаружи" }),
    );
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Снаружи" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });
  it("shows an external launch restriction once without permitting preparation", () => {
    const onPrepare = vi.fn();
    const blockedReason =
      "Эта версия Goga не поддерживает запуск в связанной рабочей копии.";
    render(
      <ContextLaunchMenu
        runs={[]}
        context={a}
        onPrepare={onPrepare}
        blockedReason={blockedReason}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
    expect(screen.getAllByText(blockedReason)).toHaveLength(1);
    for (const item of screen.getAllByRole("menuitem")) {
      expect(item.hasAttribute("disabled")).toBe(true);
      fireEvent.click(item);
    }
    expect(onPrepare).not.toHaveBeenCalled();
  });
  it("reflects completion while open and restores build preparation", () => {
    const onPrepare = vi.fn();
    const view = render(
      <ContextLaunchMenu
        runs={[build("busy", { status: "starting" })]}
        context={a}
        onPrepare={onPrepare}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
    view.rerender(
      <ContextLaunchMenu
        runs={[build("busy", { status: "exited" })]}
        context={a}
        onPrepare={onPrepare}
      />,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /^Сборка/ }));
    expect(onPrepare).toHaveBeenCalledExactlyOnceWith("build");
  });
  it("closes an open menu when its owner context changes", () => {
    const view = render(
      <ContextLaunchMenu runs={[]} context={a} onPrepare={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
    view.rerender(
      <ContextLaunchMenu runs={[]} context={b} onPrepare={() => {}} />,
    );
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

/** Mock only Electron's native window boundary: the real popup still owns its
 * same-origin portal, ready/focus handshake and exact-id cleanup. */
function nativeLaunchPopup() {
  const frame = document.createElement("iframe");
  frame.dataset.launchPopup = "";
  document.body.append(frame);
  const child = frame.contentWindow!;
  let closed = (_id: string) => {};
  const api = {
    setTopicPopupBounds: vi.fn(async (_id: string) => {}),
    closeTopicPopup: vi.fn(async (_id: string) => {}),
    onTopicPopupClosed: vi.fn((callback: typeof closed) => {
      closed = callback;
      return vi.fn();
    }),
    selectRun: vi.fn(),
  };
  vi.stubGlobal("goga", api);
  vi.spyOn(window, "open").mockReturnValue(child);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  return {
    child,
    local: within(child.document.body),
    api,
    close: (id: string) => closed(id),
  };
}

describe("native preparation menu above attached panels", () => {
  it("portals Pipeline, Build and Demo into the existing native layer without selecting a run", async () => {
    const popup = nativeLaunchPopup();
    const onPrepare = vi.fn(),
      demo = vi.fn();
    render(
      <ContextLaunchMenu
        runs={[]}
        context={a}
        onPrepare={onPrepare}
        demoItem={(close) => (
          <button
            role="menuitem"
            onClick={() => {
              close();
              demo();
            }}
          >
            Демо
          </button>
        )}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Запустить" });
    trigger.focus();
    fireEvent.click(trigger);
    const menu = await popup.local.findByRole("menu");
    await waitFor(() =>
      expect(popup.api.setTopicPopupBounds).toHaveBeenCalled(),
    );
    expect(screen.queryByRole("menu")).toBeNull();
    expect(menu.ownerDocument).toBe(popup.child.document);
    expect(popup.child.document.title).toBe("Подготовить новый запуск");
    expect(popup.local.getAllByRole("menuitem")).toHaveLength(3);
    expect(popup.api.selectRun).not.toHaveBeenCalled();
    expect(onPrepare).not.toHaveBeenCalled();
    fireEvent.blur(trigger, { relatedTarget: null });
    expect(popup.local.getByRole("menu")).toBe(menu);
    fireEvent.pointerDown(
      popup.local.getByRole("menuitem", { name: /^Сборка/ }),
    );
    fireEvent.click(popup.local.getByRole("menuitem", { name: /^Сборка/ }));
    expect(onPrepare).toHaveBeenCalledExactlyOnceWith("build");
    expect(popup.local.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(popup.api.closeTopicPopup).toHaveBeenCalledWith(
      popup.api.setTopicPopupBounds.mock.calls[0][0],
    );
    fireEvent.click(trigger);
    fireEvent.click(await popup.local.findByRole("menuitem", { name: "Демо" }));
    expect(demo).toHaveBeenCalledTimes(1);
    expect(onPrepare).toHaveBeenCalledTimes(1);
  });

  it.each(["ArrowDown", "ArrowUp"])(
    "honors %s after native ready focus and navigates in the menu document",
    async (key) => {
      const popup = nativeLaunchPopup();
      render(<ContextLaunchMenu runs={[]} context={a} onPrepare={() => {}} />);
      const trigger = screen.getByRole("button", { name: "Запустить" });
      trigger.focus();
      fireEvent.keyDown(trigger, { key });
      const first = await popup.local.findByRole("menuitem", {
        name: /^Конвейер/,
      });
      const last = popup.local.getByRole("menuitem", { name: /^Сборка/ });
      await waitFor(() =>
        expect(popup.api.setTopicPopupBounds).toHaveBeenCalled(),
      );
      expect(popup.child.document.activeElement).toBe(
        key === "ArrowUp" ? last : first,
      );
      fireEvent.keyDown(popup.child.document.activeElement!, {
        key: "ArrowDown",
      });
      expect(popup.child.document.activeElement).toBe(
        key === "ArrowUp" ? first : last,
      );
      fireEvent.keyDown(popup.child.document.activeElement!, { key: "End" });
      expect(popup.child.document.activeElement).toBe(last);
      fireEvent.keyDown(last, { key: "ArrowUp" });
      expect(popup.child.document.activeElement).toBe(first);
      fireEvent.keyDown(first, { key: "Escape" });
      expect(popup.local.queryByRole("menu")).toBeNull();
      expect(document.activeElement).toBe(trigger);
    },
  );

  it.each([false, true])(
    "dismisses on Tab (shift=%s) and restores the shell tab-order anchor",
    async (shiftKey) => {
      const popup = nativeLaunchPopup();
      render(<ContextLaunchMenu runs={[]} context={a} onPrepare={() => {}} />);
      const trigger = screen.getByRole("button", { name: "Запустить" });
      fireEvent.click(trigger);
      const item = await popup.local.findByRole("menuitem", {
        name: /^Конвейер/,
      });
      fireEvent.keyDown(item, { key: "Tab", shiftKey });
      expect(popup.local.queryByRole("menu")).toBeNull();
      expect(document.activeElement).toBe(trigger);
    },
  );

  it.each(["shell", "popup"])(
    "handles outside pointers in the %s document without preparing",
    async (target) => {
      const popup = nativeLaunchPopup(),
        onPrepare = vi.fn();
      render(
        <>
          <ContextLaunchMenu runs={[]} context={a} onPrepare={onPrepare} />
          <button>Снаружи</button>
        </>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
      await popup.local.findByRole("menu");
      const outside =
        target === "shell"
          ? screen.getByRole("button", { name: "Снаружи" })
          : popup.child.document.body;
      fireEvent.pointerDown(outside);
      expect(popup.local.queryByRole("menu")).toBeNull();
      expect(onPrepare).not.toHaveBeenCalled();
    },
  );

  it("keeps an outside shell control focused when the host dismisses the exact popup", async () => {
    const popup = nativeLaunchPopup();
    render(
      <>
        <ContextLaunchMenu runs={[]} context={a} onPrepare={() => {}} />
        <button>Снаружи</button>
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
    await popup.local.findByRole("menu");
    await waitFor(() =>
      expect(popup.api.setTopicPopupBounds).toHaveBeenCalled(),
    );
    act(() => popup.close("unrelated-popup"));
    expect(popup.local.queryByRole("menu")).not.toBeNull();
    const outside = screen.getByRole("button", { name: "Снаружи" });
    outside.focus();
    act(() => popup.close(popup.api.setTopicPopupBounds.mock.calls[0][0]));
    expect(popup.local.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  it.each(["projectId", "year", "topic", "branch", "contextId"] as const)(
    "cancels the native menu when exact owner field %s changes",
    async (field) => {
      const popup = nativeLaunchPopup(),
        onPrepare = vi.fn();
      const view = render(
        <ContextLaunchMenu runs={[]} context={a} onPrepare={onPrepare} />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
      await popup.local.findByRole("menu");
      view.rerender(
        <ContextLaunchMenu
          runs={[]}
          context={{ ...a, [field]: `${a[field]}-changed` }}
          onPrepare={onPrepare}
        />,
      );
      expect(popup.local.queryByRole("menu")).toBeNull();
      expect(popup.api.closeTopicPopup).toHaveBeenCalled();
      expect(onPrepare).not.toHaveBeenCalled();
    },
  );

  it("cancels primary-project preparation when its project changes without a topic", async () => {
    const popup = nativeLaunchPopup(),
      onPrepare = vi.fn();
    const view = render(
      <ContextLaunchMenu
        runs={[]}
        context={null}
        primaryProjectId="p"
        prepareWithoutContext
        onPrepare={onPrepare}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
    await popup.local.findByRole("menu");
    view.rerender(
      <ContextLaunchMenu
        runs={[]}
        context={null}
        primaryProjectId="other"
        prepareWithoutContext
        onPrepare={onPrepare}
      />,
    );
    expect(popup.local.queryByRole("menu") === null).toBe(true);
    expect(popup.api.closeTopicPopup).toHaveBeenCalled();
    expect(onPrepare).not.toHaveBeenCalled();
  });

  it.each(["Escape", "Tab"])(
    "dismisses a fully blocked native menu on %s even when the popup body has focus",
    async (key) => {
      const popup = nativeLaunchPopup(),
        onPrepare = vi.fn();
      render(
        <ContextLaunchMenu
          runs={[]}
          context={a}
          blockedReason="Запуск запрещён"
          onPrepare={onPrepare}
        />,
      );
      const trigger = screen.getByRole("button", { name: "Запустить" });
      fireEvent.click(trigger);
      await popup.local.findByRole("menu");
      await waitFor(() =>
        expect(popup.api.setTopicPopupBounds).toHaveBeenCalled(),
      );
      expect(
        popup.child.document.activeElement === popup.child.document.body,
      ).toBe(true);
      fireEvent.keyDown(popup.child.document.body, { key });
      expect(popup.local.queryByRole("menu") === null).toBe(true);
      expect(document.activeElement).toBe(trigger);
      expect(onPrepare).not.toHaveBeenCalled();
    },
  );

  it("retains external launch guards and closes when the trigger becomes disabled", async () => {
    const popup = nativeLaunchPopup(),
      onPrepare = vi.fn();
    const view = render(
      <ContextLaunchMenu
        runs={[]}
        context={a}
        blockedReason="Запуск запрещён"
        onPrepare={onPrepare}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
    await popup.local.findByRole("menu");
    for (const item of popup.local.getAllByRole("menuitem")) {
      expect(item.hasAttribute("disabled")).toBe(true);
      fireEvent.click(item);
    }
    expect(onPrepare).not.toHaveBeenCalled();
    view.rerender(
      <ContextLaunchMenu
        runs={[]}
        context={a}
        disabled
        onPrepare={onPrepare}
      />,
    );
    expect(popup.local.queryByRole("menu")).toBeNull();
    expect(popup.api.closeTopicPopup).toHaveBeenCalled();
  });
});

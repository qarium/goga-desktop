// @vitest-environment jsdom
import React, { createRef } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GitUpdateHandoff } from "../src/renderer/GitUpdateHandoff";
import { RepositoryOperationPopup } from "../src/renderer/RepositoryActions";
import { useRepositoryActionController } from "../src/renderer/repository-action-controller";
import { TopicFeedback } from "../src/renderer/TopicsCommon";
import { useGitUpdateHandoff } from "../src/renderer/useGitUpdateHandoff";
import type { GitUpdateHandoffCandidate } from "../src/shared/git-update-handoff";
import * as popup from "../src/renderer/TopicPickerPopup";
const scope = {
  projectId: "p",
  year: "2026",
  topic: "t",
  branch: "topic",
  contextId: "ctx-" + "a".repeat(64),
  revision: "11111111-1111-4111-8111-111111111111",
};
const candidate = {
  candidateId: "a".repeat(64),
  scope,
  root: "/fixture",
  targetBranch: "topic",
  targetHead: "b".repeat(40),
  sourceRef: "refs/source",
  sourceOid: "c".repeat(40),
  baseRef: "main",
  strategy: "merge" as const,
  algorithm: "merge" as const,
  conflicts: ["file.txt"],
  expiresAt: Date.now() + 300000,
};
let api: any;
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  api = {
    runRepositoryAction: vi.fn(async (r: any) => ({
      projectId: r.projectId,
      contextId: r.context?.contextId,
      action: r.action,
      status: "error",
      log: "original log",
      error: "conflict",
      handoff: candidate,
    })),
  };
  window.goga = api;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function Failure({
  onHandoff,
}: {
  onHandoff: (c: GitUpdateHandoffCandidate) => void;
}) {
  const controller = useRepositoryActionController();
  const anchor = createRef<HTMLDivElement>();
  return (
    <>
      <div ref={anchor} />
      <button
        onClick={() =>
          void controller.run(
            { projectId: "p", context: scope, action: "update-base" },
            "Update",
          )
        }
      >
        Run
      </button>
      <RepositoryOperationPopup anchor={anchor} onHandoff={onHandoff} />
    </>
  );
}
it("repository failure offers captured candidate to main renderer without executing", async () => {
  const onHandoff = vi.fn();
  render(<Failure onHandoff={onHandoff} />);
  fireEvent.click(screen.getByText("Run"));
  const button = await screen.findByRole("button", {
    name: "Разрешить конфликт вручную…",
  });
  expect(screen.getByText("original log")).toBeTruthy();
  fireEvent.click(button);
  expect(onHandoff).toHaveBeenCalledExactlyOnceWith(candidate);
});
it("repository failure cannot offer candidate from another scope revision", async () => {
  api.runRepositoryAction.mockImplementation(async (r: any) => ({
    projectId: r.projectId,
    contextId: r.context.contextId,
    action: r.action,
    status: "error",
    log: "log",
    handoff: {
      ...candidate,
      scope: { ...scope, revision: "22222222-2222-4222-8222-222222222222" },
    },
  }));
  render(<Failure onHandoff={vi.fn()} />);
  fireEvent.click(screen.getByText("Run"));
  await screen.findByText("log");
  expect(
    screen.queryByRole("button", { name: "Разрешить конфликт вручную…" }),
  ).toBeNull();
});
it.each(["failed", "partial", "success"])(
  "topic feedback offers candidate only for failed or partial (%s)",
  (status) => {
    const onHandoff = vi.fn();
    render(
      <TopicFeedback
        operation={
          {
            error: "",
            result: { status, message: "topic result", handoff: candidate },
          } as any
        }
        handoffScope={scope}
        onHandoff={onHandoff}
      />,
    );
    const button = screen.queryByRole("button", {
      name: "Разрешить конфликт вручную…",
    });
    if (status === "failed" || status === "partial") {
      fireEvent.click(button!);
      expect(onHandoff).toHaveBeenCalledExactlyOnceWith(candidate);
    } else expect(button).toBeNull();
  },
);
it("topic feedback rejects another full owner", () => {
  render(
    <TopicFeedback
      operation={
        {
          error: "",
          result: { status: "failed", message: "result", handoff: candidate },
        } as any
      }
      handoffScope={{ ...scope, topic: "other" }}
      onHandoff={vi.fn()}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "Разрешить конфликт вручную…" }),
  ).toBeNull();
});
it("waits for native dismissal before main confirmation", async () => {
  let resolve!: () => void;
  vi.spyOn(popup, "dismissActiveTopicPopup").mockReturnValue(
    new Promise<void>((r) => {
      resolve = r;
    }),
  );
  const onChanged = vi.fn(),
    onError = vi.fn();
  const view = renderHook(() =>
    useGitUpdateHandoff({ scope, onChanged, onError }),
  );
  act(() => {
    void view.result.current.open(candidate);
  });
  expect(view.result.current.candidate).toBeNull();
  await act(async () => resolve());
  expect(view.result.current.candidate).toEqual(candidate);
  expect(onChanged).not.toHaveBeenCalled();
  act(() => view.result.current.changed(scope));
  expect(onChanged).toHaveBeenCalledExactlyOnceWith(scope);
});
it("owner change during native dismissal suppresses old confirmation and navigation", async () => {
  let resolve!: () => void;
  vi.spyOn(popup, "dismissActiveTopicPopup").mockReturnValue(
    new Promise<void>((r) => {
      resolve = r;
    }),
  );
  const onChanged = vi.fn(),
    onError = vi.fn();
  const view = renderHook(
    ({ owner }) => useGitUpdateHandoff({ scope: owner, onChanged, onError }),
    { initialProps: { owner: scope } },
  );
  act(() => {
    void view.result.current.open(candidate);
  });
  view.rerender({
    owner: { ...scope, revision: "22222222-2222-4222-8222-222222222222" },
  });
  await act(async () => resolve());
  expect(view.result.current.candidate).toBeNull();
  act(() => view.result.current.changed(scope));
  expect(onChanged).not.toHaveBeenCalled();
});
it("late result from previous owner never navigates even after switching back", async () => {
  const onChanged = vi.fn(),
    onError = vi.fn();
  const view = renderHook(
    ({ owner }) => useGitUpdateHandoff({ scope: owner, onChanged, onError }),
    { initialProps: { owner: scope } },
  );
  await act(async () => {
    await view.result.current.open(candidate);
  });
  const stale = view.result.current.changed;
  view.rerender({ owner: { ...scope, topic: "other" } });
  view.rerender({ owner: scope });
  act(() => stale(scope));
  expect(onChanged).not.toHaveBeenCalled();
});
it.each(["reject", "timeout"])(
  "native dismissal %s yields finite error without confirmation",
  async (kind) => {
    vi.useFakeTimers();
    vi.spyOn(popup, "dismissActiveTopicPopup").mockImplementation(() =>
      kind === "reject"
        ? Promise.reject(Error("native close failed"))
        : new Promise(() => {}),
    );
    const onError = vi.fn();
    const view = renderHook(() =>
      useGitUpdateHandoff({ scope, onChanged: vi.fn(), onError }),
    );
    await act(async () => {
      void view.result.current.open(candidate);
      await vi.advanceTimersByTimeAsync(5001);
    });
    expect(onError).toHaveBeenCalledOnce();
    expect(view.result.current.candidate).toBeNull();
  },
);
it("moves native popup handoff to a main-document confirmation after close acknowledgement", async () => {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  let acknowledge!: () => void;
  api.setTopicPopupBounds = vi.fn(async () => {});
  api.closeTopicPopup = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
  );
  api.onTopicPopupClosed = () => () => {};
  api.readGitWorkspace = vi.fn(async () => ({
    scope,
    root: candidate.root,
    revision: "e".repeat(64),
    head: candidate.targetHead,
    branch: candidate.targetBranch,
    operation: "none",
  }));
  api.prepareGitUpdateHandoff = vi.fn(async () => ({
    candidate,
    token: "d".repeat(64),
    hooks: "disabled",
    publishes: false,
    effects: "Changes files",
    expiresAt: candidate.expiresAt,
  }));
  api.executeGitUpdateHandoff = vi.fn();
  vi.spyOn(window, "open").mockReturnValue(frame.contentWindow);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  function Shell() {
    const h = useGitUpdateHandoff({
      scope,
      onChanged: vi.fn(),
      onError: vi.fn(),
    });
    return (
      <>
        <Failure
          onHandoff={(c) => {
            void h.open(c);
          }}
        />
        {h.candidate && (
          <GitUpdateHandoff
            candidate={h.candidate}
            autoPrepare
            onClose={h.close}
            onChanged={h.changed}
          />
        )}
      </>
    );
  }
  try {
    render(<Shell />);
    fireEvent.click(screen.getByText("Run"));
    const button = await within(frame.contentDocument!.body).findByRole(
      "button",
      { name: "Разрешить конфликт вручную…" },
    );
    fireEvent.click(button);
    expect(api.prepareGitUpdateHandoff).not.toHaveBeenCalled();
    await act(async () => acknowledge());
    const confirmation = await screen.findByRole("button", {
      name: "Подтвердить переход к конфликту",
    });
    expect(confirmation.ownerDocument).toBe(document);
    expect(frame.contentDocument!.querySelector("dialog")).toBeNull();
    expect(api.prepareGitUpdateHandoff).toHaveBeenCalledOnce();
    expect(api.executeGitUpdateHandoff).not.toHaveBeenCalled();
  } finally {
    cleanup();
    frame.remove();
    vi.unstubAllGlobals();
  }
});

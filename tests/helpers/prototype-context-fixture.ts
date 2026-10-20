import { expect, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  topicContextRefSchema,
  worktreeContextRef,
  type WorktreeRecord,
} from "../../src/shared/worktrees";

type FixtureProject = {
  id: string;
  path: string;
  topic: string;
  branch: string;
};

/** Host-issued identities are explicit fixture data, never derived from a topic slug. */
export function installPrototypeContextFixture(
  api: any,
  projects: FixtureProject[],
) {
  const records: WorktreeRecord[] = projects.map((project, index) => ({
    projectId: project.id,
    year: "2026",
    topic: project.topic,
    branch: project.branch,
    contextId: `ctx-${(index + 1).toString(16).padStart(64, "0")}`,
    revision: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    repositoryKey: (index + 1).toString(16).padStart(64, "0"),
    projectPath: project.path,
    gitCommonDir: `${project.path}/.git`,
    path: `/fixture/checked-copies/${index + 1}`,
    ownership: "managed",
    storageKind: "clone",
    state: "ready",
  }));
  const byProject = (id: string) => {
    const record = records.find((candidate) => candidate.projectId === id);
    if (!record) throw Error(`No explicit prototype fixture for ${id}`);
    return record;
  };
  api.readTopicBoard = vi.fn(async (id: string) => {
    const record = byProject(id);
    const target = {
      topic: record.topic,
      branch: record.branch,
      remote: false,
    };
    return {
      projectId: id,
      year: record.year,
      revision: "fixture-board",
      currentBranch: record.branch,
      currentTopic: target,
      baseRef: "main",
      branches: [record.branch],
      dirty: false,
      active: false,
      entries: [{ ...target, hosts: [], statuses: [], todo: "" }],
      records: [],
      remoteEntries: [],
      remoteRecords: [],
    };
  });
  api.listTopicContexts = vi.fn(async (id: string) => {
    byProject(id);
    return [];
  });
  api.ensureTopicContext = vi.fn(async (identity: any) => {
    const record = byProject(identity.projectId);
    expect(identity).toEqual({
      projectId: record.projectId,
      year: record.year,
      topic: record.topic,
      branch: record.branch,
    });
    return record;
  });
  api.resolveTopicContext = vi.fn(async (ref: any) => {
    const record = byProject(ref.projectId);
    expect(ref).toEqual(worktreeContextRef(record));
    return record;
  });
  api.checkTopicContextReadiness = vi.fn(async (ref: any) => ({
    ...byProject(ref.projectId),
    ...ref,
  }));
  api.selectTopicContext = vi.fn(async () => {});
  return { records, owner: (id: string) => worktreeContextRef(byProject(id)) };
}

/** Tests that need a clone select it explicitly; production starts Without topic. */
export async function selectPrototypeOwner() {
  if (screen.queryByRole("button", { name: /^Открыть карточку топика / }))
    return;
  const trigger = await screen.findByRole("button", {
    name: "Выбрать другой топик",
  });
  const row = await waitFor(() => {
    expect((trigger as HTMLButtonElement).disabled).toBe(false);
    if (trigger.getAttribute("aria-expanded") !== "true")
      fireEvent.click(trigger);
    const row = screen
      .getAllByRole("row")
      .find(
        (value) => !value.getAttribute("aria-label")?.startsWith("Без топика"),
      );
    if (!row) throw Error("Explicit fixture topic row absent");
    return row;
  });
  fireEvent.click(row);
  await screen.findByRole("button", { name: /^Открыть карточку топика / });
}
/** Follows explicit fixture selection and header intent, preserving owner checks. */
export async function openPrototypeLaunch(
  kind: "pipeline" | "build" = "pipeline",
) {
  await selectPrototypeOwner();
  const actions = await waitFor(() => {
    const actions = document.querySelector<HTMLElement>(".project-actions");
    if (!actions) throw Error("Project header actions absent");
    return actions;
  });
  const header = within(actions);
  const trigger = await header.findByRole("button", { name: "Запустить" });
  const item = await waitFor(() => {
    // Initial inventory can replace the read-only display owner and close its
    // menu. Reopen the visible control, never bypass owner discovery in the UI.
    if (trigger.getAttribute("aria-expanded") !== "true")
      fireEvent.click(trigger);
    const item = screen.getByRole("menuitem", {
      name: kind === "build" ? /^Сборка/ : /^Конвейер/,
    });
    expect((item as HTMLButtonElement).disabled).toBe(false);
    return item;
  });
  const read =
    kind === "build" ? window.goga.buildContext : window.goga.discover;
  const readCount = (read as ReturnType<typeof vi.fn>).mock.calls.length;
  fireEvent.click(item);
  if (screen.queryByRole("heading", { name: "Сохранить изменения?" })) {
    expect(read).toHaveBeenCalledTimes(readCount);
    return;
  }
  const stage = screen.queryByRole("heading", {
    name: kind === "build" ? "Подготовка сборки" : "Подготовка конвейера",
  });
  if (stage) {
    await waitFor(() => expect(stage.isConnected).toBe(false));
  }
  await waitFor(() => {
    const call = (read as ReturnType<typeof vi.fn>).mock.lastCall;
    if (!call) throw Error("Owner-scoped form read absent");
    // A string project ID would silently reintroduce the removed primary fallback.
    expect(call[0]).toEqual(topicContextRefSchema.parse(call[0]));
  });
}

/** The submit button is distinct from the identically named header menu button. */
export function executionButton(name: string = "Запустить") {
  const form = [
    ...document.querySelectorAll<HTMLElement>(".launch-panel,.build-form"),
  ].find((candidate) => !candidate.closest('[role="tabpanel"][hidden]'));
  if (!form) throw Error("Visible execution form absent");
  return within(form).getByRole("button", { name }) as HTMLButtonElement;
}

/** Retained submit reference for independent stale-event safety assertions. */
export function retainedExecutionButton() {
  const candidates = document.querySelectorAll<HTMLButtonElement>(
    ".launch-panel button,.build-form button",
  );
  const found = [...candidates].find(
    (button) => button.textContent?.trim() === "Запустить",
  );
  if (!found) throw Error("Retained execution submit absent");
  return found;
}

export async function openPrototypeDocuments() {
  await selectPrototypeOwner();
  fireEvent.click(screen.getByRole("button", { name: "Проект" }));
  await screen.findByRole("textbox", { name: "Исполняемый файл" });
}

/** Opens the currently selected scope without changing it (including primary). */
export async function openCurrentLaunch(
  kind: "pipeline" | "build" = "pipeline",
) {
  const actions = document.querySelector<HTMLElement>(".project-actions")!;
  fireEvent.click(within(actions).getByRole("button", { name: "Запустить" }));
  fireEvent.click(
    screen.getByRole("menuitem", {
      name: kind === "build" ? /^Сборка/ : /^Конвейер/,
    }),
  );
}

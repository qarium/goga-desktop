// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { BuildForm } from "../src/renderer/BuildForm";
import type { BuildRepeatPreparation } from "../src/shared/build-repeat";

const project = { id: "p", name: "Alpha", path: "/synthetic/project" };
const owner = {
  projectId: "p",
  year: "2026",
  topic: "topic",
  branch: "topic",
  contextId: "ctx-" + "a".repeat(64),
  revision: "a6814931-f12f-4bf0-ae2f-cce2f9e47c70",
};
const seed: BuildRepeatPreparation = {
  sourceRunId: "old-run",
  projectId: "p",
  context: owner,
  planPath: "docs/recorded.md",
  options: {
    workflow: "quality",
    profile: "fast",
    sessionTimeout: "1h30m",
    idleTimeout: "10m",
    wait: "5m",
    maxIterations: 7,
    reviewPatience: 0,
    baseRef: "origin/main",
    addHost: [{ host: "test.local", ip: "host-gateway" }],
    clean: true,
    update: true,
    skipReview: false,
    skipManifestCheck: true,
  },
  requiredEnvKeys: ["TOKEN", "PUBLIC_LOOKING"],
  requiresProxy: true,
  requiresReview: true,
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
    buildContext: vi.fn(async () => ({
      revision: "current-context",
      branch: "topic",
      capabilities: [
        "workflow",
        "profile",
        "session-timeout",
        "idle-timeout",
        "wait",
        "max-iterations",
        "review-patience",
        "base-ref",
        "env",
        "add-host",
        "proxy",
        "clean",
        "update",
        "skip-review",
        "no-skip-review",
        "skip-manifest-check",
      ],
      defaults: { skipReview: true, profile: "" },
      branches: ["origin/main"],
      workflows: ["quality"],
      profiles: [{ name: "fast", source: "project" }],
      historyPlan: { path: "different-current-history.md" },
    })),
    readBuildPlan: vi.fn(async (_scope, path) => ({
      path,
      text: "# Current recorded plan",
      version: "current-plan",
    })),
    launchBuild: vi.fn(async () => ({
      id: "new-run",
      projectId: "p",
      kind: "build",
      status: "running",
    })),
  };
  window.goga = api;
});
afterEach(cleanup);
function mount(nextSeed = seed, nextOwner: typeof owner | undefined = owner) {
  render(
    <BuildForm
      project={project}
      owner={nextOwner}
      seed={nextSeed}
      onLaunched={() => {}}
      onCancel={() => {}}
    />,
  );
}
const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
function showDetails() {
  document.querySelectorAll("details").forEach((detail) => {
    detail.open = true;
  });
}

it("restores safe options and the exact source plan, with blank required secrets and an explicit review gate", async () => {
  mount();
  await screen.findByText("План доступен");
  await waitFor(() =>
    expect(
      screen
        .getByRole("region", { name: "Новая сборка" })
        .getAttribute("aria-busy"),
    ).toBe("false"),
  );
  showDetails();
  expect((screen.getByLabelText("План сборки") as HTMLInputElement).value).toBe(
    "docs/recorded.md",
  );
  for (const [label, value] of [
    ["Рабочий процесс", "quality"],
    ["Профиль", "fast"],
    ["Максимальное время одной сессии", "1h30m"],
    ["Максимальное время бездействия", "10m"],
    ["Пауза при лимите ИИ", "5m"],
    ["Максимальное число итераций", "7"],
    ["Повторные раунды без изменений", "0"],
    ["База сравнения", "origin/main"],
    ["Имя хоста 1", "test.local"],
    ["IP-адрес 1", "host-gateway"],
  ])
    expect(
      (screen.getByLabelText(new RegExp("^" + label)) as HTMLInputElement)
        .value,
    ).toBe(value);
  expect(
    (
      screen.getByLabelText(
        "Очистить состояние предыдущей сборки",
      ) as HTMLInputElement
    ).checked,
  ).toBe(true);
  expect(
    (screen.getByLabelText("Обновить образ перед сборкой") as HTMLInputElement)
      .checked,
  ).toBe(true);
  expect(
    (
      screen.getByLabelText(
        "Разрешить сборку с незакоммиченными контрактами",
      ) as HTMLInputElement
    ).checked,
  ).toBe(true);
  expect(
    screen
      .getByRole("switch", { name: "Пропустить ревью" })
      .getAttribute("aria-checked"),
  ).toBe("false");
  for (const index of [1, 2])
    expect(
      (
        screen.getByLabelText(
          "Значение переменной " + index,
        ) as HTMLInputElement
      ).value,
    ).toBe("");
  expect(screen.getByText("TOKEN", { selector: "code" })).toBeTruthy();
  expect(screen.getByText("PUBLIC_LOOKING", { selector: "code" })).toBeTruthy();
  expect(screen.getByText(/Прокси не сохранён/)).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Запустить" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(api.launchBuild).not.toHaveBeenCalled();
  expect(api.readBuildPlan).toHaveBeenCalledWith(owner, "docs/recorded.md");
});

it("cannot drop missing inputs; launches only a fully prepared current request with explicit acknowledgement", async () => {
  mount();
  await screen.findByText("План доступен");
  await waitFor(() =>
    expect(
      screen
        .getByRole("region", { name: "Новая сборка" })
        .getAttribute("aria-busy"),
    ).toBe("false"),
  );
  showDetails();
  fireEvent.click(screen.getByRole("button", { name: "Удалить переменную 1" }));
  change("Значение переменной 1", "new-public-looking-value");
  change("Прокси", "https://new-user:new-pass@new-proxy.test");
  await waitFor(() =>
    expect(
      screen
        .getByRole("region", { name: "Новая сборка" })
        .getAttribute("aria-busy"),
    ).toBe("false"),
  );
  expect(
    (screen.getByRole("button", { name: "Запустить" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Добавить переменную" }));
  change("Имя переменной 2", "TOKEN");
  change("Значение переменной 2", "new-sensitive-value");
  await waitFor(() =>
    expect(api.buildContext.mock.calls.at(-1)[1].env).toContainEqual({
      key: "TOKEN",
      value: "new-sensitive-value",
    }),
  );
  await waitFor(() =>
    expect(
      (
        screen.getByLabelText(
          /Я проверил параметры повторной сборки/,
        ) as HTMLInputElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByLabelText(/Я проверил параметры повторной сборки/),
  );
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Запустить" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  expect(api.launchBuild).not.toHaveBeenCalled();
  fireEvent.click(
    await screen.findByRole("button", { name: "Очистить и запустить" }),
  );
  await waitFor(() => expect(api.launchBuild).toHaveBeenCalledTimes(1));
  expect(api.launchBuild.mock.calls[0][0]).toMatchObject({
    projectId: "p",
    context: owner,
    contextRevision: "current-context",
    planPath: "docs/recorded.md",
    planVersion: "current-plan",
    confirmClean: true,
    repeat: { sourceRunId: "old-run", acknowledged: true },
    options: {
      ...seed.options,
      proxy: "https://new-user:new-pass@new-proxy.test",
      env: [
        { key: "PUBLIC_LOOKING", value: "new-public-looking-value" },
        { key: "TOKEN", value: "new-sensitive-value" },
      ],
    },
  });
});

it("requires review even with no missing sensitive inputs and refuses a seed for another owner", async () => {
  mount(
    { ...seed, requiredEnvKeys: [], requiresProxy: false },
    { ...owner, contextId: "ctx-" + "b".repeat(64) },
  );
  await screen.findByText("План доступен");
  await waitFor(() =>
    expect(
      screen
        .getByRole("region", { name: "Новая сборка" })
        .getAttribute("aria-busy"),
    ).toBe("false"),
  );
  expect(screen.getByRole("alert").textContent).toMatch(/владельц/);
  expect(
    (screen.getByRole("button", { name: "Запустить" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(api.launchBuild).not.toHaveBeenCalled();
});

it("uses the last env entry for missing-input validation and invalidates consent after edits", async () => {
  mount({
    ...seed,
    options: {},
    requiredEnvKeys: ["TOKEN"],
    requiresProxy: false,
  });
  await waitFor(() =>
    expect(
      screen
        .getByRole("region", { name: "Новая сборка" })
        .getAttribute("aria-busy"),
    ).toBe("false"),
  );
  change("Значение переменной 1", "new-value");
  await waitFor(() =>
    expect(
      screen
        .getByRole("region", { name: "Новая сборка" })
        .getAttribute("aria-busy"),
    ).toBe("false"),
  );
  fireEvent.click(
    screen.getByLabelText(/Я проверил параметры повторной сборки/),
  );
  expect(
    (screen.getByRole("button", { name: "Запустить" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Добавить переменную" }));
  change("Имя переменной 2", "TOKEN");
  await waitFor(() =>
    expect(
      screen
        .getByRole("region", { name: "Новая сборка" })
        .getAttribute("aria-busy"),
    ).toBe("false"),
  );
  const review = screen.getByLabelText(
    /Я проверил параметры повторной сборки/,
  ) as HTMLInputElement;
  expect(review.checked).toBe(false);
  expect(review.disabled).toBe(true);
  fireEvent.click(review);
  expect(
    (screen.getByRole("button", { name: "Запустить" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(api.launchBuild).not.toHaveBeenCalled();
});

it("also requires explicit review with no missing inputs and lets a restored update be turned off", async () => {
  mount({
    ...seed,
    options: { update: true },
    requiredEnvKeys: [],
    requiresProxy: false,
  });
  await waitFor(() =>
    expect(
      screen
        .getByRole("region", { name: "Новая сборка" })
        .getAttribute("aria-busy"),
    ).toBe("false"),
  );
  expect(
    (screen.getByRole("button", { name: "Запустить" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByLabelText("Обновить образ перед сборкой"));
  fireEvent.click(
    screen.getByLabelText(/Я проверил параметры повторной сборки/),
  );
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  await waitFor(() => expect(api.launchBuild).toHaveBeenCalledTimes(1));
  expect(api.launchBuild.mock.calls[0][0]).toMatchObject({
    options: { update: false },
    repeat: { sourceRunId: "old-run", acknowledged: true },
  });
});

it("explains that legacy history cannot reconstruct unknown sensitive or execution options", async () => {
  mount({
    ...seed,
    options: { clean: false },
    requiredEnvKeys: [],
    requiresProxy: false,
    legacyIncomplete: true,
  });
  await waitFor(() =>
    expect(
      screen
        .getByRole("region", { name: "Новая сборка" })
        .getAttribute("aria-busy"),
    ).toBe("false"),
  );
  expect(
    screen.getByText(
      /Для этого старого запуска сохранена только краткая сводка/,
    ),
  ).toBeTruthy();
  expect(
    screen.getByText(
      /Прежние переменные окружения, прокси, лимиты и остальные параметры неизвестны/,
    ),
  ).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Запустить" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(api.launchBuild).not.toHaveBeenCalled();
});

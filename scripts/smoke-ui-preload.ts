// Disposable test API only. Never included in the application package.
import { contextBridge } from "electron";
const project = {
  id: "fixture",
  name: "Демонстрационный проект",
  path: "/fixture/ui-review",
};
const branch =
  "feature/very-long-similar-topic-name-checkout-current-branch-with-clear-separation";
const discovery = {
  pipelines: [
    {
      id: "review",
      name: "Проверка интерфейса",
      description: "Изолированные тестовые данные; пайплайны не запускаются.",
      project: true,
    },
  ],
  topics: [
    {
      topic: branch.replaceAll("/", "-"),
      branch,
      current: true,
      remote: false,
      todo: "",
      statuses: [],
    },
    {
      topic:
        "feature-very-long-similar-topic-name-checkout-other-branch-with-clear-separation",
      branch:
        "feature/very-long-similar-topic-name-checkout-other-branch-with-clear-separation",
      current: false,
      remote: false,
      todo: "",
      statuses: [],
    },
  ],
  branches: [branch, "main"],
  currentBranch: branch,
  baseRef: "main",
  workflows: ["quality"],
  profiles: [{ name: "personal", source: "home" }],
};
let taskText =
  "# Задача выбранного топика\n\nПроверить читаемость формы и безопасное редактирование.";
let readBehavior = "success";
let readCalls = 0;
const apiCalls = { discover: 0, preview: 0, checkout: 0, launch: 0 };
let finishRead: ((value: unknown) => void) | undefined;
const taskDocument = (text: string) => ({
  text,
  exists: true,
  version: "fixture-task",
  path: ".goga/history/2026/fixture/todo.md",
});
contextBridge.exposeInMainWorld("fixtureControl", {
  mode: (value: string) => {
    readBehavior = value;
  },
  finish: (text: string) => {
    finishRead?.(taskDocument(text));
    finishRead = undefined;
  },
  calls: () => readCalls,
  apiCalls: () => ({ ...apiCalls }),
});
contextBridge.exposeInMainWorld("goga", {
  listProjects: async () => [project],
  chooseProject: async () => null,
  runs: async () => [],
  onRuns: () => () => {},
  onFocusRun: () => () => {},
  onViewError: () => () => {},
  selectRun: async () => {},
  discover: async () => {
    apiCalls.discover++;
    return discovery;
  },
  readTopicTask: async () => {
    readCalls++;
    if (readBehavior === "error") throw Error("Fixture read failed");
    if (readBehavior === "deferred")
      return new Promise((resolve) => {
        finishRead = resolve;
      });
    return taskDocument(taskText);
  },
  checkoutBranch: async () => {
    apiCalls.checkout++;
    return branch;
  },
  preview: async () => {
    apiCalls.preview++;
    return {
      token: "fixture",
      stages: [{ id: "review", title: "Тестовая стадия" }],
      workflow: null,
      profile: null,
    };
  },
  launch: async () => {
    apiCalls.launch++;
    throw Error("Forbidden: fixture must never launch pipelines");
  },
  listSettings: async () => ({ profiles: [] }),
  readSettings: async () => ({ text: "", version: "fixture" }),
  saveSettings: async () => {
    throw Error("Forbidden: no user settings");
  },
});

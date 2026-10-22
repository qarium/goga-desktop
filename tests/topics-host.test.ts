import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { HostService } from "../src/host/service";
import { NodeRunner, type Runner } from "../src/host/process";
import type { TopicOperationRequest } from "../src/shared/topics";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function fixture() {
  const dir = await mkdtemp("/private/tmp/goga-topics-");
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo"),
    home = path.join(dir, "home");
  await mkdir(repo);
  await mkdir(home);
  const node = new NodeRunner();
  cleanup.push(() => node.dispose());
  const git = (...a: string[]) => node.command("git", a, repo);
  for (const a of [
    ["init", "-b", "main"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test"],
    ["commit", "--allow-empty", "-m", "initial"],
  ])
    await git(...a);
  await mkdir(path.join(repo, ".goga/history/2025/main"), { recursive: true });
  await writeFile(
    path.join(repo, ".goga/history/2025/main/todo.md"),
    "Полная\nзадача 🙂\n",
  );
  await writeFile(
    path.join(repo, ".goga/config.yml"),
    "topics:\n  base_ref: main\n",
  );
  await git("add", ".");
  await git("commit", "-m", "task");
  await git("branch", "feature");
  const rows = [
    {
      topic: "main",
      branch: "main",
      current: true,
      remote: false,
      todo: "Полная",
      statuses: ["todo"],
      divergence: "base",
    },
    {
      topic: "merged",
      branch: "main",
      current: true,
      remote: false,
      todo: null,
      statuses: [],
      divergence: null,
    },
    {
      topic: "feature",
      branch: "feature",
      current: false,
      remote: false,
      todo: "feature",
      statuses: ["todo"],
      divergence: null,
    },
  ];
  const remote = [
    {
      topic: "remote",
      branch: "origin/remote",
      current: false,
      remote: true,
      todo: null,
      statuses: [],
      divergence: null,
    },
  ];
  const mutations: { args: string[]; input?: string }[] = [];
  let onBoardRead: (() => Promise<void>) | undefined;
  let failSwitch = false;
  let failMutation = false;
  const runner: Runner = {
    start: node.start.bind(node),
    kill: node.kill.bind(node),
    command: async (exe, args, cwd, env, input?: string) => {
      if (exe === "git") return node.command(exe, args, cwd, env);
      if (args.includes("board")) {
        if (!args.includes("--remote") && !args.includes("--per-host"))
          await onBoardRead?.();
        const data = args.includes("--remote") ? remote : [...rows, ...remote];
        return {
          stdout: JSON.stringify(
            args.includes("--per-host")
              ? data
              : data
                  .filter((r) => r.topic !== "merged")
                  .map((r) => ({ ...r, hosts: [r.branch] })),
          ),
          stderr: "",
        };
      }
      mutations.push({ args, input });
      if (failMutation) throw Error("hook failed after possible push");
      if (failSwitch && args.includes("switch")) throw Error("switch failed");
      return { stdout: "okay", stderr: "" };
    },
  };
  const service = new HostService({
    home,
    dataDir: path.join(dir, "data"),
    goga: "mock-goga",
    runner,
  });
  cleanup.push(() => service.dispose());
  const project = await service.addProject(repo);
  const board = () => service.readTopicBoard(project.id, "2025");
  const request = async (extra: Partial<TopicOperationRequest> = {}) => ({
    projectId: project.id,
    year: "2025",
    expectedRevision: (await board()).revision,
    action: "create" as const,
    branch: "fresh",
    baseRef: "main",
    task: "Текст\n🙂\n",
    publish: true,
    switch: false,
    ...extra,
  });
  return {
    service,
    project,
    repo,
    git,
    rows,
    remote,
    mutations,
    board,
    request,
    onBoardRead: (callback: () => Promise<void>) => {
      onBoardRead = callback;
    },
    failMutation: () => {
      failMutation = true;
    },
    failSwitch: () => {
      failSwitch = true;
    },
  };
}
it("reads four unfiltered JSON projections and derives own current topic, not merged history", async () => {
  const f = await fixture();
  const b = await f.board();
  expect(b.currentTopic).toEqual({
    topic: "main",
    branch: "main",
    remote: false,
  });
  expect(b.records).toHaveLength(4);
  expect(b.entries.map((r) => r.topic)).toContain("remote");
  expect(b.remoteRecords).toHaveLength(1);
  expect(b.year).toBe("2025");
  expect(f.mutations).toEqual([]);
});
it("rejects malformed JSON rows rather than coercing booleans or statuses", async () => {
  const f = await fixture();
  (f.rows[0] as any).statuses = [42];
  await expect(f.board()).rejects.toThrow(/каталог|JSON|схем/i);
});
it("reads complete year-scoped task and only permits current own working-copy edits", async () => {
  const f = await fixture();
  const d = await f.service.readTopicDetails(f.project.id, "2025", {
    topic: "main",
    branch: "main",
    remote: false,
  });
  expect(d.text).toBe("Полная\nзадача 🙂\n");
  expect(d.editable).toBe(true);
  const merged = await f.service.readTopicDetails(f.project.id, "2025", {
    topic: "merged",
    branch: "main",
    remote: false,
  });
  expect(merged.editable).toBe(false);
  expect(merged.reason).toBeTruthy();
});
it.each([
  [true, false],
  [false, false],
  [false, true],
  [true, true],
])(
  "creates publish=%s switch=%s with exact separate CLI arguments and stdin task",
  async (publish, switchTo) => {
    const f = await fixture();
    const plan = await f.service.prepareTopicOperation(
      await f.request({ publish, switch: switchTo }),
    );
    expect(f.mutations).toEqual([]);
    expect((await f.service.executeTopicOperation(plan.token)).status).toBe(
      "success",
    );
    const first = f.mutations[0]!;
    expect(first.args.slice(0, 4)).toEqual([
      "topics",
      "--year",
      "2025",
      "create",
    ]);
    expect(first.args.includes("--publish")).toBe(publish);
    expect(first.args.includes("--switch")).toBe(!publish && switchTo);
    expect(first.input).toBe("Текст\n🙂\n");
    expect(first.args).not.toContain(first.input);
    expect(f.mutations.length).toBe(publish && switchTo ? 2 : 1);
    await expect(f.service.executeTopicOperation(plan.token)).rejects.toThrow(
      /подтверж|устарел/i,
    );
  },
);
it("reports partial create+publish+switch failure even with unrelated dirty files", async () => {
  const f = await fixture();
  await writeFile(path.join(f.repo, "dirty"), "x");
  f.failSwitch();
  const p = await f.service.prepareTopicOperation(
    await f.request({ switch: true }),
  );
  expect((await f.service.executeTopicOperation(p.token)).status).toBe(
    "partial",
  );
  expect(f.mutations).toHaveLength(2);
});
it("rejects stale refs, task content and consumed/expired tokens before writes", async () => {
  const f = await fixture();
  const p = await f.service.prepareTopicOperation(await f.request());
  await f.git("branch", "elsewhere");
  await expect(f.service.executeTopicOperation(p.token)).rejects.toThrow(
    /устарел|изменил/i,
  );
  expect(f.mutations).toEqual([]);
  const p2 = await f.service.prepareTopicOperation(await f.request());
  vi.spyOn(Date, "now").mockReturnValue(p2.expiresAt + 1);
  await expect(f.service.executeTopicOperation(p2.token)).rejects.toThrow(
    /устарел/i,
  );
});
it("requires task version and preserves Unicode/multiline on confirmed safe save", async () => {
  const f = await fixture(),
    target = { topic: "main", branch: "main", remote: false };
  const d = await f.service.readTopicDetails(f.project.id, "2025", target);
  const req = await f.request({
    action: "save-task",
    target,
    task: "Новая\n🙂\r\n",
    taskVersion: d.version,
    branch: undefined,
    baseRef: undefined,
    publish: undefined,
    switch: undefined,
  });
  const p = await f.service.prepareTopicOperation(req);
  expect(
    await readFile(
      path.join(f.repo, ".goga/history/2025/main/todo.md"),
      "utf8",
    ),
  ).toBe(d.text);
  await f.service.executeTopicOperation(p.token);
  expect(
    await readFile(
      path.join(f.repo, ".goga/history/2025/main/todo.md"),
      "utf8",
    ),
  ).toBe(req.task);
});
it("rejects current deletion and refuses ambiguous own normalized branches before mutation", async () => {
  const f = await fixture();
  await expect(
    f.service.prepareTopicOperation(
      await f.request({ action: "delete", topics: ["main"] }),
    ),
  ).rejects.toThrow(/текущ/i);
  await f.git("branch", "feat-x");
  await f.git("branch", "feat/x");
  f.rows.push({ ...f.rows[2]!, topic: "feat-x", branch: "feat-x" });
  await expect(
    f.service.prepareTopicOperation(
      await f.request({ action: "delete", topics: ["feat-x"] }),
    ),
  ).rejects.toThrow(/неоднознач|несколько/i);
  expect(f.mutations).toEqual([]);
});
it("warns propagation inherently pushes the base to origin", async () => {
  const f = await fixture();
  await f.git("switch", "feature");
  const p = await f.service.prepareTopicOperation(
    await f.request({
      action: "propagate",
      target: { topic: "feature", branch: "feature", remote: false },
    }),
  );
  expect(p.details.join(" ")).toMatch(/origin/);
  await f.service.executeTopicOperation(p.token);
  expect(f.mutations[0]?.args).toEqual([
    "topics",
    "--year",
    "2025",
    "propagate",
    "feature",
    "--base-ref",
    "main",
    "--yes",
  ]);
});
it("rejects unsafe input and publication-only commit before execution", async () => {
  const f = await fixture();
  await expect(
    f.service.prepareTopicOperation(await f.request({ branch: "--bad" })),
  ).rejects.toThrow();
  await expect(
    f.service.prepareTopicOperation(
      await f.request({ publish: false, commit: "message" }),
    ),
  ).rejects.toThrow(/commit|публикац/i);
  await expect(
    f.service.prepareTopicOperation({
      ...(await f.request()),
      extra: 1,
    } as any),
  ).rejects.toThrow();
});
it("binds confirmation to origin configuration and base tags, not only branch tips", async () => {
  const f = await fixture();
  await f.git(
    "remote",
    "add",
    "origin",
    path.join(f.repo, "unused-local-origin"),
  );
  const p = await f.service.prepareTopicOperation(await f.request());
  await f.git(
    "remote",
    "set-url",
    "origin",
    path.join(f.repo, "other-local-origin"),
  );
  await expect(f.service.executeTopicOperation(p.token)).rejects.toThrow(
    /устарел|изменил/i,
  );
  expect(f.mutations).toEqual([]);
});
it("stales saved task confirmation after external dirty-file content change", async () => {
  const f = await fixture(),
    target = { topic: "main", branch: "main", remote: false };
  const file = path.join(f.repo, ".goga/history/2025/main/todo.md");
  await writeFile(file, "draft one");
  const doc = await f.service.readTopicDetails(f.project.id, "2025", target);
  const p = await f.service.prepareTopicOperation(
    await f.request({
      action: "save-task",
      target,
      task: "replacement",
      taskVersion: doc.version,
    }),
  );
  await writeFile(file, "draft two");
  await expect(f.service.executeTopicOperation(p.token)).rejects.toThrow(
    /устарел|изменил/i,
  );
  expect(await readFile(file, "utf8")).toBe("draft two");
});
it("delete preview lists exact local and origin refs and keeps survivor-carried directory", async () => {
  const f = await fixture();
  await mkdir(path.join(f.repo, ".goga/history/2025/feat-x"), {
    recursive: true,
  });
  await writeFile(
    path.join(f.repo, ".goga/history/2025/feat-x/todo.md"),
    "task",
  );
  await f.git("add", ".");
  await f.git("commit", "-m", "carried");
  await f.git("branch", "feat/x");
  const tip = (await f.git("rev-parse", "HEAD")).stdout.trim();
  await f.git("update-ref", "refs/remotes/origin/feat/x", tip);
  const p = await f.service.prepareTopicOperation(
    await f.request({ action: "delete", topics: ["feat-x"] }),
  );
  const text = p.details.join(" ");
  expect(text).toContain("feat/x");
  expect(text).toContain("origin/feat/x");
  expect(text).toMatch(/сохраняется/);
  await f.service.executeTopicOperation(p.token);
  expect(f.mutations[0]?.args).toEqual([
    "topics",
    "--year",
    "2025",
    "delete",
    "feat-x",
    "--yes",
  ]);
});
it("active repo blocks preparation and execution, but permits board and details reads", async () => {
  const f = await fixture();
  const p = await f.service.prepareTopicOperation(await f.request());
  const key = await (f.service as any).key(f.project);
  (f.service as any).activeKeys.set(key, new Set(["running-fixture"]));
  expect((await f.board()).active).toBe(true);
  const d = await f.service.readTopicDetails(f.project.id, "2025", {
    topic: "main",
    branch: "main",
    remote: false,
  });
  expect(d.editable).toBe(false);
  await expect(
    f.service.prepareTopicOperation(await f.request()),
  ).rejects.toThrow(/конвейер/);
  await expect(f.service.executeTopicOperation(p.token)).rejects.toThrow(
    /конвейер/,
  );
  expect(f.mutations).toEqual([]);
  (f.service as any).activeKeys.clear();
});
it("rejects deletion when ignored removable directory content changed after confirmation", async () => {
  const f = await fixture();
  await f.git("branch", "orphan", "HEAD~1");
  await writeFile(
    path.join(f.repo, ".git/info/exclude"),
    ".goga/history/2025/orphan/\n",
  );
  const directory = path.join(f.repo, ".goga/history/2025/orphan");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "todo.md"), "old");
  const p = await f.service.prepareTopicOperation(
    await f.request({ action: "delete", topics: ["orphan"] }),
  );
  await writeFile(path.join(directory, "todo.md"), "new");
  await expect(f.service.executeTopicOperation(p.token)).rejects.toThrow(
    /устарел|изменил/i,
  );
  expect(f.mutations).toEqual([]);
});
it("rejects remote switch when its short name names a different local branch tip", async () => {
  const f = await fixture();
  const tip = (await f.git("rev-parse", "HEAD")).stdout.trim();
  await f.git("update-ref", "refs/remotes/origin/remote", tip);
  await f.git("branch", "remote");
  await expect(
    f.service.prepareTopicOperation(
      await f.request({
        action: "switch",
        target: { topic: "remote", branch: "origin/remote", remote: true },
      }),
    ),
  ).rejects.toThrow(/локальн|неоднознач/i);
  expect(f.mutations).toEqual([]);
});
it("rejects bare-branch deletion without a topic in any tree or on disk", async () => {
  const f = await fixture();
  await f.git("branch", "bare", "HEAD~1");
  await expect(
    f.service.prepareTopicOperation(
      await f.request({ action: "delete", topics: ["bare"] }),
    ),
  ).rejects.toThrow(/отсутствует|истор/i);
  expect(f.mutations).toEqual([]);
});
it("switches a remote-only topic by exact full remote ref, not a slug resolution", async () => {
  const f = await fixture();
  const tip = (await f.git("rev-parse", "HEAD")).stdout.trim();
  await f.git("update-ref", "refs/remotes/origin/remote", tip);
  const p = await f.service.prepareTopicOperation(
    await f.request({
      action: "switch",
      target: { topic: "remote", branch: "origin/remote", remote: true },
    }),
  );
  await f.service.executeTopicOperation(p.token);
  expect(f.mutations[0]?.args).toEqual([
    "topics",
    "--year",
    "2025",
    "switch",
    "origin/remote",
  ]);
});

it("does not claim a failed remote-capable command left origin untouched", async () => {
  const f = await fixture();
  f.failMutation();
  const p = await f.service.prepareTopicOperation(
    await f.request({
      action: "publish",
      target: { topic: "feature", branch: "feature", remote: false },
    }),
  );
  const result = await f.service.executeTopicOperation(p.token);
  expect(result.status).toBe("partial");
  expect(result.message).toMatch(/origin/);
});

it("reads board and task during an active run with a large unrelated untracked file", async () => {
  const f = await fixture();
  await writeFile(
    path.join(f.repo, "large-unrelated.bin"),
    Buffer.alloc(9 * 1024 * 1024, 65),
  );
  const key = await (f.service as any).key(f.project);
  (f.service as any).activeKeys.set(key, new Set(["running-fixture"]));
  try {
    const board = await f.board();
    expect(board.active).toBe(true);
    expect(board.dirty).toBe(true);
    const task = await f.service.readTopicDetails(f.project.id, "2025", {
      topic: "main",
      branch: "main",
      remote: false,
    });
    expect(task.text).toBe("Полная\nзадача 🙂\n");
    expect(task.editable).toBe(false);
  } finally {
    (f.service as any).activeKeys.clear();
  }
  expect(f.mutations).toEqual([]);
});
it("retains content stale protection for large untracked files without a size cap", async () => {
  const f = await fixture(),
    file = path.join(f.repo, "large-unrelated.bin");
  const bytes = Buffer.alloc(9 * 1024 * 1024, 65);
  await writeFile(file, bytes);
  const plan = await f.service.prepareTopicOperation(await f.request());
  bytes[bytes.length - 1] = 66;
  await writeFile(file, bytes);
  await expect(f.service.executeTopicOperation(plan.token)).rejects.toThrow(
    /устарел|изменил/i,
  );
  expect(f.mutations).toEqual([]);
});

it.each(["update", "propagate"] as const)(
  "rejects %s before confirmation when local or origin base is checked out",
  async (action) => {
    const f = await fixture(),
      tip = (await f.git("rev-parse", "HEAD")).stdout.trim();
    await f.git("update-ref", "refs/remotes/origin/main", tip);
    for (const baseRef of ["main", "origin/main", undefined]) {
      await expect(
        f.service.prepareTopicOperation(
          await f.request({
            action,
            target: { topic: "feature", branch: "feature", remote: false },
            baseRef,
          }),
        ),
      ).rejects.toThrow(/Базовая ветка.*main.*текущая.*переключитесь/i);
    }
    expect(f.mutations).toEqual([]);
  },
);
it("does not mistake pinned update revisions for the CLI branch-shaped base", async () => {
  const f = await fixture(),
    tip = (await f.git("rev-parse", "HEAD")).stdout.trim();
  await f.git("tag", "release-pinned");
  for (const baseRef of ["HEAD", "refs/heads/main", "release-pinned", tip]) {
    const plan = await f.service.prepareTopicOperation(
      await f.request({
        action: "update",
        target: { topic: "feature", branch: "feature", remote: false },
        baseRef,
      }),
    );
    expect(plan.action).toBe("update");
  }
  expect(f.mutations).toEqual([]);
});
it("honors a literal local origin-prefixed base before stripping the origin alias", async () => {
  const f = await fixture();
  await f.git("branch", "origin/main");
  const operation = {
    action: "update" as const,
    target: { topic: "feature", branch: "feature", remote: false },
    baseRef: "origin/main",
  };
  expect(
    (await f.service.prepareTopicOperation(await f.request(operation))).action,
  ).toBe("update");
  await f.git("switch", "origin/main");
  await expect(
    f.service.prepareTopicOperation(await f.request(operation)),
  ).rejects.toThrow(/Базовая ветка.*origin\/main.*текущая/i);
  expect(f.mutations).toEqual([]);
});

it.each(["publish", "propagate"] as const)(
  "confirms dirty-tree %s as commit-only without changing files",
  async (action) => {
    const f = await fixture();
    await f.git("checkout", "feature");
    const file = path.join(f.repo, "untracked-task.md");
    await writeFile(file, "Keep this unsaved Git work");
    const plan = await f.service.prepareTopicOperation(
      await f.request({
        action,
        target: { topic: "feature", branch: "feature", remote: false },
        baseRef: "main",
      }),
    );
    expect(plan.details.join(" ")).toMatch(
      /Только коммиты.*Незакоммиченные изменения не включаются/,
    );
    expect(await readFile(file, "utf8")).toBe("Keep this unsaved Git work");
    expect(f.mutations).toEqual([]);
  },
);

it("prepares other-topic update with unrelated dirty files but rejects current update and switch", async () => {
  const f = await fixture();
  await f.git("branch", "base");
  await writeFile(path.join(f.repo, "untracked.txt"), "Keep current work");
  const target = { topic: "feature", branch: "feature", remote: false };
  const plan = await f.service.prepareTopicOperation(
    await f.request({
      action: "update",
      target,
      baseRef: "base",
      publish: false,
    }),
  );
  expect(f.mutations).toEqual([]);
  expect((await f.service.executeTopicOperation(plan.token)).status).toBe(
    "success",
  );
  expect(f.mutations[0].args).toEqual([
    "topics",
    "--year",
    "2025",
    "update",
    "feature",
    "--base-ref",
    "base",
  ]);
  expect(await readFile(path.join(f.repo, "untracked.txt"), "utf8")).toBe(
    "Keep current work",
  );
  for (const operation of [
    {
      action: "update" as const,
      target: { topic: "main", branch: "main", remote: false },
      baseRef: "base",
    },
    { action: "switch" as const, target },
  ])
    await expect(
      f.service.prepareTopicOperation(await f.request(operation)),
    ).rejects.toThrow(/dirty|изменения/i);
});
it.each([false, true])(
  "prepares deletion of another topic with dirty current tree (remote-only=%s)",
  async (remoteOnly) => {
    const f = await fixture();
    await f.git("switch", "-c", "feat/other");
    await mkdir(path.join(f.repo, ".goga/history/2025/feat-other"), {
      recursive: true,
    });
    await writeFile(
      path.join(f.repo, ".goga/history/2025/feat-other/todo.md"),
      "Other task",
    );
    await f.git("add", ".");
    await f.git("commit", "-m", "other topic");
    await f.git("update-ref", "refs/remotes/origin/feat/other", "HEAD");
    await f.git("switch", "main");
    if (remoteOnly) await f.git("branch", "-D", "feat/other");
    await writeFile(path.join(f.repo, "untracked.txt"), "Keep current work");
    const plan = await f.service.prepareTopicOperation(
      await f.request({ action: "delete", topics: ["feat-other"] }),
    );
    expect(plan.details.join(" ")).toContain("origin/feat/other");
    expect(f.mutations).toEqual([]);
    await writeFile(
      path.join(f.repo, "untracked.txt"),
      "New work after confirmation",
    );
    await expect(f.service.executeTopicOperation(plan.token)).rejects.toThrow(
      /изменил|устарел/i,
    );
    expect(f.mutations).toEqual([]);
    expect(await readFile(path.join(f.repo, "untracked.txt"), "utf8")).toBe(
      "New work after confirmation",
    );
  },
);

it("re-reads a fresh board after pipeline finalization changes files during catalog reading", async () => {
  const f = await fixture();
  let reads = 0;
  f.onBoardRead(async () => {
    if (++reads === 1) {
      await writeFile(path.join(f.repo, "pipeline-result.txt"), "Finished");
      f.rows[0]!.statuses = ["done"];
    }
  });
  const board = await f.board();
  expect(reads).toBe(2);
  expect(board.records[0]!.statuses).toEqual(["done"]);
  expect(board.revision).toBe((await f.board()).revision);
  expect(f.mutations).toEqual([]);
});
it("bounds catalog retries when project state never settles and does not report a stale confirmation", async () => {
  const f = await fixture();
  let reads = 0;
  f.onBoardRead(async () => {
    await writeFile(path.join(f.repo, "pipeline-result.txt"), String(++reads));
  });
  await expect(f.board()).rejects.toThrow(
    "Данные проекта меняются во время загрузки топиков. Повторите загрузку через несколько секунд.",
  );
  expect(reads).toBe(3);
  expect(f.mutations).toEqual([]);
});
it("does not retry unrelated catalog command failures", async () => {
  const f = await fixture();
  let reads = 0;
  f.onBoardRead(async () => {
    reads++;
    throw Error("CLI unavailable");
  });
  await expect(f.board()).rejects.toThrow("Операция Goga не выполнена");
  expect(reads).toBe(1);
  expect(f.mutations).toEqual([]);
});

it("does not refresh an operation confirmation when its board read retries", async () => {
  const f = await fixture();
  const request = await f.request();
  let reads = 0;
  f.onBoardRead(async () => {
    if (++reads === 1)
      await writeFile(path.join(f.repo, "pipeline-result.txt"), "Finished");
  });
  await expect(f.service.prepareTopicOperation(request)).rejects.toThrow(
    "Каталог изменился; обновите данные.",
  );
  expect(reads).toBe(2);
  expect(f.mutations).toEqual([]);
});

it.each([false, true])(
  "allows dirty local create switch=%s without dropping staged, unstaged or untracked work",
  async (switchTo) => {
    const f = await fixture();
    await writeFile(path.join(f.repo, "staged.txt"), "staged");
    await f.git("add", "staged.txt");
    await writeFile(path.join(f.repo, "staged.txt"), "unstaged");
    await writeFile(path.join(f.repo, "untracked.txt"), "untracked");
    const before = await f.git("status", "--porcelain=v1");
    const plan = await f.service.prepareTopicOperation(
      await f.request({ publish: false, switch: switchTo }),
    );
    expect((await f.service.executeTopicOperation(plan.token)).status).toBe(
      "success",
    );
    expect(f.mutations).toHaveLength(1);
    expect(f.mutations[0]!.args.includes("--switch")).toBe(switchTo);
    expect(await f.git("status", "--porcelain=v1")).toEqual(before);
    expect((await f.git("show", ":staged.txt")).stdout).toBe("staged");
    expect(await readFile(path.join(f.repo, "staged.txt"), "utf8")).toBe(
      "unstaged",
    );
    expect(await readFile(path.join(f.repo, "untracked.txt"), "utf8")).toBe(
      "untracked",
    );
  },
);
it("still rejects dirty independent switch and current-topic update", async () => {
  const f = await fixture();
  await writeFile(path.join(f.repo, "untracked.txt"), "dirty");
  for (const action of ["switch", "update"] as const) {
    await expect(
      f.service.prepareTopicOperation(
        await f.request({
          action,
          target: { topic: "main", branch: "main", remote: false },
          publish: false,
          switch: false,
        }),
      ),
    ).rejects.toThrow(/dirty|изменения/i);
  }
  expect(f.mutations).toEqual([]);
});

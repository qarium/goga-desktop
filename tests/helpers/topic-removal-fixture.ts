import { mkdtemp, mkdir, writeFile, rm, rename } from "node:fs/promises";
import path from "node:path";
import { HostService } from "../../src/host/service";
import { NodeRunner, type Runner } from "../../src/host/process";
import { CloneManager } from "../../src/host/clones";
export async function topicRemovalFixture(
  cleanups: Array<() => Promise<unknown>>,
) {
  const root = await mkdtemp("/private/tmp/goga-topic-removal-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    repo = path.join(root, "repo");
  await mkdir(home);
  await mkdir(repo);
  const node = new NodeRunner();
  cleanups.push(() => node.dispose());
  const env = {
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = (args: string[], cwd = repo) =>
    node
      .command("git", ["-c", "core.hooksPath=/dev/null", ...args], cwd, env)
      .then((r) => r.stdout.trim());
  await git(["init", "-b", "main"]);
  await mkdir(path.join(repo, ".goga/history/2026/alpha"), { recursive: true });
  await writeFile(
    path.join(repo, ".goga/history/2026/alpha/todo.md"),
    "Fixture",
  );
  await writeFile(
    path.join(repo, ".goga/config.yml"),
    "topics:\n  base_ref: main\n",
  );
  await git(["add", "."]);
  await git(["commit", "-m", "fixture"]);
  await git(["branch", "alpha"]);
  const calls: string[][] = [],
    order: string[] = [];
  let fail = false;
  let onMutation: (() => Promise<unknown>) | undefined;
  const runner: Runner = {
    start: node.start.bind(node),
    kill: node.kill.bind(node),
    command: async (exe, args, cwd, overrides, stdin) => {
      if (exe === "git")
        return node.command(exe, args, cwd, { ...env, ...overrides }, stdin);
      if (args.includes("board")) {
        const branches = (
          await git(
            ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
            cwd,
          )
        )
          .split("\n")
          .filter(Boolean);
        const rows = args.includes("--remote")
          ? []
          : branches.map((branch) => ({
              topic: branch,
              branch,
              remote: false,
              current: branch === (cwd === repo ? "main" : "alpha"),
              statuses: ["done"],
              todo: null,
              divergence: null,
              ...(!args.includes("--per-host") ? { hosts: [branch] } : {}),
            }));
        return { stdout: JSON.stringify(rows), stderr: "" };
      }
      calls.push(args);
      order.push("goga");
      await onMutation?.();
      if (fail) throw Error("fixture command failure");
      if (args.includes("clear") || args.includes("delete"))
        for (const branch of args.includes("clear")
          ? ["alpha"]
          : args.slice(4).filter((x) => x !== "--yes")) {
          await git(["branch", "-D", branch]);
        }
      return { stdout: "done", stderr: "" };
    },
  };
  const service = new HostService({
    home,
    dataDir: path.join(root, "data"),
    goga: "mock-goga",
    runner,
    trashItem: async (p) => {
      order.push("trash");
      await rename(p, path.join(root, "trash"));
    },
  });
  cleanups.push(() => service.dispose());
  const project = await service.addProject(repo);
  const manager = new CloneManager(home, runner);
  return {
    root,
    home,
    repo,
    git,
    service,
    project,
    manager,
    calls,
    order,
    fail: () => {
      fail = true;
    },
    onMutation: (fn: () => Promise<unknown>) => {
      onMutation = fn;
    },
    request: async (action: "delete" | "clear" = "delete") => ({
      projectId: project.id,
      year: "2026",
      expectedRevision: (await service.readTopicBoard(project.id, "2026"))
        .revision,
      action,
      ...(action === "delete" ? { topics: ["alpha"] } : { baseRef: "main" }),
    }),
  };
}

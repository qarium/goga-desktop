import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  chmod,
} from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { HostService } from "../src/host/service";
import { NodeRunner, type Runner } from "../src/host/process";
import type { BuildRequest } from "../src/shared/build";
const roots: string[] = [];
const services: HostService[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const service of services.splice(0)) await service.dispose();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const HELP =
  "--session-timeout --idle-timeout --wait --max-iterations --review-patience --base-ref --workflow --profile --env --proxy --add-host --clean --update --skip-review --no-skip-review --skip-manifest-check";
async function setup(help = HELP) {
  const root = await mkdtemp("/private/tmp/goga-build-");
  roots.push(root);
  const repo = path.join(root, "repo"),
    home = path.join(root, "home");
  await mkdir(repo);
  await mkdir(home);
  const node = new NodeRunner();
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.email", "fixture@example.com"],
    ["config", "user.name", "Fixture"],
    ["commit", "--allow-empty", "-m", "fixture"],
  ])
    await node.command("git", args, repo);
  await mkdir(path.join(repo, ".goga/workflows"), { recursive: true });
  await mkdir(path.join(repo, ".goga/profiles"));
  await writeFile(
    path.join(repo, ".goga/config.yml"),
    "build:\n  review:\n    skip: true\n",
  );
  await writeFile(path.join(repo, "plan.md"), "# Build plan\n");
  const calls: { exe: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const children: any[] = [];
  const kill = vi.fn(async () => {});
  let history = "plan.md";
  let effective: string | Error = "# build.review.skip\nTrue\n";
  const runner: Runner = {
    kill,
    command: async (exe, args, cwd, env) => {
      if (exe === "git") return node.command(exe, args, cwd);
      calls.push({ exe, args, env });
      if (args.join(" ") === "history path -f plan.md")
        return { stdout: history + "\n", stderr: "" };
      if (args.join(" ") === "config build.review.skip") {
        if (effective instanceof Error) throw effective;
        return { stdout: effective, stderr: "tool amendment diagnostic" };
      }
      if (args.join(" ") === "build --help")
        return { stdout: help, stderr: "" };
      throw Error("Unexpected Goga command");
    },
    start: (exe, args, cwd, env) => {
      calls.push({ exe, args, env });
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      children.push(child);
      return child as any;
    },
  };
  const service = new HostService({
    home,
    dataDir: path.join(root, "data"),
    goga: "fixture-goga",
    runner,
  });
  services.push(service);
  const p = await service.addProject(repo);
  const request = async (
    options: BuildRequest["options"] = {},
  ): Promise<BuildRequest> => {
    const c = await service.buildContext(p.id, {
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.workflow !== undefined ? { workflow: options.workflow } : {}),
      ...(options.profile !== undefined ? { profile: options.profile } : {}),
    });
    const plan = await service.readBuildPlan(p.id, "plan.md");
    return {
      projectId: p.id,
      expectedBranch: c.branch,
      contextRevision: c.revision,
      planPath: plan.path,
      planVersion: plan.version,
      options,
      confirmClean: false,
    };
  };
  return {
    root,
    repo,
    home,
    service,
    p,
    request,
    calls,
    children,
    kill,
    node,
    setHistory: (v: string) => (history = v),
    setEffective: (v: string | Error) => (effective = v),
  };
}
it("resolves history through selected executable, without pipeline/AFM discovery, preserves missing alternative", async () => {
  const f = await setup();
  const c = await f.service.buildContext(f.p.id);
  expect(c.historyPlan).toEqual({ path: "plan.md" });
  expect(c.branch).toBe("main");
  expect(c.defaults.skipReview).toBe(true);
  expect(c.capabilities).toContain("workflow");
  expect(
    f.calls.every((x) => ["history", "build", "config"].includes(x.args[0])),
  ).toBe(true);
  f.setHistory("absent.md");
  expect((await f.service.buildContext(f.p.id)).historyPlan.error).toBeTruthy();
  expect((await f.service.readBuildPlan(f.p.id, "plan.md")).text).toContain(
    "Build plan",
  );
});
it("contains canonical paths, excludes escaping links, checks UTF8/file size/readability", async () => {
  const f = await setup();
  await writeFile(path.join(f.root, "outside.md"), "outside");
  await symlink(f.root, path.join(f.repo, "escape"));
  await symlink(path.join(f.repo, "plan.md"), path.join(f.repo, "inside.md"));
  for (const name of ["../outside.md", "escape/outside.md", "/etc/passwd"])
    await expect(f.service.readBuildPlan(f.p.id, name)).rejects.toThrow();
  await expect(f.service.listBuildFiles(f.p.id, "escape")).rejects.toThrow();
  const listing = await f.service.listBuildFiles(f.p.id, "");
  expect(listing.directory).toBe("");
  expect(listing.entries.some((e) => e.name === "escape")).toBe(false);
  expect((await f.service.readBuildPlan(f.p.id, "inside.md")).path).toBe(
    "plan.md",
  );
  await expect(f.service.readBuildPlan(f.p.id, ".goga")).rejects.toThrow();
  await writeFile(path.join(f.repo, "binary"), Buffer.from([255, 254]));
  await expect(f.service.readBuildPlan(f.p.id, "binary")).rejects.toThrow();
  await writeFile(path.join(f.repo, "big"), "x".repeat(1024 * 1024 + 1));
  await expect(f.service.readBuildPlan(f.p.id, "big")).rejects.toThrow();
  await writeFile(path.join(f.repo, "unreadable"), "x");
  await chmod(path.join(f.repo, "unreadable"), 0);
  await expect(f.service.readBuildPlan(f.p.id, "unreadable")).rejects.toThrow();
});
it("launches independent process with all exact options and no dashboard/startup timer, retains sanitized output", async () => {
  const f = await setup();
  await writeFile(
    path.join(f.repo, ".goga/workflows/test.yml"),
    "build:\n  review:\n    skip: false\n",
  );
  await writeFile(path.join(f.repo, ".goga/profiles/dev.yml"), "{}");
  const r = await f.service.launchBuild({
    ...(await f.request({
      workflow: "test",
      profile: "dev",
      sessionTimeout: "1h30m",
      idleTimeout: "0",
      wait: "1.5s",
      maxIterations: 5,
      reviewPatience: 0,
      baseRef: "main",
      env: [{ key: "TOKEN", value: "secret-123" }],
      addHost: [{ host: "docker.local", ip: "host-gateway" }],
      proxy: "http://user:password@localhost:8080",
      clean: true,
      update: true,
      skipReview: false,
      skipManifestCheck: true,
    })),
    confirmClean: true,
  });
  expect(r.kind).toBe("build");
  expect(r.status).toBe("running");
  expect(r.startupTimeoutMs).toBeUndefined();
  expect(r.url).toBeUndefined();
  expect(r.build?.clean).toBe(true);
  expect(f.calls.at(-1)?.args).toEqual([
    "build",
    "plan.md",
    "--workflow",
    "test",
    "--profile",
    "dev",
    "--session-timeout",
    "1h30m",
    "--idle-timeout",
    "0",
    "--wait",
    "1.5s",
    "--max-iterations",
    "5",
    "--review-patience",
    "0",
    "--base-ref",
    "main",
    "--env",
    "TOKEN=secret-123",
    "--add-host",
    "docker.local:host-gateway",
    "--proxy",
    "http://user:password@localhost:8080",
    "--clean",
    "--update",
    "--no-skip-review",
    "--skip-manifest-check",
  ]);
  f.children[0].stdout.write(
    "secret-123 http://user:password@localhost:8080\n",
  );
  f.children[0].emit("close", 0);
  await vi.waitFor(() => expect(f.service.runs()[0].status).toBe("exited"));
  expect(JSON.stringify(f.service.runs())).not.toMatch(/secret-123|password/);
  expect(f.service.runs()[0].output?.text).toContain("REDACTED");
  expect(f.kill).toHaveBeenCalledTimes(1);
});
it("blocks unsupported explicit/project profile without silently discarding options", async () => {
  const f = await setup(
    HELP.replace("--workflow", "").replace("--profile", ""),
  );
  await writeFile(path.join(f.repo, ".goga/profiles/dev.yml"), "{}");
  await expect(
    f.service.launchBuild(await f.request({ profile: "dev" })),
  ).rejects.toThrow(/profile/);
  const settings = await f.service.readProjectSettings(f.p.id);
  await f.service.saveProjectSettings(
    f.p.id,
    { ...settings.value, profile: "dev" },
    settings.version,
  );
  await expect(f.service.launchBuild(await f.request())).rejects.toThrow(
    /profile/,
  );
  expect(f.children).toHaveLength(0);
});
it.each([
  { sessionTimeout: "1 day" },
  { wait: "-2s" },
  { maxIterations: 1.5 },
  { reviewPatience: -1 },
  { env: [{ key: "BAD=KEY", value: "hidden" }] },
  { env: [{ key: "A", value: "a\nb" }] },
  { addHost: [{ host: "x:y", ip: "127.0.0.1" }] },
  { addHost: [{ host: "x", ip: "bogus" }] },
  { baseRef: "HEAD~1" },
  { dryRun: true },
  { proxy: "file:///secret" },
])("rejects hostile option %j", async (options) => {
  const f = await setup();
  await expect(
    f.service.launchBuild({ ...(await f.request()), options: options as any }),
  ).rejects.toThrow();
  expect(f.children).toHaveLength(0);
});
it("rejects stale plan/settings/branch/context and clean without consent", async () => {
  const f = await setup();
  const r = await f.request();
  await writeFile(path.join(f.repo, "plan.md"), "new");
  await expect(f.service.launchBuild(r)).rejects.toThrow(/план|План/);
  const s = await f.request();
  await writeFile(path.join(f.repo, ".goga/config.yml"), "build: {}");
  await expect(f.service.launchBuild(s)).rejects.toThrow(/устар|измен/);
  const b = await f.request();
  await f.node.command("git", ["switch", "-c", "other"], f.repo);
  await expect(f.service.launchBuild(b)).rejects.toThrow(/ветк|устар/);
  await expect(
    f.service.launchBuild(await f.request({ clean: true })),
  ).rejects.toThrow(/Подтверд/);
  expect(f.children).toHaveLength(0);
});
it("shares active locks, retains lock on failed kill, stops, repeats immutable secret request and checks staleness", async () => {
  const f = await setup();
  const request = await f.request({
    clean: true,
    env: [{ key: "TOKEN", value: "original-secret" }],
  });
  request.confirmClean = true;
  const run = await f.service.launchBuild(request);
  request.options.env![0].value = "mutated";
  await expect(f.service.launchBuild(await f.request())).rejects.toThrow(
    /работает/,
  );
  f.kill.mockRejectedValueOnce(Error("cannot kill"));
  await expect(f.service.stop(run.id)).rejects.toThrow();
  await expect(f.service.launchBuild(await f.request())).rejects.toThrow(
    /работает/,
  );
  f.children[0].stdout.write("last output");
  await f.service.stop(run.id);
  expect(f.service.runs()[0].status).toBe("stopped");
  expect(f.service.runs()[0].output?.text).toContain("last output");
  await expect(f.service.repeatBuild(run.id, false)).rejects.toThrow(
    /Подтверд/,
  );
  const again = await f.service.repeatBuild(run.id, true);
  expect(f.calls.at(-1)?.args).toContain("TOKEN=original-secret");
  await f.service.stop(again.id);
  await writeFile(path.join(f.repo, "plan.md"), "changed");
  await expect(f.service.repeatBuild(run.id, true)).rejects.toThrow();
});
it("child error and nonzero exit fail without dashboard messages and close removes private repeat request", async () => {
  const f = await setup();
  const run = await f.service.launchBuild(await f.request());
  f.children[0].emit("error", Error("sensitive raw error"));
  await vi.waitFor(() => expect(f.service.runs()[0].status).toBe("failed"));
  expect(f.service.runs()[0].error).not.toMatch(/Dashboard|sensitive/);
  const second = await f.service.launchBuild(await f.request());
  f.children[1].stderr.write("failure detail");
  f.children[1].emit("close", 3);
  await vi.waitFor(() => expect(f.service.runs()[1].status).toBe("failed"));
  expect(f.service.runs()[1].output?.text).toContain("failure detail");
  await f.service.closeRun(second.id, async () => true);
  await expect(f.service.repeatBuild(second.id, false)).rejects.toThrow();
});
it("applies project runtime env verbatim then per-run overrides, using selected executable", async () => {
  const f = await setup();
  const document = await f.service.readProjectSettings(f.p.id);
  await f.service.saveProjectSettings(
    f.p.id,
    {
      ...document.value,
      executable: "/fixture/custom-goga",
      env: [
        {
          key: "PRIVATE",
          value: "host-only-secret",
          runtime: false,
          secret: true,
        },
        {
          key: "TOKEN",
          value: "project-runtime-secret",
          runtime: true,
          secret: true,
        },
      ],
    },
    document.version,
  );
  const run = await f.service.launchBuild(
    await f.request({ env: [{ key: "TOKEN", value: "per-run-secret" }] }),
  );
  const call = f.calls.at(-1)!;
  expect(call.exe).toBe("/fixture/custom-goga");
  expect(call.env).toEqual({
    PRIVATE: "host-only-secret",
    TOKEN: "project-runtime-secret",
  });
  expect(call.args).toEqual([
    "build",
    "plan.md",
    "--env",
    "TOKEN=project-runtime-secret",
    "--env",
    "TOKEN=per-run-secret",
  ]);
  f.children[0].stderr.write(
    "host-only-secret project-runtime-secret per-run-secret\n",
  );
  await f.service.stop(run.id);
  expect(JSON.stringify(f.service.runs())).not.toMatch(
    /host-only-secret|project-runtime-secret|per-run-secret/,
  );
});
it("workflow skip and unrelated templates do not override effective config review", async () => {
  const f = await setup();
  await mkdir(path.join(f.home, ".goga/profiles"), { recursive: true });
  await writeFile(path.join(f.home, ".goga/profiles/dev.yml"), "skip: true\n");
  await writeFile(path.join(f.repo, ".goga/profiles/dev.yml"), "skip: false\n");
  for (const text of [
    "profile: dev\nbuild:\n  review:\n    skip: false\n",
    "build:\n  review:\n    agent: {{ absent | default('agent') }}\n",
  ]) {
    await writeFile(path.join(f.repo, ".goga/workflows/custom.yml"), text);
    const c = await f.service.buildContext(f.p.id, { workflow: "custom" });
    expect(c.defaults.skipReview).toBe(true);
    expect(c.defaults.reviewError).toBeUndefined();
    expect(c.profiles).toEqual([{ name: "dev", source: "project" }]);
  }
});

it("repeat rejects changed settings and branch, does not bypass retained output on denied close", async () => {
  const f = await setup();
  const run = await f.service.launchBuild(await f.request());
  f.children[0].stdout.write("log\n");
  expect(await f.service.closeRun(run.id, async () => false)).toBe(false);
  expect(f.service.runs()[0].status).toBe("running");
  await f.service.stop(run.id);
  const settings = await f.service.readProjectSettings(f.p.id);
  await f.service.saveProjectSettings(
    f.p.id,
    {
      ...settings.value,
      env: [{ key: "A", value: "new", runtime: true, secret: false }],
    },
    settings.version,
  );
  await expect(f.service.repeatBuild(run.id, false)).rejects.toThrow(
    /устар|измен/,
  );
  expect(f.service.runs()[0].output?.text).toContain("log");
  const second = await f.service.launchBuild(await f.request());
  await f.service.stop(second.id);
  await f.node.command("git", ["switch", "-c", "other"], f.repo);
  await expect(f.service.repeatBuild(second.id, false)).rejects.toThrow(
    /ветк|устар/,
  );
});
it("home workflow selection does not change effective review skip", async () => {
  const f = await setup();
  await mkdir(path.join(f.home, ".goga"), { recursive: true });
  await writeFile(
    path.join(f.home, ".goga/config.yml"),
    "env:\n  GOGA_WORKFLOW: custom\n",
  );
  await writeFile(
    path.join(f.repo, ".goga/workflows/custom.yml"),
    "build:\n  review:\n    skip: false\n",
  );
  expect((await f.service.buildContext(f.p.id)).defaults).toMatchObject({
    skipReview: true,
  });
});

it("tool directories and unrelated unresolved templates do not imply unknown review", async () => {
  const f = await setup();
  await writeFile(
    path.join(f.repo, ".goga/workflows/custom.yml"),
    "build:\n  agent: {{ absent }}\n",
  );
  await mkdir(path.join(f.repo, ".goga/tools/tool"), { recursive: true });
  expect(
    (await f.service.buildContext(f.p.id, { workflow: "custom" })).defaults
      .reviewError,
  ).toBeUndefined();
  f.setEffective("# build.review.skip\nFalse\n");
  expect((await f.service.buildContext(f.p.id)).defaults.skipReview).toBe(
    false,
  );
});

it("per-run runtime selectors retain launch workflow without changing host review", async () => {
  const f = await setup();
  await writeFile(
    path.join(f.repo, ".goga/workflows/custom.yml"),
    "build:\n  review:\n    skip: {{ skip }}\n",
  );
  await writeFile(path.join(f.repo, ".goga/profiles/dev.yml"), "skip: false\n");
  const env = [
    { key: "GOGA_WORKFLOW", value: "custom" },
    { key: "GOGA_PROFILE", value: "dev" },
  ];
  const c = await f.service.buildContext(f.p.id, { env });
  expect(c.defaults.skipReview).toBe(true);
  expect(c.defaults.reviewError).toBeUndefined();
  const plan = await f.service.readBuildPlan(f.p.id, "plan.md");
  const run = await f.service.launchBuild({
    projectId: f.p.id,
    expectedBranch: c.branch,
    contextRevision: c.revision,
    planPath: plan.path,
    planVersion: plan.version,
    options: { env },
    confirmClean: false,
  });
  expect(run.workflow).toBe("custom");
  await f.service.stop(run.id);
});
it("prefixes option-looking plan filename so CLI never interprets it as flags", async () => {
  const f = await setup();
  await writeFile(path.join(f.repo, "--clean"), "plan");
  const r = await f.request();
  const plan = await f.service.readBuildPlan(f.p.id, "--clean");
  const run = await f.service.launchBuild({
    ...r,
    planPath: plan.path,
    planVersion: plan.version,
  });
  expect(f.calls.at(-1)?.args).toEqual(["build", "./--clean"]);
  await f.service.stop(run.id);
});
it("missing or malformed workflow profile is not misreported as unknown review skip", async () => {
  const f = await setup();
  await writeFile(
    path.join(f.repo, ".goga/workflows/custom.yml"),
    "profile: missing\nbuild:\n  agent: {{ agent }}\n",
  );
  for (const profile of [undefined, "false\n"]) {
    if (profile)
      await writeFile(path.join(f.repo, ".goga/profiles/missing.yml"), profile);
    expect(
      (await f.service.buildContext(f.p.id, { workflow: "custom" })).defaults
        .reviewError,
    ).toBeUndefined();
  }
});

it("redacts known home and build-config environment values and proxy credentials in live output and kill errors", async () => {
  const f = await setup();
  await mkdir(path.join(f.home, ".goga"), { recursive: true });
  await writeFile(
    path.join(f.home, ".goga/config.yml"),
    "env:\n  API_TOKEN: home-api-token\n",
  );
  await writeFile(
    path.join(f.repo, ".goga/config.yml"),
    "build:\n  env:\n    TASK_TOKEN: task-config-token\n  proxy: http://proxy-user:proxy-password@localhost:8080\n  review:\n    env:\n      REVIEW_TOKEN: review-config-token\n    additional:\n      env:\n        EXTRA_TOKEN: extra-config-token\n",
  );
  const run = await f.service.launchBuild(await f.request());
  const published: string[] = [];
  f.service.on("runs", (runs) => published.push(JSON.stringify(runs)));
  const payload =
    "home-api-token task-config-token review-config-token extra-config-token http://proxy-user:proxy-password@localhost:8080 proxy-password\n";
  f.children[0].stdout.write(payload);
  f.kill.mockRejectedValueOnce(Error(payload));
  await expect(f.service.stop(run.id)).rejects.toThrow(/остановить/);
  expect(JSON.stringify(f.service.runs())).not.toMatch(
    /home-api-token|task-config-token|review-config-token|extra-config-token|proxy-password/,
  );
  await f.service.stop(run.id);
  expect(published.join("\n")).not.toMatch(
    /home-api-token|task-config-token|review-config-token|extra-config-token|proxy-password/,
  );
  expect(f.service.runs()[0].output?.text).toContain("REDACTED");
});
it("runtime GOGA_HOME_PROFILES affects templates, not the config review decision", async () => {
  const f = await setup();
  const payload = Buffer.from(
    JSON.stringify({ dev: { skip: false } }),
  ).toString("base64");
  const c = await f.service.buildContext(f.p.id, {
    env: [{ key: "GOGA_HOME_PROFILES", value: payload }],
  });
  expect(c.defaults.skipReview).toBe(true);
  expect(c.defaults.reviewError).toBeUndefined();
  expect(JSON.stringify(c)).not.toContain(payload);
});

it("an empty inherited GOGA_PROFILE cannot change effective review skip", async () => {
  const f = await setup();
  await mkdir(path.join(f.home, ".goga/profiles"), { recursive: true });
  await writeFile(
    path.join(f.home, ".goga/config.yml"),
    "env:\n  GOGA_WORKFLOW: custom\n  GOGA_PROFILE: dev\n",
  );
  await writeFile(path.join(f.home, ".goga/profiles/dev.yml"), "skip: false\n");
  await writeFile(
    path.join(f.repo, ".goga/workflows/custom.yml"),
    "build:\n  review:\n    skip: {{ skip }}\n",
  );
  vi.stubEnv("GOGA_PROFILE", "");
  const c = await f.service.buildContext(f.p.id);
  expect(c.defaults.reviewError).toBeUndefined();
  expect(c.defaults.skipReview).toBe(true);
});

it.each([
  ["null", false],
  ["False", false],
  ["True", true],
])(
  "reads effective review %s with tools and missing history independently",
  async (value, skip) => {
    const f = await setup();
    await writeFile(
      path.join(f.repo, ".goga/config.yml"),
      "tools:\n  autonomous/basic-build: latest\nbuild:\n  review:\n    skip: false\n",
    );
    await mkdir(path.join(f.repo, ".goga/tools/mkdocs"), { recursive: true });
    f.setEffective(`# build.review.skip\n${value}\n`);
    f.setHistory("absent.md");
    const c = await f.service.buildContext(f.p.id);
    expect(c.defaults).toMatchObject({ skipReview: skip });
    expect(c.defaults.reviewError).toBeUndefined();
    expect(c.historyPlan.error).toBe(
      "План для текущего топика ещё не создан. Выберите другой файл.",
    );
    expect(
      f.calls.filter((c) => c.args[0] === "config").map((c) => c.args),
    ).toEqual([["config", "build.review.skip"]]);
  },
);
it("uses selected executable and host env for amendments, not container-only env; detects amended changes", async () => {
  const f = await setup();
  const settings = await f.service.readProjectSettings(f.p.id);
  await f.service.saveProjectSettings(
    f.p.id,
    {
      ...settings.value,
      executable: "/fixture/goga",
      env: [
        { key: "HOOK_MODE", value: "enabled", runtime: false, secret: false },
      ],
    },
    settings.version,
  );
  const a = await f.service.buildContext(f.p.id, {
    env: [{ key: "CONTAINER_ONLY", value: "yes" }],
  });
  const call = f.calls.find((c) => c.args[0] === "config");
  expect(call).toMatchObject({
    exe: "/fixture/goga",
    env: { HOOK_MODE: "enabled" },
  });
  expect(call?.env).not.toHaveProperty("CONTAINER_ONLY");
  f.setEffective("# build.review.skip\nFalse\n");
  const b = await f.service.buildContext(f.p.id, {
    env: [{ key: "CONTAINER_ONLY", value: "yes" }],
  });
  expect(b.defaults.skipReview).toBe(false);
  expect(a.revision).not.toBe(b.revision);
});
it.each([
  new Error("secret CLI failure"),
  "# build.review.skip\n42\n",
  "",
  "# other.option\nfalse\n",
])("does not silence invalid or failed effective config", async (value) => {
  const f = await setup();
  f.setEffective(value);
  const c = await f.service.buildContext(f.p.id);
  expect(c.defaults.reviewError).toMatch(
    /настройку ревью|некорректное значение/,
  );
  expect(JSON.stringify(c)).not.toContain("secret CLI failure");
  await expect(f.service.launchBuild(await f.request())).rejects.toThrow(
    /ревью|некорректное/,
  );
  const run = await f.service.launchBuild(
    await f.request({ skipReview: false }),
  );
  expect(f.calls.at(-1)?.args).toContain("--no-skip-review");
  await f.service.stop(run.id);
});
it("distinguishes absent, unreadable, external, escaped and CLI history failures", async () => {
  const f = await setup();
  await writeFile(path.join(f.repo, "unreadable.md"), "x");
  await chmod(path.join(f.repo, "unreadable.md"), 0);
  await symlink(f.root, path.join(f.repo, "escape"));
  await writeFile(path.join(f.root, "outside.md"), "outside");
  for (const [file, pattern] of [
    ["absent.md", /ещё не создан/],
    ["unreadable.md", /Нет доступа/],
    ["/etc/passwd", /за пределами/],
    ["escape/outside.md", /за пределами|не найден/],
  ] as const) {
    f.setHistory(file);
    const c = await f.service.buildContext(f.p.id);
    expect(c.historyPlan.error).toMatch(pattern);
    expect(c.defaults.reviewError).toBeUndefined();
  }
});

it("history CLI failures are distinct and never expose command output", async () => {
  const f = await setup();
  f.setHistory("");
  const c = await f.service.buildContext(f.p.id);
  expect(c.historyPlan.error).toMatch(/получить путь плана из Goga/);
  expect(c.defaults.reviewError).toBeUndefined();
});
it("rejects stale launch when tool-amended review changes", async () => {
  const f = await setup();
  const request = await f.request();
  f.setEffective("# build.review.skip\nFalse\n");
  await expect(f.service.launchBuild(request)).rejects.toThrow(/устарел/);
  expect(f.children).toHaveLength(0);
});
it("prepares a restart repeat with safe options and missing secret inputs, never launches it silently", async () => {
  const f = await setup(),
    request = await f.request({
      sessionTimeout: "7m",
      maxIterations: 3,
      env: [{ key: "CANARY_TOKEN", value: "repeat-private-canary" }],
      proxy: "https://user:password@example.invalid:443",
      skipReview: true,
    });
  const run = await f.service.launchBuild(request);
  await f.service.stop(run.id);
  await f.service.dispose();
  const restored = new HostService({
    home: f.home,
    dataDir: path.join(f.root, "data"),
    runner: f.node,
  });
  services.push(restored);
  await restored.initialize();
  const seed = await restored.prepareBuildRepeat(run.id);
  expect(seed.options.sessionTimeout).toBe("7m");
  expect(seed.options.maxIterations).toBe(3);
  expect(seed.requiredEnvKeys).toEqual(["CANARY_TOKEN"]);
  expect(seed.requiresProxy).toBe(true);
  expect(seed.requiresReview).toBe(true);
  expect(JSON.stringify(seed)).not.toMatch(
    /repeat-private-canary|password|https:/,
  );
  expect(restored.runs()).toHaveLength(1);
  await expect(
    restored.launchBuild({
      ...request,
      repeat: { sourceRunId: run.id, acknowledged: true },
      options: { skipReview: true },
    }),
  ).rejects.toThrow(/CANARY_TOKEN|окружени|значени/);
});
it("keeps an unverified recovered primary run reserved against another writer", async () => {
  const f = await setup();
  const request = await f.request();
  (f.service as any).runList.push({
    id: "recovered",
    projectId: f.p.id,
    pipeline: "build",
    topic: "",
    branch: "main",
    status: "running",
    workflow: null,
    profile: null,
    startedAt: new Date().toISOString(),
    recovery: "unverified",
  });
  await expect(f.service.launchBuild(request)).rejects.toThrow(
    /уже работает|не подтверждено/,
  );
});

import { HostService } from "../src/host/service";
import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";
async function main() {
  const root = path.resolve("work/host-smoke-" + Date.now()),
    home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      env: { ...process.env, HOME: home },
      stdio: "pipe",
    })
      .toString()
      .trim();
  async function fixture(name: string) {
    const dir = path.join(root, name);
    await mkdir(path.join(dir, ".goga/pipelines"), { recursive: true });
    await mkdir(path.join(dir, ".goga/workflows"));
    await mkdir(path.join(dir, ".goga/profiles"));
    await writeFile(
      path.join(dir, ".goga/config.yml"),
      "language: python\nimage: qarium/goga:latest\npipeline: {}\n",
    );
    await writeFile(
      path.join(dir, ".goga/pipelines/desktop-smoke.yml"),
      'name: Desktop integration smoke\ndescription: Script-only disposable test. No agents.\n---\n- name: smoke\n  title: Desktop readiness check\n  script: |\n    echo "Desktop script-only test"\n    sleep 900\n  timeout: 16m\n- name: tail\n  title: Optional tail\n  script: echo tail\n',
    );
    await writeFile(
      path.join(dir, ".goga/profiles/local.yml"),
      "skip_tail: true\n",
    );
    await writeFile(
      path.join(dir, ".goga/workflows/desktop-smoke.yml"),
      "stages:\n  tail:\n    skip: true\n",
    );
    git(dir, "init", "-b", "main");
    git(dir, "add", ".");
    git(
      dir,
      "-c",
      "user.name=Desktop Smoke",
      "-c",
      "user.email=desktop-smoke@localhost",
      "commit",
      "-m",
      "Disposable fixture",
    );
    return dir;
  }
  const service = new HostService({
    home,
    dataDir: path.join(root, "data"),
    goga: process.env.GOGA_BINARY || "goga",
  });
  const result: any = { fixtureRoot: root };
  const waitReady = async (id: string) => {
    for (let i = 0; i < 480; i++) {
      const r = service.runs().find((r) => r.id === id)!;
      if (r.status === "running") return r;
      if (r.status === "failed") throw new Error(r.error);
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("Readiness timeout");
  };
  try {
    const a = await service.addProject(await fixture("project-one"));
    const discovery = await service.discover(a.id);
    assert.ok(discovery.pipelines.some((p) => p.id === "desktop-smoke"));
    assert.ok(
      discovery.profiles.some(
        (p) => p.name === "local" && p.source === "project",
      ),
    );
    result.catalog = discovery.pipelines.map((p) => p.id);
    const params = {
      projectId: a.id,
      pipeline: "desktop-smoke",
      workflow: "auto",
      profile: "",
      skips: [],
    };
    const preview = await service.preview(params);
    assert.deepEqual(
      preview.stages.map((s) => s.id),
      ["smoke"],
    );
    assert.equal(preview.profile, null);
    assert.equal(preview.workflow, "desktop-smoke");
    result.preview = preview;
    const run = await service.launch({
      ...params,
      previewToken: preview.token,
      topic: { mode: "new", name: "desktop-test", baseRef: "HEAD" },
      task: "Literal task $(do-not-execute); no agents",
      confirmEmptyTask: false,
      expectedBranch: await service.checkoutBranch(params.projectId),
      confirmBranchSwitch: true,
      clean: false,
    });
    const ready = await waitReady(run.id);
    result.first = ready;
    const response = await fetch(ready.url + "/api/status");
    const status: any = await response.json();
    assert.equal(status.flow_name, "Desktop integration smoke");
    assert.ok(status.stages.some((s: any) => s.id === "smoke"));
    result.realAFM = {
      flow_name: status.flow_name,
      stageIds: status.stages.map((s: any) => s.id),
    };
    const html = await (await fetch(ready.url!)).text();
    assert.ok(html.includes("<html"));
    result.servesRealDashboard = true;
    assert.equal(git(a.path, "branch", "--show-current"), "desktop-test");
    const todo = await readFile(
      path.join(
        a.path,
        ".goga/history",
        String(new Date().getFullYear()),
        "desktop-test/todo.md",
      ),
      "utf8",
    );
    assert.ok(todo.includes("$(do-not-execute)"));
    result.taskLiteral = true;
    await assert.rejects(
      service.launch({
        ...params,
        previewToken: preview.token,
        topic: { mode: "new", name: "blocked", baseRef: "HEAD" },
        task: "",
        confirmEmptyTask: false,
        expectedBranch: await service.checkoutBranch(params.projectId),
        confirmBranchSwitch: true,
        clean: false,
      }),
    );
    result.checkoutLock = true;
    const b = await service.addProject(await fixture("project-two"));
    const p2 = {
      ...params,
      projectId: b.id,
      workflow: "none",
      profile: "",
      skips: ["tail"],
    };
    const preview2 = await service.preview(p2);
    assert.deepEqual(
      preview2.stages.map((s) => s.id),
      ["smoke"],
    );
    const second = await service.launch({
      ...p2,
      previewToken: preview2.token,
      topic: { mode: "new", name: "other-test", baseRef: "HEAD" },
      task: "Second script-only task",
      confirmEmptyTask: false,
      expectedBranch: await service.checkoutBranch(p2.projectId),
      confirmBranchSwitch: true,
      clean: false,
    });
    result.second = await waitReady(second.id);
    assert.notEqual(result.first.url, result.second.url);
    result.independentProjects = true;
    if (process.env.GOGA_SMOKE_CLEAN === "1") {
      // Only this script's disposable HOME is inspected or marked. Deletion is
      // exclusively Goga's --clean, exercised through the production HostService.
      await service.stop(run.id);
      const runtime = path.join(home, ".goga/runtime/pipelines");
      const entries = (await readdir(runtime)).filter((name) =>
        name.endsWith("-project-one"),
      );
      assert.equal(entries.length, 1);
      const stateDir = path.join(
        runtime,
        entries[0],
        "desktop-test",
        "desktop-smoke",
      );
      assert.ok((await stat(stateDir)).isDirectory());
      const marker = path.join(stateDir, "desktop-clean-smoke-marker.txt");
      await writeFile(marker, "disposable persistence marker");
      const again = async (clean: boolean) => {
        const task = await service.readTopicTask({
          projectId: params.projectId,
          branch: "desktop-test",
          topic: "desktop-test",
        });
        const card = await service.preview(params);
        assert.equal(
          await readFile(marker, "utf8"),
          "disposable persistence marker",
        );
        return service.launch({
          ...params,
          clean,
          previewToken: card.token,
          topic: {
            mode: "existing",
            branch: "desktop-test",
            topic: "desktop-test",
          },
          task: task.text,
          taskVersion: task.version,
          confirmEmptyTask: false,
          expectedBranch: await service.checkoutBranch(params.projectId),
          confirmBranchSwitch: true,
        });
      };
      const resumed = await again(false);
      await waitReady(resumed.id);
      assert.equal(
        await readFile(marker, "utf8"),
        "disposable persistence marker",
      );
      await service.stop(resumed.id);
      const fresh = await again(true);
      await waitReady(fresh.id);
      await assert.rejects(readFile(marker), { code: "ENOENT" });
      assert.ok((await stat(stateDir)).isDirectory());
      result.clean = {
        previewPreservedState: true,
        ordinaryLaunchPreservedState: true,
        cleanLaunchRemovedMarker: true,
        stateDirectoryRecreated: true,
        fixtureOnly: true,
      };
    }
    if (process.env.GOGA_SMOKE_CLOSE === "1") {
      const runtime = path.join(home, ".goga/runtime/pipelines");
      const entries = (await readdir(runtime)).filter((name) =>
        name.endsWith("-project-one"),
      );
      assert.equal(entries.length, 1);
      const marker = path.join(
        runtime,
        entries[0],
        "desktop-test",
        "desktop-smoke",
        "desktop-close-marker.txt",
      );
      await writeFile(marker, "must survive tab close");
      assert.equal(await service.closeRun(run.id, async () => false), false);
      assert.equal((await fetch(result.first.url + "/api/status")).status, 200);
      let confirmations = 0;
      const confirm = async () => {
        confirmations++;
        return true;
      };
      assert.deepEqual(
        await Promise.all([
          service.closeRun(run.id, confirm),
          service.closeRun(run.id, confirm),
        ]),
        [true, true],
      );
      assert.equal(confirmations, 1);
      assert.equal(
        service.runs().some((r) => r.id === run.id),
        false,
      );
      assert.equal(await readFile(marker, "utf8"), "must survive tab close");
      assert.equal(
        (await fetch(result.second.url + "/api/status")).status,
        200,
      );
      await service.closeRun(second.id, async () => true);
      assert.deepEqual(service.runs(), []);
      result.close = {
        cancelKeptProcess: true,
        duplicateConfirmationCount: confirmations,
        closedRunRemoved: true,
        runtimePreserved: true,
        otherRunUnaffected: true,
        allFixtureTabsClosed: true,
      };
    }
    result.ok = true;
    if (process.env.GOGA_SMOKE_HOLD === "1") {
      await writeFile(path.resolve("work/qa-url.txt"), result.first.url);
      for (let i = 0; i < 1200; i++) {
        try {
          await readFile(path.resolve("work/qa-finish"));
          break;
        } catch {}
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  } catch (e) {
    result.ok = false;
    result.error = String(e);
    result.runs = service.runs();
  } finally {
    await service.dispose();
    result.afterShutdown = service.runs();
    if (
      result.ok &&
      result.afterShutdown.some((r: any) => r.status !== "stopped" || r.error)
    ) {
      result.ok = false;
      result.error = "Expected clean stopped status after dispose";
    }
    await writeFile(
      path.join(root, "result.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  }
}
void main();

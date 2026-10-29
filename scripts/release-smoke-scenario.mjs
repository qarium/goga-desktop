// One synthetic repository; all product actions cross the production preload IPC.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile, rename } from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { connectTarget, findTarget, waitUntil } from "./smoke-cdp.mjs";
const exec = promisify(execFile);
export function bridgeExpression(name, args) {
  return `window.goga[${JSON.stringify(name)}](${args.map((value) => (value === undefined ? "undefined" : JSON.stringify(value))).join(",")})`;
}
export async function completeShutdown(owned, clients, timeout = 15000) {
  await owned.waitForNormalExit(timeout);
  await Promise.all(
    clients.map((client) =>
      client.waitForClosure(Math.min(timeout, 3000), { normalExit: true }),
    ),
  );
  for (const client of clients)
    client.assertNoRendererFailure({ normalExit: true });
}
export const PHASES = ["startup", "settings", "git", "terminal", "shutdown"];
export async function runPhases(tasks, phases) {
  for (const name of PHASES) {
    const start = performance.now();
    try {
      await tasks[name]();
      phases[name] = {
        outcome: "passed",
        elapsedMs: Math.ceil(performance.now() - start),
      };
    } catch (error) {
      phases[name] = {
        outcome: "failed",
        elapsedMs: Math.ceil(performance.now() - start),
      };
      throw error;
    }
  }
}
export async function createFixture(root) {
  const repo = path.join(root, "repository"),
    home = path.join(root, "app-home");
  await mkdir(repo, { mode: 0o700 });
  await mkdir(path.join(root, "empty-hooks"), { mode: 0o700 });
  const git = async (args) => {
    const { stdout } = await exec("/usr/bin/git", ["-C", repo, ...args], {
      cwd: root,
      timeout: 10000,
      maxBuffer: 256 * 1024,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: home,
        LANG: "en_US.UTF-8",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return stdout.trimEnd();
  };
  await git(["init", "--initial-branch=main"]);
  for (const [key, value] of [
    ["user.name", "Packaged Smoke"],
    ["user.email", "packaged-smoke@example.invalid"],
    ["commit.gpgSign", "false"],
    ["tag.gpgSign", "false"],
    ["core.hooksPath", path.join(root, "empty-hooks")],
    ["maintenance.auto", "false"],
    ["gc.auto", "0"],
  ])
    await git(["config", "--local", key, value]);
  await writeFile(path.join(repo, "smoke.txt"), "before\n", { mode: 0o600 });
  await git(["add", "--", "smoke.txt"]);
  await git(["commit", "-m", "Synthetic packaged smoke base"]);
  await writeFile(path.join(repo, "smoke.txt"), "after\n");
  const projectId = randomUUID();
  const state = path.join(home, ".goga/desktop");
  await mkdir(state, { recursive: true, mode: 0o700 });
  const file = path.join(state, "projects.json");
  await writeFile(
    `${file}.smoke-tmp`,
    JSON.stringify({
      schemaVersion: 1,
      revision: randomUUID(),
      projects: [{ id: projectId, name: "Packaged smoke fixture", path: repo }],
    }),
    { mode: 0o600, flag: "wx" },
  );
  await rename(`${file}.smoke-tmp`, file);
  return { repo, projectId, git };
}
export async function runScenario({
  root,
  version,
  asar,
  shell,
  port,
  owned,
  phases,
  clients,
}) {
  const call = (name, ...args) =>
    shell.evaluate(bridgeExpression(name, args), 30000);
  const terminal = (request) => callTerminal(shell, request);
  let fixture, tabId, ref;
  await runPhases(
    {
      startup: async () => {
        const ready = await waitUntil(
          () =>
            shell.evaluate(
              `(async()=>{if(!window.goga||!document.querySelector('.app-version'))return null;return {version:document.querySelector('.app-version').textContent,projects:await window.goga.listProjects(),runs:await window.goga.runs()}})()`,
            ),
          { assertAlive: owned.assertAlive },
        );
        assert.equal(
          ready.version,
          `v${version}`,
          "Wrong packaged renderer version",
        );
        assert.deepEqual(
          ready.projects,
          [],
          "Startup must have no projects/discovery",
        );
        assert.deepEqual(ready.runs, [], "Startup must have no runs");
      },
      settings: async () => {
        const before = await call("readSettings", "config");
        assert.equal(before.version, "missing");
        const text = "# isolated packaged smoke\n{}\n";
        const saved = await call(
          "saveSettings",
          "config",
          undefined,
          text,
          before.version,
        );
        const after = await call("readSettings", "config");
        assert.equal(saved.text, text);
        assert.deepEqual(after, saved);
        assert.equal(
          await readFile(path.join(root, "app-home/.goga/config.yml"), "utf8"),
          text,
        );
        assert.notEqual(after.version, "missing");
      },
      git: async () => {
        // Seed only after empty startup; React never selects this project or invokes Goga.
        fixture = await createFixture(root);
        assert.equal((await call("listProjects"))[0]?.id, fixture.projectId);
        const initial = await call("readGitWorkspace", fixture.projectId);
        assert.equal(initial.root, fixture.repo);
        assert.equal(initial.operation, "none");
        assert.deepEqual(
          initial.files.map((f) => f.path),
          ["smoke.txt"],
        );
        const preview = await call("prepareGitCommit", {
          scope: fixture.projectId,
          revision: initial.revision,
          paths: ["smoke.txt"],
          message: "Packaged smoke commit",
        });
        assert.equal(preview.root, fixture.repo);
        assert.equal(preview.hooks, "disabled");
        assert.equal(preview.signing, false);
        const result = await call("executeGitCommit", preview.token);
        assert.equal(result.status, "committed");
        assert.equal(result.indexPublished, true);
        const head = await fixture.git(["rev-parse", "HEAD"]);
        assert.notEqual(head, initial.head);
        assert.equal(head, result.commit);
        assert.equal(await fixture.git(["show", "HEAD:smoke.txt"]), "after");
        assert.equal(await fixture.git(["status", "--porcelain=v1"]), "");
        const after = await call("readGitWorkspace", fixture.projectId);
        assert.equal(after.head, head);
        assert.deepEqual(after.files, []);
      },
      terminal: async () => {
        let catalog = await terminal({
          kind: "read",
          scope: fixture.projectId,
        });
        catalog = await terminal({
          kind: "create",
          scope: fixture.projectId,
          revision: catalog.revision,
          area: "common",
        });
        tabId = catalog.selectedId;
        assert.ok(
          catalog.tabs.some((t) => t.id === tabId),
          "Created terminal tab must be selected",
        );
        const session = await terminal({
          kind: "open",
          scope: fixture.projectId,
          revision: catalog.revision,
          tabId,
        });
        assert.equal(session.tabId, tabId);
        assert.equal(session.context.projectId, fixture.projectId);
        ref = { sessionId: session.sessionId, generation: session.generation };
        await terminal({
          kind: "show",
          scope: fixture.projectId,
          revision: catalog.revision,
          tabId,
          ref,
          bounds: { x: 20, y: 80, width: 1100, height: 600 },
        });
        const target = await findTarget(
          port,
          pathToFileURL(path.join(asar, "dist/terminal/index.html")).href,
          owned.assertAlive,
        );
        const screen = await connectTarget(target, port);
        clients.push(screen);
        await screen.evaluate(
          `(()=>{if(!window.terminalScreen)throw Error('Missing production terminal preload');window.__packagedSmokeOutput='';window.terminalScreen.onFrame(frame=>{window.__packagedSmokeOutput=(window.__packagedSmokeOutput+frame.text).slice(-65536)});})()`,
        );
        await waitUntil(
          () =>
            screen.evaluate(
              `(()=>{const input=document.querySelector('.terminal-screen:not([style*="display: none"]) .xterm-helper-textarea');if(!input)return false;input.focus();return document.activeElement===input})()`,
            ),
          { assertAlive: owned.assertAlive },
        );
        const suffix = `SMOKE_${randomBytes(12).toString("hex")}`;
        const marker = `GOGA_${suffix}`;
        // Echoed input never contains the contiguous expected output marker.
        await screen.send("Input.insertText", {
          text: `printf '\\nGOGA_%s\\n' '${suffix}'`,
        });
        await screen.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          text: "\r",
        });
        await screen.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
        });
        await waitUntil(
          () =>
            screen.evaluate(
              `window.__packagedSmokeOutput.replace(/\\r/g,'').includes(${JSON.stringify(`\n${marker}\n`)})`,
            ),
          { timeout: 15000, assertAlive: owned.assertAlive },
        );
        screen.assertHealthy();
        catalog = await terminal({ kind: "read", scope: fixture.projectId });
        const confirmation = await terminal({
          kind: "prepare-close",
          scope: fixture.projectId,
          revision: catalog.revision,
          tabId,
        });
        const closed = await terminal({
          kind: "confirm",
          token: confirmation.token,
          confirmed: true,
        });
        assert.equal(closed.status, "success");
        assert.deepEqual(closed.remaining, []);
        assert.ok(
          closed.completed.some(
            (s) =>
              s.sessionId === ref.sessionId && s.generation === ref.generation,
          ),
        );
        const after = await terminal({
          kind: "read",
          scope: fixture.projectId,
        });
        assert.ok(
          !after.sessions.some(
            (s) => s.sessionId === ref.sessionId && s.state !== "exited",
          ),
        );
      },
      shutdown: async () => {
        for (const client of clients) client.assertHealthy();
        await owned.assertAlive();
        // Arm every healthy, request-idle renderer immediately before normal Quit.
        for (const client of clients) client.beginShutdown();
        // Application quit invokes the real before-quit/ShutdownCoordinator path.
        shell.requestQuit();
        await completeShutdown(owned, clients);
      },
    },
    phases,
  );
}
function callTerminal(shell, request) {
  return shell.evaluate(
    `window.goga.terminal.request(${JSON.stringify(request)})`,
    30000,
  );
}

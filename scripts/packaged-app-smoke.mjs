// Run only through verify-dmg's bounded runSmokeCommand process-group owner.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { mkdir, realpath, lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { activePort, findTarget, connectTarget } from "./smoke-cdp.mjs";
import { runScenario, PHASES } from "./release-smoke-scenario.mjs";

export function isolatedEnvironment(root) {
  const home = path.join(root, "app-home");
  // Do not spread process.env: no credentials, user Git config or runtime injection.
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    CFFIXED_USER_HOME: home,
    TMPDIR: path.join(root, "app-tmp"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    GOGA_DESKTOP_DATA_DIR: path.join(root, "app-data"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false",
  };
}
export function appLaunchOptions(root) {
  return {
    cwd: root,
    env: isolatedEnvironment(root),
    shell: false,
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
  };
}
export function observeChild(child) {
  let exit, failure;
  const listeners = new Set();
  child.once("error", () => {
    failure = Error("Packaged executable could not start");
    for (const fn of listeners) fn();
  });
  child.once("close", (code, signal) => {
    exit = { code, signal };
    for (const fn of listeners) fn();
  });
  return {
    get exit() {
      return exit;
    },
    async assertAlive() {
      if (failure) throw failure;
      if (exit) throw Error("Packaged executable exited before shutdown");
    },
    waitForNormalExit(timeout) {
      return new Promise((resolve, reject) => {
        const done = () => {
          if (!exit && !failure) return;
          clearTimeout(timer);
          listeners.delete(done);
          if (!failure && exit.code === 0 && !exit.signal) resolve(exit);
          else reject(Error("Expected normal app exit 0"));
        };
        const timer = setTimeout(() => {
          listeners.delete(done);
          reject(Error("Expected normal app exit timed out"));
        }, timeout);
        listeners.add(done);
        done();
      });
    },
  };
}
export function receiptFor({
  version,
  arch,
  phases,
  exit,
  elapsedMs,
  failure,
}) {
  const receipt = {
    schemaVersion: 1,
    kind: "real-packaged-app",
    version,
    arch,
    outcome: "failed",
    elapsedMs,
    phases,
    exit: exit ?? null,
  };
  if (failure) receipt.failure = String(failure).slice(0, 300);
  try {
    assertReceipt({ ...receipt, outcome: "passed" }, version, arch);
    if (!failure) receipt.outcome = "passed";
  } catch {}
  return receipt;
}
export function assertReceipt(receipt, version, arch) {
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.kind, "real-packaged-app");
  assert.equal(receipt.version, version, "Receipt version");
  assert.equal(receipt.arch, arch, "Receipt architecture");
  for (const name of PHASES) {
    assert.equal(
      receipt.phases?.[name]?.outcome,
      "passed",
      `Missing or failed phase: ${name}`,
    );
    assert.ok(
      Number.isFinite(receipt.phases[name].elapsedMs) &&
        receipt.phases[name].elapsedMs >= 0,
      "Invalid phase elapsed time",
    );
  }
  assert.equal(receipt.exit?.code, 0, "Expected normal app exit 0");
  assert.equal(
    receipt.exit?.signal,
    null,
    "Expected normal app exit without signal",
  );
  assert.ok(
    Number.isFinite(receipt.elapsedMs) &&
      receipt.elapsedMs >= 0 &&
      receipt.elapsedMs <= 160000,
    "Invalid total elapsed time",
  );
  assert.equal(receipt.outcome, "passed", "Failed smoke receipt");
}
export async function assertDisposableRoot(root) {
  assert.ok(
    path.isAbsolute(root) && path.normalize(root) === root,
    "A canonical disposable root is required",
  );
  assert.equal(
    await realpath(root),
    root,
    "A canonical disposable root is required",
  );
  const base = await realpath(tmpdir());
  assert.ok(
    root.startsWith(`${base}${path.sep}`),
    "A disposable root strictly inside the temporary directory is required",
  );
  const stat = await lstat(root);
  assert.ok(
    stat.isDirectory() &&
      (stat.mode & 0o077) === 0 &&
      (!process.getuid || stat.uid === process.getuid()),
    "A private owned disposable directory is required",
  );
}
async function validatePaths(executable, root, asar) {
  await assertDisposableRoot(root);
  for (const file of [executable, root, asar]) {
    assert.ok(
      path.isAbsolute(file) && path.normalize(file) === file,
      "Canonical absolute smoke paths required",
    );
    assert.equal(
      await realpath(file),
      file,
      "Smoke paths must not have symlink aliases",
    );
  }
  assert.ok((await lstat(root)).isDirectory());
  assert.ok((await lstat(executable)).isFile());
  assert.ok((await lstat(asar)).isFile());
  assert.equal(path.basename(asar), "app.asar");
  assert.equal(
    path.join(path.dirname(path.dirname(executable)), "Resources/app.asar"),
    asar,
    "Executable and ASAR must belong to one verified bundle",
  );
}
export async function packagedAppSmoke(executable, root, version, arch, asar) {
  const start = performance.now(),
    phases = {},
    clients = [];
  let child, owned, shell, failure;
  let stdout = "",
    stderr = "";
  await validatePaths(executable, root, asar);
  assert.equal(process.platform, "darwin", "Native macOS required");
  assert.equal(process.arch, arch, "Native architecture required");
  assert.match(
    version,
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.(0|[1-9]\d*))?$/,
  );
  const report = path.join(root, "report");
  // Exclusive directories ensure this can never reuse a user profile or stale receipt.
  for (const dir of ["app-home", "app-data", "app-tmp", "report"])
    await mkdir(path.join(root, dir), { mode: 0o700 });
  const capture = (name, chunk) => {
    if (name === "stdout")
      stdout = (stdout + chunk.toString("utf8")).slice(-65536);
    else stderr = (stderr + chunk.toString("utf8")).slice(-65536);
  };
  try {
    child = spawn(
      executable,
      [
        "--remote-debugging-port=0",
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${path.join(root, "app-data")}`,
      ],
      appLaunchOptions(root),
    );
    owned = observeChild(child);
    child.stdout.on("data", (chunk) => capture("stdout", chunk));
    child.stderr.on("data", (chunk) => capture("stderr", chunk));
    const { port } = await activePort(
      path.join(root, "app-data"),
      owned.assertAlive,
    );
    const target = await findTarget(
      port,
      pathToFileURL(path.join(asar, "dist/index.html")).href,
      owned.assertAlive,
    );
    shell = await connectTarget(target, port);
    clients.push(shell);
    await runScenario({
      root,
      version,
      asar,
      shell,
      port,
      owned,
      phases,
      clients,
    });
  } catch (error) {
    failure = error.message;
    if (!Object.values(phases).some((p) => p.outcome === "failed")) {
      const next = PHASES.find((name) => !phases[name]);
      if (next)
        phases[next] = {
          outcome: "failed",
          elapsedMs: Math.ceil(performance.now() - start),
        };
    }
    // Only allowlisted artifacts, never profile/repo dumps or environment values.
    if (shell && !shell.closed) {
      try {
        const shot = await shell.send(
          "Page.captureScreenshot",
          { format: "png" },
          2000,
        );
        if (typeof shot.data === "string" && shot.data.length < 3 * 1024 * 1024)
          await writeFile(
            path.join(report, "failure.png"),
            Buffer.from(shot.data, "base64"),
            { mode: 0o600 },
          );
      } catch {}
      try {
        shell.requestQuit();
      } catch {}
    }
    if (owned && !owned.exit) {
      try {
        await owned.waitForNormalExit(1000);
      } catch {
        child.kill("SIGTERM");
      }
    }
  } finally {
    for (const client of clients) client.close();
    // Parent runSmokeCommand owns the controller/app process group.
    // PTY sessions have separate groups; normal app shutdown must settle them.
    // On failure detach the pipes so it can observe controller exit and reap the group.
    if (failure && child) {
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    }
  }
  const receipt = receiptFor({
    version,
    arch,
    phases,
    exit: owned?.exit,
    elapsedMs: Math.ceil(performance.now() - start),
    failure,
  });
  await writeFile(
    path.join(report, "packaged-app-smoke.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { mode: 0o600, flag: "wx" },
  );
  if (failure) {
    await writeFile(path.join(report, "app-stdout.log"), stdout, {
      mode: 0o600,
      flag: "wx",
    });
    await writeFile(path.join(report, "app-stderr.log"), stderr, {
      mode: 0o600,
      flag: "wx",
    });
  }
  assertReceipt(receipt, version, arch);
  return receipt;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (args.length !== 5) {
    console.error(
      "Usage: packaged-app-smoke.mjs EXECUTABLE ROOT VERSION ARCH ASAR",
    );
    process.exitCode = 1;
  } else
    packagedAppSmoke(...args)
      .then(() =>
        console.log(
          "Real packaged app startup/settings/Git/terminal/normal shutdown verified.",
        ),
      )
      .catch(() => {
        console.error("Real packaged app smoke failed; see isolated report.");
        process.exitCode = 1;
      });
}

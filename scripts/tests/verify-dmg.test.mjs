import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createVerificationRoot,
  validateMetadata,
  withMountedDmg,
} from "../verify-dmg.mjs";
const correct = {
  arch: "arm64",
  version: "1.2.3-rc.1",
  shortVersion: "1.2.3-rc.1",
  bundleVersion: "1.2.3-rc.1",
  rendererVersion: true,
  terminalNativeLoaded: true,
  signature: "Signature=adhoc\n",
  macho: "arm64",
};
test("valid native adhoc artifact metadata", () =>
  assert.doesNotThrow(() => validateMetadata(correct, "v1.2.3-rc.1", "arm64")));
for (const [field, value] of Object.entries({
  arch: "x64",
  version: "0.0.0",
  shortVersion: "0.0.0",
  bundleVersion: "0.0.0",
  rendererVersion: false,
  terminalNativeLoaded: false,
  signature: "Authority=Developer ID Application\n",
  macho: "arm64 x86_64",
}))
  test(`reject wrong ${field}`, () =>
    assert.throws(() =>
      validateMetadata({ ...correct, [field]: value }, "v1.2.3-rc.1", "arm64"),
    ));
test("mount readonly without Finder and always detach on verification failure", async () => {
  const calls = [];
  const run = async (...args) => {
    calls.push(args);
    return { stdout: "", stderr: "" };
  };
  await assert.rejects(
    withMountedDmg(
      "/tmp/test.dmg",
      "/tmp/mount",
      async () => {
        throw Error("verification failed");
      },
      run,
    ),
    /verification failed/,
  );
  assert.deepEqual(calls[0][1], [
    "attach",
    "-readonly",
    "-nobrowse",
    "-noautoopen",
    "-mountpoint",
    "/tmp/mount",
    "/tmp/test.dmg",
  ]);
  assert.deepEqual(calls.at(-1)[1], ["detach", "/tmp/mount"]);
});
test("mount cleanup retries forced detach and does not ignore failure", async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push(args);
    if (args[0] === "detach") throw Error("busy");
    return { stdout: "", stderr: "" };
  };
  await assert.rejects(
    withMountedDmg("/tmp/test.dmg", "/tmp/mount", async () => {}, run),
    /busy/,
  );
  assert.deepEqual(calls.at(-1), ["detach", "-force", "/tmp/mount"]);
});

test("partial attach failure still attempts detach", async () => {
  const calls = [];
  const run = async (_command, args) => {
    calls.push(args);
    if (args[0] === "attach") throw Error("attach failed");
    return { stdout: "", stderr: "" };
  };
  await assert.rejects(
    withMountedDmg(
      "/tmp/test.dmg",
      "/tmp/mount",
      async () => assert.fail("must not verify"),
      run,
    ),
    /attach failed/,
  );
  assert.deepEqual(calls.at(-1), ["detach", "/tmp/mount"]);
});
test("UI smoke invokes the real mounted executable through Node controller and requires its receipt", async (t) => {
  const { runPackagedUI } = await import("../verify-dmg.mjs");
  assert.equal(typeof runPackagedUI, "function");
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const root = await mkdtemp("/private/tmp/goga-receipt-test-");
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const command = async (file, args, options) => {
    calls++;
    assert.equal(file, process.execPath);
    assert.ok(
      options.env,
      "Node controller must not inherit caller environment",
    );
    assert.equal(options.env.NODE_OPTIONS, undefined);
    assert.equal(options.env.NODE_PATH, undefined);
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(options.env.GITHUB_TOKEN, undefined);
    assert.ok(args[0].endsWith("/scripts/packaged-app-smoke.mjs"));
    assert.deepEqual(args.slice(1), [
      "/mounted/Goga Desktop.app/Contents/MacOS/Goga Desktop",
      root,
      "1.2.3",
      "arm64",
      "/mounted/Goga Desktop.app/Contents/Resources/app.asar",
    ]);
    await mkdir(root + "/report");
    await writeFile(
      root + "/report/packaged-app-smoke.json",
      JSON.stringify({
        schemaVersion: 1,
        kind: "real-packaged-app",
        version: "1.2.3",
        arch: "arm64",
        outcome: "passed",
        elapsedMs: 100,
        exit: { code: 0, signal: null },
        phases: Object.fromEntries(
          ["startup", "settings", "git", "terminal", "shutdown"].map((name) => [
            name,
            { outcome: "passed", elapsedMs: 10 },
          ]),
        ),
      }),
    );
  };
  await runPackagedUI(
    "/mounted/Goga Desktop.app/Contents/MacOS/Goga Desktop",
    root,
    "1.2.3",
    "arm64",
    "/mounted/Goga Desktop.app/Contents/Resources/app.asar",
    command,
  );
  assert.equal(calls, 1);
  const { unlink } = await import("node:fs/promises");
  await unlink(root + "/report/packaged-app-smoke.json");
  await assert.rejects(
    runPackagedUI("/exe", root, "1.2.3", "arm64", "/asar", async () => {}),
    /ENOENT|receipt/i,
  );
});

test("diagnostics copy only bounded allowlisted regular files, never profiles or repositories", async (t) => {
  const { collectSmokeDiagnostics } = await import("../verify-dmg.mjs");
  const { mkdtemp, mkdir, writeFile, readFile, symlink, rm } =
    await import("node:fs/promises");
  const dir = await mkdtemp("/private/tmp/goga-diagnostics-test-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = dir + "/fixture",
    dest = dir + "/artifacts";
  await mkdir(root + "/report", { recursive: true });
  await writeFile(root + "/report/app-stderr.log", "bounded");
  await writeFile(root + "/report/credentials.json", "must not upload");
  await collectSmokeDiagnostics(root, dest);
  assert.equal(await readFile(dest + "/app-stderr.log", "utf8"), "bounded");
  await assert.rejects(readFile(dest + "/credentials.json"), /ENOENT/);
  await symlink(
    root + "/report/credentials.json",
    root + "/report/failure.png",
  );
  await assert.rejects(
    collectSmokeDiagnostics(root, dir + "/other"),
    /regular|symlink|diagnostic/i,
  );
});

test("disposable verification root canonicalizes symlinked temp ancestors", async (t) => {
  const { mkdtemp, mkdir, symlink, realpath, lstat, rm } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const fixture = await mkdtemp(
    path.join(await realpath(tmpdir()), "goga-temp-root-test-"),
  );
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const actualParent = path.join(fixture, "actual");
  await mkdir(path.join(actualParent, "nested"), { recursive: true });
  const linkedParent = path.join(fixture, "alias");
  await symlink(actualParent, linkedParent);
  const root = await createVerificationRoot(path.join(linkedParent, "nested"));
  assert.equal(
    root,
    await realpath(root),
    "Disposable HOME parent must be canonical before app noSymlinks checks",
  );
  assert.equal(path.dirname(root), path.join(actualParent, "nested"));
  for (
    let current = root;
    current !== path.dirname(current);
    current = path.dirname(current)
  ) {
    assert.equal((await lstat(current)).isSymbolicLink(), false, current);
  }
});

test("packaged runtime smoke loads the native terminal addon without launching a shell", async () => {
  const { readFile } = await import("node:fs/promises");
  const script = await readFile(
    new URL("../verify-dmg.mjs", import.meta.url),
    "utf8",
  );
  assert.match(script, /require\(p.join\(root,'node_modules','node-pty'\)\)/);
  assert.match(script, /terminalNativeLoaded/);
  assert.doesNotMatch(script, /pty\.spawn\(/);
});

test("timed-out normal detach reserves time for forced detach within the cleanup budget", async () => {
  const { createDmgCleanup } = await import("../verify-dmg.mjs");
  let now = 0;
  const calls = [];
  const cleanup = createDmgCleanup({
    now: () => now,
    run: async (_file, args, options) => {
      calls.push({ args, timeout: options.timeout });
      if (!args.includes("-force")) {
        now += options.timeout + 1000;
        throw Error("normal detach timed out");
      }
      return { stdout: "", stderr: "" };
    },
  });
  await withMountedDmg(
    "/tmp/synthetic.dmg",
    "/tmp/synthetic-mount",
    async () => {},
    async () => ({}),
    cleanup,
  );
  assert.deepEqual(
    calls.map((c) => c.timeout),
    [8000, 10000],
  );
  assert.deepEqual(calls[1].args, ["detach", "-force", "/tmp/synthetic-mount"]);
  now = 20000;
  await assert.rejects(
    cleanup("hdiutil", ["detach", "-force", "/tmp/synthetic-mount"]),
    /deadline/,
  );
});

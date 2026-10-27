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
test("UI smoke is hidden, isolated and loads only packaged production modules", async () => {
  const { readFile } = await import("node:fs/promises");
  const script = await readFile(
    new URL("../packaged-ui-smoke.cjs", import.meta.url),
    "utf8",
  );
  for (const marker of [
    "show: false",
    "acceptance-host.cjs",
    "preload.cjs",
    "GOGA_DESKTOP_DATA_DIR",
    "External command/pipeline forbidden",
    "snapshot.version",
    "snapshot.projects",
    "snapshot.runs",
  ])
    assert.ok(script.includes(marker), marker);
  assert.ok(
    script.includes("process.versions.electron"),
    "UI and packaged native runtime must have the same Electron version",
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

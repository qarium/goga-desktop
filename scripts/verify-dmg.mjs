import { smokeBudget } from "./smoke-budget.mjs";
import assert from "node:assert/strict";
import { runSmokeCommand } from "./smoke-command.mjs";
import {
  mkdtemp,
  mkdir,
  lstat,
  readlink,
  realpath,
  rm,
  rmdir,
  readFile,
  writeFile,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { constants } from "node:fs";
import { assertReceipt } from "./packaged-app-smoke.mjs";
import { versionFromTag } from "./release-version.mjs";
const execute = runSmokeCommand;
const run = (file, args, options = {}) =>
  execute(file, args, {
    timeout: 90000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });

export function validateMetadata(data, tag, arch) {
  const version = versionFromTag(tag);
  assert.ok(["arm64", "x64"].includes(arch), "Unsupported architecture");
  assert.equal(
    data.macho.trim(),
    arch === "x64" ? "x86_64" : "arm64",
    "Mach-O must have exactly the expected architecture",
  );
  assert.equal(data.arch, arch, "Native executable process.arch");
  for (const key of ["version", "shortVersion", "bundleVersion"])
    assert.equal(data[key], version, key);
  assert.equal(
    data.rendererVersion,
    true,
    "Built renderer must contain the release version",
  );
  assert.equal(
    data.terminalNativeLoaded,
    true,
    "Packaged terminal native addon must load",
  );
  assert.match(data.signature, /^Signature=adhoc$/m);
  assert.doesNotMatch(
    data.signature,
    /^Authority=/m,
    "Developer ID signing is not permitted",
  );
}
export async function withMountedDmg(
  dmg,
  mountpoint,
  verify,
  command = run,
  cleanupCommand = command,
) {
  // Even partial attach failures reach cleanup; no Finder or user application opens here.
  try {
    await command("/usr/bin/hdiutil", [
      "attach",
      "-readonly",
      "-nobrowse",
      "-noautoopen",
      "-mountpoint",
      mountpoint,
      dmg,
    ]);
    return await verify(mountpoint);
  } finally {
    try {
      await cleanupCommand("/usr/bin/hdiutil", ["detach", mountpoint]);
    } catch {
      await cleanupCommand("/usr/bin/hdiutil", [
        "detach",
        "-force",
        mountpoint,
      ]);
    }
  }
}
export async function createVerificationRoot(parent = tmpdir()) {
  // macOS /var and /tmp may be symlink aliases. Keep application path guards intact.
  return mkdtemp(path.join(await realpath(parent), "goga-dmg-verify-"));
}
/** Keep normal detach from consuming the forced-detach reserve. */
export function createDmgCleanup({ run: command = run, now } = {}) {
  let cleanup;
  return (file, args) =>
    (cleanup ??= smokeBudget(20000, { run: command, now })).run(file, args, {
      timeout: args.includes("-force") ? 10000 : 8000,
    });
}
export async function runPackagedUI(
  executable,
  root,
  version,
  arch,
  asar,
  command,
) {
  await command(
    process.execPath,
    [
      fileURLToPath(new URL("./packaged-app-smoke.mjs", import.meta.url)),
      executable,
      root,
      version,
      arch,
      asar,
    ],
    {
      cwd: root,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: path.join(root, "home"),
        CFFIXED_USER_HOME: path.join(root, "home"),
        TMPDIR: await realpath(tmpdir()),
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
      },
    },
  );
  const file = path.join(root, "report/packaged-app-smoke.json");
  const stat = await lstat(file);
  assert.ok(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      stat.size <= 65536,
    "Invalid packaged smoke receipt",
  );
  const receipt = JSON.parse(await readFile(file, "utf8"));
  assertReceipt(receipt, version, arch);
  return receipt;
}
const diagnosticNames = [
  "packaged-app-smoke.json",
  "dmg-verification.json",
  "app-stdout.log",
  "app-stderr.log",
  "failure.png",
];
export async function collectSmokeDiagnostics(root, destination) {
  assert.ok(
    path.isAbsolute(destination) && path.normalize(destination) === destination,
    "Absolute diagnostic destination required",
  );
  assert.ok(
    destination !== root && !destination.startsWith(root + path.sep),
    "Diagnostic destination must survive temporary cleanup",
  );
  let cursor = path.parse(destination).root;
  for (const part of destination.slice(cursor.length).split(path.sep)) {
    cursor = path.join(cursor, part);
    try {
      assert.equal(
        (await lstat(cursor)).isSymbolicLink(),
        false,
        "Diagnostic destination symlink",
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await mkdir(destination, { recursive: true });
  for (const name of diagnosticNames) {
    const source = path.join(root, "report", name);
    let stat;
    try {
      stat = await lstat(source);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    assert.ok(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.nlink === 1 &&
        stat.size <= 4 * 1024 * 1024,
      "Invalid regular diagnostic file",
    );
    await copyFile(
      source,
      path.join(destination, name),
      constants.COPYFILE_EXCL,
    );
  }
}
export async function verifyDmg(
  dmg,
  arch,
  tag,
  { ui = false, reportDirectory = process.env.GOGA_RELEASE_REPORT_DIR } = {},
) {
  const budget = smokeBudget(160000, { run });
  const command = budget.run;
  // Cleanup gets 20 seconds total, even after the shared work deadline expires.
  const cleanupCommand = createDmgCleanup();
  const version = versionFromTag(tag);
  assert.equal(
    process.platform,
    "darwin",
    "DMG verification requires native macOS",
  );
  assert.equal(
    process.arch,
    arch,
    "Run on the target architecture, not through cross-build",
  );
  assert.equal(path.basename(dmg), `Goga-Desktop-${version}-${arch}.dmg`);
  const stat = await lstat(dmg);
  assert.ok(
    stat.isFile() && stat.size > 0 && stat.nlink === 1,
    "Expected a nonempty regular DMG",
  );
  const root = await createVerificationRoot();
  const mountpoint = path.join(root, "mount"),
    home = path.join(root, "home");
  await mkdir(mountpoint);
  await mkdir(home);
  const env = {
    ...process.env,
    HOME: home,
    CFFIXED_USER_HOME: home,
    TMPDIR: root,
    GOGA_DESKTOP_DATA_DIR: path.join(root, "data"),
    GOGA_TOPIC_READONLY_CLI: "/nonexistent/disabled",
  };
  // Never inherit Node injection flags or an Electron run mode from the caller.
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  delete env.ELECTRON_RUN_AS_NODE;
  const started = performance.now();
  let verified = false;
  try {
    const result = await withMountedDmg(
      path.resolve(dmg),
      mountpoint,
      async (mounted) => {
        const app = path.join(mounted, "Goga Desktop.app");
        assert.ok(
          (await lstat(app)).isDirectory(),
          "Expected Goga Desktop.app (not a symlink)",
        );
        const applications = path.join(mounted, "Applications");
        assert.ok((await lstat(applications)).isSymbolicLink());
        assert.equal(await readlink(applications), "/Applications");
        const contents = path.join(app, "Contents"),
          executable = path.join(contents, "MacOS", "Goga Desktop"),
          asar = path.join(contents, "Resources", "app.asar");
        assert.ok((await lstat(asar)).isFile(), "Packaged ASAR is required");
        await command("/usr/bin/codesign", [
          "--verify",
          "--deep",
          "--strict",
          app,
        ]);
        const signature = await command("/usr/bin/codesign", [
          "-dv",
          "--verbose=4",
          app,
        ]);
        const macho = await command("/usr/bin/lipo", ["-archs", executable]);
        const plist = (key) =>
          command("/usr/libexec/PlistBuddy", [
            "-c",
            `Print :${key}`,
            path.join(contents, "Info.plist"),
          ]);
        const runtimeScript = `const fs=require('node:fs'),p=require('node:path');const root=process.env.GOGA_VERIFY_ASAR;const pkg=require(p.join(root,'package.json'));const pty=require(p.join(root,'node_modules','node-pty'));if(typeof pty.spawn!=='function')throw Error('Packaged terminal addon unavailable');const assets=p.join(root,'dist','assets');const texts=fs.readdirSync(assets).filter(n=>n.endsWith('.js')).map(n=>fs.readFileSync(p.join(assets,n),'utf8'));console.log(JSON.stringify({terminalNativeLoaded:true,arch:process.arch,electron:process.versions.electron,version:pkg.version,rendererVersion:texts.some(t=>t.includes(JSON.stringify(pkg.version)))}));`;
        const runtime = await command(executable, ["-e", runtimeScript], {
          env: { ...env, ELECTRON_RUN_AS_NODE: "1", GOGA_VERIFY_ASAR: asar },
          cwd: root,
        });
        const metadata = {
          ...JSON.parse(runtime.stdout.trim()),
          shortVersion: (
            await plist("CFBundleShortVersionString")
          ).stdout.trim(),
          bundleVersion: (await plist("CFBundleVersion")).stdout.trim(),
          macho: macho.stdout,
          signature: signature.stderr + signature.stdout,
        };
        validateMetadata(metadata, tag, arch);
        if (ui)
          await runPackagedUI(executable, root, version, arch, asar, command);
        budget.check();
        const result = {
          version,
          arch,
          adhoc: true,
          nativeRuntime: true,
          packagedUI: ui,
          uiRuntime: ui
            ? "real packaged executable; production main/preload/renderer, Git, PTY and normal shutdown"
            : "not tested",
        };
        return result;
      },
      command,
      cleanupCommand,
    );
    verified = true;
    console.log(JSON.stringify(result));
    return result;
  } finally {
    try {
      if (reportDirectory) {
        await mkdir(path.join(root, "report"), { recursive: true });
        await writeFile(
          path.join(root, "report/dmg-verification.json"),
          JSON.stringify({
            version,
            arch,
            outcome: verified ? "passed" : "failed",
            elapsedMs: Math.ceil(performance.now() - started),
            packagedUI: ui,
          }) + "\n",
          { mode: 0o600, flag: "wx" },
        );
        await collectSmokeDiagnostics(root, reportDirectory);
      }
    } finally {
      // Do not recursively remove a potentially still-mounted volume after detach failure.
      try {
        await rmdir(mountpoint);
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        console.error(
          `Verification temporary directory retained for manual cleanup: ${root} (${error.code})`,
        );
      }
    }
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [dmg, arch, flag, ...extra] = process.argv.slice(2);
  if (!dmg || !arch || (flag && flag !== "--ui") || extra.length) {
    console.error(
      "Usage: RELEASE_TAG=vX.Y.Z node scripts/verify-dmg.mjs FILE arm64|x64 [--ui]",
    );
    process.exitCode = 1;
  } else
    verifyDmg(dmg, arch, process.env.RELEASE_TAG, {
      ui: flag === "--ui",
    }).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

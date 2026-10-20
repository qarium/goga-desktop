import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  lstat,
  readlink,
  realpath,
  rm,
  rmdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { versionFromTag } from "./release-version.mjs";
const execute = promisify(execFile);
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
  assert.match(data.signature, /^Signature=adhoc$/m);
  assert.doesNotMatch(
    data.signature,
    /^Authority=/m,
    "Developer ID signing is not permitted",
  );
}
export async function withMountedDmg(dmg, mountpoint, verify, command = run) {
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
      await command("/usr/bin/hdiutil", ["detach", mountpoint]);
    } catch {
      await command("/usr/bin/hdiutil", ["detach", "-force", mountpoint]);
    }
  }
}
export async function createVerificationRoot(parent = tmpdir()) {
  // macOS /var and /tmp may be symlink aliases. Keep application path guards intact.
  return mkdtemp(path.join(await realpath(parent), "goga-dmg-verify-"));
}
export async function verifyDmg(dmg, arch, tag, { ui = false } = {}) {
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
  try {
    return await withMountedDmg(
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
        await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
        const signature = await run("/usr/bin/codesign", [
          "-dv",
          "--verbose=4",
          app,
        ]);
        const macho = await run("/usr/bin/lipo", ["-archs", executable]);
        const plist = (key) =>
          run("/usr/libexec/PlistBuddy", [
            "-c",
            `Print :${key}`,
            path.join(contents, "Info.plist"),
          ]);
        const runtimeScript = `const fs=require('node:fs'),p=require('node:path');const root=process.env.GOGA_VERIFY_ASAR;const pkg=require(p.join(root,'package.json'));const assets=p.join(root,'dist','assets');const texts=fs.readdirSync(assets).filter(n=>n.endsWith('.js')).map(n=>fs.readFileSync(p.join(assets,n),'utf8'));console.log(JSON.stringify({arch:process.arch,electron:process.versions.electron,version:pkg.version,rendererVersion:texts.some(t=>t.includes(JSON.stringify(pkg.version)))}));`;
        const runtime = await run(executable, ["-e", runtimeScript], {
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
        if (ui) {
          // Dev Electron loads the real packaged ASAR modules; the DMG executable itself
          // was independently executed above. No fixture preload, projects or pipelines.
          const electron = createRequire(import.meta.url)("electron");
          await run(
            electron,
            [
              fileURLToPath(
                new URL("./packaged-ui-smoke.cjs", import.meta.url),
              ),
            ],
            {
              env: {
                ...env,
                GOGA_VERIFY_ASAR: asar,
                GOGA_VERIFY_VERSION: version,
                GOGA_VERIFY_ARCH: arch,
                GOGA_VERIFY_ELECTRON: metadata.electron,
              },
              cwd: root,
            },
          );
        }
        const result = {
          version,
          arch,
          adhoc: true,
          nativeRuntime: true,
          packagedUI: ui,
          uiRuntime: ui
            ? "same-lockfile development Electron; packaged host/preload/renderer"
            : "not tested",
        };
        console.log(JSON.stringify(result));
        return result;
      },
    );
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

import {
  assertPackageTarget,
  terminalPackageFiles,
  verifyNativeFiles,
} from "./terminal-native-build.mjs";
import path from "node:path";
import { signAsync } from "@electron/osx-sign";

/** Local-only bundle signing: never search or use a user's signing identity. */
export default async function signLocal(context) {
  if (context.electronPlatformName !== "darwin") return;
  const config = context.packager.config;
  // afterPack runs before builder's fuse/signing steps: prevent a later mutation
  // or a second signing/notarization path from invalidating this local signature.
  if (
    config.electronFuses ||
    config.mac?.identity !== null ||
    config.mac?.notarize !== false
  )
    throw new Error(
      "Local signing requires no fuse mutation, mac.identity=null and mac.notarize=false.",
    );
  const app = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  assertPackageTarget(context);
  const binaries = terminalPackageFiles(app);
  await verifyNativeFiles(binaries, process.arch);
  await signAsync({
    binaries,
    app,
    platform: "darwin",
    identity: "-",
    identityValidation: false,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    strictVerify: true,
    // Match the previous local build's non-hardened runtime. This adds a valid
    // sealed identity, not a Developer ID signature or any new OS entitlement.
    optionsForFile: () => ({
      entitlements: [],
      hardenedRuntime: false,
      timestamp: "none",
    }),
  });
}

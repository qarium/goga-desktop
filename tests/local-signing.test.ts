import { it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
const { signAsync, verifyNativeFiles } = vi.hoisted(() => ({
  signAsync: vi.fn<(options: any) => Promise<void>>(async () => {}),
  verifyNativeFiles: vi.fn(async (..._args: any[]) => {}),
}));
vi.mock("@electron/osx-sign", () => ({ signAsync }));
vi.mock("../scripts/terminal-native-build.mjs", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  verifyNativeFiles,
}));
const hookPath = "../scripts/sign-local.mjs";
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const context = () => ({
  electronPlatformName: "darwin",
  arch: process.arch === "arm64" ? 3 : 1,
  appOutDir: "/fixture/output",
  packager: {
    appInfo: { productFilename: "Goga Desktop" },
    config: { mac: { identity: null, notarize: false } },
  },
});
beforeEach(() => {
  signAsync.mockReset().mockResolvedValue(undefined);
  verifyNativeFiles.mockReset().mockResolvedValue(undefined);
});
it("requires explicit certificate-free signing in packaged builds", () => {
  expect(pkg.build.afterPack).toBe("scripts/sign-local.mjs");
  expect(pkg.build.mac.identity).toBe(null);
  expect(pkg.build.mac.notarize).toBe(false);
  expect(pkg.devDependencies["@electron/osx-sign"]).toBe("1.3.3");
});
it("signs nested bundle without certificate lookup, profiles, timestamp, or new entitlements", async () => {
  const { default: signLocal } = await import(hookPath);
  await signLocal(context());
  expect(signAsync).toHaveBeenCalledTimes(1);
  const options = signAsync.mock.calls[0][0] as any;
  expect(options).toMatchObject({
    app: "/fixture/output/Goga Desktop.app",
    identity: "-",
    identityValidation: false,
    platform: "darwin",
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    strictVerify: true,
  });
  expect(options.binaries).toEqual([
    "/fixture/output/Goga Desktop.app/Contents/Resources/terminal/terminal-inspect",
    "/fixture/output/Goga Desktop.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node",
    "/fixture/output/Goga Desktop.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper",
  ]);
  expect(verifyNativeFiles).toHaveBeenCalledWith(
    options.binaries,
    process.arch,
  );
  expect(verifyNativeFiles.mock.invocationCallOrder[0]).toBeLessThan(
    signAsync.mock.invocationCallOrder[0],
  );
  expect(options.keychain).toBeUndefined();
  expect(options.provisioningProfile).toBeUndefined();
  expect(options.optionsForFile("/fixture/output/Goga Desktop.app")).toEqual({
    entitlements: [],
    hardenedRuntime: false,
    timestamp: "none",
  });
});
it("does not run on other platforms", async () => {
  const { default: signLocal } = await import(hookPath);
  await signLocal({ ...context(), electronPlatformName: "linux" });
  expect(signAsync).not.toHaveBeenCalled();
});
it("aborts packaging rather than accepting a signing failure", async () => {
  const { default: signLocal } = await import(hookPath);
  signAsync.mockRejectedValueOnce(new Error("signature failed"));
  await expect(signLocal(context())).rejects.toThrow("signature failed");
});
it.each(["fuses", "certificate", "notarize"])(
  "rejects conflicting %s configuration before signing",
  async (mode) => {
    const { default: signLocal } = await import(hookPath);
    const c = context() as any;
    if (mode === "fuses")
      c.packager.config.electronFuses = { runAsNode: false };
    if (mode === "certificate") c.packager.config.mac.identity = "certificate";
    if (mode === "notarize") c.packager.config.mac.notarize = true;
    await expect(signLocal(c)).rejects.toThrow();
    expect(signAsync).not.toHaveBeenCalled();
  },
);

it("refuses missing or foreign native binaries before signing", async () => {
  const { default: signLocal } = await import(hookPath);
  verifyNativeFiles.mockRejectedValueOnce(Error("native mismatch"));
  await expect(signLocal(context())).rejects.toThrow("native mismatch");
  expect(signAsync).not.toHaveBeenCalled();
});

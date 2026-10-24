import {
  assertPackageTarget,
  verifyTerminalBuild,
} from "./terminal-native-build.mjs";
export default async function beforePack(
  context,
  verify = verifyTerminalBuild,
) {
  assertPackageTarget(context);
  await verify(
    context.packager.projectDir,
    context.packager.info.framework.version,
  );
}

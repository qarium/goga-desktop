import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createNativeGitClient } from "./git-native-client";
import { NativeGitJournal } from "./git-native-journal";
import {
  captureNativeGitState,
  fingerprintNativeGitControls,
  readNativeGitObservation,
  type NativeGitOwner,
} from "./git-native-state";
import { captureNativeIndexRecovery } from "./git-native-recovery";
import type { Runner } from "./process";

export interface NativeGitCapability {
  journal: NativeGitJournal;
  owner(): Promise<NativeGitOwner>;
  client(
    configuration: readonly (readonly [string, string])[],
  ): ReturnType<typeof createNativeGitClient>;
}
/** Host PATH only, never a renderer executable/argv. Resolve once per admitted
 * context; every write and subsequent probe uses the same absolute executable. */
export function createNativeGitCapability(options: {
  root: string;
  runner: Pick<Runner, "commandBytes">;
  journal: NativeGitJournal;
  owner(): Promise<NativeGitOwner>;
  env?: NodeJS.ProcessEnv;
}): NativeGitCapability {
  const searchPath = options.env?.PATH ?? process.env.PATH ?? "/usr/bin:/bin";
  let pinned: Promise<string> | undefined;
  const resolve = async () => {
    for (const folder of searchPath.split(path.delimiter)) {
      if (!path.isAbsolute(folder)) continue;
      const file = path.join(folder, "git");
      try {
        await fs.access(file, fs.constants.X_OK);
        const resolved = await fs.realpath(file);
        if ((await fs.stat(resolved)).isFile()) return resolved;
      } catch (error) {
        if (
          !["ENOENT", "ENOTDIR", "EACCES"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
      }
    }
    throw Error("Штатный Git не найден в PATH приложения.");
  };
  return {
    journal: options.journal,
    owner: options.owner,
    client: async (configuration) =>
      createNativeGitClient({
        root: options.root,
        runner: options.runner,
        env: options.env,
        executable: await (pinned ??= resolve()),
        configuration,
      }),
  };
}
export const nativeIntent = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Admission/config checks remain the handler's responsibility. No fallback to
 * a text runner, and no assertion of settlement from an arbitrary exception. */
export async function nativeGitGuard(options: {
  root: string;
  capability?: NativeGitCapability;
  paths: readonly string[];
  configuration: readonly (readonly [string, string])[];
  verify(): Promise<void>;
  policy(): Promise<string>;
  recoverIndex?: boolean;
  /** The existing private reader owns status canonicalization. A metadata-only
   * branch operation must not run live status/clean filters in the real repo. */
  admittedStatus(): Promise<{ data: Buffer; headRef: string | null }>;
}) {
  const capability = options.capability;
  if (!capability)
    throw Error("Защищённый исполнитель штатного Git недоступен.");
  const client = await capability.client(options.configuration);
  const capture = () =>
    captureNativeGitState({
      root: options.root,
      paths: options.paths,
      ...(options.recoverIndex
        ? {
            indexRecovery: (index: Buffer) =>
              captureNativeIndexRecovery(client, index, options.paths),
          }
        : {}),
      owner: async () => {
        await options.verify();
        return capability.owner();
      },
      observe: async () => {
        await options.verify();
        const status = await options.admittedStatus();
        return readNativeGitObservation(
          client,
          {
            headRef: status.headRef,
            policyFingerprint: await options.policy(),
            controlFingerprint: await fingerprintNativeGitControls(
              options.root,
            ),
          },
          async () => status.data,
        );
      },
    });
  return { capture, client, journal: capability.journal };
}

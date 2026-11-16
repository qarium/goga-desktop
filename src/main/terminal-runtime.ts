import {
  TerminalPresetStore,
  type TerminalPresetCrypto,
} from "../host/terminal-preset-store";
import { TerminalStartupError } from "../host/terminal-errors";
import type { HostService } from "../host/service";
import { TerminalStore } from "../host/terminal-store";
import { TerminalCatalog } from "../host/terminal-catalog";
import {
  TerminalSessions,
  type TerminalSessionDependencies,
} from "../host/terminal-sessions";
import { TerminalTransport } from "../host/terminal-transport";
import {
  TerminalNativeAdapter,
  type NativeTerminalDriver,
  type TerminalInspector,
  type TerminalNativeSystem,
} from "../host/terminal-native";

export interface TerminalRuntimeOptions {
  home: string;
  presetCrypto?: TerminalPresetCrypto;
  preparePreset?: TerminalSessionDependencies["preparePreset"];
  host: Pick<HostService, "resolveTerminalOwner" | "acquireTerminalContext"> &
    Partial<Pick<HostService, "setTerminalDeletionController">>;
  driver: NativeTerminalDriver;
  inspector: TerminalInspector;
  createView: ConstructorParameters<typeof TerminalTransport>[0];
  system?: TerminalNativeSystem;
}
/** Main-owned composition. Construct once per application lifecycle, not per
 * topic or UI reload. Native modules/assets come only from trusted bootstrap.
 * Construction does not read user state, create views, inspect or spawn processes.
 * The caller must use the session close protocol before tearing down its window.
 */
export function createTerminalRuntime(options: TerminalRuntimeOptions) {
  // No keychain, filesystem or subprocess activity during app start.
  const presetStore = options.presetCrypto
    ? new TerminalPresetStore(options.home, options.presetCrypto)
    : undefined;
  const catalog: TerminalCatalog = new TerminalCatalog(
    new TerminalStore(options.home),
    (scope) => options.host.resolveTerminalOwner(scope),
    presetStore
      ? {
          store: presetStore,
          start: (tab, scope, command) =>
            sessions.startPreset(tab, scope, command),
        }
      : undefined,
  );
  const native = new TerminalNativeAdapter(
    options.driver,
    options.inspector,
    options.system,
  );
  const surface = new TerminalTransport(options.createView);
  const sessions: TerminalSessions = new TerminalSessions({
    armPreset: native.armPreset,
    preparePreset:
      options.preparePreset ??
      (async (launch, command) => {
        const { preparePresetCommand } =
          await import("../host/terminal-preset-command");
        return preparePresetCommand(
          launch,
          command,
          (fd, pid) => options.inspector.presetPeer?.(fd, pid) === true,
        );
      }),
    acquire: async (scope, ref) => {
      if (!ref) return options.host.acquireTerminalContext(scope);
      if (!presetStore)
        throw new TerminalStartupError("preset-environment", false);
      const presetEnv = await presetStore
        .readSnapshot(ref.id, { tabId: ref.tabId, context: ref.context })
        .catch(() => {
          throw new TerminalStartupError("preset-environment", false);
        });
      return options.host.acquireTerminalContext(scope, { presetEnv });
    },
    prepareNative: native.prepare,
    spawn: native.spawn,
    processes: native.processes,
    prepareScreen: surface.prepare,
    removeTab: (tab) => catalog.removeTerminatedTab(tab),
  });
  options.host.setTerminalDeletionController?.(sessions);
  // Host-only objects; IPC exposes IDs and filtered snapshots, never this object.
  return { catalog, sessions, surface, presetStore };
}

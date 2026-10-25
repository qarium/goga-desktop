import type { HostService } from "../host/service";
import { TerminalStore } from "../host/terminal-store";
import { TerminalCatalog } from "../host/terminal-catalog";
import { TerminalSessions } from "../host/terminal-sessions";
import { TerminalTransport } from "../host/terminal-transport";
import {
  TerminalNativeAdapter,
  type NativeTerminalDriver,
  type TerminalInspector,
  type TerminalNativeSystem,
} from "../host/terminal-native";

export interface TerminalRuntimeOptions {
  home: string;
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
  const catalog = new TerminalCatalog(
    new TerminalStore(options.home),
    (scope) => options.host.resolveTerminalOwner(scope),
  );
  const native = new TerminalNativeAdapter(
    options.driver,
    options.inspector,
    options.system,
  );
  const surface = new TerminalTransport(options.createView);
  const sessions = new TerminalSessions({
    acquire: (scope) => options.host.acquireTerminalContext(scope),
    prepareNative: native.prepare,
    spawn: native.spawn,
    processes: native.processes,
    prepareScreen: surface.prepare,
    removeTab: (tab) => catalog.removeTerminatedTab(tab),
  });
  options.host.setTerminalDeletionController?.(sessions);
  // Host-only objects; IPC exposes IDs and filtered snapshots, never this object.
  return { catalog, sessions, surface };
}

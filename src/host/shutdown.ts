/** Main-owned shutdown lease. Never accept this capability from a renderer.
 * Preparation freezes admissions but MUST NOT stop processes. A failing prepare
 * releases its own gate. Release restores admissions, never restarts old work.
 */
export interface ShutdownItem {
  id: string;
  label: string;
}
export interface PreparedShutdown {
  items: ShutdownItem[];
  requiresConfirmation: boolean;
  validate(): void;
  stop(): Promise<void>;
  remaining(): string[];
  release(): void;
}
export interface ShutdownParticipant {
  prepare(): Promise<PreparedShutdown>;
}

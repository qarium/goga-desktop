import type { MessageKey } from "../../shared/locale-packs.generated";
import type { ChildProcess } from "node:child_process";
export interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  title?: string;
}
export interface PipeTarget {
  command(method: "Target.getTargets"): Promise<{ targetInfos: TargetInfo[] }>;
  command(method: string, params?: object): Promise<unknown>;
  attachHostPage(id: string): Promise<{
    onScreencastFrame(
      callback: (frame: { sessionId: number; data: string }) => void,
      lost: () => void,
      visibility: (visible: boolean) => void,
    ): void;
    selection(): Promise<string>;
    command(method: string, params?: object): Promise<unknown>;
    close(): Promise<void>;
  }>;
  onDocumentChanged(
    targetId: string,
    callback: (committed: boolean) => void,
  ): () => void;
  onPageActivated(callback: (targetId: string) => Promise<void>): () => void;
}
export declare function createPipeTarget(
  child: ChildProcess,
  onLost?: () => void,
  control?: {
    handles(method: string, params: object): boolean;
    forward(
      frame: unknown,
      bytes: number,
      accept: (frame: unknown) => void,
      fail: () => void,
    ): void;
    call(method: string, params: object): Promise<object>;
  },
): PipeTarget;
type Phase = "idle" | "arming" | "armed" | "connecting" | "connected";
type State = {
  slotId: string | null;
  port: number | null;
  phase: Phase;
  connectionId: string | null;
};
export declare function createAgentBroker(options: {
  resolveUpstream: (showId: string) => PipeTarget | undefined;
}): {
  state(): State;
  arm(showId: string, port: number): Promise<State>;
  handoff(from: string, to: string): Promise<State>;
  release(showId: string): Promise<void>;
  close(): Promise<void>;
};

export function installDemoFormatter(format: (key: Extract<MessageKey, `hostTerminal.${string}`>) => string): void;

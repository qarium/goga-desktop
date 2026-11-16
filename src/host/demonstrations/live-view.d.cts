import type { PipeTarget } from "./transport.cjs";
export declare function createLiveView(
  target: PipeTarget,
  options: { targetId: string; ownsPage?: () => boolean },
): {
  frame(): Promise<Buffer>;
  nextFrame(
    after: string | null,
  ): Promise<{ cursor: string; pixels: Buffer } | null>;
  click(x: number, y: number): Promise<void>;
  pointer(input: {
    phase: "down" | "move" | "up" | "cancel";
    gestureId: string;
    x: number;
    y: number;
    clickCount?: number;
  }): Promise<void>;
  selection(): Promise<string>;
  hasInputActivity(): boolean;
  scroll(x: number, y: number, deltaY: number): Promise<void>;
  key(key: string): Promise<void>;
  text(text: string): Promise<void>;
  close(): Promise<void>;
};

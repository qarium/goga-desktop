import type { PipeTarget } from "./transport.cjs";
export declare function trackPage(
  target: PipeTarget,
  id: string,
  onPageLost: () => void,
): Promise<{
  readonly url: string | null;
  navigate(url: string): Promise<void>;
  close(): Promise<void>;
}>;

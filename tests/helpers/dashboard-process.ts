import { NodeRunner, watchDashboard } from "../../src/host/process";

type Outcome =
  | { kind: "ready"; url: string }
  | { kind: "failure"; error: Error }
  | { kind: "finish"; code: number | null };

/** Own only a synthetic Node dashboard, never a real Goga process. */
export async function observeDashboard(
  script: string,
  timeoutMs: number,
  runner: Pick<NodeRunner, "start" | "dispose"> = new NodeRunner(),
): Promise<Outcome> {
  let cancel: (() => void) | undefined;
  try {
    const child = runner.start(process.execPath, ["-e", script], process.cwd());
    return await new Promise<Outcome>((resolve) => {
      cancel = watchDashboard(child, {
        timeoutMs,
        onReady: (url) => resolve({ kind: "ready", url }),
        onFailure: (error) => resolve({ kind: "failure", error }),
        onFinish: (code) => resolve({ kind: "finish", code }),
      });
    });
  } finally {
    cancel?.();
    await runner.dispose();
  }
}

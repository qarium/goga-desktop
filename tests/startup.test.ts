import { it, expect, vi } from "vitest";
import { loadShell } from "../src/main/load-shell";
it("navigates before awaiting renderer-dependent zoom setup", async () => {
  let loaded = false;
  const win = {
    loadFile: vi.fn(async () => {
      loaded = true;
    }),
    webContents: {
      setVisualZoomLevelLimits: vi.fn(async () => {
        if (!loaded)
          throw new Error("No renderer loaded: zoom IPC cannot resolve");
      }),
    },
  };
  await loadShell(win as any, "/app/index.html");
  expect(win.loadFile).toHaveBeenCalledWith("/app/index.html");
  expect(loaded).toBe(true);
});

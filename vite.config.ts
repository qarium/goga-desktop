import { defineConfig } from "vitest/config";
import { CiSequencer } from "./tests/helpers/ci-sequencer";
export default defineConfig({
  base: "./",
  build: { outDir: "dist" },
  test: {
    sequence: { sequencer: CiSequencer },
    setupFiles: ["./tests/browser-preferences-setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});

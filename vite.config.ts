import { defineConfig } from "vitest/config";
export default defineConfig({
  base: "./",
  build: { outDir: "dist" },
  test: {
    setupFiles: ["./tests/browser-preferences-setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});

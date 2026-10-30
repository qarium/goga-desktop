import { beforeEach, vi } from "vitest";

// App starts in Overview, which measures its panels. jsdom has no native
// ResizeObserver; only App suites install this inert geometry fixture.
// Layout-specific suites override it, and native acceptance checks real sizes.
beforeEach(() => {
  if (typeof ResizeObserver === "undefined")
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
});

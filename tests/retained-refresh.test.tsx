// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LoadingBoundary } from "../src/renderer/LoadingBoundary";
afterEach(cleanup);
it("keeps previous owner content visible during background refresh and a refresh failure", () => {
  const props = { pending: false, background: true, label: "Loading" };
  const view = (pending: boolean, error?: string) => (
    <LoadingBoundary {...props} pending={pending} error={error}>
      <input aria-label="draft" defaultValue="saved draft" />
    </LoadingBoundary>
  );
  const f = render(view(false));
  const input = screen.getByRole("textbox");
  f.rerender(view(true));
  expect(screen.getByRole("textbox")).toBe(input);
  expect(input.closest("[hidden]")).toBeNull();
  f.rerender(view(false, "Refresh failed"));
  expect(screen.getByRole("textbox")).toBe(input);
  expect(screen.getByRole("alert").textContent).toBe("Refresh failed");
});

import { describe, it, expect } from "vitest";
import {
  allowedDashboardURL,
  sameDashboardOrigin,
  validShellSender,
  viewBounds,
} from "../src/main/security";
describe("AFM isolation policy", () => {
  it("accepts only plain loopback HTTP with an explicit port", () => {
    expect(allowedDashboardURL("http://localhost:4123")).toBe(true);
    expect(allowedDashboardURL("http://127.0.0.1:4123/")).toBe(true);
    for (const url of [
      "https://example.org:4123",
      "http://localhost.evil:4123",
      "file:///tmp/a",
      "http://user@localhost:4123",
      "http://localhost:4123/?token=1",
      "http://localhost",
      "http://127.1:1234",
      "http://[::1]:1234/path",
    ])
      expect(allowedDashboardURL(url), url).toBe(false);
  });
  it("denies redirects, other ports and protocols but allows same origin AFM resources", () => {
    expect(
      sameDashboardOrigin(
        "http://localhost:4123",
        "http://localhost:4123/api/status",
      ),
    ).toBe(true);
    expect(
      sameDashboardOrigin(
        "http://localhost:4123",
        "ws://localhost:4123/ws",
        true,
      ),
    ).toBe(true);
    for (const url of [
      "http://localhost:4124",
      "http://evil.com",
      "file:///etc/passwd",
      "http://user@localhost:4123/",
    ])
      expect(sameDashboardOrigin("http://localhost:4123", url)).toBe(false);
  });
  it("only permits the known shell main frame to invoke privileged IPC", () => {
    expect(
      validShellSender(
        4,
        4,
        "file:///app/dist/index.html",
        "file:///app/dist/index.html",
        true,
      ),
    ).toBe(true);
    expect(
      validShellSender(
        5,
        4,
        "file:///app/dist/index.html",
        "file:///app/dist/index.html",
        true,
      ),
    ).toBe(false);
    expect(
      validShellSender(
        4,
        4,
        "http://localhost:4123",
        "file:///app/dist/index.html",
        true,
      ),
    ).toBe(false);
    expect(
      validShellSender(
        4,
        4,
        "file:///app/dist/index.html",
        "file:///app/dist/index.html",
        false,
      ),
    ).toBe(false);
  });
  it("constrains AFM surface to the shell content area", () => {
    expect(viewBounds(1280, 900)).toEqual({
      x: 236,
      y: 212,
      width: 1044,
      height: 688,
    });
    expect(viewBounds(500, 200)).toEqual({
      x: 236,
      y: 212,
      width: 264,
      height: 0,
    });
  });
});

import { describe, it, expect } from "vitest";
import {
  parseCatalog,
  parseCard,
  DashboardParser,
  pipelineArgs,
} from "../src/host/parsers";
describe("Goga protocols", () => {
  it("reads authored catalog and stage titles", () => {
    expect(
      parseCatalog(
        "* acme:build (project)\n    name: Build\n    description: Build artifact\n",
      ),
    ).toEqual([
      {
        id: "acme:build",
        name: "Build",
        description: "Build artifact",
        project: true,
      },
    ]);
    expect(
      parseCard(
        "name: Build\n---\n* plan:\n    title: Plan\n* work-1:\n    title: Work\n\ntools: x\n",
      ),
    ).toEqual([
      { id: "plan", title: "Plan" },
      { id: "work-1", title: "Work" },
    ]);
  });
  it("buffers streams separately and strips chunked ANSI; rejects unrelated URLs", () => {
    const p = new DashboardParser();
    expect(p.push("stdout", "\u001b[3")).toEqual([]);
    expect(p.push("stderr", "dashboard: https://evil.com\n")).toEqual([]);
    expect(p.push("stdout", "2m  dashboard: http://local")).toEqual([]);
    expect(p.push("stderr", "host:1234\n")).toEqual([]);
    expect(p.push("stdout", "host:1234\u001b[0m\n")).toEqual([
      "http://localhost:1234",
    ]);
    for (const url of [
      "http://localhost.evil:1234",
      "http://evil@localhost:1234",
      "http://127.0.0.1:1234/path",
      "http://2130706433:1234",
      "https://localhost:1234",
    ])
      expect(p.push("stdout", `dashboard: ${url}\n`)).toEqual([]);
  });
  it("uses same composition argv for preview and run", () => {
    const r = {
      projectId: "x",
      pipeline: "acme:build",
      workflow: "none",
      profile: "personal",
      skips: ["plan"],
    };
    expect(pipelineArgs(r, true)).toEqual([
      "pipeline",
      "acme:build",
      "--no-workflow",
      "--profile",
      "personal",
      "--skip",
      "plan",
      "--info",
    ]);
    expect(pipelineArgs(r, false)).toEqual(pipelineArgs(r, true).slice(0, -1));
    expect(() => pipelineArgs({ ...r, pipeline: "--help" }, true)).toThrow();
  });
});
it("rejects profile names outside actual Goga grammar", () => {
  for (const profile of ["x:y", "x$y", ".private", "../x"])
    expect(() =>
      pipelineArgs(
        { projectId: "p", pipeline: "p", workflow: "auto", profile, skips: [] },
        true,
      ),
    ).toThrow();
});
it("peeks literal workflow default even in Jinja template and respects last raw top-level key", async () => {
  const { peekWorkflowProfile } = await import("../src/host/parsers");
  expect(
    peekWorkflowProfile(
      `profile: first\n{% if worker %}\nstages:\n  x: {{ value }}\n{% endif %}\nprofile: 'last' # comment`,
    ),
  ).toBe("last");
  expect(peekWorkflowProfile("  profile: nested\nprofile: {{ dynamic }}")).toBe(
    null,
  );
});
it("distinguishes explicit workflows named auto and none from built-in modes", () => {
  for (const name of ["auto", "none", "file:custom"])
    expect(
      pipelineArgs(
        {
          projectId: "p",
          pipeline: "p",
          workflow: `file:${name}`,
          profile: "",
          skips: [],
        },
        true,
      ),
    ).toEqual(["pipeline", "p", "--workflow", name, "--info"]);
});

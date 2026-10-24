import { expect, it } from "vitest";
import { registerIPC } from "../src/main/ipc";
import { IPC_SCOPES } from "../src/shared/operation-scopes";
import { READ_BUDGETS, readChannel } from "../src/shared/read-deadlines";
import { scopeRefSchema } from "../src/shared/context";
it("classifies every IPC handler and every read-request route with the same explicit boundary", () => {
  const channels: string[] = [];
  registerIPC(
    { handle: (name: string) => channels.push(name.slice(5)) } as any,
    { window: { webContents: { id: 1 } }, service: {} } as any,
  );
  expect(channels.sort()).toEqual(Object.keys(IPC_SCOPES).sort());
  for (const method of Object.keys(READ_BUDGETS))
    expect(channels).toContain(readChannel(method as any));
  expect(IPC_SCOPES["save-settings"]).toBe("home");
  expect(IPC_SCOPES["repeat-build"]).toBe("run");
  expect(IPC_SCOPES["delete-context"]).toBe("owner-ticket");
});
it("does not interpret malformed context ownership as a primary project identifier", () => {
  for (const input of [
    { projectId: "p", contextId: "bad" },
    { projectId: "p", path: "/primary" },
    null,
    undefined,
  ])
    expect(scopeRefSchema.safeParse(input).success).toBe(false);
  expect(scopeRefSchema.parse("p")).toBe("p");
});

it("classifies every dedicated terminal control operation without allowing arbitrary shell commands", async () => {
  const { terminalControlRequestSchema } =
    await import("../src/shared/terminal-control");
  const { TERMINAL_CONTROL_SCOPES } =
    await import("../src/shared/operation-scopes");
  expect(
    terminalControlRequestSchema.options
      .map((option) => option.shape.kind.value)
      .sort(),
  ).toEqual(Object.keys(TERMINAL_CONTROL_SCOPES).sort());
  expect(TERMINAL_CONTROL_SCOPES.confirm).toBe("owner-ticket");
  expect(Object.keys(TERMINAL_CONTROL_SCOPES)).not.toContain("input");
});

import { TerminalInspectorError } from "../src/host/terminal-errors";
import { expect, it, vi } from "vitest";
import { ShutdownCoordinator } from "../src/main/shutdown-coordinator";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const events: string[] = [];
  function participant(name: string) {
    let active = [`${name}-1`];
    const release = vi.fn(() => {
      events.push(`release:${name}`);
    });
    const validate = vi.fn(() => {
      events.push(`validate:${name}`);
    });
    const stop = vi.fn(async () => {
      events.push(`stop:${name}`);
      active = [];
    });
    const prepare = vi.fn(async () => {
      events.push(`prepare:${name}`);
      return {
        items: active.map((id) => ({ id, label: name })),
        requiresConfirmation: active.length > 0,
        validate,
        stop,
        remaining: () => [...active],
        release,
      };
    });
    return {
      prepare,
      release,
      validate,
      stop,
      setActive: (ids: string[]) => {
        active = ids;
      },
    };
  }
  const runs = participant("runs"),
    terminals = participant("terminals");
  const confirm = vi.fn(async () => {
    events.push("confirm");
    return true;
  });
  const finalize = vi.fn(async () => {
    events.push("finalize");
  });
  const coordinator = new ShutdownCoordinator({
    participants: [runs, terminals],
    confirm,
    finalize,
  });
  return { coordinator, runs, terminals, events, confirm, finalize };
}
it("prepares both inventories, confirms once, revalidates all before the first stop, then finalizes", async () => {
  const f = fixture();
  expect(await f.coordinator.close()).toMatchObject({
    status: "success",
    remaining: [],
  });
  expect(f.events).toEqual([
    "prepare:runs",
    "prepare:terminals",
    "confirm",
    "validate:runs",
    "validate:terminals",
    "stop:runs",
    "stop:terminals",
    "finalize",
    "release:terminals",
    "release:runs",
  ]);
  expect(f.confirm).toHaveBeenCalledWith([
    { id: "runs-1", label: "runs" },
    { id: "terminals-1", label: "terminals" },
  ]);
});
it("cancel releases admissions without signals, persistence or finalization", async () => {
  const f = fixture();
  f.confirm.mockResolvedValue(false);
  expect((await f.coordinator.close()).status).toBe("cancelled");
  expect(f.runs.stop).not.toHaveBeenCalled();
  expect(f.terminals.stop).not.toHaveBeenCalled();
  expect(f.finalize).not.toHaveBeenCalled();
  expect(f.runs.release).toHaveBeenCalledTimes(1);
  expect(f.terminals.release).toHaveBeenCalledTimes(1);
});
it("overlapping window-close and quit share a single flight", async () => {
  const f = fixture(),
    answer = deferred<boolean>();
  f.confirm.mockReturnValue(answer.promise);
  const one = f.coordinator.close(),
    two = f.coordinator.close();
  expect(one).toBe(two);
  answer.resolve(true);
  await one;
  expect(f.confirm).toHaveBeenCalledTimes(1);
  expect(f.runs.stop).toHaveBeenCalledTimes(1);
  await f.coordinator.close();
  expect(f.finalize).toHaveBeenCalledTimes(1);
});
it("failed terminal preparation releases the pipeline gate and never asks for a misleading confirmation", async () => {
  const f = fixture();
  f.terminals.prepare.mockRejectedValue(Error("private-secret"));
  const result = await f.coordinator.close();
  expect(result.status).toBe("failed");
  expect(JSON.stringify(result)).not.toContain("private-secret");
  expect(f.confirm).not.toHaveBeenCalled();
  expect(f.runs.release).toHaveBeenCalledTimes(1);
  expect(f.finalize).not.toHaveBeenCalled();
});
it("stale terminal ownership aborts before stopping even the first pipeline", async () => {
  const f = fixture();
  f.terminals.validate.mockImplementation(() => {
    throw Error("stale");
  });
  expect((await f.coordinator.close()).status).toBe("failed");
  expect(f.runs.stop).not.toHaveBeenCalled();
  expect(f.terminals.stop).not.toHaveBeenCalled();
  expect(f.finalize).not.toHaveBeenCalled();
});
it("timeout retains the app and reports partial results without restarting completed work", async () => {
  const f = fixture();
  f.terminals.stop.mockRejectedValue(Error("timeout"));
  expect(await f.coordinator.close()).toMatchObject({
    status: "partial",
    completed: ["runs-1"],
    remaining: ["terminals-1"],
  });
  expect(f.finalize).not.toHaveBeenCalled();
  expect(f.terminals.release).toHaveBeenCalledTimes(1);
  f.terminals.stop.mockImplementation(async () => f.terminals.setActive([]));
  expect((await f.coordinator.close()).status).toBe("success");
  expect(f.confirm.mock.calls[1]).toEqual([
    [{ id: "terminals-1", label: "terminals" }],
  ]);
});
it("a stop that resolves while processes remain does not permit finalization", async () => {
  const f = fixture();
  f.runs.stop.mockResolvedValue();
  expect((await f.coordinator.close()).status).toBe("failed");
  expect(f.terminals.stop).not.toHaveBeenCalled();
  expect(f.finalize).not.toHaveBeenCalled();
});
it("unknown inventory after failure stays unresolved, never fabricated as completed", async () => {
  const f = fixture();
  const prepare = f.terminals.prepare.getMockImplementation()!;
  f.terminals.prepare.mockImplementation(async () => ({
    ...(await prepare()),
    remaining: () => {
      throw Error("unknown");
    },
  }));
  const result = await f.coordinator.close();
  expect(result).toMatchObject({
    status: "partial",
    remaining: ["terminals-1"],
  });
  expect(f.finalize).not.toHaveBeenCalled();
});
it("idle sessions stop without an unnecessary dialog, but still verify actual completion", async () => {
  const f = fixture();
  f.runs.setActive([]);
  const prepare = f.terminals.prepare.getMockImplementation()!;
  f.terminals.prepare.mockImplementation(async () => ({
    ...(await prepare()),
    requiresConfirmation: false,
  }));
  expect((await f.coordinator.close()).status).toBe("success");
  expect(f.confirm).not.toHaveBeenCalled();
  expect(f.terminals.stop).toHaveBeenCalledTimes(1);
});
it("finalization failure does not claim success, releases gates, and exposes no raw error", async () => {
  const f = fixture();
  f.finalize.mockRejectedValue(Error("SECRET=value"));
  const result = await f.coordinator.close();
  expect(result.status).toBe("partial");
  expect(JSON.stringify(result)).not.toContain("SECRET");
  expect(f.runs.release).toHaveBeenCalledTimes(1);
});

it("reports failed preparation and unknown inventory rather than zero remaining", async () => {
  const f = fixture();
  f.runs.setActive([]);
  f.terminals.prepare.mockRejectedValue(Error("private-secret"));
  const result = await f.coordinator.close();
  expect(result).toMatchObject({ status: "failed", inventoryComplete: false });
  expect(result.message).toContain("Подготовка к выходу");
  expect(result.message).not.toContain("private-secret");
});

it("shows the safe helper-replacement reason without authorizing shutdown", async () => {
  const f = fixture();
  f.terminals.prepare.mockRejectedValue(new TerminalInspectorError("changed"));
  const result = await f.coordinator.close();
  expect(result.message).toContain(
    "файл проверки терминальных процессов изменился",
  );
  expect(f.runs.stop).not.toHaveBeenCalled();
  expect(f.finalize).not.toHaveBeenCalled();
});

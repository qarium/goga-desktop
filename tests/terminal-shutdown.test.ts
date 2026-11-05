import { TerminalInspectorError } from "../src/host/terminal-errors";
import { expect, it, vi } from "vitest";
import { ShutdownCoordinator } from "../src/main/shutdown-coordinator";
import { ShutdownKeepError, type PreparedShutdown } from "../src/host/shutdown";
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
  const confirm = vi.fn(async (): Promise<boolean | "keep"> => {
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

function enableKeep(
  target: ReturnType<typeof fixture>["runs"],
  events: string[],
  name: string,
) {
  let retained: string[] = [];
  const validateKeep = vi.fn(async () => {
    events.push(`validate-keep:${name}`);
  });
  const keep = vi.fn(async () => {
    events.push(`keep:${name}`);
    retained = [`${name}-1`];
  });
  const prepare = target.prepare.getMockImplementation()!;
  target.prepare.mockImplementation(async () => ({
    ...(await prepare()),
    validateKeep,
    keep,
    retained: () => [...retained],
  }));
  return {
    validateKeep,
    keep,
    setRetained: (ids: string[]) => {
      retained = ids;
    },
  };
}

it("keep stops ordinary terminals before detaching runs and reports retained IDs separately", async () => {
  const f = fixture();
  const kept = enableKeep(f.runs, f.events, "runs");
  f.confirm.mockResolvedValue("keep");
  expect(await f.coordinator.close()).toMatchObject({
    status: "success",
    completed: ["terminals-1"],
    retained: ["runs-1"],
    remaining: [],
  });
  expect(f.events).toEqual([
    "prepare:runs",
    "prepare:terminals",
    "validate:runs",
    "validate:terminals",
    "validate-keep:runs",
    "stop:terminals",
    "keep:runs",
    "finalize",
    "release:terminals",
    "release:runs",
  ]);
  expect(kept.keep).toHaveBeenCalledTimes(1);
  expect(f.runs.stop).not.toHaveBeenCalled();
});

it("cancelling keep-capable shutdown sends no stop or detach", async () => {
  const f = fixture();
  const kept = enableKeep(f.runs, f.events, "runs");
  f.confirm.mockResolvedValue(false);
  expect(await f.coordinator.close()).toMatchObject({ status: "cancelled" });
  expect(kept.validateKeep).not.toHaveBeenCalled();
  expect(kept.keep).not.toHaveBeenCalled();
  expect(f.runs.stop).not.toHaveBeenCalled();
  expect(f.terminals.stop).not.toHaveBeenCalled();
  expect(f.finalize).not.toHaveBeenCalled();
});

it("keep validates every preview before checking any keep capability", async () => {
  const f = fixture();
  const kept = enableKeep(f.runs, f.events, "runs");
  f.confirm.mockResolvedValue("keep");
  f.terminals.validate.mockImplementation(() => {
    throw Error("stale");
  });
  expect((await f.coordinator.close()).status).toBe("failed");
  expect(kept.validateKeep).not.toHaveBeenCalled();
  expect(kept.keep).not.toHaveBeenCalled();
  expect(f.runs.stop).not.toHaveBeenCalled();
  expect(f.terminals.stop).not.toHaveBeenCalled();
});

it("keep waits for every async capability check before stopping ordinary participants", async () => {
  const f = fixture();
  const kept = enableKeep(f.runs, f.events, "runs");
  const second = enableKeep(f.terminals, f.events, "terminals");
  const checked = deferred<void>();
  const checking = deferred<void>();
  second.validateKeep.mockImplementation(async () => {
    checking.resolve();
    await checked.promise;
  });
  f.confirm.mockResolvedValue("keep");
  const result = f.coordinator.close();
  await checking.promise;
  expect(kept.keep).not.toHaveBeenCalled();
  expect(f.runs.stop).not.toHaveBeenCalled();
  expect(f.terminals.stop).not.toHaveBeenCalled();
  checked.resolve();
  expect((await result).status).toBe("success");
  expect(second.keep).toHaveBeenCalledTimes(1);
});

it("an unsupported active keep capability refuses before stopping ordinary terminals", async () => {
  const f = fixture();
  const kept = enableKeep(f.runs, f.events, "runs");
  kept.validateKeep.mockRejectedValue(Error("unsupported-private-detail"));
  f.confirm.mockResolvedValue("keep");
  const result = await f.coordinator.close();
  expect(result.status).toBe("failed");
  expect(result.message).not.toContain("unsupported-private-detail");
  expect(f.terminals.stop).not.toHaveBeenCalled();
  expect(f.runs.stop).not.toHaveBeenCalled();
  expect(kept.keep).not.toHaveBeenCalled();
  expect(f.finalize).not.toHaveBeenCalled();
});

it("failed terminal stop never detaches a keep-capable participant", async () => {
  const f = fixture();
  const kept = enableKeep(f.runs, f.events, "runs");
  f.terminals.stop.mockRejectedValue(Error("timeout"));
  f.confirm.mockResolvedValue("keep");
  expect((await f.coordinator.close()).status).toBe("failed");
  expect(kept.keep).not.toHaveBeenCalled();
  expect(f.runs.stop).not.toHaveBeenCalled();
  expect(f.finalize).not.toHaveBeenCalled();
});

it("keep failure after terminal stop reports partial progress with no fallback stop or finalize", async () => {
  const f = fixture();
  const kept = enableKeep(f.runs, f.events, "runs");
  kept.keep.mockRejectedValue(Error("keep-private-detail"));
  f.confirm.mockResolvedValue("keep");
  const result = await f.coordinator.close();
  expect(result).toMatchObject({
    status: "partial",
    completed: ["terminals-1"],
    retained: [],
    remaining: ["runs-1"],
  });
  expect(result.message).not.toContain("keep-private-detail");
  expect(f.runs.stop).not.toHaveBeenCalled();
  expect(f.finalize).not.toHaveBeenCalled();
});

it("detached retained IDs are not fabricated as stopped when live inventory is empty", async () => {
  const f = fixture();
  const kept = enableKeep(f.runs, f.events, "runs");
  kept.keep.mockImplementation(async () => {
    f.runs.setActive([]);
    kept.setRetained(["runs-1"]);
  });
  f.confirm.mockResolvedValue("keep");
  expect(await f.coordinator.close()).toMatchObject({
    status: "success",
    completed: ["terminals-1"],
    retained: ["runs-1"],
    remaining: [],
  });
});

it.each(["unknown-run", "*"])(
  "keep rejects retained ID %s absent from that participant's prepared snapshot",
  async (id) => {
    const f = fixture();
    const kept = enableKeep(f.runs, f.events, "runs");
    kept.keep.mockImplementation(async () => kept.setRetained([id]));
    f.confirm.mockResolvedValue("keep");
    const result = await f.coordinator.close();
    expect(result.status).toBe("partial");
    expect(result.completed).not.toContain("runs-1");
    expect(result.retained ?? []).not.toContain(id);
    expect(f.finalize).not.toHaveBeenCalled();
    expect(f.runs.stop).not.toHaveBeenCalled();
  },
);

it("keep never accepts an unretained live process", async () => {
  const f = fixture();
  const kept = enableKeep(f.runs, f.events, "runs");
  kept.keep.mockImplementation(async () => {
    kept.setRetained(["runs-1"]);
    f.runs.setActive(["runs-1", "new-run"]);
  });
  f.confirm.mockResolvedValue("keep");
  const result = await f.coordinator.close();
  expect(result.status).toBe("partial");
  expect(result.remaining).toContain("new-run");
  expect(f.finalize).not.toHaveBeenCalled();
});

it("keep rechecks every live inventory immediately before finalization", async () => {
  const f = fixture();
  const kept = enableKeep(f.runs, f.events, "runs");
  kept.keep.mockImplementation(async () => {
    kept.setRetained(["runs-1"]);
    f.terminals.setActive(["late-terminal"]);
  });
  f.confirm.mockResolvedValue("keep");
  const result = await f.coordinator.close();
  expect(result.status).toBe("partial");
  expect(result.remaining).toContain("late-terminal");
  expect(f.finalize).not.toHaveBeenCalled();
});

it.each(["validateKeep", "keep", "retained"] as const)(
  "keep refuses an incomplete optional capability missing %s before ordinary stops",
  async (missing) => {
    const f = fixture();
    const prepare = f.runs.prepare.getMockImplementation()!;
    const capability: Pick<
      PreparedShutdown,
      "validateKeep" | "keep" | "retained"
    > = {
      validateKeep: async () => {},
      keep: async () => {},
      retained: () => ["runs-1"],
    };
    delete capability[missing];
    f.runs.prepare.mockImplementation(async () => ({
      ...(await prepare()),
      ...capability,
    }));
    f.confirm.mockResolvedValue("keep");
    expect((await f.coordinator.close()).status).toBe("failed");
    expect(f.terminals.stop).not.toHaveBeenCalled();
    expect(f.runs.stop).not.toHaveBeenCalled();
    expect(f.finalize).not.toHaveBeenCalled();
  },
);

it("overlapping keep closes and a later close share one detach and finalization", async () => {
  const f = fixture();
  const kept = enableKeep(f.runs, f.events, "runs");
  const answer = deferred<boolean | "keep">();
  f.confirm.mockReturnValue(answer.promise);
  const one = f.coordinator.close();
  const two = f.coordinator.close();
  expect(one).toBe(two);
  answer.resolve("keep");
  expect((await one).status).toBe("success");
  await f.coordinator.close();
  expect(f.confirm).toHaveBeenCalledTimes(1);
  expect(kept.keep).toHaveBeenCalledTimes(1);
  expect(f.runs.stop).not.toHaveBeenCalled();
  expect(f.terminals.stop).toHaveBeenCalledTimes(1);
  expect(f.finalize).toHaveBeenCalledTimes(1);
});

it("a safe keep refusal reaches the user without an arbitrary error detail", async () => {
  const f = fixture();
  const kept = enableKeep(f.runs, f.events, "runs");
  kept.validateKeep.mockRejectedValue(new ShutdownKeepError("unsupported"));
  f.confirm.mockResolvedValue("keep");
  const result = await f.coordinator.close();
  expect(result.status).toBe("failed");
  expect(result.message).toContain(
    "Активный запуск не поддерживает сохранение после выхода",
  );
  expect(f.terminals.stop).not.toHaveBeenCalled();
  expect(f.finalize).not.toHaveBeenCalled();
});

it("boolean confirmation still stops keep-capable participants in the original order", async () => {
  const f = fixture();
  const kept = enableKeep(f.runs, f.events, "runs");
  const result = await f.coordinator.close();
  expect(result).toMatchObject({
    status: "success",
    completed: ["runs-1", "terminals-1"],
    remaining: [],
  });
  expect(result.retained).toBeUndefined();
  expect(kept.validateKeep).not.toHaveBeenCalled();
  expect(kept.keep).not.toHaveBeenCalled();
  expect(f.events.indexOf("stop:runs")).toBeLessThan(
    f.events.indexOf("stop:terminals"),
  );
});

it("a partial keep capability is invalid even when the selected action is stop", async () => {
  const f = fixture();
  const prepare = f.runs.prepare.getMockImplementation()!;
  f.runs.prepare.mockImplementation(async () => ({
    ...(await prepare()),
    keep: async () => {},
  }));
  expect((await f.coordinator.close()).status).toBe("failed");
  expect(f.runs.stop).not.toHaveBeenCalled();
  expect(f.terminals.stop).not.toHaveBeenCalled();
  expect(f.finalize).not.toHaveBeenCalled();
});

it("keep cannot retain an ID owned by a different participant", async () => {
  const f = fixture();
  const kept = enableKeep(f.runs, f.events, "runs");
  kept.keep.mockImplementation(async () => kept.setRetained(["terminals-1"]));
  f.confirm.mockResolvedValue("keep");
  const result = await f.coordinator.close();
  expect(result.status).toBe("partial");
  expect(result.retained).toEqual([]);
  expect(result.remaining).toContain("runs-1");
  expect(f.finalize).not.toHaveBeenCalled();
});

it("keep admission is bound to the original IDs even if a participant mutates its items", async () => {
  const f = fixture();
  const kept = enableKeep(f.runs, f.events, "runs");
  const prepare = f.runs.prepare.getMockImplementation()!;
  f.runs.prepare.mockImplementation(async () => {
    const lease = await prepare();
    kept.keep.mockImplementation(async () => {
      lease.items.push({ id: "late-run", label: "late" });
      kept.setRetained(["late-run"]);
      f.runs.setActive(["late-run"]);
    });
    return lease;
  });
  f.confirm.mockResolvedValue("keep");
  const result = await f.coordinator.close();
  expect(result.status).toBe("partial");
  expect(result.retained).toEqual([]);
  expect(result.completed).not.toContain("runs-1");
  expect(f.finalize).not.toHaveBeenCalled();
});

it("keep rechecks retained IDs after a later participant detaches", async () => {
  const f = fixture();
  const kept = enableKeep(f.runs, f.events, "runs");
  const second = enableKeep(f.terminals, f.events, "terminals");
  second.keep.mockImplementation(async () => {
    kept.setRetained(["late-run"]);
    second.setRetained(["terminals-1"]);
  });
  f.confirm.mockResolvedValue("keep");
  const result = await f.coordinator.close();
  expect(result.status).toBe("partial");
  expect(result.retained).toEqual(["terminals-1"]);
  expect(result.remaining).toContain("runs-1");
  expect(f.finalize).not.toHaveBeenCalled();
});

it("a partially successful keep is reported retained, never stopped, when another keep fails", async () => {
  const f = fixture();
  enableKeep(f.runs, f.events, "runs");
  const second = enableKeep(f.terminals, f.events, "terminals");
  second.keep.mockRejectedValue(Error("private-detail"));
  f.confirm.mockResolvedValue("keep");
  const result = await f.coordinator.close();
  expect(result).toMatchObject({
    status: "partial",
    completed: [],
    retained: ["runs-1"],
    remaining: ["terminals-1"],
  });
  expect(result.message).not.toContain("private-detail");
  expect(f.runs.stop).not.toHaveBeenCalled();
  expect(f.terminals.stop).not.toHaveBeenCalled();
  expect(f.finalize).not.toHaveBeenCalled();
});

it("an unreadable retained inventory is unresolved and never permits finalization", async () => {
  const f = fixture();
  enableKeep(f.runs, f.events, "runs");
  const prepare = f.runs.prepare.getMockImplementation()!;
  f.runs.prepare.mockImplementation(async () => ({
    ...(await prepare()),
    retained: () => {
      throw Error("private-retained-detail");
    },
  }));
  f.confirm.mockResolvedValue("keep");
  const result = await f.coordinator.close();
  expect(result).toMatchObject({
    status: "partial",
    inventoryComplete: false,
    completed: ["terminals-1"],
    retained: [],
    remaining: ["runs-1"],
  });
  expect(result.message).not.toContain("private-retained-detail");
  expect(f.finalize).not.toHaveBeenCalled();
});

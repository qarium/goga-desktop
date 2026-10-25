import { expect, it, vi } from "vitest";
import { performContextDeletion } from "../src/renderer/context-deletion-flow";
const owner: any = { projectId: "p", contextId: "ctx-a", topic: "a" };
const plan = {
  token: "token-a",
  contextId: "ctx-a",
  stage: "prepared",
  details: [],
};
const result = {
  projectId: "p",
  status: "success" as const,
  cloneRemoved: true,
  message: "Moved",
};
function fixture() {
  const order: string[] = [];
  const api = {
    deleteContext: vi.fn(async () => {
      order.push("trash");
      return result;
    }),
    finishContextDeletion: vi.fn(async () => {
      order.push("goga");
      return result;
    }),
  };
  const leave = vi.fn(async () => {
    order.push("primary");
  });
  return { api, leave, order };
}
it("waits for confirmed trash and completed primary navigation before Goga", async () => {
  const f = fixture();
  let release!: () => void;
  f.leave.mockImplementation(async () => {
    f.order.push("primary");
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const pending = performContextDeletion(owner, plan, false, f.api, f.leave);
  await vi.waitFor(() => expect(release).toBeDefined());
  expect(f.api.finishContextDeletion).not.toHaveBeenCalled();
  release();
  await pending;
  expect(f.order).toEqual(["trash", "primary", "goga"]);
  expect(f.api.deleteContext).toHaveBeenCalledWith({
    projectId: "p",
    token: "token-a",
  });
});
it("never navigates or runs Goga when trash was not confirmed", async () => {
  const f = fixture();
  f.api.deleteContext.mockResolvedValue({
    ...result,
    cloneRemoved: false,
    status: "partial" as any,
  });
  expect(
    (await performContextDeletion(owner, plan, false, f.api, f.leave)).status,
  ).toBe("partial");
  expect(f.leave).not.toHaveBeenCalled();
  expect(f.api.finishContextDeletion).not.toHaveBeenCalled();
});
it("leaves a removed clone even when registry completion failed, without running Goga", async () => {
  const f = fixture();
  f.api.deleteContext.mockResolvedValue({
    ...result,
    status: "partial" as any,
  });
  await performContextDeletion(owner, plan, false, f.api, f.leave);
  expect(f.leave).toHaveBeenCalledWith(owner);
  expect(f.api.finishContextDeletion).not.toHaveBeenCalled();
});
it("requires explicit ahead acknowledgement and binds it to the preview owner", async () => {
  const f = fixture();
  const ahead = { ...plan, requiresAheadConfirmation: true, aheadCount: 2 };
  await expect(
    performContextDeletion(owner, ahead, false, f.api, f.leave),
  ).rejects.toThrow(/подтверд/i);
  expect(f.api.deleteContext).not.toHaveBeenCalled();
  await performContextDeletion(owner, ahead, true, f.api, f.leave);
  expect(f.api.deleteContext).toHaveBeenCalledWith({
    projectId: "p",
    token: "token-a",
    allowAhead: true,
  });
  await expect(
    performContextDeletion(
      owner,
      { ...plan, contextId: "foreign" },
      true,
      f.api,
      f.leave,
    ),
  ).rejects.toThrow(/друг/);
});
it("does not execute Goga when leaving the removed context fails", async () => {
  const f = fixture();
  f.leave.mockRejectedValue(new Error("Selection failed"));
  await expect(
    performContextDeletion(owner, plan, false, f.api, f.leave),
  ).rejects.toThrow("Selection failed");
  expect(f.api.finishContextDeletion).not.toHaveBeenCalled();
});
it("returns a Goga failure without restoring or re-trashing the clone", async () => {
  const f = fixture();
  f.api.finishContextDeletion.mockImplementation(async () => {
    f.order.push("goga");
    return { ...result, status: "partial" as any, message: "Goga failed" };
  });
  const actual = await performContextDeletion(
    owner,
    plan,
    false,
    f.api,
    f.leave,
  );
  expect(actual.message).toBe("Goga failed");
  expect(f.order).toEqual(["trash", "primary", "goga"]);
  expect(f.api.deleteContext).toHaveBeenCalledTimes(1);
});

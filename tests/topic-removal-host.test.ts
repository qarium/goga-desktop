import { expect, it, vi } from "vitest";
import { TopicRemovalDomain } from "../src/host/topic-removal";
const ref = {
  full: "refs/heads/alpha",
  name: "alpha",
  commit: "a".repeat(40),
  remote: false,
};
const owner: any = {
  projectId: "p",
  year: "2026",
  topic: "alpha",
  branch: "alpha",
  contextId: "ctx-" + "1".repeat(64),
  revision: "11111111-1111-4111-8111-111111111111",
  path: "/copy",
  projectPath: "/repo",
  storageKind: "clone",
  ownership: "managed",
  state: "ready",
};
function fixture(action: "delete" | "clear" = "delete") {
  const domain = new TopicRemovalDomain(),
    order: string[] = [];
  let refs = [ref],
    owners = [owner],
    revision = "a".repeat(64);
  const access: any = {
    inventory: vi.fn(async () => ({
      projectId: "p",
      year: "2026",
      projectPath: "/repo",
      revision,
      refs,
      owners,
    })),
    inspect: vi.fn(async () => ({
      head: "a".repeat(40),
      fingerprint: "b".repeat(64),
    })),
    prepareNative: vi.fn(async () => ({
      token: "native",
      details: ["delete alpha"],
      expiresAt: Date.now() + 120000,
    })),
    executeNative: vi.fn(async () => {
      order.push("goga");
      refs = [];
      revision = "b".repeat(64);
      return { status: "success", message: "done" };
    }),
    prepareCleanup: vi.fn(async () => {
      order.push("cleanup-preview");
      return {
        token: "cleanup",
        contextId: "one",
        stage: "prepared",
        details: [],
      };
    }),
  };
  const request: any = {
    projectId: "p",
    year: "2026",
    expectedRevision: revision,
    action,
    ...(action === "delete"
      ? { topics: ["alpha", "alpha"] }
      : { baseRef: "main" }),
  };
  return {
    domain,
    access,
    request,
    order,
    setRefs: (v: any) => {
      refs = v;
    },
    setOwners: (v: any) => {
      owners = v;
    },
    setRevision: (v: string) => {
      revision = v;
    },
  };
}
it("prepares without cleanup and only offers cleanup after successful Goga", async () => {
  const f = fixture();
  const plan = await f.domain.prepare(f.access, f.request);
  expect(f.order).toEqual([]);
  const r = await f.domain.execute(f.access, f.domain.take("p", plan.token));
  expect(f.order).toEqual(["goga", "cleanup-preview"]);
  expect(r.topics.status).toBe("success");
  expect(r.cleanup).toHaveLength(1);
  expect(f.access.prepareNative.mock.calls[0][0].topics).toEqual(["alpha"]);
  expect(() => f.domain.take("p", plan.token)).toThrow();
});
it.each(["partial", "failed"])(
  "never offers copy cleanup after native %s",
  async (status) => {
    const f = fixture();
    f.access.executeNative.mockResolvedValue({ status, message: "failed" });
    const p = await f.domain.prepare(f.access, f.request),
      r = await f.domain.execute(f.access, f.domain.take("p", p.token));
    expect(r.cleanup).toEqual([]);
    expect(f.access.prepareCleanup).not.toHaveBeenCalled();
    expect(r.copies[0].status).toBe("kept");
  },
);
it("a thrown/lost native result cannot cause cleanup or automatic repeat", async () => {
  const f = fixture();
  f.access.executeNative.mockRejectedValue(Error("lost ack"));
  const p = await f.domain.prepare(f.access, f.request),
    r = await f.domain.execute(f.access, f.domain.take("p", p.token));
  expect(r.topics.status).toBe("partial");
  expect(f.access.prepareCleanup).not.toHaveBeenCalled();
  expect(f.access.executeNative).toHaveBeenCalledTimes(1);
});
it("clear success with no disappearing refs leaves all copies alone", async () => {
  const f = fixture("clear");
  f.access.executeNative.mockResolvedValue({
    status: "success",
    message: "empty",
  });
  const p = await f.domain.prepare(f.access, f.request),
    r = await f.domain.execute(f.access, f.domain.take("p", p.token));
  expect(r.cleanup).toEqual([]);
  expect(f.access.prepareCleanup).not.toHaveBeenCalled();
});
it("does not clean a replaced owner or a recreated own branch", async () => {
  const f = fixture("clear");
  f.access.executeNative.mockImplementation(async () => {
    f.setRefs([]);
    f.setOwners([{ ...owner, contextId: "replacement" }]);
    return { status: "success", message: "done" };
  });
  const p = await f.domain.prepare(f.access, f.request),
    r = await f.domain.execute(f.access, f.domain.take("p", p.token));
  expect(r.cleanup).toEqual([]);
});
it("preserves copied data if post-state read fails after successful command", async () => {
  const f = fixture();
  f.access.executeNative.mockImplementation(async () => {
    f.access.inventory.mockRejectedValue(Error("read"));
    return { status: "success", message: "done" };
  });
  const p = await f.domain.prepare(f.access, f.request),
    r = await f.domain.execute(f.access, f.domain.take("p", p.token));
  expect(r.topics.status).toBe("success");
  expect(r.cleanup).toEqual([]);
  expect(r.copies[0].status).toBe("kept");
});
it("stale context refuses the command itself and consumes its confirmation", async () => {
  const f = fixture(),
    p = await f.domain.prepare(f.access, f.request);
  f.setRevision("c".repeat(64));
  await expect(
    f.domain.execute(f.access, f.domain.take("p", p.token)),
  ).rejects.toThrow(/измен|устар/i);
  expect(f.access.executeNative).not.toHaveBeenCalled();
  expect(() => f.domain.take("p", p.token)).toThrow();
});
it("failed copy inspection does not ban clear, but preserves that copy", async () => {
  const f = fixture("clear");
  f.access.inspect.mockRejectedValue(Error("dirty"));
  const p = await f.domain.prepare(f.access, f.request),
    r = await f.domain.execute(f.access, f.domain.take("p", p.token));
  expect(r.topics.status).toBe("success");
  expect(r.cleanup).toEqual([]);
  expect(r.copies[0].status).toBe("kept");
});
it("clear never cleans clone-only topics that were absent before it ran", async () => {
  const f = fixture("clear");
  f.setRefs([]);
  const p = await f.domain.prepare(f.access, f.request),
    r = await f.domain.execute(f.access, f.domain.take("p", p.token));
  expect(r.cleanup).toEqual([]);
});
it("blocks explicitly selected copies that fail preflight until the user excludes them", async () => {
  const f = fixture();
  f.access.inspect.mockRejectedValue(Error("dirty"));
  const p = await f.domain.prepare(f.access, f.request);
  expect(p.blocked?.[0].topic).toBe("alpha");
  await expect(
    f.domain.execute(f.access, f.domain.take("p", p.token)),
  ).rejects.toThrow();
  expect(f.access.executeNative).not.toHaveBeenCalled();
});

it("wrong project consumes a ticket without invoking native mutation", async () => {
  const f = fixture(),
    p = await f.domain.prepare(f.access, f.request);
  expect(() => f.domain.take("other", p.token)).toThrow();
  expect(() => f.domain.take("p", p.token)).toThrow();
  expect(f.access.executeNative).not.toHaveBeenCalled();
});
it("a recreated own branch after success keeps its associated copy", async () => {
  const f = fixture("clear");
  f.access.executeNative.mockImplementation(async () => {
    f.setRefs([{ ...ref, commit: "c".repeat(40) }]);
    return { status: "success", message: "done" };
  });
  const p = await f.domain.prepare(f.access, f.request),
    r = await f.domain.execute(f.access, f.domain.take("p", p.token));
  expect(r.cleanup).toEqual([]);
  expect(f.access.prepareCleanup).not.toHaveBeenCalled();
});

import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { ByteCommandError } from "../src/host/process";
import { NativeGitJournal } from "../src/host/git-native-journal";
import { captureNativeGitState } from "../src/host/git-native-state";
import { acquireOwnedLock } from "../src/host/owned-lock";

vi.mock("../src/host/owned-lock", async (original) => {
  const actual = await original<typeof import("../src/host/owned-lock")>();
  return { ...actual, acquireOwnedLock: vi.fn(actual.acquireOwnedLock) };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename), open: vi.fn(actual.open) };
});
const cleanup: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  // Factory-created vi.fn mocks are not spies; restoreAllMocks alone does not
  // undo their fault implementations between tests in Vitest 5.
  vi.mocked(acquireOwnedLock).mockRestore();
  vi.mocked(fs.open).mockRestore();
  vi.mocked(fs.rename).mockRestore();
  for (const d of cleanup.splice(0))
    await fs.rm(d, { recursive: true, force: true });
});
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
async function fixture() {
  const base = await fs.mkdtemp("/private/tmp/goga-native-journal-");
  cleanup.push(base);
  const root = path.join(base, "repo"),
    directory = path.join(base, "desktop", "operations");
  await fs.mkdir(root);
  await fs.mkdir(path.join(root, ".git"));
  await fs.writeFile(path.join(root, "a"), "draft");
  const capture = () =>
    captureNativeGitState({
      root,
      paths: ["a"],
      owner: async () => ({
        scope: "p",
        registryRevision: "1",
        projectPath: root,
      }),
      observe: async () => ({
        head: "a".repeat(40),
        index: Buffer.from("index"),
        refs: Buffer.from("refs"),
        status: Buffer.from(" M a"),
        policyFingerprint: hash("policy"),
        controlFingerprint: hash("none"),
      }),
    });
  const snapshot = await capture();
  let now = 1000;
  const journal = new NativeGitJournal({ directory, now: () => now });
  const run = vi.fn(async () => ({
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    exitCode: 0,
    signal: null,
    processSettled: true as const,
  }));
  const verify = vi.fn(async () => ({
    outcome: "completed" as const,
    afterHead: snapshot.head,
    conflicts: [],
    verifiedUnrelatedData: true,
  }));
  const token = journal.prepare("merge", snapshot, hash("fixture-intent"));
  return {
    base,
    root,
    directory,
    capture,
    snapshot,
    journal,
    run,
    verify,
    token,
    expire: () => {
      now += 300001;
    },
  };
}
it("prepare is read-only; running is durable before spawn; success cleans only verified recovery bytes", async () => {
  const f = await fixture();
  await expect(fs.stat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
  f.run.mockImplementationOnce(async () => {
    const disk = JSON.parse(
      await fs.readFile(f.journal.recordPath(f.snapshot), "utf8"),
    );
    expect(disk.state).toBe("running");
    expect(disk.recovery.files[0].data).toBe(
      Buffer.from("draft").toString("base64"),
    );
    return {
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      signal: null,
      processSettled: true,
    };
  });
  const result = await f.journal.execute({
    operation: "merge",
    intentFingerprint: hash("fixture-intent"),
    token: f.token,
    capture: f.capture,
    run: f.run,
    verify: f.verify,
  });
  expect(result).toMatchObject({
    outcome: "completed",
    recovery: "removed",
    processSettled: true,
  });
  expect(await f.journal.inspect(f.snapshot)).toMatchObject({
    state: "completed",
    recovery: null,
  });
  expect((await fs.stat(f.directory)).mode & 0o777).toBe(0o700);
  expect((await fs.stat(f.journal.recordPath(f.snapshot))).mode & 0o777).toBe(
    0o600,
  );
  expect(await fs.readdir(path.join(f.root, ".git"))).toEqual([]);
});
it.each(["expired", "stale", "reused"])(
  "rejects %s confirmation without executing",
  async (kind) => {
    const f = await fixture();
    if (kind === "expired") f.expire();
    if (kind === "stale") await fs.writeFile(path.join(f.root, "a"), "other");
    if (kind === "reused")
      await f.journal.execute({
        operation: "merge",
        intentFingerprint: hash("fixture-intent"),
        token: f.token,
        capture: f.capture,
        run: f.run,
        verify: f.verify,
      });
    const count = f.run.mock.calls.length;
    await expect(
      f.journal.execute({
        operation: "merge",
        intentFingerprint: hash("fixture-intent"),
        token: f.token,
        capture: f.capture,
        run: f.run,
        verify: f.verify,
      }),
    ).rejects.toThrow();
    expect(f.run).toHaveBeenCalledTimes(count);
  },
);
it("keeps conflicts and recovery across restart, without replaying or aborting", async () => {
  const f = await fixture();
  f.run.mockResolvedValueOnce({
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    exitCode: 1,
    signal: null,
    processSettled: true,
  });
  const verify = async () => ({
    outcome: "conflicts" as const,
    afterHead: f.snapshot.head,
    conflicts: ["a"],
    verifiedUnrelatedData: true,
  });
  expect(
    await f.journal.execute({
      operation: "merge",
      intentFingerprint: hash("fixture-intent"),
      token: f.token,
      capture: f.capture,
      run: f.run,
      verify,
    }),
  ).toMatchObject({ outcome: "conflicts", recovery: "retained" });
  const restarted = new NativeGitJournal({ directory: f.directory });
  expect(await restarted.inspect(f.snapshot)).toMatchObject({
    state: "conflicts",
    recovery: { revision: f.snapshot.revision },
  });
  await expect(
    restarted.execute({
      operation: "merge",
      intentFingerprint: hash("fixture-intent"),
      token: restarted.prepare("merge", f.snapshot, hash("fixture-intent")),
      capture: f.capture,
      run: f.run,
      verify,
    }),
  ).rejects.toThrow();
  expect(f.run).toHaveBeenCalledTimes(1);
});
it("retains uncertain outcome on verifier failure; never infers completion from exit zero", async () => {
  const f = await fixture();
  const result = await f.journal.execute({
    operation: "merge",
    intentFingerprint: hash("fixture-intent"),
    token: f.token,
    capture: f.capture,
    run: f.run,
    verify: async () => {
      throw Error("inspection failed");
    },
  });
  expect(result).toMatchObject({
    outcome: "uncertain",
    recovery: "retained",
    exitCode: 0,
  });
  expect(await f.journal.inspect(f.snapshot)).toMatchObject({
    state: "uncertain",
  });
});
it("an unknown process failure blocks another write and keeps recovery", async () => {
  const f = await fixture();
  f.run.mockRejectedValueOnce(Error("process status unknown"));
  const result = await f.journal.execute({
    operation: "merge",
    intentFingerprint: hash("fixture-intent"),
    token: f.token,
    capture: f.capture,
    run: f.run,
    verify: f.verify,
  });
  expect(result).toMatchObject({
    outcome: "uncertain",
    processSettled: false,
    recovery: "retained",
  });
  expect(f.verify).not.toHaveBeenCalled();
  await expect(
    f.journal.execute({
      operation: "merge",
      intentFingerprint: hash("fixture-intent"),
      token: f.journal.prepare("merge", f.snapshot, hash("fixture-intent")),
      capture: f.capture,
      run: f.run,
      verify: f.verify,
    }),
  ).rejects.toThrow();
});
it("does not remove a foreign lease or Git lock", async () => {
  const f = await fixture();
  await fs.mkdir(f.directory, { recursive: true, mode: 0o700 });
  const lease = await acquireOwnedLock(
    f.journal.recordPath(f.snapshot) + ".lock",
  );
  try {
    await expect(
      f.journal.execute({
        operation: "merge",
        intentFingerprint: hash("fixture-intent"),
        token: f.token,
        capture: f.capture,
        run: f.run,
        verify: f.verify,
      }),
    ).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
  } finally {
    await lease.release();
  }
  await fs.writeFile(path.join(f.root, ".git/HEAD.lock"), "foreign");
  await expect(
    f.journal.execute({
      operation: "merge",
      intentFingerprint: hash("fixture-intent"),
      token: f.journal.prepare("merge", f.snapshot, hash("fixture-intent")),
      capture: f.capture,
      run: f.run,
      verify: f.verify,
    }),
  ).rejects.toThrow();
  expect(await fs.readFile(path.join(f.root, ".git/HEAD.lock"), "utf8")).toBe(
    "foreign",
  );
  expect(f.run).not.toHaveBeenCalled();
});
it("rejects symlink storage and storage inside the repository before spawn", async () => {
  const f = await fixture();
  const outside = path.join(f.base, "outside");
  await fs.mkdir(outside);
  await fs.mkdir(path.dirname(f.directory));
  await fs.symlink(outside, f.directory);
  await expect(
    f.journal.execute({
      operation: "merge",
      intentFingerprint: hash("fixture-intent"),
      token: f.token,
      capture: f.capture,
      run: f.run,
      verify: f.verify,
    }),
  ).rejects.toThrow();
  const bad = new NativeGitJournal({
    directory: path.join(f.root, ".git/goga-native"),
  });
  await expect(
    bad.execute({
      operation: "merge",
      intentFingerprint: hash("fixture-intent"),
      token: bad.prepare("merge", f.snapshot, hash("fixture-intent")),
      capture: f.capture,
      run: f.run,
      verify: f.verify,
    }),
  ).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
});
it("rejects damaged recovery on restart", async () => {
  const f = await fixture();
  await f.journal.execute({
    operation: "merge",
    intentFingerprint: hash("fixture-intent"),
    token: f.token,
    capture: f.capture,
    run: f.run,
    verify: async () => {
      throw Error("failure");
    },
  });
  const file = f.journal.recordPath(f.snapshot),
    disk = JSON.parse(await fs.readFile(file, "utf8"));
  disk.recovery.files[0].data = Buffer.from("damaged").toString("base64");
  await fs.writeFile(file, JSON.stringify(disk));
  await expect(f.journal.inspect(f.snapshot)).rejects.toThrow();
});

it.each(["prepared", "running"] as const)(
  "restart after crash at %s never runs a command",
  async (state) => {
    const f = await fixture();
    let durable = "";
    f.run.mockImplementationOnce(async () => {
      durable = await fs.readFile(f.journal.recordPath(f.snapshot), "utf8");
      throw Error("simulated interrupted command");
    });
    await f.journal.execute({
      operation: "merge",
      intentFingerprint: hash("fixture-intent"),
      token: f.token,
      capture: f.capture,
      run: f.run,
      verify: f.verify,
    });
    const crashed = JSON.parse(durable);
    crashed.state = state;
    await fs.writeFile(
      f.journal.recordPath(f.snapshot),
      JSON.stringify(crashed),
    );
    const restarted = new NativeGitJournal({ directory: f.directory });
    expect(await restarted.inspect(await f.capture())).toMatchObject({
      state: state === "running" ? "uncertain" : "prepared",
    });
    await expect(
      restarted.execute({
        operation: "merge",
        intentFingerprint: hash("fixture-intent"),
        token: restarted.prepare("merge", f.snapshot, hash("fixture-intent")),
        capture: f.capture,
        run: f.run,
        verify: f.verify,
      }),
    ).rejects.toThrow();
    expect(f.run).toHaveBeenCalledTimes(1);
  },
);
it("a recovery write failure prevents spawning", async () => {
  const f = await fixture();
  await fs.mkdir(f.directory, { recursive: true, mode: 0o700 });
  await fs.mkdir(f.journal.recordPath(f.snapshot));
  await expect(
    f.journal.execute({
      operation: "merge",
      intentFingerprint: hash("fixture-intent"),
      token: f.token,
      capture: f.capture,
      run: f.run,
      verify: f.verify,
    }),
  ).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
});
it("cleanup failure preserves completed result, recovery and prevents blind overwrite", async () => {
  const f = await fixture();
  const { rename } = await vi.importActual<typeof fs>("node:fs/promises");
  const spy = vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    const data = JSON.parse(await fs.readFile(from, "utf8"));
    if (data.state === "completed" && data.recovery === null)
      throw Object.assign(Error("disk failure"), { code: "EIO" });
    return rename(from, to);
  });
  const result = await f.journal.execute({
    operation: "merge",
    intentFingerprint: hash("fixture-intent"),
    token: f.token,
    capture: f.capture,
    run: f.run,
    verify: f.verify,
  });
  expect(result).toMatchObject({ outcome: "completed", recovery: "unknown" });
  spy.mockRestore();
  expect(await f.journal.inspect(f.snapshot)).toMatchObject({
    state: "completed",
    recovery: { revision: f.snapshot.revision },
  });
  await expect(
    f.journal.assertAdmission(f.root, f.snapshot.owner),
  ).rejects.toThrow();
  await expect(
    f.journal.execute({
      operation: "merge",
      intentFingerprint: hash("fixture-intent"),
      token: f.journal.prepare("merge", f.snapshot, hash("fixture-intent")),
      capture: f.capture,
      run: f.run,
      verify: f.verify,
    }),
  ).rejects.toThrow();
  expect(f.run).toHaveBeenCalledTimes(1);
});
it("does not rewrite a replaced journal or delete its recovery", async () => {
  const f = await fixture();
  f.verify.mockImplementationOnce(async () => {
    await fs.rename(
      f.journal.recordPath(f.snapshot),
      f.journal.recordPath(f.snapshot) + ".saved",
    );
    await fs.writeFile(f.journal.recordPath(f.snapshot), "foreign", {
      mode: 0o600,
    });
    return {
      outcome: "completed",
      afterHead: f.snapshot.head,
      conflicts: [],
      verifiedUnrelatedData: true,
    };
  });
  expect(
    await f.journal.execute({
      operation: "merge",
      intentFingerprint: hash("fixture-intent"),
      token: f.token,
      capture: f.capture,
      run: f.run,
      verify: f.verify,
    }),
  ).toMatchObject({ outcome: "uncertain", recovery: "unknown" });
  expect(await fs.readFile(f.journal.recordPath(f.snapshot), "utf8")).toBe(
    "foreign",
  );
});
it("rejects an active record owned by another registry identity in the same physical repo", async () => {
  const f = await fixture();
  await f.journal.execute({
    operation: "merge",
    intentFingerprint: hash("fixture-intent"),
    token: f.token,
    capture: f.capture,
    run: f.run,
    verify: async () => {
      throw Error("uncertain");
    },
  });
  const other = await captureNativeGitState({
    root: f.root,
    paths: ["a"],
    owner: async () => ({
      scope: "other",
      registryRevision: "2",
      projectPath: f.root,
    }),
    observe: async () => ({
      head: f.snapshot.head,
      index: Buffer.from("index"),
      refs: Buffer.from("refs"),
      status: Buffer.from(" M a"),
      policyFingerprint: hash("policy"),
      controlFingerprint: hash("none"),
    }),
  });
  expect(f.journal.recordPath(other)).toBe(f.journal.recordPath(f.snapshot));
  await expect(f.journal.inspect(other)).rejects.toThrow();
});
it("serializes different operation kinds for the same physical repository", async () => {
  const f = await fixture();
  let started!: () => void, finish!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const active = f.journal.execute({
    operation: "merge",
    intentFingerprint: hash("fixture-intent"),
    token: f.token,
    capture: f.capture,
    run: async () => {
      started();
      await wait;
      return f.run();
    },
    verify: f.verify,
  });
  await entered;
  try {
    await expect(
      f.journal.execute({
        operation: "discard",
        intentFingerprint: hash("fixture-intent"),
        token: f.journal.prepare("discard", f.snapshot, hash("fixture-intent")),
        capture: f.capture,
        run: f.run,
        verify: f.verify,
      }),
    ).rejects.toThrow();
  } finally {
    finish();
  }
  expect(await active).toMatchObject({ outcome: "completed" });
  expect(f.run).toHaveBeenCalledTimes(1);
});

it("allows a fresh owner after verified completion, but not an active split owner", async () => {
  const f = await fixture();
  await f.journal.execute({
    operation: "merge",
    intentFingerprint: hash("fixture-intent"),
    token: f.token,
    capture: f.capture,
    run: f.run,
    verify: f.verify,
  });
  const capture = () =>
    captureNativeGitState({
      root: f.root,
      paths: ["a"],
      owner: async () => ({
        scope: "other",
        registryRevision: "2",
        projectPath: f.root,
      }),
      observe: async () => ({
        head: f.snapshot.head,
        index: Buffer.from("index"),
        refs: Buffer.from("refs"),
        status: Buffer.from(" M a"),
        policyFingerprint: hash("policy"),
        controlFingerprint: hash("none"),
      }),
    });
  const other = await capture();
  expect(
    await f.journal.execute({
      operation: "merge",
      intentFingerprint: hash("fixture-intent"),
      token: f.journal.prepare("merge", other, hash("fixture-intent")),
      capture,
      run: f.run,
      verify: f.verify,
    }),
  ).toMatchObject({ outcome: "completed" });
  expect(f.run).toHaveBeenCalledTimes(2);
});

it("consumes a token presented to the wrong operation without running either", async () => {
  const f = await fixture();
  await expect(
    f.journal.execute({
      operation: "discard",
      intentFingerprint: hash("fixture-intent"),
      token: f.token,
      capture: f.capture,
      run: f.run,
      verify: f.verify,
    }),
  ).rejects.toThrow();
  await expect(
    f.journal.execute({
      operation: "merge",
      intentFingerprint: hash("fixture-intent"),
      token: f.token,
      capture: f.capture,
      run: f.run,
      verify: f.verify,
    }),
  ).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
});

it("binds confirmation to exact host intent, not only operation kind", async () => {
  const f = await fixture();
  const token = f.journal.prepare("merge", f.snapshot, hash("source branch A"));
  await expect(
    f.journal.execute({
      operation: "merge",
      intentFingerprint: hash("source branch B"),
      token,
      capture: f.capture,
      run: f.run,
      verify: f.verify,
    }),
  ).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
});

it("expires confirmation again after slow revalidation, before any command", async () => {
  const f = await fixture();
  let calls = 0;
  const capture = async () => {
    const s = await f.capture();
    if (++calls === 2) f.expire();
    return s;
  };
  await expect(
    f.journal.execute({
      operation: "merge",
      intentFingerprint: hash("fixture-intent"),
      token: f.token,
      capture,
      run: f.run,
      verify: f.verify,
    }),
  ).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
  expect(await f.journal.inspect(f.snapshot)).toBeNull();
});
it("retains all recovery when post-command ownership is no longer provable", async () => {
  const f = await fixture();
  f.run.mockImplementationOnce(async () => {
    await fs.rename(f.root, f.root + "-previous");
    await fs.mkdir(f.root);
    await fs.mkdir(path.join(f.root, ".git"));
    await fs.writeFile(path.join(f.root, "a"), "draft");
    return {
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      signal: null,
      processSettled: true,
    };
  });
  expect(
    await f.journal.execute({
      operation: "merge",
      intentFingerprint: hash("fixture-intent"),
      token: f.token,
      capture: f.capture,
      run: f.run,
      verify: f.verify,
    }),
  ).toMatchObject({
    outcome: "uncertain",
    processSettled: true,
    recovery: "retained",
  });
  expect(f.verify).not.toHaveBeenCalled();
  const disk = JSON.parse(
    await fs.readFile(f.journal.recordPath(f.snapshot), "utf8"),
  );
  expect(disk.state).toBe("uncertain");
  expect(disk.recovery.files[0].data).toBe(
    Buffer.from("draft").toString("base64"),
  );
  await expect(f.journal.inspect(f.snapshot)).rejects.toThrow();
});
it("refuses hardlinked journal data without following or deleting it", async () => {
  const f = await fixture();
  await f.journal.execute({
    operation: "merge",
    intentFingerprint: hash("fixture-intent"),
    token: f.token,
    capture: f.capture,
    run: f.run,
    verify: async () => {
      throw Error("uncertain");
    },
  });
  const copy = path.join(f.base, "outside-copy");
  await fs.link(f.journal.recordPath(f.snapshot), copy);
  await expect(f.journal.inspect(f.snapshot)).rejects.toThrow();
  expect(await fs.readFile(copy)).toEqual(
    await fs.readFile(f.journal.recordPath(f.snapshot)),
  );
});

it("syncs newly created storage ancestry before executing Git", async () => {
  const f = await fixture();
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  const synced: string[] = [];
  const spy = vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      synced.push(String(args[0]));
      await sync();
    };
    return handle;
  });
  f.run.mockImplementationOnce(async () => {
    expect(synced).toContain(path.dirname(f.directory));
    expect(synced).toContain(f.base);
    return {
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      signal: null,
      processSettled: true,
    };
  });
  try {
    expect(
      await f.journal.execute({
        operation: "merge",
        intentFingerprint: hash("fixture-intent"),
        token: f.token,
        capture: f.capture,
        run: f.run,
        verify: f.verify,
      }),
    ).toMatchObject({ outcome: "completed" });
  } finally {
    spy.mockRestore();
  }
});

it("resumes a sealed conflict after restart while retaining the ORIGINAL recovery snapshot", async () => {
  const f = await fixture();
  f.run.mockImplementationOnce(async () => {
    await fs.writeFile(path.join(f.root, "a"), "conflict");
    return {
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: 1,
      signal: null,
      processSettled: true,
    };
  });
  const first = await f.journal.execute({
    token: f.token,
    operation: "merge",
    intentFingerprint: hash("fixture-intent"),
    capture: f.capture,
    run: f.run,
    verify: async () => ({
      outcome: "conflicts",
      afterHead: f.snapshot.head,
      conflicts: ["a"],
      verifiedUnrelatedData: true,
    }),
  });
  const restarted = new NativeGitJournal({ directory: f.directory });
  expect(await restarted.inspect(await f.capture())).toMatchObject({
    checkpoint: {
      files: [{ path: "a", data: Buffer.from("conflict").toString("base64") }],
    },
  });
  await fs.writeFile(path.join(f.root, "a"), "resolved");
  const current = await f.capture();
  const next = await restarted.prepareFollowup(
    "merge",
    current,
    hash("continue"),
  );
  const result = await restarted.execute({
    token: next,
    operation: "merge",
    intentFingerprint: hash("continue"),
    capture: f.capture,
    run: async () => {
      const disk = JSON.parse(
        await fs.readFile(restarted.recordPath(current), "utf8"),
      );
      expect(disk.state).toBe("running");
      expect(disk.id).toBe(first.operationId);
      expect(disk.attemptFingerprint).toBe(hash("continue"));
      expect(disk.recovery.files[0].data).toBe(
        Buffer.from("draft").toString("base64"),
      );
      return f.run();
    },
    verify: f.verify,
  });
  expect(result).toMatchObject({
    operationId: first.operationId,
    outcome: "completed",
    recovery: "removed",
  });
  expect(await restarted.inspect(await f.capture())).toMatchObject({
    state: "completed",
    recovery: null,
  });
});

it("followup cannot grant provenance to an external merge or uncertain attempt", async () => {
  const f = await fixture();
  await expect(
    f.journal.prepareFollowup("merge", f.snapshot, hash("continue")),
  ).rejects.toThrow();
  f.run.mockRejectedValueOnce(Error("unknown transport"));
  await f.journal.execute({
    token: f.token,
    operation: "merge",
    intentFingerprint: hash("fixture-intent"),
    capture: f.capture,
    run: f.run,
    verify: f.verify,
  });
  await expect(
    f.journal.prepareFollowup("merge", await f.capture(), hash("continue")),
  ).rejects.toThrow();
});

it("followup refuses changed controls and a replaced conflict record, without running Git", async () => {
  const f = await fixture();
  f.run.mockResolvedValueOnce({
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    exitCode: 1,
    signal: null,
    processSettled: true,
  });
  await f.journal.execute({
    token: f.token,
    operation: "merge",
    intentFingerprint: hash("fixture-intent"),
    capture: f.capture,
    run: f.run,
    verify: async () => ({
      outcome: "conflicts",
      afterHead: f.snapshot.head,
      conflicts: ["a"],
      verifiedUnrelatedData: true,
    }),
  });
  const snapshot = await f.capture();
  const changed = await captureNativeGitState({
    root: f.root,
    paths: ["a"],
    owner: async () => snapshot.owner,
    observe: async () => ({
      head: snapshot.head,
      index: Buffer.from("index"),
      refs: Buffer.from("refs"),
      status: Buffer.from(" M a"),
      policyFingerprint: hash("policy"),
      controlFingerprint: hash("other operation"),
    }),
  });
  await expect(
    f.journal.prepareFollowup("merge", changed, hash("continue")),
  ).rejects.toThrow();
  const token = await f.journal.prepareFollowup(
    "merge",
    snapshot,
    hash("continue"),
  );
  const record = JSON.parse(
    await fs.readFile(f.journal.recordPath(snapshot), "utf8"),
  );
  record.intentFingerprint = hash("replaced intent");
  await fs.writeFile(f.journal.recordPath(snapshot), JSON.stringify(record));
  await expect(
    f.journal.execute({
      token,
      operation: "merge",
      intentFingerprint: hash("continue"),
      capture: f.capture,
      run: f.run,
      verify: f.verify,
    }),
  ).rejects.toThrow();
  expect(f.run).toHaveBeenCalledTimes(1);
});

it("a settled rejection with unchanged public/user state is retryable but not successful", async () => {
  const f = await fixture();
  f.run.mockResolvedValueOnce({
    stdout: Buffer.alloc(0),
    stderr: Buffer.from("refused"),
    exitCode: 128,
    signal: null,
    processSettled: true,
  });
  const result = await f.journal.execute({
    token: f.token,
    operation: "merge",
    intentFingerprint: hash("fixture-intent"),
    capture: f.capture,
    run: f.run,
    verify: async () => ({
      outcome: "rejected",
      afterHead: f.snapshot.head,
      conflicts: [],
      verifiedUnrelatedData: true,
    }),
  });
  expect(result).toMatchObject({
    outcome: "rejected",
    exitCode: 128,
    recovery: "removed",
  });
  expect(
    await f.journal.execute({
      token: f.journal.prepare("merge", await f.capture(), hash("new intent")),
      operation: "merge",
      intentFingerprint: hash("new intent"),
      capture: f.capture,
      run: f.run,
      verify: f.verify,
    }),
  ).toMatchObject({ outcome: "completed" });
});

it("does not bless changed user data as an unchanged rejection", async () => {
  const f = await fixture();
  f.run.mockImplementationOnce(async () => {
    await fs.writeFile(path.join(f.root, "a"), "changed despite error");
    return {
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: 1,
      signal: null,
      processSettled: true,
    };
  });
  expect(
    await f.journal.execute({
      token: f.token,
      operation: "merge",
      intentFingerprint: hash("fixture-intent"),
      capture: f.capture,
      run: f.run,
      verify: async () => ({
        outcome: "rejected",
        afterHead: f.snapshot.head,
        conflicts: [],
        verifiedUnrelatedData: true,
      }),
    }),
  ).toMatchObject({ outcome: "uncertain", recovery: "retained" });
});

it("host admission blocks other writers after an uncertain attempt, including after restart", async () => {
  const f = await fixture();
  await f.journal.execute({
    token: f.token,
    operation: "merge",
    intentFingerprint: hash("fixture-intent"),
    capture: f.capture,
    run: async () => {
      throw Error("unsettled");
    },
    verify: f.verify,
  });
  const restarted = new NativeGitJournal({ directory: f.directory });
  await expect(
    restarted.assertAdmission(f.root, f.snapshot.owner),
  ).rejects.toThrow();
});

it("retains original recovery and blocks replay if releasing the journal lease fails", async () => {
  const f = await fixture();
  const actual = await vi.importActual<typeof import("../src/host/owned-lock")>(
    "../src/host/owned-lock",
  );
  vi.mocked(acquireOwnedLock).mockImplementationOnce(async (file, options) => {
    const lease = await actual.acquireOwnedLock(file, options);
    return {
      release: async () => {
        throw Error("injected lease release failure");
      },
    };
  });
  const result = await f.journal.execute({
    operation: "merge",
    intentFingerprint: hash("fixture-intent"),
    token: f.token,
    capture: f.capture,
    run: f.run,
    verify: f.verify,
  });
  expect(result).toMatchObject({ outcome: "uncertain", recovery: "retained" });
  expect(await f.journal.inspect(f.snapshot)).toMatchObject({
    state: "uncertain",
    recovery: {
      files: [{ path: "a", data: Buffer.from("draft").toString("base64") }],
    },
  });
  expect(
    (await fs.stat(f.journal.recordPath(f.snapshot) + ".lock")).isFile(),
  ).toBe(true);
  await expect(
    f.journal.assertAdmission(f.root, f.snapshot.owner),
  ).rejects.toThrow();
  expect(f.run).toHaveBeenCalledTimes(1);
});

it("durably binds optional host intent details and rejects a mismatched descriptor", async () => {
  const f = await fixture();
  const details = JSON.stringify({
    command: "rebase",
    args: ["--merge", "a".repeat(40)],
  });
  expect(() =>
    f.journal.prepare("rebase", f.snapshot, hash("other"), details),
  ).toThrow();
  const token = f.journal.prepare("rebase", f.snapshot, hash(details), details);
  f.run.mockImplementationOnce(async () => {
    expect(
      JSON.parse(await fs.readFile(f.journal.recordPath(f.snapshot), "utf8")),
    ).toMatchObject({
      state: "running",
      intentDetails: details,
      intentFingerprint: hash(details),
    });
    return {
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      signal: null,
      processSettled: true,
    };
  });
  expect(
    await f.journal.execute({
      token,
      operation: "rebase",
      intentFingerprint: hash(details),
      capture: f.capture,
      run: f.run,
      verify: f.verify,
    }),
  ).toMatchObject({ outcome: "completed" });
  const restarted = new NativeGitJournal({ directory: f.directory });
  expect(await restarted.inspect(f.snapshot)).toMatchObject({
    intentDetails: details,
  });
  const filename = f.journal.recordPath(f.snapshot);
  const record = JSON.parse(await fs.readFile(filename, "utf8"));
  record.intentDetails = "changed descriptor";
  await fs.writeFile(filename, JSON.stringify(record));
  await expect(restarted.inspect(f.snapshot)).rejects.toThrow();
});

it("keeps native process facts and recovery when journalled post-command inspection fails", async () => {
  const f = await fixture();
  const inspect = vi.fn(async () => {
    expect(f.run).toHaveBeenCalledTimes(1);
    throw Error("invalid public plan");
  });
  const result = await f.journal.execute({
    token: f.token,
    operation: "merge",
    intentFingerprint: hash("fixture-intent"),
    capture: f.capture,
    run: f.run,
    afterSettled: inspect,
    verify: f.verify,
  } as Parameters<NativeGitJournal["execute"]>[0]);
  expect(inspect).toHaveBeenCalledTimes(1);
  expect(f.verify).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    outcome: "uncertain",
    exitCode: 0,
    processSettled: true,
    recovery: "retained",
  });
});

it.each([true, false])(
  "retains primary exit facts when an inspection transport fails (settled=%s)",
  async (settled) => {
    const f = await fixture();
    const result = await f.journal.execute({
      token: f.token,
      operation: "merge",
      intentFingerprint: hash("fixture-intent"),
      capture: f.capture,
      run: f.run,
      afterSettled: async () => {
        throw new ByteCommandError(
          "timeout",
          settled,
          Buffer.alloc(0),
          Buffer.alloc(0),
          7,
          "SIGTERM",
        );
      },
      verify: f.verify,
    });
    expect(result).toMatchObject({
      outcome: "uncertain",
      exitCode: 0,
      signal: null,
      processSettled: settled,
      recovery: "retained",
    });
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.verify).not.toHaveBeenCalled();
  },
);

it.each(["bytes", "mode", "index", "headRef", "refs", "control"] as const)(
  "final durable-prepared capture rejects %s drift before native execution and consumes the token",
  async (kind) => {
    const f = await fixture();
    let count = 0;
    const capture = async () => {
      if (++count >= 3) {
        if (kind === "bytes")
          await fs.writeFile(path.join(f.root, "a"), "late draft");
        if (kind === "mode") await fs.chmod(path.join(f.root, "a"), 0o640);
        return captureNativeGitState({
          root: f.root,
          paths: ["a"],
          owner: async () => f.snapshot.owner,
          observe: async () => ({
            head: f.snapshot.head,
            headRef:
              kind === "headRef" ? "refs/heads/other" : f.snapshot.headRef,
            index: Buffer.from(kind === "index" ? "changed staged" : "index"),
            refs: Buffer.from(
              kind === "refs" ? "refs/heads/alias\0refs/heads/main" : "refs",
            ),
            status: Buffer.from(" M a"),
            policyFingerprint: hash("policy"),
            controlFingerprint: hash(
              kind === "control" ? "changed patch" : "none",
            ),
          }),
        });
      }
      return f.capture();
    };
    const execute = () =>
      f.journal.execute({
        operation: "merge",
        intentFingerprint: hash("fixture-intent"),
        token: f.token,
        capture,
        run: f.run,
        verify: f.verify,
      });
    await expect(execute()).rejects.toThrow();
    await expect(execute()).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
    const record = JSON.parse(
      await fs.readFile(f.journal.recordPath(f.snapshot), "utf8"),
    );
    expect(record.state).toBe("prepared");
    expect(record.recovery.files[0].data).toBe(
      Buffer.from("draft").toString("base64"),
    );
    expect(await fs.readFile(path.join(f.root, "a"), "utf8")).toBe(
      kind === "bytes" ? "late draft" : "draft",
    );
    if (kind === "mode")
      expect((await fs.stat(path.join(f.root, "a"))).mode & 0o777).toBe(0o640);
  },
);

it("initial record identity-read failure prevents execution and leaves durable recovery blocked", async () => {
  const f = await fixture(),
    record = f.journal.recordPath(f.snapshot);
  const { open } = await vi.importActual<typeof fs>("node:fs/promises");
  const spy = vi.mocked(fs.open).mockImplementation(async (...args) => {
    if (
      String(args[0]) === record &&
      (await fs.stat(record).then(
        () => true,
        () => false,
      ))
    )
      throw Object.assign(Error("record read failed"), { code: "EIO" });
    return open(...args);
  });
  await expect(
    f.journal.execute({
      operation: "merge",
      intentFingerprint: hash("fixture-intent"),
      token: f.token,
      capture: f.capture,
      run: f.run,
      verify: f.verify,
    }),
  ).rejects.toThrow();
  spy.mockRestore();
  expect(f.run).not.toHaveBeenCalled();
  expect(await f.journal.inspect(f.snapshot)).toMatchObject({
    state: "prepared",
    recovery: { revision: f.snapshot.revision },
  });
  await expect(
    f.journal.assertAdmission(f.root, f.snapshot.owner),
  ).rejects.toThrow();
});

it.each(["moved", "corrupt", "ancestor-symlink", "read-EIO"] as const)(
  "post-command %s recovery fault reports unknown without replay or deleting foreign data",
  async (kind) => {
    const f = await fixture(),
      record = f.journal.recordPath(f.snapshot);
    let saved = "",
      foreign = "";
    f.run.mockImplementationOnce(async () => {
      if (kind === "moved") {
        saved = record + ".saved";
        await fs.rename(record, saved);
      }
      if (kind === "corrupt") {
        foreign = "foreign corrupt journal";
        await fs.writeFile(record, foreign);
      }
      if (kind === "ancestor-symlink") {
        saved = path.dirname(f.directory) + "-saved";
        await fs.rename(path.dirname(f.directory), saved);
        await fs.symlink(saved, path.dirname(f.directory));
      }
      if (kind === "read-EIO") {
        const { open } = await vi.importActual<typeof fs>("node:fs/promises");
        vi.mocked(fs.open).mockImplementation(async (...args) => {
          if (String(args[0]) === record)
            throw Object.assign(Error("read failed"), { code: "EIO" });
          return open(...args);
        });
      }
      return {
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        exitCode: 0,
        signal: null,
        processSettled: true,
      };
    });
    const execute = () =>
      f.journal.execute({
        operation: "merge",
        intentFingerprint: hash("fixture-intent"),
        token: f.token,
        capture: f.capture,
        run: f.run,
        verify: f.verify,
      });
    expect(await execute()).toMatchObject({
      outcome: "uncertain",
      recovery: "unknown",
      exitCode: 0,
      signal: null,
      processSettled: true,
    });
    await expect(execute()).rejects.toThrow();
    vi.mocked(fs.open).mockRestore();
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(f.root, "a"), "utf8")).toBe("draft");
    const restarted = new NativeGitJournal({ directory: f.directory });
    await expect(
      restarted.assertAdmission(f.root, f.snapshot.owner),
    ).rejects.toThrow();
    await expect(
      restarted.execute({
        operation: "merge",
        intentFingerprint: hash("fresh intent"),
        token: restarted.prepare("merge", f.snapshot, hash("fresh intent")),
        capture: f.capture,
        run: f.run,
        verify: f.verify,
      }),
    ).rejects.toThrow();
    expect(f.run).toHaveBeenCalledTimes(1);
    if (kind === "corrupt")
      expect(await fs.readFile(record, "utf8")).toBe(foreign);
    if (kind === "moved")
      expect(JSON.parse(await fs.readFile(saved, "utf8")).state).toBe(
        "running",
      );
    if (kind === "ancestor-symlink") {
      expect((await fs.lstat(path.dirname(f.directory))).isSymbolicLink()).toBe(
        true,
      );
      expect(
        JSON.parse(
          await fs.readFile(
            path.join(saved, "operations", path.basename(record)),
            "utf8",
          ),
        ).state,
      ).toBe("running");
    }
  },
);

it.each(["retained", "removed"] as const)(
  "final pending fence cleanup failure (%s) retains recovery and blocks restarted writers",
  async (kind) => {
    const f = await fixture();
    const actual = await vi.importActual<
      typeof import("../src/host/owned-lock")
    >("../src/host/owned-lock");
    vi.mocked(acquireOwnedLock).mockImplementation(async (file, options) => {
      const lease = await actual.acquireOwnedLock(file, options);
      if (!file.endsWith(".pending")) return lease;
      return {
        ...lease,
        release: async () => {
          if (kind === "removed") await lease.release();
          throw Object.assign(Error("pending cleanup failed"), { code: "EIO" });
        },
      };
    });
    const result = await f.journal.execute({
      operation: "merge",
      intentFingerprint: hash("fixture-intent"),
      token: f.token,
      capture: f.capture,
      run: f.run,
      verify: f.verify,
    });
    expect(result).toMatchObject({
      outcome: "uncertain",
      recovery: "unknown",
      exitCode: 0,
      signal: null,
      processSettled: true,
    });
    const restarted = new NativeGitJournal({ directory: f.directory });
    expect(await restarted.inspect(f.snapshot)).toMatchObject({
      state: "uncertain",
      recovery: {
        revision: f.snapshot.revision,
        files: [
          expect.objectContaining({
            data: Buffer.from("draft").toString("base64"),
          }),
        ],
      },
    });
    const pendingExists = await fs
      .lstat(f.journal.recordPath(f.snapshot) + ".pending")
      .then(
        () => true,
        () => false,
      );
    expect(pendingExists).toBe(kind === "retained");
    await expect(
      restarted.assertAdmission(f.root, f.snapshot.owner),
    ).rejects.toThrow();
    await expect(
      restarted.execute({
        operation: "merge",
        intentFingerprint: hash("fresh intent"),
        token: restarted.prepare("merge", f.snapshot, hash("fresh intent")),
        capture: f.capture,
        run: f.run,
        verify: f.verify,
      }),
    ).rejects.toThrow();
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(f.root, "a"), "utf8")).toBe("draft");
  },
);

it("keeps recovery and the durable fence until outer context cleanup succeeds", async () => {
  const f = await fixture();
  let finalize!: () => Promise<
    import("../src/shared/git-native-operation").NativeGitOperationResult
  >;
  const result = await f.journal.execute({
    token: f.token,
    operation: "merge",
    intentFingerprint: hash("fixture-intent"),
    capture: f.capture,
    run: f.run,
    verify: f.verify,
    deferRecoveryCleanup: (finish) => {
      finalize = finish;
    },
  });
  expect(result).toMatchObject({ outcome: "completed", recovery: "retained" });
  const restarted = new NativeGitJournal({ directory: f.directory });
  await expect(
    restarted.assertAdmission(f.root, f.snapshot.owner),
  ).rejects.toThrow();
  const record = JSON.parse(
    await fs.readFile(f.journal.recordPath(f.snapshot), "utf8"),
  );
  expect(record.recovery.files[0].data).toBe(
    Buffer.from("draft").toString("base64"),
  );
  const finalized = await finalize();
  expect(finalized, JSON.stringify(finalized)).toMatchObject({
    outcome: "completed",
    recovery: "removed",
  });
  await expect(
    restarted.assertAdmission(f.root, f.snapshot.owner),
  ).resolves.toBeUndefined();
  await expect(finalize()).rejects.toThrow();
  expect(f.run).toHaveBeenCalledTimes(1);
});
it("does not clean a replaced recovery record during deferred finalization", async () => {
  const f = await fixture();
  let finalize!: () => Promise<
    import("../src/shared/git-native-operation").NativeGitOperationResult
  >;
  await f.journal.execute({
    token: f.token,
    operation: "merge",
    intentFingerprint: hash("fixture-intent"),
    capture: f.capture,
    run: f.run,
    verify: f.verify,
    deferRecoveryCleanup: (finish) => {
      finalize = finish;
    },
  });
  const filename = f.journal.recordPath(f.snapshot);
  const content = await fs.readFile(filename);
  await fs.rename(filename, filename + ".original");
  await fs.writeFile(filename, content, { mode: 0o600 });
  expect(await finalize()).toMatchObject({ recovery: "unknown" });
  expect(await fs.readFile(filename)).toEqual(content);
  expect(await fs.readFile(filename + ".original")).toEqual(content);
  await expect(
    f.journal.assertAdmission(f.root, f.snapshot.owner),
  ).rejects.toThrow();
});

async function stoppedResolutionFixture() {
  const f = await fixture();
  await f.journal.execute({
    token: f.token,
    operation: "merge",
    intentFingerprint: hash("fixture-intent"),
    capture: f.capture,
    run: async () => ({ ...(await f.run()), exitCode: 1 }),
    verify: async () => ({
      outcome: "conflicts",
      afterHead: f.snapshot.head,
      conflicts: ["a", "other"],
      verifiedUnrelatedData: true,
    }),
  });
  return f;
}
it("resolution keeps the original stopped receipt byte-for-byte and permits Desktop followup", async () => {
  const f = await stoppedResolutionFixture();
  const original = await fs.readFile(f.journal.recordPath(f.snapshot), "utf8");
  const token = await f.journal.prepareResolution(
    f.snapshot,
    hash("resolve-a"),
    "a",
  );
  const result = await f.journal.execute({
    token,
    operation: "resolve",
    intentFingerprint: hash("resolve-a"),
    capture: f.capture,
    run: f.run,
    verify: f.verify,
  });
  expect(result).toMatchObject({ outcome: "completed", recovery: "retained" });
  expect(await fs.readFile(f.journal.recordPath(f.snapshot), "utf8")).toBe(
    original,
  );
  await expect(
    f.journal.prepareFollowup("merge", f.snapshot, hash("continue")),
  ).resolves.toBeTypeOf("string");
});
it("failed resolution retains its own snapshot, parent receipt and durable fence", async () => {
  const f = await stoppedResolutionFixture();
  const parent = await f.journal.inspect(f.snapshot);
  const token = await f.journal.prepareResolution(
    f.snapshot,
    hash("resolve-a"),
    "a",
  );
  const result = await f.journal.execute({
    token,
    operation: "resolve",
    intentFingerprint: hash("resolve-a"),
    capture: f.capture,
    run: async () => {
      throw new Error("stage failure");
    },
    verify: f.verify,
  });
  expect(result.outcome).toBe("uncertain");
  const record = await f.journal.inspect(f.snapshot);
  expect(record).toMatchObject({
    state: "uncertain",
    intentFingerprint: parent!.intentFingerprint,
    recovery: parent!.recovery,
    checkpoint: parent!.checkpoint,
    resolutionParentResult: parent!.result,
    attemptRecovery: f.snapshot,
  });
  await expect(
    f.journal.prepareFollowup("merge", f.snapshot, hash("continue")),
  ).rejects.toThrow();
  await expect(
    f.journal.prepareResolution(f.snapshot, hash("retry"), "a"),
  ).rejects.toThrow();
});
it("resolution does not adopt an external operation as a Desktop merge", async () => {
  const f = await fixture();
  const token = await f.journal.prepareResolution(
    f.snapshot,
    hash("resolve-external"),
    "a",
  );
  expect(
    await f.journal.execute({
      token,
      operation: "resolve",
      intentFingerprint: hash("resolve-external"),
      capture: f.capture,
      run: f.run,
      verify: f.verify,
    }),
  ).toMatchObject({ outcome: "completed" });
  expect(await f.journal.inspect(f.snapshot)).toMatchObject({
    operation: "resolve",
    recovery: null,
  });
  await expect(
    f.journal.prepareFollowup("merge", f.snapshot, hash("continue")),
  ).rejects.toThrow();
});
it("resolution rejects a changed parent receipt between preparation and execution", async () => {
  const f = await stoppedResolutionFixture();
  const token = await f.journal.prepareResolution(
    f.snapshot,
    hash("resolve-a"),
    "a",
  );
  const filename = f.journal.recordPath(f.snapshot);
  const record = JSON.parse(await fs.readFile(filename, "utf8"));
  record.attemptFingerprint = hash("another-attempt");
  await fs.writeFile(filename, JSON.stringify(record));
  const n = f.run.mock.calls.length;
  await expect(
    f.journal.execute({
      token,
      operation: "resolve",
      intentFingerprint: hash("resolve-a"),
      capture: f.capture,
      run: f.run,
      verify: f.verify,
    }),
  ).rejects.toThrow();
  expect(f.run).toHaveBeenCalledTimes(n);
});

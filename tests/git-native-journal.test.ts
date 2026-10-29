import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
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
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    open: vi.fn(actual.open),
    unlink: vi.fn(actual.unlink),
    link: vi.fn(actual.link),
  };
});
const cleanup: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  // Factory-created vi.fn mocks are not spies; restoreAllMocks alone does not
  // undo their fault implementations between tests in Vitest 5.
  vi.mocked(acquireOwnedLock).mockRestore();
  vi.mocked(fs.open).mockRestore();
  vi.mocked(fs.rename).mockRestore();
  vi.mocked(fs.unlink).mockRestore();
  vi.mocked(fs.link).mockRestore();
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
      diagnostic: { stage: "finalize", kind: "unknown" },
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

async function discardRecoveryFixture(old = false) {
  const f = await fixture();
  await fs.writeFile(path.join(f.root, "b"), "unrelated");
  const observation = {
    head: "a".repeat(40),
    headRef: "refs/heads/main",
    index: Buffer.from(
      `100644 ${"a".repeat(40)} 0\ta\0` + `100644 ${"b".repeat(40)} 0\tb\0`,
    ),
    refs: Buffer.from("refs"),
    status: Buffer.from(" M a"),
    policyFingerprint: hash("policy"),
    controlFingerprint: hash("none"),
  };
  const owner = { ...f.snapshot.owner };
  const paths = ["a", "b"];
  const capture = () =>
    captureNativeGitState({
      root: f.root,
      paths,
      owner: async () => owner,
      observe: async () => observation,
    });
  const snapshot = await capture();
  const intentDetails = JSON.stringify(["discard", ["a"], [{ path: "a" }]]);
  const token = f.journal.prepare(
    "discard",
    snapshot,
    hash(intentDetails),
    old ? undefined : intentDetails,
  );
  await f.journal.execute({
    token,
    operation: "discard",
    intentFingerprint: hash(intentDetails),
    capture,
    run: async () => {
      throw new ByteCommandError(
        "verification",
        true,
        Buffer.alloc(0),
        Buffer.from("PRIVATE STDERR"),
        1,
      );
    },
    verify: f.verify,
  });
  const recordPath = f.journal.recordPath(snapshot);
  const read = () => f.journal.readDiscardRecovery(f.root, owner);
  const retire = async (
    fingerprint: string,
    expectedCurrent?: Awaited<ReturnType<typeof capture>>,
    mode: "retry-unchanged" | "preserve-current" = "retry-unchanged",
  ) =>
    f.journal.retireDiscardRecovery({
      root: f.root,
      owner,
      fingerprint,
      expectedCurrent: expectedCurrent ?? (await capture()),
      intentDetails,
      capture,
      mode,
    });
  return {
    ...f,
    snapshot,
    capture,
    paths,
    owner,
    observation,
    intentDetails,
    recordPath,
    read,
    retire,
  };
}
it("reads settled uncertain discard recovery without writes or process liveness guesses", async () => {
  const f = await discardRecoveryFixture();
  const entries = await fs.readdir(f.directory),
    raw = await fs.readFile(f.recordPath, "utf8"),
    pending = await fs.readFile(f.recordPath + ".pending", "utf8");
  const locks = vi.mocked(acquireOwnedLock).mock.calls.length;
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Error("must not probe PID");
  });
  expect(await f.read()).toMatchObject({
    snapshot: f.snapshot,
    intentDetails: f.intentDetails,
    state: "uncertain",
    result: { processSettled: true },
    diagnostic: { stage: "run", kind: "verification" },
  });
  expect(await fs.readdir(f.directory)).toEqual(entries);
  expect(await fs.readFile(f.recordPath, "utf8")).toBe(raw);
  expect(await fs.readFile(f.recordPath + ".pending", "utf8")).toBe(pending);
  expect(vi.mocked(acquireOwnedLock).mock.calls.length).toBe(locks);
  expect(kill).not.toHaveBeenCalled();
  expect(raw).not.toContain("PRIVATE STDERR");
});
it.each([false, true])(
  "retires original snapshot without archiving old/current bytes or mutating files (old=%s)",
  async (old) => {
    const f = await discardRecoveryFixture(old);
    const recovery = (await f.read())!;
    await fs.writeFile(path.join(f.root, "a"), "partially discarded");
    f.observation.index = Buffer.from(
      `100644 ${"c".repeat(40)} 0\ta\0` + `100644 ${"b".repeat(40)} 0\tb\0`,
    );
    const current = await f.capture(),
      calls = f.run.mock.calls.length;
    await f.retire(recovery.fingerprint, current, "preserve-current");
    expect(await fs.readdir(f.directory)).toEqual([]);
    expect(f.run).toHaveBeenCalledTimes(calls);
    expect(await fs.readFile(path.join(f.root, "a"), "utf8")).toBe(
      "partially discarded",
    );
    expect(await f.read()).toBeNull();
    await f.journal.assertAdmission(f.root, f.owner);
  },
);
it.each([
  "running",
  "unsettled",
  "other-operation",
  "foreign",
  "missing-pending",
  "orphan-pending",
  "tampered-pending",
  "unsupported",
])("blocks invalid discard recovery: %s", async (kind) => {
  const f = await discardRecoveryFixture();
  const raw = JSON.parse(await fs.readFile(f.recordPath, "utf8"));
  if (kind === "running") raw.state = "running";
  if (kind === "unsettled") raw.result.processSettled = false;
  if (kind === "other-operation") raw.operation = "merge";
  if (kind === "unsupported") raw.schemaVersion = 99;
  if (["running", "unsettled", "other-operation", "unsupported"].includes(kind))
    await fs.writeFile(f.recordPath, JSON.stringify(raw));
  if (kind === "foreign") f.owner.registryRevision = "2";
  if (kind === "missing-pending") await fs.unlink(f.recordPath + ".pending");
  if (kind === "orphan-pending") await fs.unlink(f.recordPath);
  if (kind === "tampered-pending")
    await fs.writeFile(f.recordPath + ".pending", "{}");
  await expect(f.read()).rejects.toThrow();
  await expect(f.journal.assertAdmission(f.root, f.owner)).rejects.toThrow();
});
it.each([
  "owner",
  "head",
  "headRef",
  "refs",
  "policy",
  "control",
  "unrelated-file",
  "unrelated-index",
  "intent",
  "record",
  "pending",
  "after-preview",
])("refuses discard retirement drift: %s", async (kind) => {
  const f = await discardRecoveryFixture();
  const recovery = (await f.read())!,
    preview = await f.capture();
  if (kind === "owner") f.owner.registryRevision = "2";
  if (kind === "head") f.observation.head = "b".repeat(40);
  if (kind === "headRef") f.observation.headRef = "refs/heads/other";
  if (kind === "refs") f.observation.refs = Buffer.from("changed");
  if (kind === "policy") f.observation.policyFingerprint = hash("changed");
  if (kind === "control") f.observation.controlFingerprint = hash("changed");
  if (kind === "unrelated-file")
    await fs.writeFile(path.join(f.root, "b"), "changed");
  if (kind === "unrelated-index")
    f.observation.index = Buffer.from(
      `100644 ${"a".repeat(40)} 0\ta\0` + `100644 ${"c".repeat(40)} 0\tb\0`,
    );
  if (kind === "record")
    await fs.writeFile(
      f.recordPath,
      (await fs.readFile(f.recordPath, "utf8")) + " ",
    );
  if (kind === "pending")
    await fs.writeFile(
      f.recordPath + ".pending",
      (await fs.readFile(f.recordPath + ".pending", "utf8")) + " ",
    );
  if (kind === "after-preview")
    await fs.writeFile(path.join(f.root, "a"), "late edit");
  await expect(
    f.journal.retireDiscardRecovery({
      root: f.root,
      owner: f.owner,
      fingerprint: recovery.fingerprint,
      expectedCurrent: kind === "after-preview" ? preview : await f.capture(),
      intentDetails:
        kind === "intent"
          ? JSON.stringify(["discard", ["b"], []])
          : f.intentDetails,
      capture: f.capture,
      mode: "retry-unchanged",
    }),
  ).rejects.toThrow();
  expect(await fs.readFile(f.recordPath, "utf8")).toContain('"uncertain"');
  await expect(f.journal.assertAdmission(f.root, f.owner)).rejects.toThrow();
});

it("has no discard recovery after a verified completed receipt", async () => {
  const f = await fixture();
  await f.journal.execute({
    token: f.token,
    operation: "merge",
    intentFingerprint: hash("fixture-intent"),
    capture: f.capture,
    run: f.run,
    verify: f.verify,
  });
  expect(
    await f.journal.readDiscardRecovery(f.root, f.snapshot.owner),
  ).toBeNull();
});
it.each([
  "archive-create",
  "archive-write",
  "archive-sync",
  "archive-readback",
  "pending-unlink",
  "record-unlink",
  "record-unlink-after",
  "final-sync",
  "lease-release",
])("fails closed on discard retirement receipt fault: %s", async (fault) => {
  const f = await discardRecoveryFixture(),
    recovery = (await f.read())!;
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  let archiveWritten = false,
    pendingRemoved = false,
    recordRemoved = false,
    injected = false;
  const fail = () => {
    injected = true;
    throw Object.assign(Error("injected recovery fault"), { code: "EIO" });
  };
  vi.mocked(fs.unlink).mockImplementation(async (filename) => {
    if (String(filename) === f.recordPath + ".pending") {
      if (fault === "pending-unlink" && !injected) fail();
      await actual.unlink(filename);
      pendingRemoved = true;
      return;
    }
    if (String(filename) === f.recordPath) {
      if (fault === "record-unlink" && !injected) fail();
      await actual.unlink(filename);
      recordRemoved = true;
      if (fault === "record-unlink-after" && !injected) fail();
      return;
    }
    return actual.unlink(filename);
  });
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const filename = String(args[0]),
      flags = args[1];
    const isArchive = filename.includes(".discard-recovery-");
    if (
      isArchive &&
      typeof flags === "number" &&
      flags & constants.O_CREAT &&
      fault === "archive-create" &&
      !injected
    )
      fail();
    if (
      isArchive &&
      archiveWritten &&
      fault === "archive-readback" &&
      !injected
    )
      fail();
    const handle = await actual.open(...args);
    if (isArchive && typeof flags === "number" && flags & constants.O_CREAT) {
      const write = handle.writeFile.bind(handle),
        sync = handle.sync.bind(handle);
      handle.writeFile = (async (...a: Parameters<typeof handle.writeFile>) => {
        if (fault === "archive-write" && !injected) fail();
        await write(...a);
        archiveWritten = true;
      }) as typeof handle.writeFile;
      handle.sync = async () => {
        if (fault === "archive-sync" && !injected) fail();
        await sync();
      };
    }
    if (filename === f.directory && fault === "final-sync") {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        if (recordRemoved && !injected) fail();
        await sync();
      };
    }
    return handle;
  });
  if (fault === "lease-release") {
    const { acquireOwnedLock: acquire } = await vi.importActual<
      typeof import("../src/host/owned-lock")
    >("../src/host/owned-lock");
    vi.mocked(acquireOwnedLock).mockImplementation(async (file, options) => {
      const lease = await acquire(file, options);
      return {
        release: async () => {
          await lease.release();
          if (!injected) fail();
        },
      };
    });
  }
  await expect(f.retire(recovery.fingerprint)).rejects.toThrow();
  expect(injected).toBe(true);
  vi.mocked(fs.open).mockRestore();
  vi.mocked(fs.unlink).mockRestore();
  vi.mocked(acquireOwnedLock).mockRestore();
  await expect(f.journal.assertAdmission(f.root, f.owner)).rejects.toThrow();
  expect(await fs.readFile(path.join(f.root, "a"), "utf8")).toBe("draft");
  if (pendingRemoved && fault !== "lease-release")
    expect(
      (await fs.readdir(f.directory)).some((name) =>
        name.includes(".discard-recovery-"),
      ),
    ).toBe(true);
  if (fault === "lease-release") {
    const restored = JSON.parse(await fs.readFile(f.recordPath, "utf8"));
    expect(restored.recovery).toEqual(f.snapshot);
    expect(await fs.readFile(f.recordPath + ".pending", "utf8")).toBeTruthy();
  }
});
it("resumes explicit retirement from durable receipt witness after pending-first interruption", async () => {
  const f = await discardRecoveryFixture(),
    recovery = (await f.read())!;
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.unlink).mockImplementation(async (filename) => {
    if (String(filename) === f.recordPath)
      throw Error("crash before original record removal");
    return actual.unlink(filename);
  });
  await expect(f.retire(recovery.fingerprint)).rejects.toThrow();
  vi.mocked(fs.unlink).mockRestore();
  await expect(fs.lstat(f.recordPath + ".pending")).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect((await f.read())!.fingerprint).toBe(recovery.fingerprint);
  await expect(f.journal.assertAdmission(f.root, f.owner)).rejects.toThrow();
  await fs.writeFile(path.join(f.root, "a"), "current kept after restart");
  const current = await f.capture();
  await f.retire(recovery.fingerprint, current, "preserve-current");
  expect(await f.capture()).toEqual(current);
  expect(await fs.readdir(f.directory)).toEqual([]);
  expect(await f.read()).toBeNull();
});
it("keeps blocked when a missing-pending archive witness is tampered", async () => {
  const f = await discardRecoveryFixture(),
    recovery = (await f.read())!;
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.unlink).mockImplementation(async (filename) => {
    if (String(filename) === f.recordPath) throw Error("interrupted");
    return actual.unlink(filename);
  });
  await expect(f.retire(recovery.fingerprint)).rejects.toThrow();
  vi.mocked(fs.unlink).mockRestore();
  const name = (await fs.readdir(f.directory)).find((name) =>
    name.includes(".discard-recovery-"),
  )!;
  const filename = path.join(f.directory, name),
    archive = JSON.parse(await fs.readFile(filename, "utf8"));
  archive.pendingRaw = archive.pendingRaw + " ";
  await fs.writeFile(filename, JSON.stringify(archive));
  await expect(f.read()).rejects.toThrow();
  await expect(f.retire(recovery.fingerprint)).rejects.toThrow();
});
it("does not remove a foreign repo lease, even when its PID is dead", async () => {
  const f = await discardRecoveryFixture(),
    recovery = (await f.read())!;
  const filename = f.recordPath + ".lock",
    raw = JSON.stringify({
      schemaVersion: 1,
      pid: 2147483647,
      nonce: "00000000-0000-4000-8000-000000000001",
    });
  await fs.writeFile(filename, raw, { mode: 0o600 });
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(Error("dead"), { code: "ESRCH" });
  });
  await expect(f.retire(recovery.fingerprint)).rejects.toThrow();
  expect(kill).not.toHaveBeenCalled();
  expect(await fs.readFile(filename, "utf8")).toBe(raw);
});
it("blocks real Git locks without deleting them during discard archival", async () => {
  const f = await discardRecoveryFixture(),
    recovery = (await f.read())!;
  const filename = path.join(f.root, ".git/index.lock");
  await fs.writeFile(filename, "foreign");
  await expect(f.retire(recovery.fingerprint)).rejects.toThrow();
  expect(await fs.readFile(filename, "utf8")).toBe("foreign");
});

it("preserve-current retires observed drift without claiming old success, archiving bytes or writing Git", async () => {
  const f = await discardRecoveryFixture(),
    recovery = (await f.read())!;
  f.observation.head = "c".repeat(40);
  f.observation.headRef = "refs/heads/new";
  f.observation.refs = Buffer.from("new refs");
  f.observation.policyFingerprint = hash("new policy");
  f.observation.index = Buffer.from(`100644 ${"d".repeat(40)} 0\tb\0`);
  await fs.writeFile(path.join(f.root, "b"), "edited unrelated");
  await fs.writeFile(path.join(f.root, "new"), "new draft");
  f.paths.push("new");
  const current = await f.capture();
  await expect(
    f.retire(recovery.fingerprint, current, "retry-unchanged"),
  ).rejects.toThrow();
  await f.retire(recovery.fingerprint, current, "preserve-current");
  expect(await fs.readdir(f.directory)).toEqual([]);
  expect(await f.capture()).toEqual(current);
  expect(await f.read()).toBeNull();
});
it.each(["owner", "physical", "control", "pathset"])(
  "preserve-current still rejects %s drift",
  async (kind) => {
    const f = await discardRecoveryFixture(),
      recovery = (await f.read())!;
    if (kind === "owner") f.owner.registryRevision = "changed";
    if (kind === "physical") {
      await fs.rename(
        path.join(f.root, ".git"),
        path.join(f.root, ".git-saved"),
      );
      await fs.mkdir(path.join(f.root, ".git"));
    }
    if (kind === "control")
      await fs.writeFile(path.join(f.root, ".git/MERGE_HEAD"), "active");
    if (kind === "pathset") f.paths.splice(1, 1);
    await expect(
      f.retire(recovery.fingerprint, await f.capture(), "preserve-current"),
    ).rejects.toThrow();
    expect(await fs.readFile(f.recordPath, "utf8")).toContain('"uncertain"');
  },
);

it("preserve-current accepts stable residual ORIG_HEAD and REBASE_HEAD without removing them", async () => {
  const f = await discardRecoveryFixture(),
    recovery = (await f.read())!;
  await fs.writeFile(path.join(f.root, ".git/ORIG_HEAD"), "old head");
  await fs.writeFile(path.join(f.root, ".git/REBASE_HEAD"), "residual head");
  f.observation.controlFingerprint = hash("new residual control fingerprint");
  const current = await f.capture();
  await f.retire(recovery.fingerprint, current, "preserve-current");
  expect(await f.capture()).toEqual(current);
  expect(await fs.readFile(path.join(f.root, ".git/ORIG_HEAD"), "utf8")).toBe(
    "old head",
  );
  expect(await fs.readFile(path.join(f.root, ".git/REBASE_HEAD"), "utf8")).toBe(
    "residual head",
  );
});
it.each([
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "rebase-merge",
  "rebase-apply",
  "sequencer",
  "MERGE_AUTOSTASH",
])(
  "preserve-current rejects active Git control %s without deleting it",
  async (control) => {
    const f = await discardRecoveryFixture(),
      recovery = (await f.read())!;
    const filename = path.join(f.root, ".git", control);
    if (["rebase-merge", "rebase-apply", "sequencer"].includes(control))
      await fs.mkdir(filename);
    else await fs.writeFile(filename, "active");
    await expect(
      f.retire(recovery.fingerprint, await f.capture(), "preserve-current"),
    ).rejects.toThrow();
    expect(await fs.lstat(filename)).toBeDefined();
    await expect(f.journal.assertAdmission(f.root, f.owner)).rejects.toThrow();
  },
);
it.each(["after-settled", "verify"])(
  "retains only finite safe diagnostics at %s",
  async (stage) => {
    const f = await fixture();
    const fail = async () => {
      throw Error("PRIVATE PATH /secret and stderr env=config");
    };
    await f.journal.execute({
      token: f.token,
      operation: "merge",
      intentFingerprint: hash("fixture-intent"),
      capture: f.capture,
      run: f.run,
      ...(stage === "after-settled" ? { afterSettled: fail } : {}),
      verify: stage === "verify" ? fail : f.verify,
    });
    const raw = await fs.readFile(f.journal.recordPath(f.snapshot), "utf8");
    expect(JSON.parse(raw).diagnostic).toEqual({ stage, kind: "unknown" });
    expect(raw).not.toContain("PRIVATE PATH");
    expect(raw).not.toContain("env=config");
  },
);

it("records only validated finite discard failure steps", async () => {
  const f = await fixture();
  await f.journal.execute({
    token: f.token,
    operation: "merge",
    intentFingerprint: hash("fixture-intent"),
    capture: f.capture,
    failureStep: () => "discard-index",
    run: async () => {
      throw new ByteCommandError(
        "verification",
        true,
        Buffer.alloc(0),
        Buffer.alloc(0),
      );
    },
    verify: f.verify,
  });
  expect((await f.journal.inspect(f.snapshot))?.diagnostic).toEqual({
    stage: "run",
    kind: "verification",
    step: "discard-index",
  });
});
it.each(["throw", "raw-string"])(
  "invalid failure step %s never hides primary command facts or leaks details",
  async (kind) => {
    const f = await fixture();
    await f.journal.execute({
      token: f.token,
      operation: "merge",
      intentFingerprint: hash("fixture-intent"),
      capture: f.capture,
      failureStep: (() => {
        if (kind === "throw") throw Error("PRIVATE DETAILS");
        return "PRIVATE DETAILS";
      }) as never,
      run: async () => {
        throw new ByteCommandError(
          "timeout",
          true,
          Buffer.alloc(0),
          Buffer.alloc(0),
          1,
        );
      },
      verify: f.verify,
    });
    const raw = await fs.readFile(f.journal.recordPath(f.snapshot), "utf8");
    expect(JSON.parse(raw).diagnostic).toEqual({
      stage: "run",
      kind: "timeout",
    });
    expect(JSON.parse(raw).result).toMatchObject({
      exitCode: 1,
      processSettled: true,
    });
    expect(raw).not.toContain("PRIVATE DETAILS");
  },
);

it("discard inspection remains empty and read-only before any journal exists", async () => {
  const f = await fixture();
  expect(
    await f.journal.readDiscardRecovery(f.root, f.snapshot.owner),
  ).toBeNull();
  await expect(fs.lstat(f.directory)).rejects.toMatchObject({ code: "ENOENT" });
});
it("discard inspection rejects a physical repository replacement during the read", async () => {
  const f = await discardRecoveryFixture();
  const { open } = await vi.importActual<typeof fs>("node:fs/promises");
  let replaced = false;
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    if (String(args[0]) === f.recordPath + ".pending" && !replaced) {
      replaced = true;
      await fs.rename(
        path.join(f.root, ".git"),
        path.join(f.root, ".git-saved"),
      );
      await fs.mkdir(path.join(f.root, ".git"));
    }
    return open(...args);
  });
  await expect(f.read()).rejects.toThrow();
  expect(replaced).toBe(true);
});

it("does not publish recovery bytes into a replaced journal directory", async () => {
  const f = await discardRecoveryFixture(),
    recovery = (await f.read())!,
    current = await f.capture();
  let replaced = false;
  await expect(
    f.journal.retireDiscardRecovery({
      root: f.root,
      owner: f.owner,
      fingerprint: recovery.fingerprint,
      expectedCurrent: current,
      intentDetails: f.intentDetails,
      mode: "retry-unchanged",
      capture: async () => {
        if (!replaced) {
          replaced = true;
          await fs.rename(f.directory, f.directory + "-saved");
          await fs.mkdir(f.directory, { mode: 0o700 });
          await fs.writeFile(path.join(f.directory, "foreign"), "preserve");
        }
        return f.capture();
      },
    }),
  ).rejects.toThrow();
  expect(await fs.readdir(f.directory)).toEqual(["foreign"]);
  expect(await fs.readFile(path.join(f.directory, "foreign"), "utf8")).toBe(
    "preserve",
  );
  expect(
    await fs.readFile(
      path.join(f.directory + "-saved", path.basename(f.recordPath)),
      "utf8",
    ),
  ).toContain('"uncertain"');
});

it.each(["completed", "rejected"] as const)(
  "exposes settled %s discard retained before deferred cleanup as recoverable",
  async (outcome) => {
    const f = await fixture(),
      intentDetails = JSON.stringify(["discard", ["a"], []]);
    const token = f.journal.prepare(
      "discard",
      f.snapshot,
      hash(intentDetails),
      intentDetails,
    );
    let cleanup: (() => Promise<unknown>) | undefined;
    const result = await f.journal.execute({
      token,
      operation: "discard",
      intentFingerprint: hash(intentDetails),
      capture: f.capture,
      run: async () => {
        if (outcome === "completed")
          await fs.writeFile(path.join(f.root, "a"), "restored content");
        return {
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          exitCode: outcome === "completed" ? 0 : 1,
          signal: null,
          processSettled: true,
        };
      },
      verify: async () => ({
        outcome,
        afterHead: f.snapshot.head,
        conflicts: [],
        verifiedUnrelatedData: true,
      }),
      deferRecoveryCleanup: (finish) => {
        cleanup = finish;
      },
    });
    expect(cleanup).toBeTypeOf("function");
    expect(result).toMatchObject({
      outcome,
      recovery: "retained",
      processSettled: true,
    });
    const recovery = await f.journal.readDiscardRecovery(
      f.root,
      f.snapshot.owner,
    );
    expect(recovery).toMatchObject({
      state: outcome,
      snapshot: f.snapshot,
      result: { outcome },
    });
    await expect(
      f.journal.assertAdmission(f.root, f.snapshot.owner),
    ).rejects.toThrow();
    const current = await f.capture();
    await f.journal.retireDiscardRecovery({
      root: f.root,
      owner: f.snapshot.owner,
      fingerprint: recovery!.fingerprint,
      expectedCurrent: current,
      intentDetails,
      mode: outcome === "completed" ? "preserve-current" : "retry-unchanged",
      capture: f.capture,
    });
    expect(await fs.readdir(f.directory)).toEqual([]);
    expect(await f.capture()).toEqual(current);
    expect(
      await f.journal.readDiscardRecovery(f.root, f.snapshot.owner),
    ).toBeNull();
  },
);

it.each([
  "partial-write",
  "canonical-link-before",
  "canonical-link-after",
  "prepared-unlink",
] as const)(
  "a healthy explicit retry recovers receipt publication fault %s without removing failed candidates",
  async (fault) => {
    const f = await discardRecoveryFixture(),
      recovery = (await f.read())!;
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    let injected = false;
    const fail = () => {
      injected = true;
      throw Object.assign(Error("publication fault"), { code: "EIO" });
    };
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (
        fault === "partial-write" &&
        String(args[0]).includes(".discard-recovery-") &&
        typeof args[1] === "number" &&
        args[1] & constants.O_CREAT
      ) {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = (async (
          data: Parameters<typeof handle.writeFile>[0],
        ) => {
          if (!injected) {
            await write(String(data).slice(0, 17));
            fail();
          }
          await write(data);
        }) as typeof handle.writeFile;
      }
      return handle;
    });
    vi.mocked(fs.link).mockImplementation(async (source, destination) => {
      if (String(destination).includes(".discard-recovery-") && !injected) {
        if (fault === "canonical-link-before") fail();
        if (fault === "canonical-link-after") {
          await actual.link(source, destination);
          fail();
        }
      }
      return actual.link(source, destination);
    });
    vi.mocked(fs.unlink).mockImplementation(async (filename) => {
      if (
        fault === "prepared-unlink" &&
        String(filename).includes(".discard-recovery-") &&
        String(filename).endsWith(".prepared") &&
        !injected
      )
        fail();
      return actual.unlink(filename);
    });
    await expect(f.retire(recovery.fingerprint)).rejects.toThrow();
    expect(injected).toBe(true);
    vi.mocked(fs.open).mockRestore();
    vi.mocked(fs.link).mockRestore();
    vi.mocked(fs.unlink).mockRestore();
    await expect(f.journal.assertAdmission(f.root, f.owner)).rejects.toThrow();
    const failed = (await fs.readdir(f.directory)).filter((name) =>
      name.includes(".discard-recovery-"),
    );
    const retained = new Map(
      await Promise.all(
        failed.map(
          async (name) =>
            [
              name,
              await fs.readFile(path.join(f.directory, name), "utf8"),
            ] as const,
        ),
      ),
    );
    expect((await f.read())!.fingerprint).toBe(recovery.fingerprint);
    expect(await fs.readdir(f.directory)).toContain(
      path.basename(f.recordPath) + ".pending",
    );
    await f.retire(recovery.fingerprint);
    // Failed unlinked candidates contain metadata only. Valid published receipts
    // and their exact hard-link twins are removed after successful retirement.
    const remaining = await fs.readdir(f.directory);
    expect(remaining.filter((name) => name.endsWith(".json"))).toEqual([]);
    if (fault === "partial-write")
      for (const [name, raw] of retained)
        expect(await fs.readFile(path.join(f.directory, name), "utf8")).toBe(
          raw,
        );
    expect(await f.read()).toBeNull();
    expect(await fs.readFile(path.join(f.root, "a"), "utf8")).toBe("draft");
  },
);
it("retains a legacy incomplete canonical witness while publishing a complete alternate on healthy retry", async () => {
  const f = await discardRecoveryFixture(),
    recovery = (await f.read())!;
  const raw = await fs.readFile(f.recordPath, "utf8"),
    s = await fs.lstat(f.recordPath, { bigint: true });
  const identity = [
    s.dev,
    s.ino,
    s.mode,
    s.nlink,
    s.size,
    s.mtimeNs,
    s.ctimeNs,
  ].join(":");
  const canonical =
    f.recordPath +
    `.discard-recovery-${recovery.id}-${hash(JSON.stringify([raw, identity]))}.json`;
  await fs.writeFile(canonical, '{"schemaVersion":', { mode: 0o600 });
  expect((await f.read())!.fingerprint).toBe(recovery.fingerprint);
  await f.retire(recovery.fingerprint);
  expect(await fs.readdir(f.directory)).toEqual([path.basename(canonical)]);
  expect(await fs.readFile(canonical, "utf8")).toBe('{"schemaVersion":');
  expect(await f.read()).toBeNull();
});

it("reads a complete nlink-two receipt witness after interruption without cleaning its pinned prepared twin", async () => {
  const f = await discardRecoveryFixture(),
    recovery = (await f.read())!;
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  let archivePath = "";
  vi.mocked(fs.link).mockImplementation(async (source, destination) => {
    await actual.link(source, destination);
    if (String(destination).includes(".discard-recovery-")) {
      archivePath = String(destination);
      throw Error("crash immediately after exclusive publication");
    }
  });
  await expect(f.retire(recovery.fingerprint)).rejects.toThrow();
  vi.mocked(fs.link).mockRestore();
  expect((await fs.lstat(archivePath)).nlink).toBe(2);
  await fs.unlink(f.recordPath + ".pending"); // Restart after a pending-first retirement.
  const entries = await fs.readdir(f.directory),
    stageRaw = await fs.readFile(archivePath + ".prepared", "utf8");
  vi.mocked(fs.unlink).mockClear();
  expect((await f.read())!.fingerprint).toBe(recovery.fingerprint);
  expect(await fs.readdir(f.directory)).toEqual(entries);
  expect(await fs.readFile(archivePath + ".prepared", "utf8")).toBe(stageRaw);
  expect(fs.unlink).not.toHaveBeenCalled();
  await expect(f.journal.assertAdmission(f.root, f.owner)).rejects.toThrow();
  await f.retire(recovery.fingerprint);
  await expect(fs.lstat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.lstat(archivePath + ".prepared")).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await f.read()).toBeNull();
});
it("rejects a published receipt with an unexpected third hard link and never removes it", async () => {
  const f = await discardRecoveryFixture(),
    recovery = (await f.read())!;
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  let archivePath = "";
  vi.mocked(fs.link).mockImplementation(async (source, destination) => {
    await actual.link(source, destination);
    if (String(destination).includes(".discard-recovery-")) {
      archivePath = String(destination);
      throw Error("publication interruption");
    }
  });
  await expect(f.retire(recovery.fingerprint)).rejects.toThrow();
  vi.mocked(fs.link).mockRestore();
  const foreign = path.join(f.directory, "foreign-link");
  await fs.link(archivePath, foreign);
  const raw = await fs.readFile(foreign, "utf8");
  await fs.unlink(f.recordPath + ".pending");
  await expect(f.read()).rejects.toThrow();
  await expect(f.retire(recovery.fingerprint)).rejects.toThrow();
  expect((await fs.stat(foreign)).nlink).toBe(3);
  expect(await fs.readFile(foreign, "utf8")).toBe(raw);
});
it("retains invalid UTF-8 legacy canonical bytes without treating them as recovery proof", async () => {
  const f = await discardRecoveryFixture(),
    recovery = (await f.read())!;
  const raw = await fs.readFile(f.recordPath, "utf8"),
    s = await fs.lstat(f.recordPath, { bigint: true });
  const identity = [
    s.dev,
    s.ino,
    s.mode,
    s.nlink,
    s.size,
    s.mtimeNs,
    s.ctimeNs,
  ].join(":");
  const canonical =
      f.recordPath +
      `.discard-recovery-${recovery.id}-${hash(JSON.stringify([raw, identity]))}.json`,
    bytes = Buffer.from([0x7b, 0x22, 0xe2, 0x82]);
  await fs.writeFile(canonical, bytes, { mode: 0o600 });
  expect((await f.read())!.fingerprint).toBe(recovery.fingerprint);
  await f.retire(recovery.fingerprint);
  expect(await fs.readdir(f.directory)).toEqual([path.basename(canonical)]);
  expect(await fs.readFile(canonical)).toEqual(bytes);
  expect(await f.read()).toBeNull();
});

it("settled discard retirement leaves no persistent content archives", async () => {
  const f = await discardRecoveryFixture();
  const recovery = (await f.read())!;
  const before = await f.capture();
  await f.retire(recovery.fingerprint);
  expect(await fs.readdir(f.directory)).toEqual([]);
  expect(await f.capture()).toEqual(before);
  expect(await f.read()).toBeNull();
  await f.journal.assertAdmission(f.root, f.owner);
});

it("interrupted retirement persists only bounded metadata, never old or current file/index bytes", async () => {
  const f = await discardRecoveryFixture();
  const recovery = (await f.read())!;
  await fs.writeFile(path.join(f.root, "a"), "CURRENT-PRIVATE-CONTENT");
  const current = await f.capture();
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.unlink).mockImplementation(async (filename) => {
    if (String(filename) === f.recordPath)
      throw Error("interrupted retirement");
    return actual.unlink(filename);
  });
  await expect(
    f.retire(recovery.fingerprint, current, "preserve-current"),
  ).rejects.toThrow();
  vi.mocked(fs.unlink).mockRestore();
  const names = (await fs.readdir(f.directory)).filter((n) =>
    n.includes(".discard-recovery-"),
  );
  expect(names).toHaveLength(1);
  const raw = await fs.readFile(path.join(f.directory, names[0]), "utf8");
  expect(raw.length).toBeLessThan(4096);
  expect(JSON.parse(raw)).toMatchObject({
    schemaVersion: 2,
    kind: "discard-retirement",
    currentRevision: current.revision,
  });
  for (const snapshot of [f.snapshot, current]) {
    expect(raw).not.toContain(snapshot.indexData);
    for (const file of snapshot.files)
      if (file.data) expect(raw).not.toContain(file.data);
  }
  expect(raw).not.toContain("CURRENT-PRIVATE-CONTENT");
  expect((await f.read())!.fingerprint).toBe(recovery.fingerprint);
});

it("resumes a legacy content archive witness without copying or deleting its sole historical bytes", async () => {
  const f = await discardRecoveryFixture();
  const recovery = (await f.read())!;
  const recordRaw = await fs.readFile(f.recordPath, "utf8");
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.unlink).mockImplementation(async (filename) => {
    if (String(filename) === f.recordPath)
      throw Error("interrupted retirement");
    return actual.unlink(filename);
  });
  await expect(f.retire(recovery.fingerprint)).rejects.toThrow();
  vi.mocked(fs.unlink).mockRestore();
  const name = (await fs.readdir(f.directory)).find((n) =>
    n.includes(".discard-recovery-"),
  )!;
  const filename = path.join(f.directory, name);
  const receipt = JSON.parse(await fs.readFile(filename, "utf8"));
  const legacy = JSON.stringify({
    schemaVersion: 1,
    kind: "discard-recovery",
    recordRaw,
    recordIdentity: receipt.recordIdentity,
    pendingRaw: receipt.pendingRaw,
    pendingIdentity: receipt.pendingIdentity,
    directoryIdentity: receipt.directoryIdentity,
    fingerprint: receipt.fingerprint,
    intentDetails: f.intentDetails,
    mode: receipt.mode,
    current: f.snapshot,
  });
  await fs.writeFile(filename, legacy);
  expect((await f.read())!.fingerprint).toBe(recovery.fingerprint);
  await f.retire(recovery.fingerprint);
  expect(await fs.readdir(f.directory)).toEqual([name]);
  expect(await fs.readFile(filename, "utf8")).toBe(legacy);
  expect(await f.read()).toBeNull();
  await f.journal.assertAdmission(f.root, f.owner);
});

it.each(["before", "after"])(
  "retirement receipt cleanup fault %s unlink retains the original fence and permits a fresh verified retry",
  async (when) => {
    const f = await discardRecoveryFixture();
    const recovery = (await f.read())!;
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    let injected = false;
    vi.mocked(fs.unlink).mockImplementation(async (filename) => {
      if (
        String(filename).includes(".discard-recovery-") &&
        String(filename).endsWith(".json") &&
        !injected
      ) {
        injected = true;
        if (when === "after") await actual.unlink(filename);
        throw Error("receipt cleanup failed");
      }
      return actual.unlink(filename);
    });
    await expect(f.retire(recovery.fingerprint)).rejects.toThrow();
    vi.mocked(fs.unlink).mockRestore();
    expect(injected).toBe(true);
    await expect(f.journal.assertAdmission(f.root, f.owner)).rejects.toThrow();
    expect(
      JSON.parse(await fs.readFile(f.recordPath, "utf8")).recovery,
    ).toEqual(f.snapshot);
    expect(await fs.readFile(path.join(f.root, "a"), "utf8")).toBe("draft");
    const fresh = (await f.read())!;
    await f.retire(fresh.fingerprint);
    expect(await f.read()).toBeNull();
    await f.journal.assertAdmission(f.root, f.owner);
    // No old/current bytes can survive in a disposable receipt left by a fault.
    for (const n of await fs.readdir(f.directory)) {
      const raw = await fs.readFile(path.join(f.directory, n), "utf8");
      expect(raw.length).toBeLessThan(8192);
      expect(raw).not.toContain(Buffer.from("draft").toString("base64"));
    }
  },
);

it.each(["recordHash", "intentFingerprint", "currentRevision"])(
  "does not authorize pending-less retirement from a tampered retry receipt %s",
  async (field) => {
    const f = await discardRecoveryFixture();
    const recovery = (await f.read())!;
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.unlink).mockImplementation(async (filename) => {
      if (String(filename) === f.recordPath) throw Error("interruption");
      return actual.unlink(filename);
    });
    await expect(f.retire(recovery.fingerprint)).rejects.toThrow();
    vi.mocked(fs.unlink).mockRestore();
    const name = (await fs.readdir(f.directory)).find((n) =>
      n.includes(".discard-recovery-"),
    )!;
    const filename = path.join(f.directory, name);
    const value = JSON.parse(await fs.readFile(filename, "utf8"));
    value[field] = "0".repeat(64);
    await fs.writeFile(filename, JSON.stringify(value));
    await expect(f.read()).rejects.toThrow();
    await expect(f.retire(recovery.fingerprint)).rejects.toThrow();
    expect(await fs.readFile(path.join(f.root, "a"), "utf8")).toBe("draft");
  },
);

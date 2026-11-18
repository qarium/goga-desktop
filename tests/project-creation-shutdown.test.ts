import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { ProjectCreationCoordinator } from "../src/host/project-creation";
import { ByteCommandError, type Runner } from "../src/host/process";
import { ShutdownCoordinator } from "../src/main/shutdown-coordinator";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const root = await mkdtemp("/private/tmp/goga-creation-shutdown-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dispose = vi.fn(async () => {});
  const commandBytes = vi.fn(async () => {
    throw new ByteCommandError(
      "timeout",
      false,
      Buffer.alloc(0),
      Buffer.alloc(0),
    );
  });
  const register = vi.fn(async (folder: string) => ({
    id: "created",
    path: folder,
    name: "Synthetic",
  }));
  const creator = new ProjectCreationCoordinator({
    runner: { dispose, commandBytes } as unknown as Runner,
    home: root,
    register,
    progress: () => {},
  });
  return { creator, dispose, commandBytes, register, root };
}

it("allows an empty disposed participant to prepare and release again without reopening creation", async () => {
  const f = await fixture();
  await f.creator.dispose();
  const lease = await f.creator.prepareShutdown();
  expect(lease.items).toEqual([]);
  expect(lease.requiresConfirmation).toBe(false);
  lease.validate();
  await lease.stop();
  expect(lease.remaining()).toEqual([]);
  lease.release();
  const retry = await f.creator.prepareShutdown();
  retry.release();
  expect(
    await f.creator.create({
      id: "fresh",
      mode: "empty",
      parent: f.root,
      name: "must-not-create",
      git: false,
    }),
  ).toMatchObject({ status: "error" });
  expect(f.commandBytes).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
});

it("retries app shutdown after creation is disposed and a later finalization step fails", async () => {
  const f = await fixture();
  let attempts = 0;
  const confirm = vi.fn(async () => true);
  const shutdown = new ShutdownCoordinator({
    participants: [{ prepare: () => f.creator.prepareShutdown() }],
    confirm,
    finalize: async () => {
      await f.creator.dispose();
      if (++attempts === 1) throw Error("synthetic-later-resource-failure");
    },
  });
  expect((await shutdown.close()).status).toBe("failed");
  expect(await shutdown.close()).toMatchObject({
    status: "success",
    inventoryComplete: true,
    remaining: [],
  });
  expect(attempts).toBe(2);
  expect(confirm).not.toHaveBeenCalled();
  expect(f.commandBytes).not.toHaveBeenCalled();
});

it("retries without repeating an already completed creation stop when a later participant fails", async () => {
  const f = await fixture();
  expect(
    await f.creator.create({
      id: "unsettled",
      mode: "empty",
      parent: f.root,
      name: "synthetic",
      git: true,
    }),
  ).toMatchObject({ status: "error" });
  const stop = vi.fn(async () => {});
  stop.mockRejectedValueOnce(Error("synthetic-stop-failure"));
  const confirm = vi.fn(async () => true);
  const finalize = vi.fn(async () => {});
  const shutdown = new ShutdownCoordinator({
    participants: [
      { prepare: () => f.creator.prepareShutdown() },
      {
        prepare: async () => ({
          items: [],
          requiresConfirmation: false,
          validate() {},
          stop,
          remaining: () => [],
          release() {},
        }),
      },
    ],
    confirm,
    finalize,
  });
  expect(await shutdown.close()).toMatchObject({
    status: "partial",
    remaining: [],
  });
  expect(f.dispose).toHaveBeenCalledTimes(1);
  expect(await shutdown.close()).toMatchObject({
    status: "success",
    remaining: [],
  });
  expect(f.dispose).toHaveBeenCalledTimes(1);
  expect(f.commandBytes).toHaveBeenCalledTimes(1);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(finalize).toHaveBeenCalledTimes(1);
});

it("a disposed participant still exposes unsettled work and refuses unconfirmed cleanup", async () => {
  const f = await fixture();
  await f.creator.create({
    id: "unsettled",
    mode: "empty",
    parent: f.root,
    name: "synthetic",
    git: true,
  });
  f.dispose.mockRejectedValueOnce(Error("still-live"));
  await expect(f.creator.dispose()).rejects.toThrow("still-live");
  const lease = await f.creator.prepareShutdown();
  expect(lease.items.map((item) => item.id)).toEqual([
    "project-create:unsettled",
  ]);
  expect(lease.requiresConfirmation).toBe(true);
  f.dispose.mockRejectedValueOnce(Error("still-live"));
  await expect(lease.stop()).rejects.toThrow("still-live");
  expect(lease.remaining()).toEqual(["project-create:unsettled"]);
  lease.release();
  const retry = await f.creator.prepareShutdown();
  await retry.stop();
  expect(retry.remaining()).toEqual([]);
  retry.release();
  expect(f.commandBytes).toHaveBeenCalledTimes(1);
});

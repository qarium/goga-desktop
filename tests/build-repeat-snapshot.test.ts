import { describe, expect, it } from "vitest";
import { buildRepeatSnapshotSchema } from "../src/shared/build-repeat";
import { createBuildRepeatSnapshot } from "../src/host/build-repeat";

const owner = {
  projectId: "p",
  year: "2026",
  topic: "topic",
  branch: "topic",
  contextId: "ctx-" + "a".repeat(64),
  revision: "a6814931-f12f-4bf0-ae2f-cce2f9e47c70",
};

describe("safe build repeat snapshot", () => {
  it("restores every non-secret option but never any env value or any part of the proxy URL", () => {
    const options = {
      workflow: "quality",
      profile: "fast",
      sessionTimeout: "1h30m",
      idleTimeout: "10m",
      wait: "5m",
      maxIterations: 7,
      reviewPatience: 0,
      baseRef: "origin/main",
      addHost: [{ host: "local.test", ip: "host-gateway" }],
      clean: true,
      update: true,
      skipReview: false,
      skipManifestCheck: true,
    };
    const snapshot = createBuildRepeatSnapshot(
      {
        ...options,
        env: [
          { key: "TOKEN", value: "SENSITIVE_ENV" },
          { key: "PUBLIC_LOOKING", value: "ALSO_SENSITIVE" },
        ],
        proxy: "https://user:password@secret-proxy.example:8443/private",
      },
      { owner, sourceRunId: "run-1" },
    );
    expect(snapshot).toEqual({
      options,
      requiredEnvKeys: ["TOKEN", "PUBLIC_LOOKING"],
      requiresProxy: true,
      owner,
      sourceRunId: "run-1",
    });
    const durable = JSON.stringify(snapshot);
    for (const value of [
      "SENSITIVE_ENV",
      "ALSO_SENSITIVE",
      "https",
      "user",
      "password",
      "secret-proxy.example",
      "/private",
    ])
      expect(durable).not.toContain(value);
  });

  it("uses a strict structured allowlist, rejects embedded secrets and detached owner metadata", () => {
    const snapshot = createBuildRepeatSnapshot({
      profile: "",
      env: [{ key: "TOKEN", value: "" }],
    });
    expect(snapshot).toEqual({
      options: { profile: "" },
      requiredEnvKeys: ["TOKEN"],
      requiresProxy: false,
    });
    for (const poisoned of [
      { ...snapshot, env: [{ key: "TOKEN", value: "secret" }] },
      { ...snapshot, options: { proxy: "https://secret.example" } },
      { ...snapshot, options: { env: [{ key: "TOKEN", value: "secret" }] } },
      { ...snapshot, options: { arbitrary: "secret" } },
      {
        ...snapshot,
        options: {
          addHost: [{ host: "test", ip: "127.0.0.1", token: "secret" }],
        },
      },
      { ...snapshot, owner: { ...owner, path: "/unsafe" } },
      { ...snapshot, requiredEnvKeys: ["TOKEN=secret"] },
    ])
      expect(buildRepeatSnapshotSchema.safeParse(poisoned).success).toBe(false);
  });

  it("takes an immutable detached projection and deduplicates required env key names", () => {
    const options = {
      addHost: [{ host: "test", ip: "127.0.0.1" }],
      env: [
        { key: "TOKEN", value: "first" },
        { key: "TOKEN", value: "second" },
      ],
    };
    const snapshot = createBuildRepeatSnapshot(options, { owner });
    options.addHost[0].host = "changed";
    expect(snapshot.options.addHost?.[0].host).toBe("test");
    expect(snapshot.owner).not.toBe(owner);
    expect(snapshot.requiredEnvKeys).toEqual(["TOKEN"]);
  });
});

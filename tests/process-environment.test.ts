import { describe, expect, it } from "vitest";
import { childEnvironment } from "../src/host/process-environment";
import {
  withPrivateGitReadScope,
  withGitPolicyCaptureScope,
} from "../src/host/git-private-read-scope";
import {
  withTrustedGitIndex,
  withPrivateGitIndexWrite,
  withNativeGitIndex,
  withNativeGitObjects,
} from "../src/host/git-index-scope";
import { withOfflineGitReadScope } from "../src/host/read-scope";
import { withNativeGitPolicy } from "../src/host/git-native-policy";

it("native remote policy cannot weaken an enclosing offline read capability", () => {
  const env = withOfflineGitReadScope(() =>
    withNativeGitPolicy("remote", () =>
      childEnvironment({ GIT_ALLOW_PROTOCOL: "https" }),
    ),
  );
  expect(env.GIT_ALLOW_PROTOCOL).toBe("");
});

it("native policy cannot reintroduce the live index into a private read", () => {
  const env = withTrustedGitIndex(
    "/private/tmp/repo/.git/goga-commit-00000000-0000-0000-0000-000000000000/index",
    () =>
      withPrivateGitReadScope(() =>
        withNativeGitPolicy("local-read", () => childEnvironment({})),
      ),
  );
  expect(env.GIT_INDEX_FILE).toBeUndefined();
  expect(env.GIT_ATTR_NOSYSTEM).toBe("1");
});

describe("private Git read environment", () => {
  it("overrides inherited, default and explicit configuration/attribute redirects without changing the ordinary environment", () => {
    const hostile = {
      GIT_CONFIG_GLOBAL: "/ambient/config",
      GIT_CONFIG: "/ambient/other",
      GIT_NAMESPACE: "ambient",
      GIT_REPLACE_REF_BASE: "refs/ambient",
      GIT_CONFIG_SYSTEM: "/ambient/system",
      GIT_CONFIG_NOSYSTEM: "0",
      GIT_ATTR_NOSYSTEM: "0",
      GIT_ATTR_SOURCE: "refs/heads/hostile",
      GIT_ATTR_GLOBAL: "/ambient/attributes",
      GIT_ATTR_SYSTEM: "/ambient/system-attributes",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "filter.hostile.process",
      GIT_CONFIG_VALUE_0: "not-executed",
      GIT_NO_LAZY_FETCH: "0",
      GIT_ALLOW_PROTOCOL: "all",
    };
    const original = { ...hostile };
    const result = withPrivateGitReadScope(() =>
      childEnvironment(hostile, hostile, hostile),
    );
    expect(result).toMatchObject({
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_ATTR_GLOBAL: "/dev/null",
      GIT_ATTR_SYSTEM: "/dev/null",
      GIT_NO_LAZY_FETCH: "1",
      GIT_ALLOW_PROTOCOL: "",
    });
    expect(result.GIT_ATTR_SOURCE).toBeUndefined();
    expect(result.GIT_CONFIG).toBeUndefined();
    expect(result.GIT_NAMESPACE).toBeUndefined();
    expect(result.GIT_REPLACE_REF_BASE).toBeUndefined();
    expect(result.GIT_CONFIG_COUNT).toBeUndefined();
    expect(hostile).toEqual(original);
    expect(childEnvironment(hostile).GIT_CONFIG_GLOBAL).toBe("/ambient/config");
  });

  it("cannot inherit a trusted source index into private metadata reads", () => {
    const result = withTrustedGitIndex(
      "/private/tmp/repo/.git/goga-commit-00000000-0000-0000-0000-000000000000/index",
      () => withPrivateGitReadScope(() => childEnvironment({})),
    );
    expect(result.GIT_INDEX_FILE).toBeUndefined();
  });

  it("allows only explicit private staging to write its validated index and source object store", async () => {
    const index =
      "/private/tmp/repo/.git/goga-commit-00000000-0000-0000-0000-000000000000/index";
    const hostile = {
      GIT_INDEX_FILE: "/foreign/index",
      GIT_OBJECT_DIRECTORY: "/foreign/objects",
      GIT_CONFIG_GLOBAL: "/foreign/config",
    };
    const [staging, read, ordinary] = await Promise.all([
      withPrivateGitReadScope(() =>
        withPrivateGitIndexWrite(() =>
          withTrustedGitIndex(index, async () => {
            await Promise.resolve();
            return childEnvironment(hostile, hostile, hostile);
          }),
        ),
      ),
      withPrivateGitReadScope(() =>
        withTrustedGitIndex(index, async () => {
          await Promise.resolve();
          return childEnvironment(hostile);
        }),
      ),
      Promise.resolve().then(() => childEnvironment(hostile)),
    ]);
    expect(staging).toMatchObject({
      GIT_INDEX_FILE: index,
      GIT_OBJECT_DIRECTORY: "/private/tmp/repo/.git/objects",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_ALLOW_PROTOCOL: "",
    });
    for (const env of [
      read,
      ordinary,
      withPrivateGitReadScope(() =>
        withPrivateGitIndexWrite(() => childEnvironment(hostile)),
      ),
    ]) {
      expect(env.GIT_INDEX_FILE).toBeUndefined();
      expect(env.GIT_OBJECT_DIRECTORY).toBeUndefined();
    }
    expect(childEnvironment(hostile).GIT_CONFIG_GLOBAL).toBe(
      hostile.GIT_CONFIG_GLOBAL,
    );
  });

  it("captures native policy without leaking legacy GIT_CONFIG clearing to concurrent ordinary children", async () => {
    const inherited = {
      GIT_CONFIG: "/ambient/legacy",
      GIT_CONFIG_GLOBAL: "/ambient/global",
      GIT_CONFIG_SYSTEM: "/ambient/system",
      GIT_NAMESPACE: "preserved",
    };
    const [captured, ordinary] = await Promise.all([
      withGitPolicyCaptureScope(async () => {
        await Promise.resolve();
        return childEnvironment(inherited, inherited, inherited);
      }),
      Promise.resolve().then(() => childEnvironment(inherited)),
    ]);
    expect(captured.GIT_CONFIG).toBeUndefined();
    expect(captured.GIT_CONFIG_GLOBAL).toBe(inherited.GIT_CONFIG_GLOBAL);
    expect(captured.GIT_CONFIG_SYSTEM).toBe(inherited.GIT_CONFIG_SYSTEM);
    expect(captured.GIT_NAMESPACE).toBe(inherited.GIT_NAMESPACE);
    expect(ordinary).toMatchObject(inherited);
    expect(childEnvironment(inherited)).toMatchObject(inherited);
  });

  it.each([
    ["capture", withGitPolicyCaptureScope],
    ["private", withPrivateGitReadScope],
    ["offline", withOfflineGitReadScope],
  ] as const)(
    "suppresses all trace destinations in %s scope without changing concurrent ordinary children",
    async (_name, scope) => {
      const hostile = {
        GIT_TRACE: "/ambient/trace",
        GIT_TRACE_SETUP: "/ambient/setup",
        GIT_TRACE_PERFORMANCE: "/ambient/performance",
        GIT_TRACE_PACKET: "/ambient/packet",
        GIT_TRACE_PACK_ACCESS: "/ambient/pack",
        GIT_TRACE_CURL: "/ambient/curl",
        GIT_TRACE2: "/ambient/trace2",
        GIT_TRACE2_EVENT: "/ambient/event",
        GIT_TRACE2_PERF: "/ambient/perf",
        GIT_TRACE_FUTURE: "/ambient/future",
      };
      const original = { ...hostile };
      const [protectedEnv, ordinaryEnv] = await Promise.all([
        scope(async () => {
          await Promise.resolve();
          return childEnvironment(hostile, hostile, hostile);
        }),
        Promise.resolve().then(() =>
          childEnvironment(hostile, hostile, hostile),
        ),
      ]);
      expect(
        Object.fromEntries(
          Object.entries(protectedEnv).filter(([key]) =>
            key.startsWith("GIT_TRACE"),
          ),
        ),
      ).toEqual({
        GIT_TRACE2: "0",
        GIT_TRACE2_EVENT: "0",
        GIT_TRACE2_PERF: "0",
      });
      expect(ordinaryEnv).toMatchObject(hostile);
      expect(childEnvironment(hostile)).toMatchObject(hostile);
      expect(hostile).toEqual(original);
      await expect(
        scope(async () => {
          throw Error("fixture failure");
        }),
      ).rejects.toThrow("fixture failure");
      expect(childEnvironment(hostile)).toMatchObject(hostile);
    },
  );

  it.each([undefined, "0", "1"])(
    "preserves native system-attributes policy %s only in the legacy private scope",
    async (attributePolicy) => {
      const inherited = {
        GIT_ATTR_NOSYSTEM: attributePolicy,
        GIT_CONFIG_GLOBAL: "/ambient/config",
        GIT_CONFIG_SYSTEM: "/ambient/system",
        GIT_ATTR_SOURCE: "refs/heads/foreign",
        GIT_TRACE: "/ambient/trace",
      };
      const [legacy, modern, ordinary] = await Promise.all([
        withPrivateGitReadScope(
          async () => {
            await Promise.resolve();
            return childEnvironment(inherited, inherited, inherited);
          },
          { nativeAttributes: true },
        ),
        withPrivateGitReadScope(async () => {
          await Promise.resolve();
          return childEnvironment(inherited, inherited, inherited);
        }),
        Promise.resolve().then(() => childEnvironment(inherited)),
      ]);
      expect(legacy.GIT_ATTR_NOSYSTEM).toBe(attributePolicy);
      expect(modern.GIT_ATTR_NOSYSTEM).toBe("1");
      expect(legacy.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      expect(legacy.GIT_CONFIG_SYSTEM).toBe("/dev/null");
      expect(legacy.GIT_ATTR_SOURCE).toBeUndefined();
      expect(legacy.GIT_TRACE).toBeUndefined();
      expect(legacy.GIT_TRACE2_EVENT).toBe("0");
      expect(legacy.GIT_NO_LAZY_FETCH).toBe("1");
      expect(legacy.GIT_ALLOW_PROTOCOL).toBe("");
      expect(ordinary).toMatchObject(inherited);
      expect(childEnvironment(inherited)).toMatchObject(inherited);
    },
  );

  it("does not leak isolation into concurrent ordinary child processes", async () => {
    const inherited = { GIT_CONFIG_GLOBAL: "/ambient/config" };
    const [privateEnv, ordinaryEnv] = await Promise.all([
      withPrivateGitReadScope(async () => {
        await Promise.resolve();
        return childEnvironment(inherited);
      }),
      Promise.resolve().then(() => childEnvironment(inherited)),
    ]);
    expect(privateEnv.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(ordinaryEnv.GIT_CONFIG_GLOBAL).toBe("/ambient/config");
  });
});

it("freezes config for native private abort without changing index, attributes or ordinary shells", async () => {
  const { withFrozenGitConfigScope } =
    await import("../src/host/git-private-read-scope");
  const env = {
    GIT_CONFIG_GLOBAL: "/test/global",
    GIT_CONFIG_SYSTEM: "/test/system",
    GIT_CONFIG: "/test/redirect",
    GIT_ATTR_GLOBAL: "/test/attributes",
    GIT_TRACE: "/test/trace",
  };
  const index =
    "/tmp/repo/.git/goga-abort-00000000-0000-4000-8000-000000000001/index";
  const result = withFrozenGitConfigScope(() =>
    withTrustedGitIndex(index, () => childEnvironment(env, env, env)),
  );
  expect(result.GIT_INDEX_FILE).toBe(index);
  expect(result.GIT_CONFIG_GLOBAL).toBe("/dev/null");
  expect(result.GIT_CONFIG_SYSTEM).toBe("/dev/null");
  expect(result.GIT_CONFIG_NOSYSTEM).toBe("1");
  expect(result.GIT_CONFIG).toBeUndefined();
  expect(result.GIT_ATTR_GLOBAL).toBe("/test/attributes");
  expect(result.GIT_OBJECT_DIRECTORY).toBeUndefined();
  expect(result.GIT_TRACE).toBeUndefined();
  expect(childEnvironment(env).GIT_CONFIG_GLOBAL).toBe("/test/global");
});

it("scopes native object writes to the minted index without leaking redirects", async () => {
  const index = "/private/tmp/goga-native-index-abcdef/index",
    objects = "/private/tmp/repo/.git/objects";
  const hostile = {
    GIT_INDEX_FILE: "/foreign/index",
    GIT_OBJECT_DIRECTORY: "/foreign/objects",
  };
  const scoped = withNativeGitIndex(index, () =>
    withNativeGitObjects(objects, () =>
      withNativeGitPolicy("local-write", () =>
        childEnvironment(hostile, hostile, hostile),
      ),
    ),
  );
  expect(scoped.GIT_INDEX_FILE).toBe(index);
  expect(scoped.GIT_OBJECT_DIRECTORY).toBe(objects);
  expect(scoped.GIT_ALLOW_PROTOCOL).toBe("");
  expect(childEnvironment(hostile).GIT_OBJECT_DIRECTORY).toBeUndefined();
  expect(() => withNativeGitObjects(objects, () => {})).toThrow();
  expect(() =>
    withNativeGitIndex(index, () =>
      withPrivateGitReadScope(() => childEnvironment({})),
    ),
  ).toThrow();
});

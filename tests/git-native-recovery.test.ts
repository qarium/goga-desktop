import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  captureNativeIndexRecovery,
  readNativeGitBlobBodies,
  readNativeGitBlobStates,
} from "../src/host/git-native-recovery";
import type { NativeGitRequest } from "../src/host/git-native-policy";
import type { ByteCommandResult } from "../src/host/process";

const LIMIT = 8 * 1024 * 1024;
const blob = (data: Buffer, algorithm = "sha1") => ({
  oid: createHash(algorithm)
    .update(`blob ${data.length}\0`)
    .update(data)
    .digest("hex"),
  data,
});
type Blob = ReturnType<typeof blob>;
const result = (stdout: Buffer): ByteCommandResult => ({
  stdout,
  stderr: Buffer.alloc(0),
  exitCode: 0,
  signal: null,
  processSettled: true,
});
function fixture(objects: Blob[]) {
  const calls: NativeGitRequest[] = [];
  let transform = (_request: NativeGitRequest, response: ByteCommandResult) =>
    response;
  const client = {
    run: async (request: NativeGitRequest) => {
      calls.push(request);
      let response: Buffer;
      if (request.command === "ls-files") response = Buffer.from("H a\0");
      else {
        const args = request.args ?? [];
        const requested = request.stdin
          ?.toString("ascii")
          .trim()
          .split("\n") ?? [args[1]];
        response = Buffer.concat(
          requested.map((oid) => {
            const o = objects.find((o) => o.oid === oid);
            if (!o) return Buffer.from(`${oid} missing\n`);
            const header = Buffer.from(`${oid} blob ${o.data.length}\n`);
            return args[0] === "-s"
              ? Buffer.from(`${o.data.length}\n`)
              : args[0] === "blob"
                ? o.data
                : args[0] === "--batch-check"
                  ? header
                  : Buffer.concat([header, o.data, Buffer.from("\n")]);
          }),
        );
      }
      return transform(request, result(response));
    },
  };
  return {
    client,
    calls,
    index: Buffer.from(
      objects.map((o, i) => `100644 ${o.oid} ${i % 4}\tp${i}\0`).join(""),
    ),
    paths: objects.map((_o, i) => `p${i}`),
    transform: (fn: typeof transform) => {
      transform = fn;
    },
  };
}
const expected = (o: Blob) => ({
  oid: o.oid,
  data: o.data.toString("base64"),
  checksum: createHash("sha256").update(o.data).digest("hex"),
});
const options = { freshBatch: true as const, flags: Buffer.from("h a\0S b\0") };

it.each(["sha1", "sha256"])(
  "fresh %s batch preserves empty and arbitrary binary bodies, unique sorted OIDs and stage/path duplicates",
  async (algorithm) => {
    const objects = [
      blob(Buffer.from([239, 187, 191, 255, 0, 10, 13, 128, 10]), algorithm),
      blob(Buffer.alloc(0), algorithm),
    ];
    const f = fixture([...objects, objects[0], objects[1]]);
    const recovery = await captureNativeIndexRecovery(
      f.client,
      f.index,
      f.paths,
      options,
    );
    const sorted = [...objects].sort((a, b) => a.oid.localeCompare(b.oid));
    expect(recovery).toEqual({
      flags: options.flags.toString("base64"),
      objects: sorted.map(expected),
    });
    expect(f.calls.map((c) => c.args)).toEqual([
      ["--batch-check"],
      ["--batch"],
    ]);
    expect(
      f.calls.every((c) =>
        c.stdin?.equals(
          Buffer.from(sorted.map((o) => o.oid).join("\n") + "\n"),
        ),
      ),
    ).toBe(true);
  },
);
it("keeps legacy scalar reads and fresh flags as the default provider", async () => {
  const o = blob(Buffer.from("legacy")),
    f = fixture([o]);
  expect(await captureNativeIndexRecovery(f.client, f.index, f.paths)).toEqual({
    flags: Buffer.from("H a\0").toString("base64"),
    objects: [expected(o)],
  });
  expect(f.calls.map((c) => [c.command, ...c.args!])).toEqual([
    ["ls-files", "-v", "-z"],
    ["cat-file", "-s", o.oid],
    ["cat-file", "blob", o.oid],
  ]);
});
it("reads flags freshly when omitted but issues no object commands for unprotected entries", async () => {
  const f = fixture([blob(Buffer.from("unused"))]);
  expect(
    (
      await captureNativeIndexRecovery(f.client, f.index, [], {
        freshBatch: true,
      })
    ).objects,
  ).toEqual([]);
  expect(f.calls.map((c) => c.command)).toEqual(["ls-files"]);
  f.calls.length = 0;
  await captureNativeIndexRecovery(f.client, f.index, [], options);
  expect(f.calls).toEqual([]);
});
it.each(["sha1", "sha256"])(
  "rejects a leading UTF-8 BOM in %s batch-check metadata before reading bodies",
  async (algorithm) => {
    const f = fixture([
      blob(Buffer.from([239, 187, 191, 0, 255, 10]), algorithm),
    ]);
    f.transform((request, response) =>
      request.args?.[0] === "--batch-check"
        ? result(Buffer.concat([Buffer.from([239, 187, 191]), response.stdout]))
        : response,
    );
    await expect(
      captureNativeIndexRecovery(f.client, f.index, f.paths, options),
    ).rejects.toThrow();
    expect(f.calls.map((request) => request.args?.[0])).toEqual([
      "--batch-check",
    ]);
  },
);
it.each([
  "missing",
  "tree",
  "wrong OID",
  "leading zero",
  "negative",
  "unsafe size",
  "over-limit",
  "truncated",
  "extra",
  "reordered",
  "duplicate",
  "high-bit",
])("rejects %s batch-check before any body request", async (kind) => {
  const f = fixture([blob(Buffer.from("first")), blob(Buffer.from("second"))]);
  f.transform((r, response) => {
    if (r.args?.[0] !== "--batch-check") return response;
    if (kind === "high-bit") {
      const bytes = Buffer.from(response.stdout);
      bytes[bytes.indexOf(32) + 1] |= 0x80;
      return result(bytes);
    }
    const rows = response.stdout.toString("ascii").trimEnd().split("\n");
    const first = rows[0],
      oid = first.split(" ")[0];
    const changed: Record<string, string> = {
      missing: `${oid} missing`,
      tree: first.replace("blob", "tree"),
      "wrong OID": first.replace(oid, "f".repeat(40)),
      "leading zero": first.replace(/ \d+$/, " 05"),
      negative: first.replace(/ \d+$/, " -1"),
      "unsafe size": first.replace(/ \d+$/, " 9007199254740993"),
      "over-limit": first.replace(/ \d+$/, ` ${LIMIT + 1}`),
      truncated: first,
      extra: response.stdout.toString() + first + "\n",
      reordered: [...rows].reverse().join("\n") + "\n",
      duplicate: `${first}\n${first}\n`,
    };
    return result(
      Buffer.from(
        kind in { truncated: 1, extra: 1, reordered: 1, duplicate: 1 }
          ? changed[kind]
          : [changed[kind], rows[1]].join("\n") + "\n",
      ),
    );
  });
  await expect(
    captureNativeIndexRecovery(f.client, f.index, f.paths, options),
  ).rejects.toThrow();
  expect(f.calls.map((c) => c.args?.[0])).toEqual(["--batch-check"]);
});
it.each([
  "wrong OID",
  "wrong type",
  "wrong size",
  "noncanonical size",
  "hash",
  "header",
  "body",
  "newline",
  "trailing",
  "duplicate",
  "high-bit",
])("rejects %s batch body without scalar fallback or retry", async (kind) => {
  const f = fixture([blob(Buffer.from([0, 255, 10, 2]))]);
  f.transform((r, response) => {
    if (r.args?.[0] !== "--batch") return response;
    if (kind === "high-bit") {
      const bytes = Buffer.from(response.stdout);
      bytes[0] |= 0x80;
      return result(bytes);
    }
    const b = response.stdout,
      end = b.indexOf(10);
    const header = b.subarray(0, end).toString("ascii");
    const changed: Record<string, Buffer> = {
      "wrong OID": Buffer.concat([
        Buffer.from("f".repeat(40) + header.slice(40)),
        b.subarray(end),
      ]),
      "wrong type": Buffer.concat([
        Buffer.from(header.replace("blob", "tree")),
        b.subarray(end),
      ]),
      "wrong size": Buffer.concat([
        Buffer.from(header.replace(/ \d+$/, " 3")),
        b.subarray(end),
      ]),
      "noncanonical size": Buffer.concat([
        Buffer.from(header.replace(/ \d+$/, " 04")),
        b.subarray(end),
      ]),
      hash: Buffer.concat([
        b.subarray(0, end + 1),
        Buffer.from([0, 255, 10, 3, 10]),
      ]),
      header: b.subarray(0, 20),
      body: b.subarray(0, -2),
      newline: b.subarray(0, -1),
      trailing: Buffer.concat([b, Buffer.from("x")]),
      duplicate: Buffer.concat([b, b]),
    };
    return result(changed[kind]);
  });
  await expect(
    captureNativeIndexRecovery(f.client, f.index, f.paths, options),
  ).rejects.toThrow();
  expect(f.calls.map((c) => c.args?.[0])).toEqual(["--batch-check", "--batch"]);
});
it.each(["nonzero", "signal", "unsettled", "timeout"])(
  "propagates %s once without retry at either batch phase",
  async (kind) => {
    for (const phase of ["--batch-check", "--batch"]) {
      const f = fixture([blob(Buffer.from("a"))]);
      f.transform((r, response) => {
        if (r.args?.[0] !== phase) return response;
        if (kind === "timeout") throw Error("deadline sentinel");
        return {
          ...response,
          ...(kind === "nonzero"
            ? { exitCode: 128 }
            : kind === "signal"
              ? { signal: "SIGTERM" as const }
              : { processSettled: false }),
        } as unknown as ByteCommandResult;
      });
      await expect(
        captureNativeIndexRecovery(f.client, f.index, f.paths, options),
      ).rejects.toThrow();
      expect(f.calls.map((c) => c.args?.[0])).toEqual(
        phase === "--batch" ? ["--batch-check", "--batch"] : ["--batch-check"],
      );
    }
  },
);
it("selects scalar before requesting a body whose framing exceeds transport, including exactly 8 MiB", async () => {
  for (const size of [LIMIT, LIMIT - 1, LIMIT - 54, LIMIT - 55, LIMIT - 80]) {
    const o = blob(Buffer.alloc(size, 5)),
      f = fixture([o]);
    expect(
      (await captureNativeIndexRecovery(f.client, f.index, f.paths, options))
        .objects,
    ).toEqual([expected(o)]);
    expect(f.calls.map((c) => c.args?.[0])).toEqual([
      "--batch-check",
      size + Buffer.byteLength(`${o.oid} blob ${size}\n`) + 1 > LIMIT
        ? "blob"
        : "--batch",
    ]);
  }
});
it("chunks by complete framed stdout rather than body sizes and checks total before bodies", async () => {
  const objects = Array.from({ length: 5 }, (_, i) =>
      blob(Buffer.alloc(LIMIT / 2, i)),
    ),
    f = fixture(objects.slice(0, 4));
  expect(
    (await captureNativeIndexRecovery(f.client, f.index, f.paths, options))
      .objects,
  ).toHaveLength(4);
  expect(f.calls.map((c) => c.args?.[0])).toEqual([
    "--batch-check",
    ...Array(4).fill("--batch"),
  ]);
  const over = fixture(
    Array.from({ length: 5 }, (_, i) => blob(Buffer.alloc(LIMIT, i))),
  );
  await expect(
    captureNativeIndexRecovery(over.client, over.index, over.paths, options),
  ).rejects.toThrow();
  expect(over.calls.map((c) => c.args?.[0])).toEqual(["--batch-check"]);
});
it("freshly rereads bodies on every invocation and rejects same-OID same-size corruption and deletion", async () => {
  const o = blob(Buffer.from("before")),
    f = fixture([o]);
  await captureNativeIndexRecovery(f.client, f.index, f.paths, options);
  o.data = Buffer.from("after!");
  await expect(
    captureNativeIndexRecovery(f.client, f.index, f.paths, options),
  ).rejects.toThrow();
  o.oid = "f".repeat(40);
  await expect(
    captureNativeIndexRecovery(f.client, f.index, f.paths, options),
  ).rejects.toThrow();
  expect(f.calls.filter((c) => c.args?.[0] === "--batch-check")).toHaveLength(
    3,
  );
});
it.each(["not buffer", "oversized"])(
  "rejects %s supplied flags before commands",
  async (kind) => {
    const f = fixture([]);
    await expect(
      captureNativeIndexRecovery(f.client, f.index, f.paths, {
        freshBatch: true,
        flags: (kind === "oversized"
          ? Buffer.alloc(LIMIT + 1)
          : "bad") as Buffer,
      }),
    ).rejects.toThrow();
    expect(f.calls).toEqual([]);
  },
);
it("retains index mode validation and bounds transport responses", async () => {
  const o = blob(Buffer.from("a")),
    f = fixture([o]);
  await expect(
    captureNativeIndexRecovery(
      f.client,
      Buffer.from(`160000 ${o.oid} 0\tp0\0`),
      f.paths,
      options,
    ),
  ).rejects.toThrow();
  f.transform(() => result(Buffer.alloc(LIMIT + 1)));
  await expect(
    captureNativeIndexRecovery(f.client, f.index, f.paths, options),
  ).rejects.toThrow();
});

it("reads known declarations with fresh bodies but no repeated declaration command", async () => {
  const bodies = readNativeGitBlobBodies;
  const o = blob(Buffer.from([239, 187, 191, 255, 0, 10]));
  const f = fixture([o]);
  const declarations = [
    {
      oid: o.oid,
      type: "blob" as const,
      size: o.data.length,
      sha256: expected(o).checksum,
    },
  ];
  await expect(bodies!(f.client, declarations)).resolves.toEqual(declarations);
  await expect(bodies!(f.client, declarations)).resolves.toEqual(declarations);
  expect(f.calls.map((r) => r.args)).toEqual([["--batch"], ["--batch"]]);
});

it.each(["sha1", "sha256"])(
  "known %s declaration never accepts changed or deleted current bodies",
  async (algorithm) => {
    const o = blob(Buffer.from("unchanged-body"), algorithm),
      f = fixture([o]);
    const declaration = [
      {
        oid: o.oid,
        type: "blob" as const,
        size: o.data.length,
        sha256: expected(o).checksum,
      },
    ];
    await readNativeGitBlobBodies(f.client, declaration);
    o.data = Buffer.from("corrupted-body");
    await expect(
      readNativeGitBlobBodies(f.client, declaration),
    ).rejects.toThrow();
    f.transform(() => result(Buffer.from(`${o.oid} missing\n`)));
    await expect(
      readNativeGitBlobBodies(f.client, declaration),
    ).rejects.toThrow();
    expect(f.calls.map((c) => c.args?.[0])).toEqual([
      "--batch",
      "--batch",
      "--batch",
    ]);
  },
);
it("known near-limit declaration chooses scalar before attempting a body batch", async () => {
  const o = blob(Buffer.alloc(LIMIT)),
    f = fixture([o]);
  await readNativeGitBlobBodies(f.client, [
    {
      oid: o.oid,
      type: "blob",
      size: o.data.length,
      sha256: expected(o).checksum,
    },
  ]);
  expect(f.calls.map((c) => c.args)).toEqual([["blob", o.oid]]);
});

it("QUALITY02 two 18MiB blob generations retain independent 32MiB budgets", async () => {
  const objects = Array.from({ length: 6 }, (_, i) =>
    blob(Buffer.alloc(6 * 1024 * 1024, 0xc0 + i)),
  );
  const f = fixture(objects);
  const declarations = objects.map((o) => ({
    oid: o.oid,
    type: "blob" as const,
    size: o.data.length,
    sha256: expected(o).checksum,
  }));
  const states = [declarations.slice(0, 3), declarations.slice(3)];
  expect(
    states.map((state) => state.reduce((sum, entry) => sum + entry.size, 0)),
  ).toEqual([18 * 1024 * 1024, 18 * 1024 * 1024]);
  await expect(
    readNativeGitBlobStates(f.client, states),
  ).resolves.toBeUndefined();
  // A genuine single-state overflow remains prohibited by the original API.
  await expect(
    readNativeGitBlobBodies(f.client, declarations),
  ).rejects.toThrow();
  expect(f.calls).toHaveLength(6);
  for (const call of f.calls) {
    expect(call.args).toEqual(["--batch"]);
    expect(call.stdin!.toString().trim().split("\n")).toHaveLength(1);
  }
});

it.each([0, 1])(
  "QUALITY02 rejects overflow in independently bounded state %s",
  async (invalidState) => {
    const o = blob(Buffer.from("valid state")),
      f = fixture([o]);
    const valid = [
      {
        oid: o.oid,
        type: "blob" as const,
        size: o.data.length,
        sha256: expected(o).checksum,
      },
    ];
    const overflow = Array.from({ length: 6 }, (_, i) => ({
      oid: (i + 1).toString(16).padStart(40, "0"),
      type: "blob" as const,
      size: 6 * 1024 * 1024,
      sha256: "a".repeat(64),
    }));
    const states = invalidState === 0 ? [overflow, valid] : [valid, overflow];
    await expect(readNativeGitBlobStates(f.client, states)).rejects.toThrow(
      "Некорректное ожидаемое объявление объекта Git.",
    );
    expect(f.calls).toHaveLength(invalidState);
  },
);

it.each([0, 1])(
  "QUALITY02 rejects changed and missing current bodies in state %s without retry",
  async (changedState) => {
    const objects = [blob(Buffer.from("first")), blob(Buffer.from("other"))];
    const f = fixture(objects);
    const states = objects.map((o) => [
      {
        oid: o.oid,
        type: "blob" as const,
        size: o.data.length,
        sha256: expected(o).checksum,
      },
    ]);
    await readNativeGitBlobStates(f.client, states);
    f.calls.length = 0;
    objects[changedState].data = Buffer.from("wrong");
    await expect(readNativeGitBlobStates(f.client, states)).rejects.toThrow(
      "Содержимое объекта Git не соответствует ожиданию.",
    );
    expect(f.calls).toHaveLength(changedState + 1);
    f.calls.length = 0;
    f.transform((request, response) =>
      request.stdin?.toString().includes(objects[changedState].oid)
        ? result(Buffer.from(`${objects[changedState].oid} missing\n`))
        : response,
    );
    await expect(readNativeGitBlobStates(f.client, states)).rejects.toThrow();
    expect(f.calls).toHaveLength(changedState + 1);
  },
);

it("QUALITY02 rereads even a shared OID independently in each state", async () => {
  const o = blob(Buffer.from("before")),
    f = fixture([o]);
  const state = [
    {
      oid: o.oid,
      type: "blob" as const,
      size: o.data.length,
      sha256: expected(o).checksum,
    },
  ];
  f.transform((_request, response) => {
    // The first response is already copied. Corrupt the next current read.
    o.data = Buffer.from("after!");
    return response;
  });
  await expect(
    readNativeGitBlobStates(f.client, [state, state]),
  ).rejects.toThrow("Содержимое объекта Git не соответствует ожиданию.");
  expect(f.calls.map((call) => call.args)).toEqual([["--batch"], ["--batch"]]);
});

it("QUALITY02 keeps per-blob and SHA-256 checks for every state", async () => {
  const o = blob(Buffer.from("body")),
    f = fixture([o]);
  const entry = {
    oid: o.oid,
    type: "blob" as const,
    size: o.data.length,
    sha256: expected(o).checksum,
  };
  await expect(
    readNativeGitBlobStates(f.client, [
      [entry],
      [{ ...entry, size: LIMIT + 1 }],
    ]),
  ).rejects.toThrow("Некорректное ожидаемое объявление объекта Git.");
  expect(f.calls).toHaveLength(1);
  f.calls.length = 0;
  await expect(
    readNativeGitBlobStates(f.client, [
      [entry],
      [{ ...entry, sha256: "0".repeat(64) }],
    ]),
  ).rejects.toThrow("Содержимое объекта Git не соответствует ожиданию.");
  expect(f.calls).toHaveLength(2);
});

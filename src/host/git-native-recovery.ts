import { createHash } from "node:crypto";
import type { NativeGitClient } from "./git-native-client";
import type { NativeGitState } from "./git-native-state";

/** Portable recovery data, never a binary index backup or an object-store copy.
 * Git supplies public index tuples and raw blobs; only protected paths need
 * blobs. Unchanged tracked files remain addressable through the recorded HEAD. */
export async function captureNativeIndexRecovery(
  client: Pick<NativeGitClient, "run">,
  index: Buffer,
  paths: readonly string[],
  options?: { flags?: Buffer; freshBatch?: true },
): Promise<NonNullable<NativeGitState["indexRecovery"]>> {
  const limit = 8 * 1024 * 1024;
  if (
    options?.flags !== undefined &&
    (!Buffer.isBuffer(options.flags) || options.flags.length > limit)
  )
    throw Error("Некорректные признаки индекса Git.");
  const read = async (
    args: string[],
    maxOutputBytes = limit,
    stdin?: Buffer,
  ) => {
    const r = await client.run({
      policy: "local-read",
      command: "cat-file",
      args,
      ...(stdin ? { stdin } : {}),
    });
    if (r.exitCode !== 0 || !r.processSettled || r.signal !== null)
      throw Error("Не удалось сохранить подготовленное содержимое Git.");
    if (r.stdout.length > maxOutputBytes)
      throw Error("Превышен предел чтения Git.");
    return r.stdout;
  };
  const selected = new Set(paths),
    ids = new Set<string>();
  for (const row of new TextDecoder("utf-8", { fatal: true })
    .decode(index)
    .split("\0")
    .filter(Boolean)) {
    const m = /^(\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) [0-3]\t([\s\S]+)$/.exec(
      row,
    );
    if (!m) throw Error("Некорректный публичный индекс Git.");
    if (!selected.has(m[3])) continue;
    if (!["100644", "100755", "120000"].includes(m[1]))
      throw Error("Этот тип записи Git нельзя включить в защитный снимок.");
    ids.add(m[2]);
  }
  const flags =
    options?.flags ??
    (await (async () => {
      const result = await client.run({
        policy: "local-read",
        command: "ls-files",
        args: ["-v", "-z"],
      });
      if (
        result.exitCode !== 0 ||
        !result.processSettled ||
        result.signal !== null
      )
        throw Error("Не удалось сохранить признаки индекса Git.");
      if (!Buffer.isBuffer(result.stdout) || result.stdout.length > limit)
        throw Error("Некорректные признаки индекса Git.");
      return result.stdout;
    })());
  const objects: NonNullable<NativeGitState["indexRecovery"]>["objects"] = [];
  const sorted = [...ids].sort();
  const save = (oid: string, size: number, data: Buffer) => {
    if (
      data.length !== size ||
      createHash(oid.length === 40 ? "sha1" : "sha256")
        .update(`blob ${size}\0`)
        .update(data)
        .digest("hex") !== oid
    )
      throw Error("Содержимое объекта Git не соответствует индексу.");
    objects.push({
      oid,
      data: data.toString("base64"),
      checksum: createHash("sha256").update(data).digest("hex"),
    });
  };
  let total = 0;
  const boundedSize = (size: number) => {
    if (
      !Number.isSafeInteger(size) ||
      size > limit ||
      (total += size) > 32 * 1024 * 1024
    )
      throw Error("Превышен предел защитного снимка Git.");
    return size;
  };
  if (!options?.freshBatch) {
    // Other writers keep their existing scalar public-object reads.
    for (const oid of sorted) {
      const sizeText = (await read(["-s", oid], 128)).toString("ascii");
      if (!/^(?:0|[1-9][0-9]*)\n$/.test(sizeText))
        throw Error("Некорректный размер объекта Git.");
      const size = boundedSize(Number(sizeText));
      save(oid, size, await read(["blob", oid]));
    }
  } else if (sorted.length) {
    const request = (oids: readonly string[]) =>
      Buffer.from(oids.join("\n") + "\n");
    // All declarations are fresh and validated before reading any bodies. No
    // object authority or bytes survive into a later observation/capture.
    const declarations = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    })
      .decode(await read(["--batch-check"], limit, request(sorted)))
      .split("\n");
    if (declarations.length !== sorted.length + 1 || declarations.pop() !== "")
      throw Error("Некорректный ответ объектов Git.");
    const entries = sorted.map((oid, i) => {
      const match = /^([a-f0-9]{40}|[a-f0-9]{64}) blob (0|[1-9][0-9]*)$/.exec(
        declarations[i],
      );
      if (!match || match[1] !== oid)
        throw Error("Некорректный ответ объектов Git.");
      const size = boundedSize(Number(match[2]));
      const header = Buffer.from(`${oid} blob ${size}\n`);
      return { oid, size, header, framed: header.length + size + 1 };
    });
    await readBlobFrames(entries, read, save);
  }
  return { flags: flags.toString("base64"), objects };
}

export interface NativeGitBlobDeclaration {
  readonly oid: string;
  readonly type: "blob";
  readonly size: number;
  readonly sha256: string;
}

/** Expected declarations bound framing, never substitute for current bytes.
 * Every call reads all bodies and validates both their Git OID and SHA-256.
 * This reader has no recovery serialization or persistent object cache. */
export async function readNativeGitBlobBodies(
  client: Pick<NativeGitClient, "run">,
  expected: readonly NativeGitBlobDeclaration[],
): Promise<readonly NativeGitBlobDeclaration[]> {
  const limit = 8 * 1024 * 1024;
  let total = 0;
  const seen = new Set<string>();
  if (expected.length > 12288) throw Error("Слишком много объектов Git.");
  const entries = expected
    .map((entry) => {
      if (
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.oid) ||
        entry.type !== "blob" ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        entry.size > limit ||
        (total += entry.size) > 32 * 1024 * 1024 ||
        seen.has(entry.oid)
      )
        throw Error("Некорректное ожидаемое объявление объекта Git.");
      seen.add(entry.oid);
      const header = Buffer.from(`${entry.oid} blob ${entry.size}\n`);
      return { ...entry, header, framed: header.length + entry.size + 1 };
    })
    .sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const checksums = new Map(entries.map((entry) => [entry.oid, entry.sha256]));
  const observed: NativeGitBlobDeclaration[] = [];
  await readBlobFrames(
    entries,
    async (args, max, stdin) => {
      const result = await client.run({
        policy: "local-read",
        command: "cat-file",
        args,
        ...(stdin ? { stdin } : {}),
      });
      if (
        !result.processSettled ||
        result.signal !== null ||
        result.exitCode !== 0 ||
        !Buffer.isBuffer(result.stdout) ||
        result.stdout.length > (max ?? limit)
      )
        throw Error("Не удалось проверить текущее содержимое Git.");
      return result.stdout;
    },
    (oid, size, body) => {
      const sha256 = createHash("sha256").update(body).digest("hex");
      if (
        body.length !== size ||
        createHash(oid.length === 40 ? "sha1" : "sha256")
          .update(`blob ${size}\0`)
          .update(body)
          .digest("hex") !== oid ||
        sha256 !== checksums.get(oid)
      )
        throw Error("Содержимое объекта Git не соответствует ожиданию.");
      observed.push({ oid, type: "blob", size, sha256 });
    },
  );
  return observed;
}

/** Transaction generations have independent per-state budgets. Every state
 * still gets fresh bounded reads; declarations never replace current bodies. */
export async function readNativeGitBlobStates(
  client: Pick<NativeGitClient, "run">,
  states: readonly (readonly NativeGitBlobDeclaration[])[],
): Promise<void> {
  for (const state of states) await readNativeGitBlobBodies(client, state);
}

/** One byte framing implementation for recovery and ephemeral commit proofs. */
async function readBlobFrames(
  entries: readonly {
    oid: string;
    size: number;
    header: Buffer;
    framed: number;
  }[],
  read: (args: string[], max?: number, stdin?: Buffer) => Promise<Buffer>,
  save: (oid: string, size: number, data: Buffer) => void,
) {
  const limit = 8 * 1024 * 1024;
  let chunk: (typeof entries)[number][] = [],
    framed = 0;
  const flush = async () => {
    if (!chunk.length) return;
    const response = await read(
      ["--batch"],
      limit,
      Buffer.from(chunk.map((entry) => entry.oid).join("\n") + "\n"),
    );
    let offset = 0;
    for (const entry of chunk) {
      const start = offset + entry.header.length,
        end = start + entry.size;
      if (
        !response.subarray(offset, start).equals(entry.header) ||
        end >= response.length ||
        response[end] !== 10
      )
        throw Error("Некорректный ответ объектов Git.");
      save(entry.oid, entry.size, response.subarray(start, end));
      offset = end + 1;
    }
    if (offset !== response.length)
      throw Error("Некорректный ответ объектов Git.");
    chunk = [];
    framed = 0;
  };
  for (const entry of entries) {
    if (framed + entry.framed > limit) await flush();
    if (entry.framed > limit) {
      // Choose scalar before any attempted batch read; never retry on failure.
      save(entry.oid, entry.size, await read(["blob", entry.oid]));
    } else {
      chunk.push(entry);
      framed += entry.framed;
    }
  }
  await flush();
}

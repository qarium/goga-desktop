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
): Promise<NonNullable<NativeGitState["indexRecovery"]>> {
  const read = async (args: string[], maxOutputBytes = 8 * 1024 * 1024) => {
    const r = await client.run({
      policy: "local-read",
      command: "cat-file",
      args,
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
  const flags = await client.run({
    policy: "local-read",
    command: "ls-files",
    args: ["-v", "-z"],
  });
  if (flags.exitCode !== 0 || !flags.processSettled || flags.signal !== null)
    throw Error("Не удалось сохранить признаки индекса Git.");
  const objects: NonNullable<NativeGitState["indexRecovery"]>["objects"] = [];
  let total = 0;
  for (const oid of [...ids].sort()) {
    const sizeText = (await read(["-s", oid], 128)).toString("ascii");
    if (!/^(?:0|[1-9][0-9]*)\n$/.test(sizeText))
      throw Error("Некорректный размер объекта Git.");
    const size = Number(sizeText);
    if (size > 8 * 1024 * 1024 || (total += size) > 32 * 1024 * 1024)
      throw Error("Превышен предел защитного снимка Git.");
    const data = await read(["blob", oid]);
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
  }
  return { flags: flags.stdout.toString("base64"), objects };
}

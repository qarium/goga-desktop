/** Docker 27 env-file scanner: maximum content bytes, excluding the LF. */
export const MAX_ENV_LINE_BYTES = 65535;

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const cp = character.codePointAt(0)!;
    bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/** Reject lossy transport inputs; never normalize or expose the value. */
export function assertEnvironmentValue(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new Error(
          "Некорректный Unicode (UTF-16). Исправьте значение переменной.",
        );
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error(
        "Некорректный Unicode (UTF-16). Исправьте значение переменной.",
      );
    }
  }
  if (/[\0\r\n]/.test(value))
    throw new Error(
      "Переносы строк и нулевой символ недопустимы. Вставка отклонена; прежнее значение сохранено.",
    );
  if (utf8Bytes(value) > 65536)
    throw new Error("Значение переменной превышает допустимый размер UTF-8.");
}

// Python json.dumps(..., ensure_ascii=True, separators=(',', ':')) counts
// non-ASCII UTF-16 units as six ASCII bytes, including each half of an emoji.
function escapedBytes(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    bytes +=
      c === 34 || c === 92 || [8, 9, 10, 12, 13].includes(c)
        ? 2
        : c < 32 || c > 126
          ? 6
          : 1;
  }
  return bytes;
}

type Entry = { key: string; value: string; runtime: boolean };
export function environmentTransportSize(rows: readonly Entry[]) {
  const runtime = rows.filter((row) => row.runtime);
  const values = new Map(runtime.map((row) => [row.key, row.value]));
  let jsonBytes = 2;
  for (const [key, value] of values)
    jsonBytes += escapedBytes(key) + escapedBytes(value) + 5;
  jsonBytes += Math.max(0, values.size - 1);
  return {
    jsonBytes,
    payloadLineBytes: "GOGA_EXTRA_ENV=".length + 4 * Math.ceil(jsonBytes / 3),
    rawLineBytes: runtime.map(
      (row) => utf8Bytes(row.key) + 1 + utf8Bytes(row.value),
    ),
  };
}

/** Matches the supported Goga codec; OFF rows never enter its aggregate. */
export function assertEnvironmentTransport(rows: readonly Entry[]): void {
  for (const row of rows) assertEnvironmentValue(row.value);
  const size = environmentTransportSize(rows);
  if (
    size.payloadLineBytes > MAX_ENV_LINE_BYTES ||
    size.rawLineBytes.some((bytes) => bytes > MAX_ENV_LINE_BYTES)
  )
    throw new Error(
      "Суммарный размер runtime-переменных превышает лимит Docker. Уменьшите значения или отключите runtime для ненужных переменных.",
    );
}

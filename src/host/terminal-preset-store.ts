import { t } from "../shared/i18n";
import {
  terminalContextKey,
  terminalContextSchema,
  type TerminalContext,
} from "../shared/terminal";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  parseTerminalPresetDraft,
  parseTerminalPresetEnv,
  terminalPresetNameSchema,
  type TerminalPresetDraft,
  type TerminalPresetEnv,
  type TerminalPresetMenuItem,
  type TerminalPresetSummary,
  type TerminalPresetDocument,
} from "../shared/terminal-presets";
import { PrivateFileError, TerminalPrivateFile } from "./terminal-private-file";
export interface TerminalPresetCrypto {
  seal(plain: string): string;
  open(sealed: string): string;
}
const messages = {
  get invalid() { return t("hostTerminal.presetStoreInvalid"); },
  get conflict() { return t("hostTerminal.presetChanged"); },
  get unavailable() { return t("hostTerminal.presetStoreUnavailable"); },
};
const fail = (message: string): never => {
  throw new PrivateFileError(message);
};
const id = z.string().uuid(),
  cipher = z.string().min(1);
const storedPreset = z
  .object({ id, revision: id, name: terminalPresetNameSchema, payload: cipher })
  .strict();
const storedSnapshot = z.object({ id, payload: cipher }).strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    presets: z.array(storedPreset).max(4096),
    snapshots: z.array(storedSnapshot).max(65536),
  })
  .strict();
type Entry = z.infer<typeof storedPreset>;
type State = z.infer<typeof stateSchema>;
function identity(v: string): string {
  if (!id.safeParse(v).success)
    fail(t("hostTerminal.badPresetSnapshot"));
  return v;
}
function parse(raw: string | undefined): State {
  if (raw === undefined) return { version: 1, presets: [], snapshots: [] };
  try {
    const s = stateSchema.parse(JSON.parse(raw));
    if (
      new Set(s.presets.map((x) => x.id)).size !== s.presets.length ||
      new Set(s.presets.map((x) => x.name.toLowerCase())).size !==
        s.presets.length ||
      new Set(s.snapshots.map((x) => x.id)).size !== s.snapshots.length
    )
      throw Error();
    return s;
  } catch {
    return fail(messages.invalid);
  }
}
const meta = ({ id, revision, name }: Entry): TerminalPresetMenuItem => ({
  id,
  revision,
  name,
});
export interface TerminalPresetSnapshotOwner {
  tabId: string;
  context: TerminalContext;
}
function snapshotOwner(input: TerminalPresetSnapshotOwner) {
  const owner = z
    .object({ tabId: id, context: terminalContextSchema })
    .strict()
    .safeParse(input);
  if (!owner.success) return fail(t("hostTerminal.environmentOwnerMissing"));
  return {
    tabId: owner.data.tabId,
    contextKey: terminalContextKey(owner.data.context),
  };
}
function lookup(s: State, pid: string, rev?: string) {
  identity(pid);
  const found = s.presets.find((p) => p.id === pid);
  if (!found) return fail(t("hostTerminal.presetGone"));
  if (rev !== undefined && found.revision !== identity(rev))
    return fail(messages.conflict);
  return found;
}
export class TerminalPresetStore {
  private readonly store: TerminalPrivateFile;
  constructor(
    home: string,
    private readonly crypto: TerminalPresetCrypto,
  ) {
    this.store = new TerminalPrivateFile(home, "terminal-presets", messages);
  }
  private tx<T>(fn: (s: State) => { value: T; write?: boolean }): Promise<T> {
    return this.store.run((raw) => {
      const s = parse(raw),
        result = fn(s);
      return { value: result.value, next: result.write ? s : undefined };
    });
  }
  private seal(value: unknown): string {
    try {
      return this.crypto.seal(JSON.stringify(value));
    } catch {
      return fail(
        t("hostTerminal.encryptionFailed"),
      );
    }
  }
  private open(payload: string): unknown {
    let plain: string;
    try {
      plain = this.crypto.open(payload);
    } catch {
      return fail(
        t("hostTerminal.decryptionFailed"),
      );
    }
    try {
      return JSON.parse(plain);
    } catch {
      return fail(messages.invalid);
    }
  }
  private document(entry: Entry): TerminalPresetDocument {
    // Verify record binding after decrypting: cipher blobs are neither movable nor interchangeable.
    const opened = this.open(entry.payload);
    try {
      const body = z
        .object({
          kind: z.literal("preset"),
          id,
          revision: id,
          data: z.unknown(),
        })
        .strict()
        .parse(opened);
      const draft = parseTerminalPresetDraft(body.data);
      if (
        body.id !== entry.id ||
        body.revision !== entry.revision ||
        draft.name !== entry.name
      )
        throw Error();
      return { ...draft, id: entry.id, revision: entry.revision };
    } catch {
      return fail(messages.invalid);
    }
  }
  menu(): Promise<TerminalPresetMenuItem[]> {
    return this.tx((s) => ({ value: s.presets.map(meta) }));
  }
  list(): Promise<TerminalPresetSummary[]> {
    return this.tx((s) => ({
      value: s.presets.map((p) => {
        const d = this.document(p);
        return { ...meta(p), command: d.command, envCount: d.env.length };
      }),
    }));
  }
  read(key: string, revision?: string): Promise<TerminalPresetDocument> {
    return this.tx((s) => ({ value: this.document(lookup(s, key, revision)) }));
  }
  async save(
    input: TerminalPresetDraft,
    key?: string,
    revision?: string,
  ): Promise<TerminalPresetDocument> {
    const draft = parseTerminalPresetDraft(input);
    if ((key === undefined) !== (revision === undefined))
      fail(t("hostTerminal.badPresetVersion"));
    return this.tx((s) => {
      const before = key === undefined ? undefined : lookup(s, key, revision);
      if (before) this.document(before); // Do not overwrite a damaged or substituted record.
      if (!before && s.presets.length >= 4096)
        fail(t("hostTerminal.presetLimit"));
      if (
        s.presets.some(
          (p) =>
            p.id !== key && p.name.toLowerCase() === draft.name.toLowerCase(),
        )
      )
        fail(t("hostTerminal.duplicatePresetName"));
      const header = {
        id: before?.id ?? randomUUID(),
        revision: randomUUID(),
        name: draft.name,
      };
      const payload = this.seal({
        kind: "preset",
        id: header.id,
        revision: header.revision,
        data: draft,
      });
      const entry = { ...header, payload };
      if (before) s.presets[s.presets.indexOf(before)] = entry;
      else s.presets.push(entry);
      return { value: { ...draft, ...header }, write: true };
    });
  }
  remove(key: string, revision: string): Promise<void> {
    return this.tx((s) => {
      identity(revision);
      const before = lookup(s, key, revision);
      this.document(before);
      s.presets = s.presets.filter((p) => p !== before);
      return { value: undefined, write: true };
    });
  }
  async createSnapshot(
    input: TerminalPresetEnv,
    owner: TerminalPresetSnapshotOwner,
  ): Promise<string | undefined> {
    const bound = snapshotOwner(owner);
    const env = parseTerminalPresetEnv(input);
    if (!env.length) return undefined;
    return this.tx((s) => {
      if (s.snapshots.length >= 65536)
        fail(t("hostTerminal.savedEnvironmentLimit"));
      const sid = randomUUID();
      s.snapshots.push({
        id: sid,
        payload: this.seal({ kind: "snapshot", id: sid, ...bound, env }),
      });
      return { value: sid, write: true };
    });
  }
  async readSnapshot(
    sid: string,
    owner: TerminalPresetSnapshotOwner,
  ): Promise<TerminalPresetEnv> {
    const bound = snapshotOwner(owner);
    return this.tx((s) => {
      identity(sid);
      const row = s.snapshots.find((x) => x.id === sid);
      if (!row)
        return fail(
          t("hostTerminal.environmentMissing"),
        );
      const value = this.open(row.payload);
      try {
        const v = z
          .object({
            kind: z.literal("snapshot"),
            id,
            tabId: id,
            contextKey: z.string(),
            env: z.unknown(),
          })
          .strict()
          .parse(value);
        if (
          v.id !== sid ||
          v.tabId !== bound.tabId ||
          v.contextKey !== bound.contextKey
        )
          throw Error();
        const env = parseTerminalPresetEnv(v.env);
        if (!env.length) throw Error();
        return { value: env };
      } catch {
        return fail(messages.invalid);
      }
    });
  }
  removeSnapshot(sid: string): Promise<void> {
    return this.tx((s) => {
      identity(sid);
      const rest = s.snapshots.filter((p) => p.id !== sid),
        write = s.snapshots.length !== rest.length;
      s.snapshots = rest;
      return { value: undefined, write };
    });
  }
  /** Caller owns cross-registry publication lock and supplied IDs came from a fresh trusted tab registry. */
  collectSnapshots(live: ReadonlySet<string>): Promise<void> {
    const keys = new Set(Array.from(live, identity));
    return this.tx((s) => {
      const rest = s.snapshots.filter((x) => keys.has(x.id)),
        write = rest.length !== s.snapshots.length;
      s.snapshots = rest;
      return { value: undefined, write };
    });
  }
}

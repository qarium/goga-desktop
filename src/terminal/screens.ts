import {
  TERMINAL_SOURCE_BYTES,
  terminalGrantSchema,
  terminalFrameSchema,
  terminalScreenInputSchema,
  terminalScreenResizeSchema,
  sameTerminalGrant,
  type TerminalGrant,
  type TerminalAck,
} from "../shared/terminal-screen";
export interface TerminalScreenSurface {
  write(text: string, parsed: () => void): void;
  onData(listener: (text: string) => void): { dispose(): void };
  visible(shown: boolean, focus?: boolean): void;
  inputEnabled(enabled: boolean): void;
  fit(): { cols: number; rows: number } | undefined;
  dispose(): void;
}
export interface TerminalScreenDependencies {
  create(
    grant: TerminalGrant,
    options: { scrollback: number },
  ): TerminalScreenSurface;
  ack(value: TerminalAck): void;
  input(value: TerminalGrant & { text: string }): void;
  resize(value: TerminalGrant & { cols: number; rows: number }): void;
  fault(grant: TerminalGrant): void;
}
interface Entry {
  interactive?: boolean;
  grant: TerminalGrant;
  surface: TerminalScreenSurface;
  subscription?: { dispose(): void };
  state: "live" | "exited" | "lost";
  nextSequence: number;
  pending: { sequence: number; bytes: number; parsed: boolean }[];
  bytes: number;
  size?: { cols: number; rows: number };
}
/** Lives in the dedicated renderer, not in React or the reloadable main UI.
 * Never snapshots/replays ANSI. Hidden screens keep parsing in their original xterm.
 */
export class TerminalScreens {
  private entries = new Map<string, Entry>();
  private retired = new Set<string>();
  private selected: Entry | undefined;
  private lost = false;
  constructor(private dependencies: TerminalScreenDependencies) {}
  grant(raw: TerminalGrant): void {
    const grant = terminalGrantSchema.parse(raw);
    if (this.lost || this.retired.has(this.key(grant)))
      throw Error("Экран терминала утрачен; требуется новая сессия.");
    const old = this.entries.get(grant.sessionId);
    if (old) {
      if (sameTerminalGrant(old.grant, grant)) return;
      throw Error("Нельзя заменять экран работающей сессии.");
    }
    const surface = this.dependencies.create(
      { ...grant },
      { scrollback: 5000 },
    );
    const entry: Entry = {
      grant,
      surface,
      state: "live",
      nextSequence: 1,
      pending: [],
      bytes: 0,
    };
    this.entries.set(grant.sessionId, entry);
    surface.visible(false);
    surface.inputEnabled(true);
    entry.subscription = surface.onData((text) => {
      if (
        !this.current(entry) ||
        entry.state !== "live" ||
        entry.interactive === false
      )
        return;
      // xterm emits one paste event (including a single bracketed-paste pair).
      // Split its bytes, not the paste operation; preserve Unicode and order.
      if (typeof text !== "string" || !text || text.length > 1024 * 1024 + 12)
        return;
      const bytes = new TextEncoder().encode(text);
      if (bytes.length > 1024 * 1024 + 12) return;
      const decoder = new TextDecoder();
      for (let start = 0; start < bytes.length;) {
        if (!this.current(entry) || entry.state !== "live") break;
        let end = Math.min(start + TERMINAL_SOURCE_BYTES, bytes.length);
        while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
        const parsed = terminalScreenInputSchema.safeParse({
          ...entry.grant,
          text: decoder.decode(bytes.subarray(start, end)),
        });
        if (!parsed.success) break;
        try {
          this.dependencies.input(parsed.data);
        } catch {
          this.fail(entry);
          break;
        }
        start = end;
      }
    });
  }
  receive(raw: unknown): void {
    const parsed = terminalFrameSchema.safeParse(raw);
    if (!parsed.success) return;
    const frame = parsed.data,
      entry = this.find(frame);
    if (!entry || entry.state === "lost") return;
    if (frame.sequence < entry.nextSequence) return;
    const bytes = new TextEncoder().encode(frame.text).byteLength;
    if (
      frame.sequence !== entry.nextSequence ||
      entry.bytes + bytes > 256 * 1024 ||
      entry.pending.length >= 4096
    ) {
      this.fail(entry);
      return;
    }
    entry.nextSequence++;
    const pending = { sequence: frame.sequence, bytes, parsed: false };
    entry.pending.push(pending);
    entry.bytes += bytes;
    try {
      entry.surface.write(frame.text, () => {
        if (!this.current(entry) || entry.state === "lost" || pending.parsed)
          return;
        pending.parsed = true;
        while (
          entry.pending[0]?.parsed &&
          this.current(entry) &&
          (entry.state as string) !== "lost"
        ) {
          const first = entry.pending.shift()!;
          entry.bytes -= first.bytes;
          try {
            this.dependencies.ack({ ...entry.grant, sequence: first.sequence });
          } catch {
            this.fail(entry);
          }
        }
      });
    } catch {
      this.fail(entry);
    }
  }
  select(grant: TerminalGrant | null, focus = true, interactive = true): void {
    const entry = grant ? this.find(grant) : undefined;
    // A stale selection must not reveal another context's previous screen.
    for (const value of this.entries.values())
      if (value === entry && !focus) value.surface.visible(true, false);
      else value.surface.visible(value === entry);
    this.selected = entry;
    if (entry) {
      entry.interactive = interactive;
      entry.surface.inputEnabled(interactive && entry.state === "live");
    }
    this.fit();
  }
  fit(): void {
    const entry = this.selected;
    if (
      !entry ||
      !this.current(entry) ||
      entry.state !== "live" ||
      entry.interactive === false
    )
      return;
    const size = entry.surface.fit();
    const parsed = terminalScreenResizeSchema.safeParse({
      ...entry.grant,
      ...size,
    });
    if (
      !parsed.success ||
      (entry.size?.cols === parsed.data.cols &&
        entry.size?.rows === parsed.data.rows)
    )
      return;
    try {
      this.dependencies.resize(parsed.data);
      entry.size = { cols: parsed.data.cols, rows: parsed.data.rows };
    } catch {
      this.fail(entry);
    }
  }
  exited(grant: TerminalGrant): void {
    const entry = this.find(grant);
    if (entry && entry.state === "live") {
      entry.state = "exited";
      entry.surface.inputEnabled(false);
    }
  }
  remove(grant: TerminalGrant): void {
    const entry = this.find(grant);
    if (!entry) return;
    this.entries.delete(grant.sessionId);
    this.retired.add(this.key(grant));
    if (this.selected === entry) this.selected = undefined;
    entry.subscription?.dispose();
    entry.surface.dispose();
    entry.pending = [];
    entry.bytes = 0;
  }
  screenLost(grant: TerminalGrant): void {
    const entry = this.find(grant);
    if (entry) this.fail(entry);
  }
  dispose(): void {
    this.lost = true;
    for (const entry of this.entries.values()) {
      entry.subscription?.dispose();
      entry.surface.dispose();
    }
    this.entries.clear();
    this.selected = undefined;
  }
  rendererLost(): void {
    if (this.lost) return;
    this.lost = true;
    for (const entry of this.entries.values()) this.fail(entry);
  }
  private key(grant: TerminalGrant) {
    return JSON.stringify([grant.sessionId, grant.generation]);
  }
  private find(grant: TerminalGrant): Entry | undefined {
    if (this.lost) return;
    const entry = this.entries.get(grant.sessionId);
    return entry && sameTerminalGrant(entry.grant, grant) ? entry : undefined;
  }
  private current(entry: Entry) {
    return !this.lost && this.entries.get(entry.grant.sessionId) === entry;
  }
  private fail(entry: Entry) {
    if (entry.state === "lost") return;
    entry.state = "lost";
    entry.surface.inputEnabled(false);
    this.dependencies.fault({ ...entry.grant });
  }
}

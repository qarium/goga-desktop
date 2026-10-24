import { randomUUID } from "node:crypto";
import {
  terminalSessionRefSchema,
  type TerminalSessionRef,
} from "../shared/terminal";
import {
  TERMINAL_FRAME_BYTES,
  TERMINAL_SOURCE_BYTES,
  terminalGrantSchema,
  terminalAckSchema,
  sameTerminalGrant,
  type TerminalGrant,
  type TerminalFrame,
} from "../shared/terminal-screen";
export const FLOW_HIGH = 256 * 1024;
export const FLOW_LOW = 64 * 1024;
export const FLOW_LIMIT = 1024 * 1024;
const FRAME_LIMIT = 4096;
interface Frame {
  wire: TerminalFrame;
  bytes: number;
}
export interface TerminalFlowTransport {
  send(frame: TerminalFrame): void;
  /** Pause native reads, not software XOFF injected into a user's terminal. */
  pause(): void;
  resume(): void;
  lost(): void;
}
/** One output stream, one renderer capability, no replay into a replacement parser.
 * Payload budget includes sent-but-not-parsed frames. The source must retain an
 * unaccepted chunk and retry after drainage; `false` never means data consumed.
 * Native adapters must supply <=64 KiB per source event and respect pause().
 */
export class TerminalFlow {
  private credential: TerminalGrant;
  private state: "active" | "renderer-lost" | "disposed" = "active";
  private queue: Frame[] = [];
  private flight: Frame[] = [];
  private pendingBytes = 0;
  private flightBytes = 0;
  private nextSequence = 1;
  private paused = false;
  private pumping = false;
  constructor(
    ref: TerminalSessionRef,
    private transport: TerminalFlowTransport,
  ) {
    this.credential = {
      ...terminalSessionRefSchema.parse(ref),
      capability: randomUUID(),
    };
  }
  get grant(): TerminalGrant {
    return { ...this.credential };
  }
  snapshot() {
    return {
      state: this.state,
      pendingBytes: this.pendingBytes,
      queuedFrames: this.queue.length,
      inFlightFrames: this.flight.length,
      paused: this.paused,
    };
  }
  accepts(raw: unknown): boolean {
    const parsed = terminalGrantSchema.safeParse(raw);
    return (
      this.state === "active" &&
      parsed.success &&
      sameTerminalGrant(parsed.data, this.credential)
    );
  }
  offer(text: string): boolean {
    if (this.state === "disposed") return false;
    if (
      typeof text !== "string" ||
      Buffer.byteLength(text) > TERMINAL_SOURCE_BYTES
    )
      throw Error("Недопустимый размер события терминального транспорта.");
    if (!text) return true;
    // Build at most a few bounded frames before accepting the event atomically.
    const parts: { text: string; bytes: number }[] = [];
    let part = "",
      bytes = 0;
    for (const character of text) {
      const length = Buffer.byteLength(character);
      if (bytes + length > TERMINAL_FRAME_BYTES) {
        parts.push({ text: part, bytes });
        part = "";
        bytes = 0;
      }
      part += character;
      bytes += length;
    }
    parts.push({ text: part, bytes });
    const total = parts.reduce((n, p) => n + p.bytes, 0);
    if (
      this.pendingBytes + total > FLOW_LIMIT ||
      this.queue.length + this.flight.length + parts.length > FRAME_LIMIT
    ) {
      this.pause();
      return false;
    }
    if (!Number.isSafeInteger(this.nextSequence + parts.length)) {
      this.rendererLost();
      return false;
    }
    this.pendingBytes += total;
    for (const part of parts)
      this.queue.push({
        wire: {
          ...this.credential,
          sequence: this.nextSequence++,
          text: part.text,
        },
        bytes: part.bytes,
      });
    if (this.pendingBytes >= FLOW_HIGH) this.pause();
    this.pump();
    return true;
  }
  ack(raw: unknown): boolean {
    const parsed = terminalAckSchema.safeParse(raw);
    if (
      this.state !== "active" ||
      !parsed.success ||
      !sameTerminalGrant(parsed.data, this.credential)
    )
      return false;
    const first = this.flight[0];
    if (!first || first.wire.sequence !== parsed.data.sequence) return false;
    this.flight.shift();
    this.pendingBytes -= first.bytes;
    this.flightBytes -= first.bytes;
    this.pump();
    if (
      this.state === "active" &&
      this.paused &&
      this.pendingBytes <= FLOW_LOW &&
      this.queue.length + this.flight.length < FRAME_LIMIT / 2
    ) {
      this.paused = false;
      try {
        this.transport.resume();
      } catch {
        this.rendererLost();
      }
    }
    return true;
  }
  rendererLost(): void {
    if (this.state !== "active") return;
    this.state = "renderer-lost";
    this.pause();
    this.transport.lost();
  }
  /** Only after explicit lifecycle disposal; never a recovery/reconnect path. */
  dispose(): void {
    if (this.state === "disposed") return;
    this.state = "disposed";
    this.pause();
    this.queue = [];
    this.flight = [];
    this.pendingBytes = 0;
    this.flightBytes = 0;
  }
  private pause() {
    if (this.paused) return;
    this.paused = true;
    try {
      this.transport.pause();
    } catch {
      if (this.state === "active") {
        this.state = "renderer-lost";
        this.transport.lost();
      }
    }
  }
  private pump() {
    if (this.pumping || this.state !== "active") return;
    this.pumping = true;
    try {
      while (
        this.state === "active" &&
        this.queue.length &&
        this.flightBytes + this.queue[0].bytes <= FLOW_HIGH
      ) {
        const frame = this.queue.shift()!;
        this.flight.push(frame);
        this.flightBytes += frame.bytes;
        try {
          this.transport.send({ ...frame.wire });
        } catch {
          this.rendererLost();
        }
      }
    } finally {
      this.pumping = false;
    }
  }
}

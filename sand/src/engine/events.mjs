/**
 * The event bus and the agent stderr parser.
 *
 * Every observable thing that happens in a run becomes an event with a
 * monotonic sequence number. The sequence is what lets a browser that
 * connects late, or reconnects after a drop, ask for everything it missed
 * instead of starting blind at the current moment.
 */

import { EventEmitter } from "node:events";

/**
 * Both harnesses log with the same shape, independently arrived at:
 *
 *     [tool_call] tool=read path=README.md
 *
 * The bracketed token is the event type; the remainder is space-separated
 * k=v where a value may itself be JSON. Splitting before each `key=` keeps
 * JSON values containing spaces intact, which split(" ") would shred.
 */
const EVENT_LINE = /^\[([a-z0-9_.-]+)\]\s*(.*)$/i;

export function parseAgentLine(line) {
  const match = EVENT_LINE.exec(line.trim());
  if (!match) return null;
  const [, type, rest] = match;

  const fields = {};
  const parts = rest.split(/\s+(?=[A-Za-z_][A-Za-z0-9_]*=)/).filter(Boolean);
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq);
    const raw = part.slice(eq + 1);
    let value = raw;
    if (raw.startsWith("{") || raw.startsWith("[") || raw.startsWith('"')) {
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
    }
    fields[key] = value;
  }
  return { type, fields };
}

/**
 * Turns a byte stream into whole lines. Chunk boundaries do not respect
 * newlines, so a partial line is held back until its terminator arrives.
 */
export function createLineSplitter(onLine) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) onLine(line);
      }
    },
    /** Anything left after the stream closes is a final unterminated line. */
    flush() {
      if (buffer.trim()) onLine(buffer);
      buffer = "";
    },
  };
}

export class EventBus extends EventEmitter {
  constructor({ historyLimit = 5000 } = {}) {
    super();
    this.setMaxListeners(0);
    this.seq = 0;
    this.history = [];
    this.historyLimit = historyLimit;
  }

  /**
   * Record an event and notify listeners. Returns the stored event so a
   * caller can read the assigned sequence number.
   */
  emitEvent(event) {
    this.seq += 1;
    const stored = { seq: this.seq, at: Date.now(), ...event };
    this.history.push(stored);
    // Bound memory: a long run with a chatty agent must not grow forever.
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }
    this.emit("event", stored);
    return stored;
  }

  /** Every event after `seq`, for a client catching up. */
  since(seq) {
    if (!Number.isFinite(seq) || seq <= 0) return this.history.slice();
    return this.history.filter((e) => e.seq > seq);
  }
}

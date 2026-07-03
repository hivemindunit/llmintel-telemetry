import { sendBatch, type TransportOptions } from "./transport";
import type { UsageRecord } from "./types";

export interface BufferOptions extends TransportOptions {
  flushAt: number;
  flushIntervalMs: number;
  environment?: string;
}

/**
 * An in-memory, metadata-only record buffer. Accumulates {@link UsageRecord}s and flushes them to
 * the ingest endpoint on a size threshold, a timer, or an explicit/exit flush. Every operation is
 * guarded so the buffer can never throw into the host app.
 */
export class TelemetryBuffer {
  private records: UsageRecord[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;

  constructor(private readonly opts: BufferOptions) {
    if (opts.flushIntervalMs > 0) {
      this.timer = setInterval(() => {
        void this.flush();
      }, opts.flushIntervalMs);
      // Don't keep the event loop alive just for telemetry.
      this.timer.unref?.();
    }
  }

  /** Add a record. Applies the client-level environment tag if the record didn't set one. */
  add(record: UsageRecord): void {
    if (this.opts.environment && record.environment === undefined) {
      record.environment = this.opts.environment;
    }
    this.records.push(record);
    if (this.records.length >= this.opts.flushAt) {
      void this.flush();
    }
  }

  /** Number of buffered records not yet flushed. */
  get size(): number {
    return this.records.length;
  }

  /**
   * Flush all buffered records. Best-effort and re-entrancy-safe: concurrent calls coalesce onto the
   * in-flight flush. Never rejects — transport errors are swallowed by {@link sendBatch}.
   */
  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.records.length === 0) return;

    const batch = this.records;
    this.records = [];

    this.flushing = sendBatch(batch, this.opts).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /** Stop the interval timer and flush any remaining records. */
  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}

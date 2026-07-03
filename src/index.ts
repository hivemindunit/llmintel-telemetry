import { TelemetryBuffer } from "./buffer";
import {
  extractAnthropic,
  extractGoogle,
  extractOpenAI,
} from "./providers/index";
import { isServerless, resolveWaitUntil } from "./serverless";
import { DEFAULT_ENDPOINT } from "./transport";
import type { InstrumentOptions, UsageExtractor, UsageRecord } from "./types";

export type { InstrumentOptions, UsageRecord, UsageExtractor } from "./types";
export {
  extractOpenAI,
  extractAnthropic,
  extractBedrock,
  extractGoogle,
  extractAzureOpenAI,
} from "./providers/index";
export { TelemetryBuffer } from "./buffer";

/** A handle returned by {@link instrument} for manual control and clean shutdown. */
export interface TelemetryHandle {
  /** Record a usage entry directly (escape hatch, e.g. for Bedrock or unwrapped calls). */
  record: (record: UsageRecord) => void;
  /** Force-flush buffered records now. Best-effort; never rejects. */
  flush: () => Promise<void>;
  /** Stop timers and flush. Call on graceful shutdown. */
  close: () => Promise<void>;
}

interface Resolved {
  apiKey: string;
  endpoint: string;
  buffer: TelemetryBuffer;
  onError: (error: unknown) => void;
  /**
   * Called after each instrumented call resolves. In serverless this ships buffered records before
   * the runtime freezes — either via a platform `waitUntil` (returns immediately) or by returning a
   * promise the wrapper awaits inline. In a long-running process it's a no-op (background timer/exit
   * hook handle flushing). Never rejects.
   */
  afterCall: () => Promise<void> | void;
}

function noop(): void {}

function resolveOptions(options: InstrumentOptions): Resolved | null {
  const apiKey = options.apiKey ?? process.env.LLMINTEL_API_KEY;
  const onError = options.onError ?? noop;
  if (!apiKey) {
    // No key → disable silently rather than throw (never break the host app on misconfiguration).
    onError(new Error("LLMIntel telemetry disabled: no apiKey and LLMINTEL_API_KEY unset."));
    return null;
  }
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    onError(new Error("LLMIntel telemetry disabled: no global fetch (Node <18?)."));
    return null;
  }
  const buffer = new TelemetryBuffer({
    apiKey,
    endpoint,
    fetchImpl,
    onError,
    flushAt: options.flushAt ?? 50,
    flushIntervalMs: options.flushIntervalMs ?? 10_000,
    environment: options.environment,
  });

  // Resolve the per-call flush strategy. `"auto"` becomes per-call flushing in a serverless runtime
  // (where the background timer/exit hook can't fire before freeze) and background-only otherwise.
  const mode = options.flushMode ?? "auto";
  const perCallFlush = mode === "sync" || (mode === "auto" && isServerless());
  const waitUntil = perCallFlush ? resolveWaitUntil(options.waitUntil) : null;

  const afterCall: () => Promise<void> | void = !perCallFlush
    ? noop
    : waitUntil
      ? () => {
          // Zero-latency: extend the request's life past the response so the flush still runs.
          waitUntil(buffer.flush());
        }
      : () => buffer.flush(); // Inline: the wrapper awaits this before the host's await resolves.

  if (!options.disableExitFlush && typeof process !== "undefined" && process.once) {
    process.once("beforeExit", () => {
      void buffer.flush();
    });
  }

  return { apiKey, endpoint, buffer, onError, afterCall };
}

/** Detect which provider a client belongs to by structural fingerprint (no SDK imports needed). */
function detectExtractor(client: unknown): UsageExtractor | null {
  const c = client as Record<string, unknown> | null;
  if (!c || typeof c !== "object") return null;
  const ctorName = (c.constructor as { name?: string } | undefined)?.name ?? "";

  const chat = c.chat as Record<string, unknown> | undefined;
  const hasOpenAiChat =
    chat && typeof (chat.completions as Record<string, unknown> | undefined)?.create === "function";
  const hasResponses = typeof (c.responses as Record<string, unknown> | undefined)?.create === "function";
  if (hasOpenAiChat || hasResponses || /openai/i.test(ctorName)) return extractOpenAI;

  const hasMessages = typeof (c.messages as Record<string, unknown> | undefined)?.create === "function";
  if (hasMessages || /anthropic/i.test(ctorName)) return extractAnthropic;

  if (typeof c.getGenerativeModel === "function" || /generative/i.test(ctorName)) {
    return extractGoogle;
  }

  return null;
}

/**
 * Wrap a method on `target[path]` so its (awaited) return value is passed to `extract`, and any
 * resulting {@link UsageRecord} is buffered. The wrapper preserves the original return value exactly
 * and swallows extraction errors — the host call is never affected.
 */
function wrapMethod(
  container: Record<string, unknown> | undefined,
  method: string,
  extract: UsageExtractor,
  buffer: TelemetryBuffer,
  onError: (e: unknown) => void,
  afterCall: () => Promise<void> | void,
): void {
  if (!container || typeof container[method] !== "function") return;
  const original = container[method] as (...args: unknown[]) => unknown;
  container[method] = function wrapped(this: unknown, ...args: unknown[]): unknown {
    const result = original.apply(this, args);
    if (result instanceof Promise) {
      return result.then(async (value) => {
        try {
          const model = extractModelFromArgs(args);
          const record = extract(value, model);
          if (record) {
            buffer.add(record);
            // In serverless (`afterCall` flushes) we await it here so the record is shipped before
            // the host returns and the runtime freezes. `waitUntil` mode returns instantly; inline
            // mode adds one small ingest request. Never throws — flush swallows transport errors.
            await afterCall();
          }
        } catch (error) {
          onError(error);
        }
        return value;
      });
    }
    return result;
  };
}

/** Best-effort read of `{ model }` from the first argument (the request body most SDKs accept). */
function extractModelFromArgs(args: unknown[]): string | undefined {
  const first = args[0];
  if (first && typeof first === "object" && "model" in first) {
    const model = (first as { model?: unknown }).model;
    if (typeof model === "string") return model;
  }
  return undefined;
}

/**
 * Instrument a provider SDK client so model usage (metadata only) is recorded and shipped to
 * LLMIntel. Returns the **same client** (mutated in place) plus a handle for manual flush/close.
 *
 * ```ts
 * import OpenAI from "openai";
 * import { instrument } from "@llmintel/telemetry";
 * const openai = instrument(new OpenAI(), { apiKey: process.env.LLMINTEL_API_KEY });
 * ```
 *
 * Supported auto-wiring: OpenAI (`chat.completions.create`, `responses.create`), Azure OpenAI (same
 * client), and Anthropic (`messages.create`). For Google Gemini and AWS Bedrock (per-model / command
 * patterns that aren't a single stable method on the client), use the returned `record()` with
 * {@link extractGoogle} / {@link extractBedrock}.
 *
 * The agent is **best-effort and never throws** into the host app: a missing key, missing fetch, or
 * flush failure disables/skips telemetry silently (routed to `onError` if provided).
 */
export function instrument<T>(
  client: T,
  options: InstrumentOptions = {},
): T & { __llmintel: TelemetryHandle } {
  const resolved = resolveOptions(options);

  const handle: TelemetryHandle = resolved
    ? {
        record: (record) => {
          resolved.buffer.add(record);
          // Best-effort per-call flush for the escape hatch too. With a platform `waitUntil` this
          // ships the record after the response for free. In inline (no-waitUntil) serverless, this
          // starts the flush but can't be awaited through a void `record()` — those users should
          // still `await handle.flush()` before returning (see README serverless notes).
          void resolved.afterCall();
        },
        flush: () => resolved.buffer.flush(),
        close: () => resolved.buffer.close(),
      }
    : { record: noop, flush: async () => {}, close: async () => {} };

  if (resolved && client && typeof client === "object") {
    const extractor = detectExtractor(client);
    if (extractor) {
      const c = client as Record<string, unknown>;
      // OpenAI / Azure OpenAI
      wrapMethod(
        (c.chat as Record<string, unknown> | undefined)?.completions as
          | Record<string, unknown>
          | undefined,
        "create",
        extractor,
        resolved.buffer,
        resolved.onError,
        resolved.afterCall,
      );
      wrapMethod(
        c.responses as Record<string, unknown> | undefined,
        "create",
        extractor,
        resolved.buffer,
        resolved.onError,
        resolved.afterCall,
      );
      // Anthropic
      wrapMethod(
        c.messages as Record<string, unknown> | undefined,
        "create",
        extractor,
        resolved.buffer,
        resolved.onError,
        resolved.afterCall,
      );
    } else {
      resolved.onError(
        new Error("LLMIntel telemetry: unrecognized client; use the returned record() escape hatch."),
      );
    }
  }

  Object.defineProperty(client as object, "__llmintel", {
    value: handle,
    enumerable: false,
    configurable: true,
  });
  return client as T & { __llmintel: TelemetryHandle };
}

/** Anything exposing the `__llmintel` handle (an instrumented client) or the handle itself. */
type Flushable = { __llmintel: TelemetryHandle } | TelemetryHandle;

function toHandle(target: Flushable): TelemetryHandle {
  return "__llmintel" in target ? target.__llmintel : target;
}

/**
 * Wrap a request handler so buffered telemetry is flushed after it settles — the explicit,
 * zero-config way to guarantee delivery in serverless without touching the handler body or knowing
 * about `waitUntil`. Works for any `(...args) => Promise<R>` handler (Next.js route handlers,
 * server actions, Lambda handlers, etc.).
 *
 * ```ts
 * const openai = instrument(new OpenAI(), { environment: "prod" });
 * export const POST = withTelemetry(openai, async (req: Request) => {
 *   const reply = await openai.chat.completions.create({ ... });
 *   return Response.json({ reply });
 * });
 * ```
 *
 * The flush is best-effort and never alters the handler's result or error: the original value is
 * returned (or the original error re-thrown) unchanged, after the flush is awaited. Pass either an
 * instrumented client or its `__llmintel` handle as `target`.
 */
export function withTelemetry<A extends unknown[], R>(
  target: Flushable,
  handler: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  const flush = () => toHandle(target).flush();
  return async (...args: A): Promise<R> => {
    try {
      const result = await handler(...args);
      await flush(); // best-effort; never rejects
      return result;
    } catch (error) {
      await flush(); // still ship what was recorded before the failure
      throw error;
    }
  };
}

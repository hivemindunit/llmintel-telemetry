/**
 * The closed, metadata-only record shape sent to `POST /v1/telemetry`. This is the entire network
 * payload surface — there is no field in which prompt/response content could ride along (see the
 * package README's "metadata-only guarantee").
 */
export interface UsageRecord {
  /** The raw model id the app invoked (e.g. "gpt-4o-2024-05-13"). */
  model: string;
  /** Provider-reported input/prompt tokens. */
  inputTokens: number;
  /** Provider-reported output/completion tokens. */
  outputTokens: number;
  /** Number of requests this record represents (default 1). */
  requestCount?: number;
  /** ISO timestamp of the call; the server hour-truncates it. */
  ts?: string;
  /** Optional environment tag ("prod"/"staging"); server defaults to "default". */
  environment?: string;
  /** Cached-input tokens, when the provider reports them (captured, not yet priced distinctly). */
  cachedInputTokens?: number;
  /** Batch-endpoint input tokens, when reported. */
  batchInputTokens?: number;
  /** Batch-endpoint output tokens, when reported. */
  batchOutputTokens?: number;
}

/** Options for {@link instrument}. */
export interface InstrumentOptions {
  /** LLMIntel API key (Bearer). Falls back to `process.env.LLMINTEL_API_KEY`. */
  apiKey?: string;
  /**
   * Ingest endpoint. Defaults to LLMIntel production. Point this at a local echo server to audit
   * exactly what leaves the process.
   */
  endpoint?: string;
  /** Optional environment tag applied to every record from this client (e.g. "prod"). */
  environment?: string;
  /** Flush when the buffer reaches this many records (default 50). */
  flushAt?: number;
  /** Flush at least this often, in ms (default 10000). Set 0 to disable interval flushing. */
  flushIntervalMs?: number;
  /** Also ask the server to register discovered models on the account's watch set. */
  syncWatches?: boolean;
  /** Opt-out of the process-exit flush hook (default false — the hook is installed). */
  disableExitFlush?: boolean;
  /**
   * Optional error sink for diagnostics. The agent NEVER throws into the host app; flush failures
   * are swallowed. Provide this only if you want visibility. Defaults to a no-op.
   */
  onError?: (error: unknown) => void;
  /** Injected fetch (for tests). Defaults to global `fetch`. */
  fetch?: typeof fetch;
}

/** Extracts a {@link UsageRecord} from a provider response, or null if there's no usage to record. */
export type UsageExtractor = (response: unknown, model?: string) => UsageRecord | null;

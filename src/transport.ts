import type { UsageRecord } from "./types";

export const DEFAULT_ENDPOINT = "https://llmintel.ai/v1/telemetry";

export interface TransportOptions {
  endpoint: string;
  apiKey: string;
  syncWatches: boolean;
  fetchImpl: typeof fetch;
  onError: (error: unknown) => void;
}

/**
 * POST a batch of metadata-only records to the ingest endpoint. **Best-effort**: any failure
 * (network, non-2xx, serialization) is routed to `onError` and swallowed — telemetry must never
 * throw into or block the host app's request path.
 */
export async function sendBatch(records: UsageRecord[], opts: TransportOptions): Promise<void> {
  if (records.length === 0) return;
  try {
    const response = await opts.fetchImpl(opts.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({ records, syncWatches: opts.syncWatches }),
    });
    if (!response.ok) {
      opts.onError(new Error(`LLMIntel telemetry ingest returned ${response.status}`));
    }
  } catch (error) {
    opts.onError(error);
  }
}

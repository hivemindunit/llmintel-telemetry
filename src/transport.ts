import type { UsageRecord } from "./types";

export const DEFAULT_ENDPOINT = "https://llmintel.ai/v1/telemetry";

export interface TransportOptions {
  endpoint: string;
  apiKey: string;
  fetchImpl: typeof fetch;
  onError: (error: unknown) => void;
}

/**
 * POST a batch of metadata-only records to the ingest endpoint. **Best-effort**: any failure
 * (network, non-2xx, serialization) is routed to `onError` and swallowed — telemetry must never
 * throw into or block the host app's request path.
 *
 * On a non-2xx response the error message includes the server's response body (truncated), because
 * the ingest endpoint returns an actionable `{ error, message }` on 4xx (e.g. the exact validation
 * reason behind a 400, or the upgrade prompt behind a 402). Without it the host app only sees a bare
 * status code, which is not enough to diagnose a rejected batch.
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
      body: JSON.stringify({ records }),
    });
    if (!response.ok) {
      const detail = await readErrorDetail(response);
      opts.onError(
        new Error(
          `LLMIntel telemetry ingest returned ${response.status}${detail ? `: ${detail}` : ""}`,
        ),
      );
    }
  } catch (error) {
    opts.onError(error);
  }
}

/**
 * Read a short, safe diagnostic from a non-2xx response. Prefers the API's `message` field, falls
 * back to raw text, and truncates. Never throws (a body that can't be read yields an empty string).
 */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return "";
    let message = text;
    try {
      const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
      if (typeof parsed.message === "string" && parsed.message) message = parsed.message;
      else if (typeof parsed.error === "string" && parsed.error) message = parsed.error;
    } catch {
      // Not JSON — use the raw text.
    }
    return message.length > 300 ? `${message.slice(0, 300)}…` : message;
  } catch {
    return "";
  }
}

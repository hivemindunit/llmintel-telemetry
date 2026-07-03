/**
 * Serverless environment detection and `waitUntil` resolution.
 *
 * Serverless platforms freeze the process the instant a handler returns its response, so the
 * background flush timer and `beforeExit` hook never fire — buffered telemetry is silently dropped.
 * The wrapper compensates by flushing per-call in these environments (see {@link InstrumentOptions.flushMode}).
 */

/** True when running on a known serverless platform where post-response background work is frozen. */
export function isServerless(): boolean {
  // Cloudflare Workers: no Node `process`, but a global `WebSocketPair`.
  if (typeof (globalThis as Record<string, unknown>).WebSocketPair !== "undefined") return true;

  const env = typeof process !== "undefined" ? process.env : undefined;
  if (!env) return false;

  return Boolean(
    env.VERCEL || // Vercel (functions + edge)
      env.AWS_LAMBDA_FUNCTION_NAME || // AWS Lambda
      env.LAMBDA_TASK_ROOT || // AWS Lambda (alt marker)
      env.FUNCTIONS_WORKER_RUNTIME || // Azure Functions
      env.K_SERVICE || // Google Cloud Run / Functions (Knative)
      env.NETLIFY || // Netlify Functions
      env.CF_PAGES, // Cloudflare Pages Functions
  );
}

type WaitUntil = (promise: Promise<unknown>) => void;

/**
 * Best-effort resolution of a platform `waitUntil`, used to run a flush *after* the response without
 * adding request latency. Prefers an explicitly injected `waitUntil`, then Vercel's
 * `@vercel/functions` (an optional peer — never a hard dependency). Returns null when none is
 * reachable, in which case the caller falls back to an inline awaited flush.
 *
 * The `@vercel/functions` lookup is wrapped in try/catch and a dynamic require/import so bundlers on
 * other platforms don't choke on a missing optional module.
 */
export function resolveWaitUntil(injected?: WaitUntil): WaitUntil | null {
  if (typeof injected === "function") return injected;

  try {
    // Avoid a static import so the optional dep isn't required to exist.
    const req = (globalThis as { require?: (id: string) => unknown }).require;
    if (typeof req === "function") {
      const mod = req("@vercel/functions") as { waitUntil?: WaitUntil } | undefined;
      if (mod && typeof mod.waitUntil === "function") return mod.waitUntil;
    }
  } catch {
    // Not installed / not resolvable — fall through to inline flushing.
  }

  return null;
}

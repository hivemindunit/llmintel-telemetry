# @llmintel/telemetry

Metadata-only runtime telemetry for LLM model usage & cost analysis. A thin wrapper around the
official provider SDKs (OpenAI, Azure OpenAI, Anthropic, Google Gemini, AWS Bedrock) that reads the
**token-usage fields providers already return** and ships them to [LLMIntel](https://llmintel.ai) —
so your cost & optimization dashboard reflects the models you *actually* run at runtime, including
the ones configured per-tenant or swapped via an env var.

- **Metadata only.** It reads `response.usage` (token counts, model id). It **never** reads or sends
  your prompts, completions, tool args, or any message content. See [the guarantee](#metadata-only-guarantee).
- **Never breaks your app.** Every operation is best-effort and swallowed: a bad key, offline
  network, or flush error is routed to an optional `onError` and otherwise ignored. Telemetry must
  not degrade the product it observes.
- **Exact numbers.** Uses provider-reported token counts — no estimation.
- **Auditable & MIT-licensed.** Source is public; the entire network payload is the small closed
  schema documented below.

## Install

```bash
pnpm add @llmintel/telemetry
# provider SDKs are peer deps — install only the ones you use, e.g.
pnpm add openai
```

Set your LLMIntel API key — create an **account-scoped** key in your
[dashboard](https://llmintel.ai/dashboard) (telemetry requires one):

```bash
export LLMINTEL_API_KEY="li_..."
```

## Usage

### OpenAI / Azure OpenAI / Anthropic (auto-wired)

```ts
import OpenAI from "openai";
import { instrument } from "@llmintel/telemetry";

const openai = instrument(new OpenAI(), {
  environment: "prod", // optional tag → per-env cost breakdown
});

// use the client normally — usage is recorded from response.usage and flushed in the background
await openai.chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
```

`instrument()` returns the same client, wired in place, with a non-enumerable `__llmintel` handle:

```ts
await openai.__llmintel.flush();  // force a flush (best-effort)
await openai.__llmintel.close();  // stop timers + final flush (graceful shutdown)
```

### Serverless (Vercel / AWS Lambda / Cloudflare Workers) — automatic

In a long-running process the background timer and exit hook flush for you. In a **serverless**
function the runtime **freezes the moment you return the response**, so those never fire. As of
**v0.3**, the wrapper handles this for you: it **auto-detects** serverless runtimes (Vercel, AWS
Lambda, Google Cloud Run/Functions, Azure Functions, Netlify, Cloudflare) and flushes after each
instrumented call — so **no code change is needed**.

By default it flushes **inline** (the instrumented call's promise also awaits a small ingest
request, adding a little tail latency). To make that flush **zero-latency**, give it your platform's
`waitUntil` so the response returns immediately and the flush finishes in the background:

```ts
import { waitUntil } from "@vercel/functions";
import OpenAI from "openai";
import { instrument } from "@llmintel/telemetry";

// Once, at module scope. `@vercel/functions`' waitUntil is also auto-detected if installed —
// passing it explicitly is just the portable, dependency-agnostic way.
const openai = instrument(new OpenAI(), { environment: "prod", waitUntil });

export async function POST(req: Request) {
  const reply = await openai.chat.completions.create({ /* ... */ });
  return Response.json({ reply }); // telemetry already shipped via waitUntil
}
```

Prefer wrapping the whole handler? `withTelemetry` flushes on the way out (success **and** error),
which also covers the Gemini/Bedrock `record()` escape hatch and any non-Vercel runtime:

```ts
import { instrument, withTelemetry } from "@llmintel/telemetry";

const openai = instrument(new OpenAI(), { environment: "prod" });

export const POST = withTelemetry(openai, async (req: Request) => {
  const reply = await openai.chat.completions.create({ /* ... */ });
  return Response.json({ reply });
});
```

Override auto-detection with `flushMode`: `"sync"` forces per-call flushing everywhere, `"background"`
restores the pre-0.3 fire-and-forget behavior (correct only for long-running servers).

### Google Gemini / AWS Bedrock (record() escape hatch)

These use per-model / command patterns that aren't a single stable method on the client, so record
their usage explicitly with the provided extractors:

```ts
import { instrument, extractBedrock, extractGoogle } from "@llmintel/telemetry";

const t = instrument({}, { environment: "prod" }); // empty client → handle only

// Bedrock Converse — pass the modelId you invoked (it's not on the response)
const out = await bedrock.send(command);
const rec = extractBedrock(out, "anthropic.claude-3-5-sonnet-20241022-v2:0");
if (rec) t.__llmintel.record(rec);

// Gemini
const result = await model.generateContent(prompt);
const grec = extractGoogle(result, "gemini-1.5-pro");
if (grec) t.__llmintel.record(grec);
```

## Options

| Option             | Default                          | Description                                              |
| ------------------ | -------------------------------- | -------------------------------------------------------- |
| `apiKey`           | `process.env.LLMINTEL_API_KEY`   | LLMIntel API key (Bearer).                               |
| `endpoint`         | `https://llmintel.ai/v1/telemetry` | Ingest endpoint. Point at a local server to audit it.  |
| `environment`      | `"default"` (server-side)        | Tag applied to every record (e.g. `"prod"`/`"staging"`). |
| `flushMode`        | `"auto"`                         | `"auto"` (per-call flush in serverless, background otherwise), `"sync"` (always per-call), `"background"` (pre-0.3). |
| `waitUntil`        | auto-detected                    | Platform primitive for zero-latency post-response flush (e.g. `@vercel/functions`' `waitUntil`). |
| `flushAt`          | `50`                             | Flush when the buffer reaches this many records.         |
| `flushIntervalMs`  | `10000`                          | Flush at least this often. `0` disables the timer.       |
| `disableExitFlush` | `false`                          | Skip the `beforeExit` flush hook.                        |
| `onError`          | no-op                            | Diagnostics sink; the agent never throws.                |

## Metadata-only guarantee

The **entire** network payload is this closed schema — there is no field in which content could
ride along:

```jsonc
{
  "records": [
    {
      "model": "gpt-4o-2024-05-13",
      "inputTokens": 12000,
      "outputTokens": 3400,
      "requestCount": 1,
      "ts": "2026-06-30T14:07:11Z",   // optional; server hour-truncates
      "environment": "prod",           // optional
      "cachedInputTokens": 800,        // optional, from provider usage metadata
      "batchInputTokens": 0,
      "batchOutputTokens": 0
    }
  ]
}
```

The extractors read only `response.usage` (and the request's `model`). They never touch `messages`,
`prompt`, `input`, tool args, or completion text.

### Verify it yourself

Point the agent at a local echo server and inspect exactly what leaves your process:

```ts
const openai = instrument(new OpenAI(), { endpoint: "http://localhost:8787/echo" });
```

```bash
# minimal echo server
node -e "require('http').createServer((q,s)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{console.log(b);s.end('{}')})}).listen(8787)"
```

You'll see only the metadata schema above — no prompt or response text.

## How it works

The wrapper buffers records in memory and flushes on a size threshold, an interval, or process
exit. In serverless the runtime freezes after the response, so the wrapper auto-detects that and
flushes per call instead (inline, or via `waitUntil` when available) — see
[Serverless](#serverless-vercel--aws-lambda--cloudflare-workers--automatic). Bucketing, model
resolution, and pricing all happen **server-side** — the agent stays deliberately dumb, which is why
re-bucketing or fixing model resolution never requires a client upgrade. Cost is priced at ingest
and frozen, so historic spend never shifts.

## Releasing

`@llmintel/telemetry` is developed in the private monorepo but **published from the public mirror**
`github.com/hivemindunit/llmintel-telemetry` — npm provenance only accepts a public source repo.

1. Tag the monorepo: `git tag telemetry-v0.1.0 && git push origin telemetry-v0.1.0`.
2. The monorepo workflow copies `packages/telemetry` to the public mirror, generates a committed
   `package-lock.json` for a reproducible build, and pushes a `v0.1.0` tag there (needs a
   `MIRROR_PUSH_TOKEN` with Contents: read/write on the mirror).
3. The mirror's own workflow runs `npm ci && npm run build && npm publish --access public
   --provenance` (needs the mirror's `NPM_TOKEN`, a granular token with read/write on the
   `@llmintel` scope, and `id-token: write`).

The mirror workflow source is staged at `packages/telemetry/.github-mirror/workflows/publish.yml`;
copy it into the mirror repo as `.github/workflows/publish.yml`.

## License

MIT © LLMIntel

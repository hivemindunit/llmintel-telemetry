# Contributing to `@llmintel/telemetry`

The metadata-only runtime telemetry agent for LLM usage & cost analysis. This package is developed
inside the private `hivemindunit/llmintel.ai` monorepo and **published from a public mirror**
(`hivemindunit/llmintel-telemetry`) so the npm release carries a verifiable provenance attestation.

## Development

All work happens in the monorepo at `packages/telemetry`. From the repo root:

```bash
pnpm install                                   # install workspace deps
pnpm --filter @llmintel/telemetry run typecheck
pnpm --filter @llmintel/telemetry run build
pnpm exec vitest run packages/telemetry        # unit tests
```

- Source lives in `src/`. The public API surface is `src/index.ts` (`instrument`, `record`) and
  `src/types.ts` (`UsageRecord`, `InstrumentOptions`).
- Provider usage extractors live in `src/providers/`. Add a new provider by implementing an
  extractor that returns a `UsageRecord` (or `null` when usage is absent) and wiring it into
  `detectExtractor` / the `record()` path.
- Keep the agent **best-effort and non-throwing**: nothing here may break the host application.
  Network and extraction failures must be swallowed.
- Keep it **metadata-only**: never read or transmit prompt/response content, tool args, or system
  prompts. Only token counts, model id, and the timestamp leave the process.

## Design invariants

- **Dumb client, smart server.** Bucketing, model resolution, and pricing happen server-side; the
  agent just batches raw `UsageRecord`s. This lets us fix pricing/resolution without a client bump.
- **Peer dependencies, not bundled.** Provider SDKs are optional `peerDependencies` and are marked
  `external` in `tsup.config.ts` — the host provides the client instance.

## Releasing

Releases are fully automated via a two-repo flow (see the RFC "Publish workflow" section for why):

1. Bump `version` in `package.json` (semver; stay on `0.x` until the `/v1/telemetry` ingest contract
   is frozen, then `1.0.0`).
2. Commit to `main` in the monorepo.
3. Tag and push from the monorepo:

   ```bash
   git tag telemetry-v<x.y.z>
   git push origin telemetry-v<x.y.z>
   ```

   The tag version **must** equal `package.json`'s `version`; the sync job fails fast otherwise.

What the pipeline does:

- **Monorepo** (`.github/workflows/publish-telemetry.yml`): copies `packages/telemetry` into a clean
  standalone tree, swaps in the self-contained `.github-mirror/tsconfig.mirror.json`, adds
  `@types/node`, generates a committed `package-lock.json`, and pushes the tree + a `v<x.y.z>` tag to
  the public mirror. Publishes nothing to npm itself.
- **Mirror** (`.github/workflows/publish.yml`, staged at `.github-mirror/workflows/publish.yml`):
  `npm ci → typecheck → build → npm publish --access public --provenance`. The mirror is public, so
  npm accepts the provenance attestation.

### Verifying a release

```bash
npm view @llmintel/telemetry version
npm audit signatures   # in a project that installed the package; verifies provenance
```

The provenance statement is also visible on the npm package page and in the Sigstore transparency
log referenced by the publish job.

## Required secrets

| Secret              | Location                                   | Scope                                             |
| ------------------- | ------------------------------------------ | ------------------------------------------------- |
| `MIRROR_PUSH_TOKEN` | monorepo, `production` environment         | fine-grained PAT: Contents + Workflows read/write on the mirror repo |
| `NPM_TOKEN`         | mirror repo, Actions secrets               | granular npm token: read/write on the `@llmintel` scope |

`MIRROR_PUSH_TOKEN` needs the **Workflows** permission (not just Contents) because the pushed tree
includes `.github/workflows/publish.yml`.

# Jovita creator tool

The public TypeScript SDK and `jov` CLI for building Jovita apps. The SDK describes an app and runs its tools. The CLI creates, tests, bundles, connects, and submits the app. Provider keys stay in Jovita's private broker and never go in source code or a `.jov` bundle.

## A one-call API app

```ts
import { defineApp, provider } from '@jovita-ai/sdk';
import { z } from 'zod';

const search = provider({
  name: 'Example Search',
  baseUrl: 'https://api.example.com',
  auth: 'bearer',
});

export default defineApp({
  id: 'web-search',
  name: 'Web Search',
  version: '1.0.0',
  tools: {
    search: search.post('/search', {
      description: 'Find web pages for a query',
      input: z.object({ query: z.string().min(1) }),
      output: z.object({ results: z.array(z.object({ title: z.string() })) }),
      creditsPerCall: 10,
    }),
  },
});
```

`provider()` describes a host and authentication method. The `search.post()` declaration describes one versioned operation, its schemas, and its fixed buyer credit price. The key is entered separately with `jov connect` after Jovita approves the host. The tool can only call its declared operation, at most once per invocation. The app's one-time purchase price is set separately at submission.

## Start and test

Requires Node.js 22.19 or newer. Install the CLI from npm. `jov init` adds the SDK and runtime to executable projects; skill-only projects do not need them.

```sh
npm install -g @jovita-ai/cli
jov init web-search
cd web-search
npm install
npm run dev
jov lint
jov build --target linux-amd64
jov verify build/web-search-0.1.0-linux-amd64.jov
```

`jov dev` uses JSON fixtures from `fixtures/` and prints each broker call. It does not spend provider money or buyer credits. `jov connect` runs a real provider test, which can incur a provider charge for a non-GET operation. Use `--test-operation`, `--sample-input`, and `--confirm-provider-charge` for that case.

For a skill-only app, use `jov init my-skill --template skill`, edit `skill/SKILL.md`, then run `jov build`. No Node runtime target or SDK dependency is needed.

To work from this repository, run `npm install && npm run build && npm test` at the root. The checked-in examples use local package references.

## Connect and submit

```sh
jov login --email creator@example.com
export JOVITA_PROVIDER_API_KEY='your-provider-key'
jov connect example_search --test-operation search --sample-input '{"query":"hello"}' --confirm-provider-charge
jov submit build/web-search-1.0.0-linux-amd64.jov --price-cents 0
```

`jov login` uses the creator email code flow and saves rotating session tokens under `~/.config/jovita/creator-session.json` with owner-only file permissions. Set `JOVITA_API_URL` to another HTTPS API origin for a nonproduction environment. For automation, `JOVITA_CREATOR_TOKEN` can replace a saved session. Run `jov logout` to remove the local session.

The server imports the public declaration and requests host approval. If approval or a tested connection is missing, `jov submit` leaves the release as a draft. Finish setup, then rerun with `--release-id`. The release still needs Jovita's publishing review. Neither the CLI nor SDK handles the buyer's card or wallet; Jovita reserves and settles the declared credits for each successful operation call.

## Custom apps

Use `jov init my-app --template custom` when a tool needs branching, several providers, or a long-running workflow. A `JovitaTool` class implements `run(ctx, input)` and lists each allowed operation with its maximum call count. `ctx.call()` provides stable call IDs, delivery acknowledgment, and recovery through the SDK runtime client. You can split providers, tools, and app registration across files; `src/jovita.app.ts` is the single authoring entry point. See [the custom example](examples/custom-example/src/jovita.app.ts).

The SDK compiles both styles into the same manifest and `.jov` format. Existing hand-written `jovita.service.json` projects remain supported. Keep one authoring source for each project.

## Existing command miniapps

An existing command miniapp keeps its source and SDK declaration together under `runtime/`. Put `defineRuntimeApp({...})` in `runtime/jovita.app.ts`, next to its `runtime/src/` code. Larger apps can keep their operation grants in `runtime/operation-contracts.ts` and their storefront details in `runtime/release-metadata.ts`. The SDK supplies the standard broker protocol and skill path. Run `jov sync` to generate its compatibility `jovita.service.json`; `jov sync --check`, `jov lint`, and `jov build` reject a stale copy. New apps should use `defineApp` and SDK `ctx.call()` directly.

```ts
import { defineRuntimeApp } from '@jovita-ai/sdk';
import { operations } from './operation-contracts.js';

export default defineRuntimeApp({
  id: 'my-command', name: 'My Command', version: '1.0.0',
  description: 'Run a command with approved broker operations.',
  operations,
  healthCheck: { command: 'my-command', args: ['--help'], operationId: 'offline' },
});
```

An executable app cannot omit its operation grants: Jovita uses them to authorize and bill broker calls. A skill-only app has no command runtime or broker calls. Create one with `jov init my-skill --template skill`; it needs `skill/SKILL.md`, a small `jovita.service.json`, and the CLI for packaging, but it does not need `@jovita-ai/sdk` or `@jovita-ai/runtime`. Developers who prefer a typed declaration can use the optional `defineSkillApp({...})` helper.

The 17 retained first-party miniapps use this migration path in the Jovita SaaS repository. Their declarations are checked against the compatibility manifests, and their brokered runtimes use the public `@jovita-ai/runtime` call client. Broker operation IDs, tool grants, commands, activity metadata, and buyer-facing release details are preserved during migration.

## Repository layout

- `packages/sdk`: public authoring API, compiler, and schemas.
- `packages/runtime`: small authenticated call client shared by the SDK and existing miniapps.
- `packages/cli`: project commands and `.jov` packaging.
- `examples/fluent-example`: direct API tool.
- `examples/custom-example`: class-based workflow.

The broker, creator credentials, buyer billing, and platform lifecycle services stay in Jovita's private server repositories. Existing published miniapps import `@jovita-ai/runtime` directly; it is the same call transport that SDK apps use through `ctx.call()`.

## npm releases

The three public packages are `@jovita-ai/runtime`, `@jovita-ai/sdk`, and `@jovita-ai/cli`. Runtime is published first because the SDK depends on it; the SDK is published before the CLI. Package versions are immutable on npm. When changing the SDK version, update the CLI's exact SDK dependency too. `jov init` reads these versions from the CLI package so generated projects install the matching release.

The [publish workflow](.github/workflows/publish.yml) runs on tags named `npm-v<version>` that point to commits on `main`. The tag version must equal the CLI version; SDK and runtime versions change independently. Before tagging, run `npm ci && npm run build && npm run typecheck && npm test`, then review `npm pack --dry-run -w @jovita-ai/runtime`, `npm pack --dry-run -w @jovita-ai/sdk`, and `npm pack --dry-run -w @jovita-ai/cli`. Push the release commit, then create and push the tag, for example `git tag npm-v0.1.4 && git push origin npm-v0.1.4`. The workflow skips any package version already published, which allows a partial release to resume in dependency order.

Publishing uses npm trusted publishing with GitHub Actions OIDC. Each package must have a trusted publisher configured on npm: GitHub owner `VenbrinoDevelopers`, repository `jovita-creator-tool`, workflow filename `publish.yml`, and direct `npm publish` permission. No npm token is stored in GitHub. The initial version of a new package must be published by its owning npm account before its trusted publisher can be configured.

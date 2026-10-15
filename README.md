# Jovita creator tool

The public TypeScript SDK, `jov` CLI, provider catalog, and standalone broker for building Jovita apps. The SDK describes an app and runs its tools. The CLI creates, tests, bundles, connects, and submits the app. Provider keys stay in the broker's database and never go in source code or a `.jov` bundle. Jovita Cloud runs its broker privately.

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

Requires Node.js 22.19 or newer. Install the CLI from npm. `jov init` adds the SDK to executable projects; skill-only projects do not need it.

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

The server imports the public broker operation declaration and validates its HTTPS host automatically. If the host fails validation or a tested connection is missing, `jov submit` leaves the release as a draft. Finish setup, then rerun with `--release-id`. Fill in the buyer-facing store listing, prompts, and examples in Creator Studio when uploading or afterward; they are not part of the SDK app declaration. The release still needs Jovita's publishing review. Neither the CLI nor SDK handles the buyer's card or wallet; Jovita reserves and settles the declared credits for each successful operation call.

## Custom apps

Use `jov init my-app --template custom` when a tool needs branching, several providers, or a long-running workflow. A `JovitaTool` class implements `run(ctx, input)` and lists each allowed operation with its maximum call count. `ctx.call()` provides stable call IDs, delivery acknowledgment, and recovery through the SDK runtime client. You can split providers, tools, and app registration across files; `src/jovita.app.ts` is the single authoring entry point. See [the custom example](examples/custom-example/src/jovita.app.ts).

The SDK compiles both styles into the same manifest and `.jov` format. Existing hand-written `jovita.service.json` projects remain supported. Keep one authoring source for each project.

## Command-backed apps

A command-backed app can keep an established CLI workflow and declare its tools with `defineApp`. Put `runtime/jovita.app.ts` beside the command source. A command tool names its allowed broker calls; the SDK normally uses the tool name as the CLI command and infers whether billing is required. Use explicit routing or billing only for commands that differ from those defaults. Larger apps can keep tool definitions in `runtime/tools.ts`. Store copy belongs in Creator Studio. `jov sync` writes a generated `jovita.service.json`; `jov sync --check`, `jov lint`, and `jov build` reject a stale copy. The SDK declaration remains the authoring source.

```ts
import { defineApp, commandTools } from '@jovita-ai/sdk';

export default defineApp({
  id: 'my-command', name: 'My Command', version: '1.0.0',
  description: 'Run a command with approved broker operations.',
  billing: { tier: 'free', entitlementKey: 'pack.my_command' },
  tools: commandTools({
    search: { capabilities: ['broker.my-command.example_search.search.v1'] },
    export: {},
  }),
});
```

This creates `search` and `export` command routes, a free `offline` health route using `--help`, and default activity messages. `search` requires billing because it uses a broker capability. Set `healthArgs` for a different free health command, such as `['describe']`. Keep `argvPrefix`, `requiredArgs`, `excludedArgs`, `billingRequired`, and custom `activity` when an existing CLI needs them. Keep nondefault `skill`, `compat`, OAuth, or runtime build settings in `jovita.app.ts`.

Use `@jovita-ai/sdk/runtime` inside command code for broker calls and receipt recovery. `jov dev <tool-id> --dir <app> --args-json '["--query","example"]'` runs a command tool with local response fixtures. A custom SDK workflow uses `run(ctx, input)` and `ctx.call()`; command-backed tools keep their established argument and output contract.

An executable app cannot omit its operation grants: Jovita uses them to authorize and bill broker calls. A skill-only app has no command runtime or broker calls. Create one with `jov init my-skill --template skill`; it needs `skill/SKILL.md`, a small `jovita.service.json`, and the CLI for packaging, but it does not need `@jovita-ai/sdk` or `@jovita-ai/runtime`. Developers who prefer a typed declaration can use the optional `defineSkillApp({...})` helper.

The 17 retained first-party miniapps use this `defineApp` path in the Jovita SaaS repository. Their compiled declarations are checked against the generated manifests, and their command code imports the broker transport through `@jovita-ai/sdk/runtime`. Broker operation IDs, tool grants, commands, activity metadata, and buyer-facing release details are preserved.

## Repository layout

- `packages/sdk`: public authoring API, compiler, and schemas.
- `packages/runtime`: small authenticated call client used through `@jovita-ai/sdk/runtime` by command apps and through `ctx.call()` by SDK workflows.
- `packages/cli`: project commands and `.jov` packaging.
- `packages/provider-catalog`: reviewed built-in operation definitions shared by the broker and generated SDK names. Ordinary external APIs belong in an app declaration.
- `packages/broker`: self-hostable broker service and generic HTTP, media, and submit/poll execution paths.
- `examples/fluent-example`: direct API tool.
- `examples/custom-example`: class-based workflow.

Run the standalone broker with `docker compose -f compose.broker.yml up --build` after setting `JOVITA_BROKER_SHARED_SECRET` and `JOVITA_DATA_ENCRYPTION_KEY` to separate random values of at least 32 characters. Compose seeds the versioned public catalog before starting the broker. Its health endpoint is `/health`; internal endpoints require signed requests. External creator API calls work without Jovita Cloud. Cloud-only media, hosting, Google Workspace, and owned-resource actions need their respective infrastructure and server callbacks. Jovita Cloud owns buyer billing and creator earnings. Command apps import `@jovita-ai/sdk/runtime`; direct SDK workflows use `ctx.call()`.

Tagging a reviewed commit `broker-vX.Y.Z` builds `ghcr.io/venbrinodevelopers/jovita-broker:broker-vX.Y.Z` from this repository. Deploy that image on a private network with the same MongoDB collections and encryption key used during migration, and run `npm run catalog:seed -w @jovita-ai/broker` once before startup. Do not expose `/internal/broker/*` to the public internet.

## npm releases

The four npm packages are `@jovita-ai/runtime`, `@jovita-ai/provider-catalog`, `@jovita-ai/sdk`, and `@jovita-ai/cli`. The broker source is distributed through this repository and Docker image. Runtime and catalog publish before the SDK; the SDK publishes before the CLI. Package versions are immutable on npm. When changing the SDK version, update the CLI's exact SDK dependency too. `jov init` reads these versions from the CLI package so generated projects install the matching release.

The [publish workflow](.github/workflows/publish.yml) runs on tags named `npm-v<version>` that point to commits on `main`. The tag version must equal the CLI version; SDK, catalog, and runtime versions change independently. Before tagging, run `npm ci && npm run build && npm run typecheck && npm test`, then review `npm pack --dry-run` for all four public packages. Push the release commit, then create and push the tag, for example `git tag npm-v0.1.4 && git push origin npm-v0.1.4`. The workflow skips any package version already published, which allows a partial release to resume in dependency order.

Publishing uses npm trusted publishing with GitHub Actions OIDC. Each package must have a trusted publisher configured on npm: GitHub owner `VenbrinoDevelopers`, repository `jovita-creator-tool`, workflow filename `publish.yml`, and direct `npm publish` permission. No npm token is stored in GitHub. The initial version of a new package must be published by its owning npm account before its trusted publisher can be configured.

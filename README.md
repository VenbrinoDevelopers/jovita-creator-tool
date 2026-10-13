# Jovita creator tool

The public TypeScript SDK and `jov` CLI for building Jovita apps. The SDK describes an app and runs its tools. The CLI creates, tests, bundles, connects, and submits the app. Provider keys stay in Jovita's private broker and never go in source code or a `.jov` bundle.

## A one-call API app

```ts
import { defineApp, provider } from '@jovita/sdk';
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

Requires Node.js 22.19 or newer. Once the packages are published:

```sh
npm install -g @jovita/cli
jov init web-search
cd web-search
npm install
npm run dev
jov lint
jov build --target linux-amd64
jov verify build/web-search-0.1.0-linux-amd64.jov
```

`jov dev` uses JSON fixtures from `fixtures/` and prints each broker call. It does not spend provider money or buyer credits. `jov connect` runs a real provider test, which can incur a provider charge for a non-GET operation. Use `--test-operation`, `--sample-input`, and `--confirm-provider-charge` for that case.

To work from this repository before package publication, run `npm install && npm run build && npm test` at the root. The checked-in examples use local package references.

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

The SDK compiles both styles into the same manifest and `.jov` format. Existing hand-written `jovita.service.json` projects remain supported, but a project must use one authoring source.

## Repository layout

- `packages/sdk`: public authoring API, compiler, and schemas.
- `packages/runtime`: small authenticated call client shared by the SDK and existing miniapps.
- `packages/cli`: project commands and `.jov` packaging.
- `examples/fluent-example`: direct API tool.
- `examples/custom-example`: class-based workflow.

The broker, creator credentials, buyer billing, and platform lifecycle services stay in Jovita's private server repositories. Existing published miniapps import `@jovita/runtime` directly; it is the same call transport that SDK apps use through `ctx.call()`.

# Planban Online Boards: hosted service

An Online Board has one source of truth: this service, built on Convex. Local
Planban installs whose project manifest says `"storage": { "kind": "online" }`
read and write through it; local boards never touch it.

- `service/convex/`: the Convex functions. `boards.ts` runs the shared planning
  rules from `src/core/boardOperations.ts` inside one mutation per change.
  `http.ts` serves the REST API the local side uses (`/api/v1/...`).
  `live.ts` is the revision query a board server subscribes to.
- `scripts/`: end-to-end checks that run against a local backend.

## Run it locally (no account needed)

```sh
cd online/service
npm install
CONVEX_AGENT_MODE=anonymous npx convex dev          # leave running; serves http://127.0.0.1:3211
CONVEX_AGENT_MODE=anonymous node scripts/setup-local.mjs   # once: development sign-in and live-update key
```

Development sign-in (`planban online login http://127.0.0.1:3211 --dev-user owner`)
works only on a local backend with `PLANBAN_DEV_AUTH=1`.

## Browser sign-in and remote MCP

Clerk proves the human identity for an explicit Planban consent screen. Set
`CLERK_ISSUER`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` and the canonical
`PLANBAN_PUBLIC_URL` privately on the selected backend. The publishable key and
issuer must belong to the same dedicated Clerk application. Never put secret
values in command arguments, chat or committed files.

Planban is the OAuth authorization server. Its discovery document is
`/.well-known/oauth-authorization-server`; protected MCP resource discovery is
`/.well-known/oauth-protected-resource/mcp`. Authorization uses S256 PKCE and
freezes the client, callback, resource and requested permissions before the
person chooses Allow or Cancel. The server verifies an active Clerk browser
session, including the configured issuer and authorized party, and checks it
again when a session-backed code is redeemed.

`planban online login <url>` uses the predefined `planban-cli` client and
`planban:machine` purpose. Its registered callbacks are
`http://127.0.0.1:53682/callback` through `:53686/callback`. Code redemption
returns this machine's own opaque credential directly. It persists until
sign-out or about 90 days unused; it does not retain provider tokens or a
refresh token. Signing out revokes that machine's connection.

Remote agents use `planban:read`, `planban:plan` or `planban:complete`, with
`offline_access` when needed. Access credentials last five minutes; rotating
refresh credentials expire after 90 days unused, bounded by a one-year grant.
Every credential belongs to one independently revocable connection. Refresh
replay closes that family. Explicit new consent creates a separate connection;
old revoked access and refresh-derived credentials stay refused. Direct Clerk
OAuth bearer exchange and restoration of revoked connections are retired.

Client metadata is fetched only from the reviewed exact publisher documents:

- `https://chatgpt.com/oauth/codex/client.json`
- `https://chatgpt.com/oauth/client.json`
- `https://claude.ai/oauth/claude-code-client-metadata`
- `https://claude.ai/oauth/mcp-oauth-client-metadata` (claude.ai's custom
  connectors; only Claude's own connector callback, named Claude (claude.ai))

The service trusts these publishers' DNS/TLS, follows no redirects, bounds
response size/time and fetches no secondary URLs. A validated document is kept
for an hour, so sign-in starts don't each fetch it. Arbitrary metadata
publishers are disabled; dynamic registration is open only to claude.ai (see
"claude.ai self-registration" below). Native callback ports may vary only
on a registered literal loopback IP and exact path. Only the exact Claude Code
publisher also permits a canonical port from 1 through 65535 on its registered
HTTP localhost callback, keeping host and raw path unchanged; other publishers'
localhost callbacks retain exact matching. This relies on the computer's
localhost resolution and PKCE, and does not authenticate the installed program.
Claude Code's reviewed native document omits `application_type`; that omission
is recognized only for this exact publisher. claude.ai's hosted connector was
accepted end to end on production on 14 October 2026, through its published
document; self-registration remains its fallback.

MCP discovery reflects the credential's current board permissions. Read grants
receive read tools; planning grants receive permitted writes without completion;
completion is scoped to eligible boards and requires explicit confirmation.
Each discovery request is private and uncached on the server. This stateless
endpoint advertises `listChanged: false` and sends no change notifications;
`ttlMs: 0` does not make SDK or native clients refresh their cached tool lists.
After changing board access, request `tools/list` again. In a client that caches
discovery, reconnect or reload the MCP connection to obtain its current tools
and board choices. That rediscovery can reuse a still-valid credential; access
beyond its original OAuth scopes requires new explicit authorization. Calls
always recheck authorization inside the operation, regardless of previously
discovered schemas.

Deterministic tests and SDK simulations do not establish real sign-in or client
acceptance. Provider-backed consent, native OAuth, refresh/revoke/reconnect and
independent machines must be verified on the exact candidate. Hosted connectors
cannot use a loopback-only backend; an externally reachable deployment and real
owner identities remain separate acceptance gates.

## Checks

From the repository root, with the backend running:

```sh
node --import tsx/esm online/scripts/smoke-convex.ts                     # REST API end to end
node --import tsx/esm online/scripts/history-convex.ts                   # history rebuilds and pruning
node --import tsx/esm online/scripts/generations-convex.ts               # Take Local bound to a generation, large exports, replays
PLANBAN_HOME=$(mktemp -d) node --import tsx/esm online/scripts/transfers-convex.ts   # killed transfers resume
PLANBAN_HOME=$(mktemp -d) node --import tsx/esm online/scripts/live-convex.ts   # live updates
node --import tsx/esm online/scripts/access-convex.ts                    # connections, sign-out, personal access keys
node --import tsx/esm online/scripts/index-convex.ts                     # boards hold text only; no file routes
node --import tsx/esm online/scripts/invites-convex.ts                   # invites, joining, roles, agent permissions
node --import tsx/esm online/scripts/limits-convex.ts                    # board size and daily volume caps (needs PLANBAN_TEST_LIMITS; see the script)
(cd online/service && node scripts/mcp-sdk-check.mjs)                  # remote MCP with the official MCP SDK client
online/scripts/demo-convex.sh                                            # two machines, CLI and local MCP
```

## GitHub merges (linked repositories)

`convex/github.ts` and `convex/model/githubWebhook.ts`. A board's owner links a
repository from their computer: the service makes the link and a random secret,
returns the secret once to the owner's own sign-in (never to a browser session
or an agent), and the computer passes it to GitHub on `gh`'s standard input when
it adds the repository webhook. The secret lives only in its `githubLinks` row;
unlinking deletes the row.

GitHub posts to `/api/v1/github/hooks/<linkId>` (through the edge's existing
`/api/v1/` route). The handler limits the body to 1 MB, checks
`X-Hub-Signature-256` with a constant-time compare, and gives an unknown link, a
bad or missing signature and another repository's delivery the same 401. Only
`ping` and `pull_request` closed with `merged: true` reach a mutation. Delivery
ids are remembered for a week, each pull request is recorded once per board,
and a link records at most 120 merges an hour; a refused or failed delivery is
not remembered, so it can be redelivered from GitHub.

A merge becomes a landing note on each card that names it, or an item in the
board's inbox (`src/core/landings.ts`), as one board change credited to GitHub.
The webhook needs an address GitHub can reach: a local backend on 127.0.0.1
can't receive real deliveries; `tests/github-webhook.test.ts` drives the real
handlers in memory instead.

## Planban is an index, not storage

Online Boards hold text only (owner decision 18). The service has no file
routes, and every write (edits, remote MCP, Take Online) refuses embedded
files and oversized documents (`src/core/contentRules.ts`). The attachment
storage built for the prototype has been removed, along with its tables.

The guarantee has three layers, set out at the top of `src/core/contentRules.ts`
and in the card's spec (decision 21): the text check, the size and volume caps
(`convex/model/limits.ts`), and never serving stored text as a file
(`tests/no-file-serving.test.ts`). New ways of writing a file as text found
later are follow-ups, not blockers; record them here.

Historical direct-provider-token probes are archived in `retired/clerk-tokens-convex.ts`; they are not checks for the current enrollment boundary.

## The public address (app.planban.ai)

`edge/` is a Cloudflare Worker that serves the public address and forwards
only this service's routes to the backend's native address. It adds a shared
proof to every request; the backend holds only the proof's SHA-256 as
`PLANBAN_EDGE_PROOF_SHA256`. With that setting and a `PLANBAN_PUBLIC_URL`
different from the native address, the backend accepts credentials only
through the Worker, and its sign-in, consent, token and invitation routes
refuse direct requests. The Worker also limits sign-in starts, claude.ai
registrations and authorize requests per caller. It answers nothing until
`UPSTREAM` is set to the backend's `https://<deployment>.convex.site` address
and the `EDGE_PROOF` secret is set.

Invitation emails need two more backend settings: `RESEND_API_KEY`, a
send-only key for the sending domain, and `PLANBAN_INVITE_FROM`, for example
`Planban <invites@planban.ai>`. Without both, invitations work only as links
the owner shares, and the invite form says so.

## The web page at the public address

The same Worker serves the web page (Planban 2.0) as Workers static assets
from `dist/web`. Only the service's addresses run the Worker (`/api/`,
`/oauth/`, `/mcp`, `/.well-known/`, `/web/`, and the favicon and brand
files); every other address serves the page, falling back to its main page so
it can route `/boards/...`, `/invite/...`, `/sign-in` and `/approve` itself.
Page files don't count towards the Worker's daily requests. `WORKER_FIRST` in
`edge/worker.ts` and `assets.run_worker_first` in `edge/wrangler.jsonc` must
match; a test checks.

The page's security headers come from `dist/web/_headers`, written for each
deployment from its Clerk frontend address and Convex client address, so the
Content Security Policy allows exactly Clerk's sign-in and Convex's live
updates. The page also needs `PLANBAN_SIGNIN_NOTE_KEY` (at least 32 random
characters) on the backend, or sign-in reports itself unavailable.

### Deploying the web page

Deploys to production need the owner's OK. In order, from a clean checkout of
the commit being released:

1. Build the page: `~/mac-mini-setup/dev24 npm run build`.
2. Write its headers for the target deployment:
   `~/mac-mini-setup/dev24 node --import tsx/esm online/edge/write-headers.ts --clerk <Clerk frontend API origin> --convex <https://<deployment>.convex.cloud>`.
3. Deploy the backend first if its code changed (`convex deploy`), then the
   Worker from `online/edge` with `wrangler deploy --var UPSTREAM:<https://<deployment>.convex.site>`.
4. Read back: the Worker's bindings include `ASSETS`; `/` and
   `/boards/<any>` answer 200 with the page and the exact
   Content-Security-Policy; `/api/nothing` answers 404 JSON; `/web/config`
   names the deployment's Clerk instance.

Rollback: deploy the previous Worker (or this one without the `assets`
block). The service's routes are unchanged either way, and every browser
session can be ended at once by revoking web connections.

## claude.ai self-registration

`POST /oauth/register` accepts RFC 7591 registrations only for Claude's own
connector callbacks, as public clients using the authorization-code flow
with PKCE. An unused registration expires after a day. The first person to
approve one owns it; it appears in their Connections (on the web page's account menu, or the board's menu on a computer) as Claude
(claude.ai), and revoking it there ends the registration and every grant
made through it. Other clients still register by published metadata
documents from the reviewed list.

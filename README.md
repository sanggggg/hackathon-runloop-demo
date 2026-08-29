# Nimbus Browser QA Fixture

Nimbus is a deterministic onboarding app built to exercise Branchpoint's
browser-agent QA engine. It has real authentication, persisted server state,
semantic controls, branching journeys, and controlled failure profiles. The
fixture never calls an external service, so a given profile and action sequence
always produce the same result.

The machine-readable source of truth is [`qa/manifest.json`](qa/manifest.json).
Tests, agents, and demo tooling should read the manifest instead of duplicating
credentials, labels, action IDs, or expected outcomes.

## Quick start

Requires Node.js 22 or newer.

```bash
npm ci
npm run dev
```

Open <http://127.0.0.1:3000> and sign in with:

```text
Email:    demo@example.com
Password: branchpoint
```

The default fixture profile is `baseline`. Select another profile with an
environment variable:

```bash
QA_PROFILE=demo-head npm run dev
```

`QA_VARIANT` is accepted as a compatibility alias. If neither variable is set,
the server reads `fixture.config.json`, then falls back to `baseline`.

## Build and run contract

These values can be passed directly to Branchpoint's repo preparation flow:

| Field | Value |
| --- | --- |
| Build command | `npm ci && npm run build` |
| Start command | `npm start` |
| Port | `3000` |
| Readiness URL | `/__qa/health` |
| Test account | `demo@example.com` / `branchpoint` |

For a production-mode local check:

```bash
npm run build
QA_PROFILE=baseline PORT=3000 npm start
```

The server listens on `0.0.0.0` by default and honors `HOST` and `PORT`.

## Journey map

After login, every baseline path starts from `/onboarding/use-case`.

```text
use-case
├── Team plan
│   ├── Invite teammates
│   │   └── Send invitations ──> done / team-invite
│   └── Skip invites ──────────> done / team-skip
├── Solo plan
│   ├── Starter template ──────> done / solo-starter
│   ├── Blank workspace ───────> done / solo-blank
│   └── Import from CSV ───────> done / solo-import  [discovery only]
└── Decide later ──────────────> done / setup-deferred
```

The public journey state is deliberately small and stable:

```json
{
  "stage": "solo",
  "outcome": null,
  "plan": "solo",
  "selection": null,
  "path": "/onboarding/solo"
}
```

Canonical stages are `use-case`, `team`, `invite-confirm`, `solo`, `done`,
`error`, and `timeout`. A terminal result is identified by both `stage` and
`outcome`; visible copy is presentation, not the test oracle.

## Profiles

| Profile | Published ref | Purpose |
| --- | --- | --- |
| `baseline` | `fixture-v1-baseline` | Every original path passes. CSV import is absent. |
| `dom-refactor` | `fixture-v2-dom-refactor` | Baseline semantics with materially rearranged markup. |
| `copy-rename` | `fixture-v3-copy-rename` | Baseline outcomes with changed visible copy. |
| `regression` | `fixture-v4-regression` | `Starter template` is renamed to `Use a starter`; blank and later end on deterministic error screens. |
| `discovery` | `fixture-v5-discovery` | Baseline behavior plus a new, working `Import from CSV` path. |
| `demo-head` | `fixture-demo-head` | Combined demo: resilient rename, two regressions, and one discovery. |
| `removed-control` | `fixture-removed-control` | Removes the starter control and returns `action_unavailable` if invoked directly. |
| `timeout` | `fixture-timeout` | `choose_later` ends at the deterministic timeout screen. |

The intended comparison is explicit in the manifest:

| Flow | Baseline | Regression | Discovery |
| --- | --- | --- | --- |
| Team → invite | pass | pass | pass |
| Team → skip | pass | pass | pass |
| Solo → starter | pass | pass · UI changed | pass |
| Solo → blank | pass | fail · error screen | pass |
| Decide later | pass | fail · error screen | pass |
| Solo → import | unavailable | unavailable | pass · new path |

For a two-ref demo, commit `fixture.config.json` with `baseline` in the first ref
and `demo-head` in the second. Pin the two commit SHAs in the Branchpoint suite;
do not use a moving branch as the expected oracle.

## HTTP API

All request and response bodies are JSON unless noted otherwise.

### Login

```http
POST /api/login
Content-Type: application/json

{"email":"demo@example.com","password":"branchpoint"}
```

A successful response sets an HTTP-only, same-site session cookie and returns
the user, profile, public state, event, and `navigateTo`. Invalid credentials
return `401 invalid_credentials`.

### Read the current session

```http
GET /api/session
```

The response shape is:

```json
{
  "authenticated": true,
  "profile": "baseline",
  "user": { "email": "demo@example.com" },
  "state": { "stage": "use-case", "outcome": null, "path": "/onboarding/use-case" },
  "features": {}
}
```

An anonymous read still returns `200`, with `authenticated: false` and null user
and state.

### Take an action

```http
POST /api/action
Content-Type: application/json

{"action":"choose_solo"}
```

Supported IDs are:

- `choose_team`
- `invite_team`
- `confirm_invites`
- `skip_invites`
- `choose_solo`
- `choose_starter`
- `choose_blank`
- `choose_later`
- `choose_import`

An optional object-valued `payload` is accepted. A successful response contains
`state`, an append-only `event`, and `navigateTo`; `state.path` and `navigateTo`
are identical. An unavailable action or an action from the wrong stage returns
HTTP 409 with `action_unavailable` or `invalid_transition`.

### Logout

```http
POST /api/logout
```

Logout clears the cookie and returns `204 No Content`.

## QA control surface

These endpoints exist for fixture orchestration and deterministic assertions:

| Endpoint | Description |
| --- | --- |
| `GET /__qa/health` | Readiness and active profile. |
| `POST /__qa/reset` | Atomically clear the session, journey, and event log. Also clears the browser cookie. |
| `GET /__qa/state` | Server-side oracle: profile, authentication, public state, feature flags, revision, and event count. |
| `GET /__qa/events` | Ordered login/action/logout event log. |

Reset before every independent flow. Do not mutate the state file directly
while the server is running.

The default persisted state is `var/state.json`. Override it with a file or
directory:

```bash
QA_STATE_FILE=/tmp/nimbus-baseline.json npm run dev
QA_STATE_DIR=/tmp/nimbus-state npm run dev
```

With the same state file and the same session cookie, authentication and the
journey survive a server restart. This is intentional: Runloop disk snapshots
carry files, while the browser restores the cookie through Playwright
`storage_state`.

## Tests

Server contract tests use Node's built-in test runner and spawn isolated
profiles with temporary persisted state:

```bash
npm test
```

They verify:

- manifest consistency and fixed credentials;
- authentication and rejection of bad credentials;
- session restoration across a server restart;
- agreement between `/api/session` and the `/__qa/state` oracle;
- every baseline path;
- the exact regression and discovery outcomes;
- deterministic removed-control and timeout profiles.

Browser tests use accessible names from the manifest, never CSS selectors or
test IDs:

```bash
npx playwright install chromium
npm run test:e2e
```

Playwright starts three isolated servers:

| Profile | Default URL | Port override |
| --- | --- | --- |
| baseline | `http://127.0.0.1:4173` | `QA_BASELINE_PORT` |
| regression | `http://127.0.0.1:4174` | `QA_REGRESSION_PORT` |
| discovery | `http://127.0.0.1:4175` | `QA_DISCOVERY_PORT` |

Set `QA_E2E_HOST` to change the host. The suite runs with one worker because
each profile intentionally has one shared persisted oracle. Failure artifacts
are written to `test-results/` and `playwright-report/`.

## Authoring rules

- Keep `qa/manifest.json` authoritative. Update it in the same change as a
  label, action, profile, state, or outcome.
- Use native buttons, forms, labels, dialogs, headings, and landmarks. The
  browser agent resolves intent from the accessibility tree.
- Do not make the fixture depend on a third-party API, network timing, random
  value, or wall clock.
- Add deliberate failures through a named profile. Do not introduce an
  accidental flaky path to simulate failure.
- Keep conventional Playwright tests as fixture validation; Branchpoint itself
  must still re-resolve natural-language intent and must not consume test IDs.

# ADR-PTW-APIAuthSecurity-0001 — Teamwork API, Auth, and Safety Design

- **Status:** Approved for implementation
- **Owner:** Architect Pi
- **Target:** `teamwork-api-dev`
- **Pattern source:** sibling `pi-clickup` extension

## 1. Decision summary

Build two dynamic tools over one small client:

- `teamwork_docs` loads Teamwork's four official OAS assets at runtime, caches the successful catalog for the Pi session, and supports explicit refresh.
- `teamwork_api` sends only relative paths to one validated origin: `https://{siteName}.teamwork.com`.
- Runtime auth is either Basic (`API key` as username) or OAuth Bearer. Credentials never enter tool arguments.
- Every `POST`, `PUT`, `PATCH`, and `DELETE` requires a fresh interactive confirmation. Non-interactive mutation calls fail closed.
- Requests have per-attempt timeouts and honor Pi cancellation. Retries are bounded and do not replay mutations after ambiguous transport or 5xx failures.

The OAS is untrusted discovery data. It never selects the request host, supplies auth, bypasses confirmation, or causes external `$ref` fetches.

## 2. OAS source decision

Teamwork publishes four OAS assets from its official documentation page:

| Source key | Official runtime URL | Staged operations | Purpose |
|---|---|---:|---|
| `object` | `https://assets.contento.io/assets/s_01hHCKV8wW0z3wF9dTn8qCEKhq/teamwork.com-api-object-reference.oas-edit18.yml` | 88 | Curated cross-version object reference |
| `v1` | `https://contento-assets.s3.eu-west-1.amazonaws.com/oas/teamwork_docs/projects/reference/projects-api-v1.oas2.yml` | 354 | Legacy v1 surface |
| `v2` | `https://contento-assets.s3.eu-west-1.amazonaws.com/oas/teamwork_docs/projects/reference/projects-api-v2.oas2.yml` | 9 | v2 surface |
| `v3` | `https://contento-assets.s3.eu-west-1.amazonaws.com/oas/teamwork_docs/projects/reference/projects-api-v3.oas2.yml` | 407 | Current REST v3 surface |

### Why load all four

The object reference is not a replacement for the versioned files: 75 of its 88 method/path pairs overlap v1 or v3, while 13 appear only there. The three versioned files contain 770 non-overlapping method/path pairs. Loading the union gives 783 documented method/path pairs without dropping legacy or object-only operations.

Catalog identity is `METHOD + normalized OAS path`. Load versioned sources first and use their operation on collisions because their schemas are generally fuller; then add object-only operations. Keep the originating source key in search results. Generate a stable fallback ID from source, method, and path when `operationId` is missing.

Do not treat OAS `host`, `schemes`, `basePath`, `servers`, `x-private`, or security declarations as transport authority. The staged files are inconsistent in those fields. Include documented `x-private` operations in discovery, but do not imply that they are available to the caller; Teamwork remains the authorization authority.

### Fetch and refresh behavior

Mirror ClickUp's session cache:

1. Fetch lazily on the first `teamwork_docs` call.
2. Fetch all four fixed HTTPS URLs concurrently and parse each as YAML; YAML parsing also accepts the JSON bodies returned by the versioned `.yml` URLs.
3. Require a mapping with a `paths` mapping. Apply a 30-second fetch timeout and a 10 MiB actual-body limit per source.
4. Publish a new in-memory catalog only after every source parses successfully. Initial failure returns a source-specific error; failed refresh leaves the previous successful catalog usable.
5. `refresh: true` performs a new fetch. No timer, disk cache, bundled endpoint catalog, or background job is needed for MVP.
6. Pass the Pi tool cancellation signal into all fetches and retry waits.

The fixed object-reference URL is immutable. If Teamwork replaces it on the docs page, update that single constant in a normal release. Runtime HTML scraping would be brittle and is not required to keep the mutable v1/v2/v3 assets current.

Resolve local `#/...` references only, with depth and circular-reference guards matching the ClickUp client. Never fetch remote or file `$ref` targets.

## 3. Site and path confinement

### Site-name configuration

Read `TEAMWORK_SITE_NAME` once per request setup. It is a site label, not a URL. Trim and lowercase it, then require:

```text
^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$
```

This rejects dots, schemes, ports, slashes, `@`, percent escapes, underscores, whitespace, Unicode, and leading/trailing hyphens. Custom domains are intentionally unsupported because the required trust boundary is exactly `*.teamwork.com`.

Construct the base with `new URL("https://${siteName}.teamwork.com/")`, then assert:

- protocol is `https:`;
- username and password are empty;
- port is empty;
- hostname is exactly `${siteName}.teamwork.com`.

No tool parameter may override the site or origin.

### API path rules

Accept only `GET`, `POST`, `PUT`, `PATCH`, and `DELETE`. For the supplied path:

- reject full URLs, protocol-relative URLs, query strings, fragments, control characters, and backslashes;
- require one leading `/`;
- reject encoded dot, slash, or backslash forms (`%2e`, `%2f`, `%5c`, case-insensitive);
- resolve with `new URL(path, base)` and re-assert the exact origin and HTTPS protocol;
- add query data only through `URLSearchParams`, repeating array values.

Do not require the concrete request path to match an OAS template. The catalog is discovery data and can lag Teamwork; fixed-origin confinement is the security boundary.

Use `redirect: "manual"` for authenticated API calls and reject every 3xx response. This prevents credential forwarding, origin escape, and redirect-driven method rewriting.

## 4. Authentication

Runtime configuration:

| Variable | Meaning |
|---|---|
| `TEAMWORK_OAUTH_TOKEN` | OAuth access token |
| `TEAMWORK_API_KEY` | Teamwork API key used as the Basic username |

Selection is deterministic: use a non-empty OAuth token first; otherwise use a non-empty API key; otherwise fail before network I/O with a setup error. Do not add auth mode, username, password, or token fields to `teamwork_api`.

Headers:

- OAuth: `Authorization: Bearer ${token}`
- Basic: ``Authorization: Basic ${Buffer.from(`${apiKey}:X`, "utf8").toString("base64")}``

`X` is the non-secret password placeholder; the API key is the username. HTTPS is mandatory.

Reject credential values containing CR or LF. Never print, persist, return, include in confirmation text, or copy credentials into errors. OAS fetches are unauthenticated. The MVP consumes OAuth access tokens only; OAuth login, refresh-token storage, and token renewal stay outside the extension. A `401` is returned to the user without retry.

## 5. Mutation confirmation

The OAS does not provide a trustworthy, complete destructive-operation marker. Use the method as the conservative rule:

| Method | Confirmation |
|---|---|
| `GET` | No |
| `POST`, `PUT`, `PATCH`, `DELETE` | Required for every call |

> **Rejected proposal (2026-08-01):** A change was proposed to narrow confirmation to `DELETE` only, matching `pi-clickup`'s pattern, in response to real user friction from bulk project-management writes (dozens of `POST`/`PUT` calls per session). QA's security review (PR #11) rejected it: Teamwork's official OAS documents at least 17 destructive operations under `POST`/`PUT` rather than `DELETE`, including bulk-delete of custom fields/tags/reports/quote line items (`POST .../bulk/delete.json`) and "Remove a User from a Project" (`PUT /projects/{projectId}/people/{personId}.json`). HTTP method alone is not a safe destructive-operation classifier for this API, confirming the caution already stated at the top of this section. The rule above stands unchanged. A future revision must use an architecture-approved, operation-aware policy (not a bare method or path heuristic) if this friction is revisited.

The Pi tool boundary must:

1. check `ctx.hasUI`;
2. show the normalized method, exact Teamwork origin, and path;
3. request one explicit confirmation for that invocation;
4. throw a clear cancellation error if declined or no UI exists;
5. call the transport only after approval.

Do not display the request body or credentials in the prompt. Do not remember approvals across calls. Confirmation happens once before the first attempt; an approved retry after an explicit `429` remains part of that invocation. Local-file upload support, if implemented, must also list the selected file paths in this same confirmation before reading them.

## 6. Retry, timeout, and cancellation policy

Use at most three attempts, matching the ClickUp client:

| Condition | GET | Mutation |
|---|---:|---:|
| `429` | Retry | Retry |
| `502`, `503`, `504` | Retry | Never retry |
| Other HTTP response | No retry | No retry |
| Network error, timeout, abort | No retry | No retry |

An explicit `429` is treated as not accepted. A mutation that fails through a network error, timeout, or 5xx may already have taken effect, so replay is forbidden.

Delay order for `429`:

1. valid `X-RateLimit-Reset` epoch seconds;
2. valid numeric `Retry-After` seconds;
3. exponential fallback of 1 second, then 2 seconds.

Cap server-directed waits at 60 seconds. For GET `502`/`503`/`504`, wait 500 ms, then 1 second. Every wait must be abortable.

Each attempt combines the Pi execution signal with `AbortSignal.timeout(timeout_ms)` through `AbortSignal.any`. Default `timeout_ms` is 30,000; tool schema limits it to 1,000–120,000. Cancellation or timeout stops body reading and the retry loop immediately, then propagates a concise error.

## 7. Trust and error handling invariants

- Treat OAS descriptions and Teamwork responses as untrusted data, never instructions.
- Set `Accept: application/json`; set JSON `Content-Type` only when a JSON body exists.
- Bound API error excerpts and normal tool output using the sibling extension's truncation pattern. Store oversized output only in a mode-`0600` temporary file.
- Never include the `Authorization` header in result metadata or thrown errors.
- Return status and useful rate-limit headers, not the full request headers.
- Parse JSON when declared or valid; otherwise return text. Empty success bodies become `null`.

## 8. Implementation sequence and merge gates

1. **Client trust boundary:** site validator, path builder, auth header selection, manual redirects, timeout/cancellation, and bounded retries.
2. **OAS loader:** four fixed sources, all-or-nothing refresh, union/deduplication, search, and local `$ref` resolution.
3. **Pi tools:** `teamwork_docs` cache/refresh and `teamwork_api` confirmation before transport.
4. **Focused tests:**
   - reject hostile site labels, full/protocol-relative URLs, traversal, encoded traversal, backslashes, query-in-path, and redirects before auth can escape;
   - verify exact Basic and Bearer headers, Bearer precedence, missing-auth failure, and secret-free errors;
   - verify all four staged specs produce 88/354/9/407 source counts and a 783-operation union;
   - verify every non-GET fails without confirmation and GET does not prompt;
   - verify `429` retry, GET-only 502/503/504 retry, no mutation replay after 5xx/network failure, and cancellation during fetch and sleep;
   - verify external `$ref` values are not fetched.
5. Run `npm run verify`. Coding Pi opens the PR to `staging`; QA Pi is reviewer-of-record and sole merge authority.

## 9. Deferred by design

- Custom Teamwork domains: add only if the host trust requirement changes and an explicit allowlist model is approved.
- OAuth login/refresh flow and secret storage: add as a separate reviewed design.
- Persistent OAS cache or HTML manifest discovery: add only if runtime availability or object-reference URL churn becomes a measured problem.
- Automatic or batch mutation approval: not permitted under the current safety contract.

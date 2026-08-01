# PROJECT STATUS — Pi Teamwork

## Goal and current phase

Build a public Pi extension for stable, direct Teamwork.com PM operations. The extension loads Teamwork's official OpenAPI specification at runtime and exposes all documented operations through `teamwork_docs` and `teamwork_api`, matching the Pi ClickUp extension pattern.

**Phase:** released, hotfixed. `production` (commit `50f2f8e`) has the full implementation plus a fix for a real production stall (see below). Registered in `~/.pi/agent/settings.json` as `../../Develop/PiCode/pi-teamwork`. See `Ops/HND-PICODE-PiTeamwork-0001.md` for the full review trail.

## Source of truth

| Area | Source |
|---|---|
| Code, checks, releases | This checkout and `https://github.com/umar-rana/pi-teamwork-extension` |
| API contract | Teamwork official docs and the linked official OAS asset |
| Coordination | `PROJECT_STATUS.md` |
| Public documentation | `README.md` |
| Runtime activation | Pi package installed from the public Git repository, or local path during PiCode development |

## API contract

- Official docs: `https://apidocs.teamwork.com/docs/teamwork`
- Authentication: Basic first; Bearer OAuth supported in the same MVP.
- Site URL: `https://{siteName}.teamwork.com`
- Live OAS union: 88 object-reference + 354 v1 + 9 v2 + ~409 v3 ≈ 785 deduped operations (grows as Teamwork ships more v3 ops — tests assert floors, not exact counts).
- The extension refreshes the official OAS at runtime; no hard-coded endpoint catalog.

## What shipped

- `client.ts`: strict `TEAMWORK_SITE_NAME` validation, single-origin path confinement, manual redirect rejection, deterministic Bearer-over-Basic auth (raw CR/LF and full Unicode control/format/separator rejection before trimming), bounded abortable retries with no mutation replay, all-or-nothing four-source OAS loader with union dedup and local-only `$ref` resolution.
- `index.ts`: session-cached `teamwork_docs` with explicit refresh; `teamwork_api` with fresh per-invocation confirmation for every non-GET (confined normalized path only, no raw/hostile input, no body), bounded output spilling to a 0600 temp file, and `executionMode: "sequential"` so concurrent mutating calls in one turn can't race the confirmation dialog.
- `test/client.test.ts` + `test/tools.test.ts`: 17 passing tests (1 opt-in live-spec skip).
- `.github/workflows/verify.yml`: CI gate mirroring `pi-clickup-extension`.

## Known-fixed production bug

**2026-07-29:** User reported the extension "gets stuck while updating" in a real Teamwork workspace (Malco Properties), once for ~98 minutes with no visible confirmation prompt and no error. Root cause: Pi's agent loop runs same-turn tool calls in parallel by default; the model sometimes batches multiple mutating `teamwork_api` calls in one turn, and two concurrent `ctx.ui.confirm()` dialogs raced the same TUI dialog with nothing surfaced to the user. Fixed by declaring `teamwork_api` `executionMode: "sequential"` (PR #5 → `staging`, PR #6 → `production` at `50f2f8e`), which forces Pi's scheduler to serialize any turn containing it.

**Recommended follow-up (not started):** `pi-clickup` has the same latent gap (DELETE and file-upload confirmations could theoretically race the same way) but is far less likely to trigger it since it only confirms on `DELETE`, not every mutating method. QA recommends a separate fix ticket for `pi-clickup`.

## Team

| Pi | Model | Scope | Session ID | Authority |
|---|---|---|---|---|
| PiCode PM / Docs-Ops Pi | `claude-code/claude-sonnet-5` | Human front desk, scope, coordination, handoffs, README/release hygiene | `picode-pm-docs` | No feature code / no routine merge |
| Architect Pi | `openai-codex/gpt-5.6-sol` | API/auth/security design; completed ADR | `pi-teamwork-architect` | No routine merge |
| pi-developer | `claude-code/claude-opus-5` | Implementation on isolated task branches | `pi-developer` | Never merges |
| pi-qa | `openai-codex/gpt-5.6-sol` | Pre-implementation gate, code review, sole merge authority | `pi-qa` / `pi-qa-2` | Reviewer-of-record; sole merge authority |

## Branch and merge rules

- `production` accepts only reviewed promotion PRs from `staging`; no direct commits.
- Feature/fix work uses one `<task>-dev` branch per task, based on `staging`.
- Flow: `<task>-dev` → PR to `staging` → QA PASS → squash merge → delete branch → promotion PR to `production`.
- Authors never merge. QA merges only after `npm run verify` passes and CI is green.
- Runtime/live API checks are post-merge and non-blocking; they must never require credentials in CI.

## Non-goals for MVP

- No custom Teamwork domain model or separate ORM.
- No hard-coded PM wrapper tool set instead of full OAS coverage.
- No live credentialed tests in GitHub Actions.
- No automatic destructive mutations.
- Deferred by design (see ADR §9): multipart upload, OAuth login/refresh flow, persistent OAS cache, batch mutation approval.

## Next up (not started)

- `pi-clickup`: apply the same `executionMode: "sequential"` fix as a preventive measure (recommended by QA, not yet a ticket).
- README pass to confirm install/usage instructions match the shipped tool names and config vars exactly (currently drafted from `docs-dev`, not yet reconciled against the released code).

## Operating rule

Every Pi reads `AGENTS.md` and this file before acting, reports its role and authority, and stops/returns the work to PM when a request crosses its boundary.

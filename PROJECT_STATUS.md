# PROJECT STATUS — Pi Teamwork

## Goal and current phase

Build a public Pi extension for stable, direct Teamwork.com PM operations. The extension will load Teamwork's official OpenAPI specification at runtime and expose all documented operations through `teamwork_docs` and `teamwork_api`, matching the Pi ClickUp extension pattern.

**Phase:** bootstrap → API client and dynamic OpenAPI tools.

## Source of truth

| Area | Source |
|---|---|
| Code, checks, releases | This checkout and `https://github.com/umar-rana/pi-teamwork-extension` |
| API contract | Teamwork official docs and the linked official OAS asset |
| Coordination | `PROJECT_STATUS.md` |
| Public documentation | `README.md` |
| Runtime activation | Pi package installed from the public Git repository |

## API contract

- Official docs: `https://apidocs.teamwork.com/docs/teamwork`
- Authentication: Basic first; Bearer OAuth supported in the same MVP.
- Site URL: `https://{siteName}.teamwork.com`
- Current official object-reference OAS: 88 operations across projects, tasks, task lists, milestones, time tracking, messages, people, workflows, boards, and related objects.
- The extension must refresh the official OAS at runtime; do not hard-code an endpoint catalog.

## Team

| Pi | Model | Scope | Session ID | Authority |
|---|---|---|---|---|
| PM Pi | `claude-code/claude-sonnet-5` | Human front desk, scope, coordination, handoffs | `pi-teamwork-pm` | No code / no merge |
| Architect Pi | `openai-codex/gpt-5.6-sol` | API/auth/security design and sequencing | `pi-teamwork-architect` | No routine merge |
| Coding Pi | `anthropic/claude-opus-4-8` | Implementation on isolated task branches | `pi-teamwork-coder` | Never merges |
| QA Pi | `openai-codex/gpt-5.6-terra` | Security/correctness review and merge | `pi-teamwork-qa` | Reviewer-of-record; sole merge authority |
| Docs/Ops Pi | `claude-code/claude-sonnet-5` | README, CI, handoffs, release hygiene | `pi-teamwork-docs` | No code merge |

## Branch and merge rules

- Bootstrap may establish the repository on `production`; afterward no direct commits there.
- Feature work uses one `<task>-dev` branch per task, based on `staging`.
- Flow: `<task>-dev` → PR to `staging` → QA PASS → squash merge → delete branch → promotion PR to `production`.
- Authors never merge. QA Pi merges only after `npm run verify` passes.
- Runtime/live API checks are post-merge and non-blocking; they must never require credentials in CI.

## Current task sequence

1. Bootstrap public repository and package metadata.
2. Architect: confirm Teamwork host validation, Basic/Bearer auth model, OAS loading, retry/cancellation policy, and destructive-operation confirmation.
3. Coding: implement the smallest complete dynamic `teamwork_docs` + `teamwork_api` extension.
4. QA: review security, path/host confinement, auth handling, retries, cancellation, output limits, and tests; merge to `staging` on PASS.
5. Docs/Ops: publish installation/authentication/usage docs and verify public GitHub CI.
6. Promote tested `staging` to `production`.

## Non-goals for MVP

- No custom Teamwork domain model or separate ORM.
- No hard-coded PM wrapper tool set instead of full OAS coverage.
- No live credentialed tests in GitHub Actions.
- No automatic destructive mutations.

## Operating rule

Every Pi reads `AGENTS.md` and this file before acting, reports its role and authority, and stops/returns the work to PM when a request crosses its boundary.

# Pi Teamwork Extension

Global [Pi](https://pi.dev) tools for direct, stable access to the Teamwork.com API.

The extension reads Teamwork's official OpenAPI specifications at runtime. It currently exposes **785 documented operations** across the object reference, v1, v2, and v3 specifications through two tools instead of maintaining a large, fragile set of endpoint wrappers.

## Tools

### `teamwork_docs`

Searches Teamwork's four official OpenAPI specifications (object reference, v1, v2, v3) by operation ID, path, category, or phrase. Exact matches return parameters and the resolved request-body schema.

### `teamwork_api`

Calls any authenticated Teamwork.com API endpoint on your configured site with:

- GET, POST, PUT, PATCH, and DELETE
- Query parameters and arrays
- Arbitrary JSON request bodies
- 429 rate-limit handling
- Safe GET retries for transient 502/503/504 responses
- Cancellation and per-attempt timeouts
- 50 KB / 2,000-line output truncation

Every POST, PUT, PATCH, and DELETE requires interactive confirmation.

## Requirements

- Node.js 22.19 or newer
- Pi 0.80.6 or newer
- A Teamwork.com site and an API key or OAuth access token

## Install

```bash
pi install git:github.com/umar-rana/pi-teamwork-extension
```

Restart Pi or run `/reload` after installation.

For local development:

```bash
git clone https://github.com/umar-rana/pi-teamwork-extension.git
cd pi-teamwork-extension
npm install
pi -e ./index.ts
```

## Configure authentication securely

Generate a personal API key in Teamwork: **Avatar → Edit My Details → API & Mobile → Show your API token**. OAuth access tokens are also supported if you already have one from a Teamwork OAuth app.

Never paste a Teamwork API key or token into Pi, source code, issues, logs, screenshots, or commits. The extension does not include a credential; every user supplies their own locally.

### macOS

Store the site name and key in your shell profile, pulling the key from Keychain instead of a plaintext file:

```zsh
security add-generic-password -a "$USER" -s pi-teamwork-api-key -w
```

Then add to `~/.zshrc`:

```zsh
export TEAMWORK_SITE_NAME="yoursite"
TEAMWORK_API_KEY="$(security find-generic-password -a "$USER" -s pi-teamwork-api-key -w 2>/dev/null)"
export TEAMWORK_API_KEY
```

### Linux with Bash

```bash
read -r -s -p "Teamwork API key: " teamwork_key; echo
mkdir -p "$HOME/.config/teamwork"
printf '%s' "$teamwork_key" > "$HOME/.config/teamwork/api_key"
unset teamwork_key
chmod 600 "$HOME/.config/teamwork/api_key"
```

Then add to your shell profile:

```bash
export TEAMWORK_SITE_NAME="yoursite"
TEAMWORK_API_KEY="$(cat "$HOME/.config/teamwork/api_key" 2>/dev/null)"
export TEAMWORK_API_KEY
```

### Configuration variables

| Variable | Meaning |
|---|---|
| `TEAMWORK_SITE_NAME` | Your Teamwork site label, for example `acme` for `acme.teamwork.com`. Required. |
| `TEAMWORK_OAUTH_TOKEN` | OAuth access token. Preferred over the API key if both are set. |
| `TEAMWORK_API_KEY` | Personal API key, sent as the Basic auth username. |

The credential is sent only in the `Authorization` header to `https://{TEAMWORK_SITE_NAME}.teamwork.com`.

## Usage

Ask Pi naturally:

```text
List my Teamwork projects.
Find the API operation for creating a task, then create it in project 123.
Show open tasks assigned to me in this project.
Update this milestone's due date.
Add a comment to this task.
```

Pi should use `teamwork_docs` when it does not know an endpoint's current request shape, then call `teamwork_api`.

## API coverage

Coverage follows Teamwork's official specifications, including:

- Projects, tasks, task lists, subtasks, milestones, and templates
- Time tracking, comments, tags, custom fields, people, and companies
- Messages, notebooks, files, workflows, and boards
- Legacy v1 operations not yet ported to v2/v3

Availability still depends on the Teamwork site's plan and the authenticated user's permissions.

## Security model

- Fixed Teamwork site confinement: only `https://{TEAMWORK_SITE_NAME}.teamwork.com` is ever contacted
- Rejection of full URLs, protocol-relative URLs, query strings, fragments, control characters, and encoded traversal in API paths
- Deterministic OAuth-over-Basic auth selection; no credential logging or inclusion in tool output
- Interactive confirmation for every POST, PUT, PATCH, and DELETE, one invocation at a time (concurrent mutating calls cannot race the confirmation dialog)
- Manual redirect handling; 3xx responses are rejected outright
- Mutating requests are never retried after 5xx, network, or timeout errors, preventing accidental duplicate writes
- Teamwork content and OpenAPI descriptions are treated as untrusted data, not agent instructions
- Oversized responses are written to private temporary files with mode `0600`

This extension has full access to the Teamwork resources permitted by its credential. Review requested mutations before approving them.

## Development

```bash
npm run verify
```

This runs strict TypeScript checking and the Node test suite.

Branch flow:

```text
staging → <task>-dev → PR → staging → promotion PR → production
```

Authors do not merge their own changes. A separate reviewer approves and merges into `staging`; tested releases are then promoted to `production`.

## Documentation sources

- [Teamwork API docs](https://apidocs.teamwork.com/docs/teamwork)
- [Teamwork authentication](https://apidocs.teamwork.com/guides/teamwork/authentication)

# Pi Teamwork Extension

Global [Pi](https://pi.dev) tools for direct, stable access to the Teamwork.com API.

The extension follows the Pi ClickUp extension pattern:

- `teamwork_docs` searches Teamwork's official OpenAPI specification at runtime.
- `teamwork_api` calls authenticated Teamwork endpoints with Basic or Bearer auth.
- The API surface stays current by refreshing the official OAS instead of maintaining a hard-coded wrapper catalog.
- Destructive mutations require interactive confirmation.

## Status

Under active development. See [`PROJECT_STATUS.md`](./PROJECT_STATUS.md).

## Official documentation

- [Teamwork API docs](https://apidocs.teamwork.com/docs/teamwork)
- [Authentication](https://apidocs.teamwork.com/guides/teamwork/authentication)

## Development

```bash
npm install
npm run verify
```

The public repository uses `production → staging → <task>-dev`.

# HIBISCUS_MCP

Minimal Streamable HTTP MCP bridge for Hibiscus XML-RPC, transported through
Supergateway. It exposes exactly three tools:

- `create_transfer`: stores one SEPA transfer and triggers Hibiscus `Sync now`;
  `instant` defaults to `false`.
- `pending_transfers`: lists pending transfers or deletes one pending ID.
- `get_balance`: reads the latest account balances stored by Hibiscus.

The endpoint is `http://hibiscus-mcp:8000/mcp`; health is available at
`/healthz`. Every MCP request requires `Authorization: Bearer <token>`.

By default the request bearer becomes the HTTP Basic password for Hibiscus
(username `foobar`). If `HIBISCUS_MCP_GATEWAY` is configured, clients use that
synthetic token while the real upstream credential remains exclusively in
`HIBISCUS_MCP_BEARER` inside this container. No credentials are written to the
image or logged.

The container has no database or volume. Container builds and pushes run only
in GitHub Actions. Deploy with `sudo podman-smart1.sh --update`, then run
`./setup.sh` as the target user.

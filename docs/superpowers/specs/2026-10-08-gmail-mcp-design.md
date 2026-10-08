# Gmail MCP deployment design

Approved base: a focused TypeScript MCP server with oidc-provider, following the verified crosscheck in `/private/research/merged.md`.

One HTTPS `/mcp` endpoint exposes only explicitly routed Gmail tools. Draft-only is the default; send and label operations require an explicit configuration choice. No arbitrary local file attachments, Gmail token passthrough, account-enrollment MCP tools or default mailbox. `list_accounts` requires a configured `account` alias too; the operator already knows at least one configured alias, so discovery can retain the user's literal contract without a wildcard or exception.

The OAuth provider uses preregistered public clients, PKCE S256, owner-only Google OIDC login, explicit consent, durable encrypted storage, rotation/replay rejection and immediate grant revocation. Owner subject bootstrap and mailbox enrollment happen through a local CLI using Google Desktop OAuth with SSH forwarding. Google Web OAuth handles remote owner login. The server fails closed until configuration and the pinned owner exist.

Secrets and state live outside the repository. Authenticated encryption protects payloads; HMAC protects bearer-token lookup IDs. SQLite transactions protect consumption and updates. Files are 0600, directory 0700, encryption key separate. Logs contain fixed event codes, never arbitrary errors, request data, mail, URLs or tokens.

Deployment uses a dedicated non-root systemd service, loopback app listener and Caddy HTTPS. Existing services/firewall/tunnel routes are not changed until the exact deployment proposal is approved. The domain is `mcp.example.com`; the sole owner is `owner@example.com`. The four mailbox identities and incoming forwarding aliases are recorded in the README. Read, draft, send and label access is enabled using `gmail.modify`. Firewall restrictions apply only to public ingress; existing LAN, Tailscale and services must be preserved. Google console/browser steps must wait for the user.

Acceptance: local tests cover storage secrecy/tamper/cross-record binding, replay, owner isolation, audience/scope rejection, strict tool arguments and write retry behavior. MCP Inspector must connect locally using OAuth. Real Claude must list accounts, search each and create synthetic drafts; never send during verification. That final test needs real credentials and user login.

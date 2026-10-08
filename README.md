# Gmail MCP

Self-hosted, single-user Gmail MCP service for Claude, under construction.

The current implementation contains the encrypted state store and its tests.
The HTTP endpoint, OAuth provider, Gmail tools, enrollment CLI and deployment
are still pending. Do not deploy this checkout yet.
The initial store also has [known issues](docs/storage-review.md) to resolve
before OAuth integration.

## Intended configuration

- One HTTPS endpoint, for example `https://mcp.example.com/mcp`.
- One explicitly configured owner identity, for example `owner@example.com`.
- Multiple Gmail accounts, each selected by a required `account` alias.
- Configurable access: read and drafts, or read, drafts, send and apply labels.
  Full access uses `https://www.googleapis.com/auth/gmail.modify`.

Example account aliases:

| Alias | Gmail address |
| --- | --- |
| personal | owner@example.com |
| work | owner@example.org |

Addresses that forward into a Gmail inbox are read through that inbox's account
alias. Forwarding alone does not configure an outgoing Gmail identity.

## Development

Use Node.js 24 or newer.

```sh
npm ci --ignore-scripts
npm test
npm run check
npm run build
```

Credentials, encryption keys and runtime state must live outside this checkout.
The store requires a private directory and a 32-byte encryption key. It encrypts
record contents with AES-256-GCM and hashes lookup IDs with HMAC-SHA256.

## Implementation status

- [x] Research MCP authorization, Claude connectors and candidate projects.
- [x] Approve a custom TypeScript server using the official MCP SDK and oidc-provider.
- [x] Implement and test the initial encrypted state store.
- [ ] Resolve the storage review findings and add regression coverage.
- [ ] Implement Gmail tools, OAuth, HTTP and the enrollment CLI.
- [ ] Create Google OAuth clients and authorize each account in a browser.
- [ ] Approve and install systemd, TLS and public ingress configuration.
- [ ] Verify with MCP Inspector and Claude using searches and drafts only.
- [ ] Complete operational instructions for accounts, rotation, revocation and updates.

Deployment instructions must account for existing services and preserve intended
LAN and VPN access. Verification uses synthetic messages and drafts; never send
email during tests.

## Public repository policy

Keep domains, owner identities, mailbox addresses, forwarding rules and host
paths in private configuration outside the repository. Examples use reserved
`example.com` and `example.org` names. Tests use synthetic data. Do not commit
OAuth client files, keys, tokens, state databases, request logs or real email.

Before making the repository public, inspect the complete Git history and other
GitHub content for private deployment details. Sanitizing current files does not
remove earlier versions. Select a distribution license before a public release.

Design and implementation plan are in [docs/superpowers](docs/superpowers).

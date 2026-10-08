# Gmail MCP

Private, single-user Gmail MCP service for Claude, under construction.

The current implementation contains the encrypted state store and its tests.
The HTTP endpoint, OAuth provider, Gmail tools, enrollment CLI and deployment
are still pending. Do not deploy this checkout yet.

## Approved configuration

- Endpoint: `https://mcp.example.com/mcp`
- Sole login identity: `owner@example.com`
- Gmail access: read, draft, send and apply labels, using
  `https://www.googleapis.com/auth/gmail.modify`.
- Accounts:

| Alias | Gmail address |
| --- | --- |
| personal | owner@example.com |
| work-one | owner@work-one.example |
| work-two | owner@work-two.example |
| work-three | owner@work-three.example |

Cloudflare forwards mail for `owner@forward.example`, `hello@forward.example`,
`privacy@forward.example` and `contact@another.example` into `personal`.
These are incoming addresses only, not separate accounts or outgoing identities.

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

## Setup checklist

- [x] Research MCP authorization, Claude connectors and candidate projects.
- [x] Approve a custom TypeScript server using the official MCP SDK and oidc-provider.
- [x] Confirm accounts, permissions and sole login identity.
- [x] Implement and test the initial encrypted state store.
- [ ] Implement Gmail tools, OAuth, HTTP and the enrollment CLI.
- [ ] Create Google OAuth clients and authorize each account in a browser.
- [ ] Approve and install systemd, TLS and public ingress configuration.
- [ ] Verify with MCP Inspector and Claude using searches and drafts only.
- [ ] Complete operational instructions for accounts, rotation, revocation and updates.

Existing services, LAN and Tailscale access must remain available. Changes to
existing services require approval. No email will be sent during testing.

Design and implementation plan are in [docs/superpowers](docs/superpowers).

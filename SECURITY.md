# Security

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/alexneamtu/gmail-mcp/security/advisories/new).
Open the repository's **Security** tab and choose **Report a vulnerability**.
Do not put exploit details or credentials in a public issue. If private reporting
is unavailable, contact the maintainer through their GitHub profile to arrange a
private channel before sharing sensitive details.

Include the affected commit/version, a description of the impact, and a minimal
reproduction with synthetic accounts. Remove OAuth codes, tokens, client secrets,
real addresses, message contents, private hostnames, and database/key files.
Do not test against somebody else's deployment or send real email to demonstrate
an issue. A fake Gmail backend is sufficient for write-path reports.

## Supported versions

This is an early personal-use project. Security fixes target the latest `main`
revision; older snapshots have no separate maintenance branch. There is no
promised response time or service-level agreement.

## Security model and limits

Each deployment has one configured Google owner. Google mailbox authorization is
separate from MCP client consent. The server pins identities, requires PKCE,
checks OAuth audience/grants, and encrypts stored credentials and authorization
state. Each tool requires an explicit mailbox alias.

Encryption at rest does not protect against a compromised host or an attacker
who obtains both the database and its key. Backups also need private permissions.
A restored old database can restore old authorization; revoke connector access
before exposing restored state. Mail returned to a client is subject to that
client's retention policy. Email content remains untrusted input for the model.

Sending requires explicit user authorization for the specific draft. The tool
annotation and description are instructions to the client, not an independent
human approval system. Review client permission settings. Unknown write outcomes
must be checked in Gmail before retrying.

Use your own Google project and credentials. Keep configuration, tokens and live
verification records outside the checkout. Do not enable proxy access logs or
HTTP debugging that could capture OAuth callback URLs or mail content. Follow
the [operations guide](docs/operations.md) for updates and code rollback.

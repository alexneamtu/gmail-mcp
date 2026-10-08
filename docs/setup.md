# First-time setup

This guide is for one owner hosting their own connector. It is not a hosted,
multi-tenant service. Each operator uses their own Google project and credentials.
Phone-only enrollment is unsupported; use a computer with a browser and SSH.

## 1. Build and configure

Install Node 24, Git and npm on the server. Clone this repository and enter it:

```bash
git clone https://github.com/alexneamtu/gmail-mcp.git
cd gmail-mcp
npm ci --ignore-scripts
npm test
npm run check
npm run build
install -d -m 0700 "$HOME/.config/gmail-mcp"
install -m 0600 deploy/config.example.json "$HOME/.config/gmail-mcp/config.json"
```

Edit that private config. Set `origin` to your HTTPS hostname, `ownerEmail` to the
only Google identity allowed to log in, and `accounts` to alias/address pairs.
Choose `access: "drafts"` or `"full"`. Each mailbox must be explicitly authorized;
email forwarding addresses are not independent Gmail accounts. Never commit this
file. Use port 8787 unless it conflicts with another service.

## 2. Serve the public information pages before Google setup

The ordinary server cannot start until owner enrollment is complete. Use the
information-only entry point first:

```bash
npm run start:setup
```

Leave it running in its terminal. It binds loopback, serves `/`, `/privacy` and
`/terms`, and returns 503 for `/mcp`. It does not need OAuth client JSON or a key.
It intentionally has no Gmail tools or login endpoints.

Publish your hostname through a Cloudflare tunnel with service URL
`http://127.0.0.1:8787`. If the tunnel runs in a container, its loopback is different:
choose an explicit route to the server instead and review that network boundary.
Preserve existing routes. Configure public Host and forwarded HTTPS correctly;
use no caching, access logging or interactive Access login on this hostname.
See [Cloudflare published applications](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/).

Open `https://YOUR-HOST/`, `/privacy`, and `/terms` in a browser. Check that the
privacy statements describe your deployment. The hostname must be reachable
before you give these URLs to Google. Tunnel setup normally creates its DNS
record; otherwise use the record specified by your tunnel provider/configuration.

## 3. Configure your Google project

In [Google Cloud Console](https://console.cloud.google.com/), select/create a
dedicated project. Then complete these steps:

1. **APIs & Services → Library:** find Gmail API and enable it.
2. **Google Auth Platform → Branding:** set the app name, support email and
   developer contact email. Add the real homepage, privacy and terms URLs from
   step 2. Add your registrable domain under Authorized domains, for example
   `example.com` for `mcp.example.com`. A logo is optional; leave it empty unless
   you need it. Save all required fields.
3. **Audience:** select External if the accounts span personal Gmail and Workspace
   organizations. Publish the app to **In production before enrollment**. Google's
   Testing status expires Gmail authorizations and offline refresh tokens after
   seven days. In production is separate from verification. Personal-use projects
   may remain unverified where Google permits it; a warning or Workspace policy
   can still apply. See [Google audience guidance](https://support.google.com/cloud/answer/15549945).
4. **Data Access:** add `openid`, `https://www.googleapis.com/auth/userinfo.email`
   and the Gmail scopes for your mode. Full mode needs only
   `https://www.googleapis.com/auth/gmail.modify`. Drafts mode needs
   `https://www.googleapis.com/auth/gmail.readonly` and
   `https://www.googleapis.com/auth/gmail.compose`. The compose scope can send;
   this server omits the sending tool in drafts mode.
5. **Clients → Create client:** create a Desktop app for account enrollment.
   Download its JSON file. No domain callback is registered on this client;
   enrollment uses a loopback callback on port 18888.
6. Create a second client of type Web application for owner login. Add exactly
   `https://YOUR-HOST/login/google/callback` under Authorized redirect URIs.
   Leave JavaScript origins empty. Download its JSON while the secret is shown.

Save the two JSON files privately on the server as
`~/.config/gmail-mcp/google-desktop.json` and `google-web.json`:

```bash
chmod 600 "$HOME/.config/gmail-mcp/google-desktop.json" \
  "$HOME/.config/gmail-mcp/google-web.json"
```

Never paste secrets into an issue or chat. Workspace administrators may need to
allow the app. Do not reuse the maintainer's project or expect verification of
one deployment to apply to another.

## 4. Enroll the owner and each mailbox

Run the CLI in a second server terminal while the information pages remain up:

```bash
node dist/cli.js init "$HOME/.config/gmail-mcp/google-desktop.json" \
  "$HOME/.config/gmail-mcp/google-web.json"
node dist/cli.js enroll-owner
```

Before opening the printed Google link, run this on the computer displaying the
browser, substituting your SSH account and server:

```bash
ssh -N -L 18888:127.0.0.1:18888 <ssh-user>@<server>
```

Keep it running. Sign in as the configured owner. Back on the server, enroll each
configured mailbox, selecting its exact Google identity and approving all
requested scopes:

```bash
node dist/cli.js enroll personal
node dist/cli.js enroll work
node dist/cli.js status
```

Use your actual aliases. Each enrollment expires after ten minutes; cancellation
and errors require a fresh command/link. The success page names the completed
alias. After all enrollments succeed, close the SSH tunnel. Local `status` does
not contact Google or establish that refresh will work in the future.

## 5. Install and connect

Stop the information-page server with Ctrl-C. Follow the
[installation commands](operations.md#first-installation). Verify HTTPS and the
unauthenticated 401 response before adding the connector in
[Claude](../README.md#connect-claude) or [Codex](../README.md#connect-codex).
Google client IDs are different from the connector's `claude-gmail` and
`codex-gmail` IDs. No shared API key or secret URL grants mailbox access.

After installation use `sudo gmail-mcp-admin`, not the development CLI defaults,
so account changes affect the live configuration/database.

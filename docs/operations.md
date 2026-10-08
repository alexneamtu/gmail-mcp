# Install, update and roll back

Supported deployment: Linux with systemd, Node 24, a dedicated service user and
HTTPS supplied by a Cloudflare tunnel. Node's entire installation directory must
contain `bin/node`. The scripts do not change your tunnel, firewall or router.

Run these Bash commands from a reviewed checkout. Keep enrollment/admin commands
stopped during installation and maintenance. Test backups and protect both the
key and database; restoring only one can make the state unreadable.

## First installation

Complete [setup](setup.md), including owner and mailbox enrollment. Stop the
information-only server with Ctrl-C before installing the service. Confirm that
port 8787 is free for the service.

```bash
set -euo pipefail
release_repo=$(pwd -P)
node_directory=$(dirname "$(dirname "$(node -p 'process.execPath')")")
sudo bash deploy/install.sh "$release_repo" "$node_directory" \
  "$HOME/.config/gmail-mcp" "$HOME/.local/share/gmail-mcp"
sudo gmail-mcp-admin status
```

The installer refuses existing installations. Do not delete live directories to
force it through; use the update procedure below. The service runs as `gmail-mcp`.
Application files are root-owned under `/opt/gmail-mcp`; private configuration
and state are under `/etc/gmail-mcp` and `/var/lib/gmail-mcp`.

## Code-only update

This procedure updates application code and dependencies, not Node, the systemd
unit, or the database schema. Read release notes first. A future schema-changing
release needs its own migration and rollback instructions. Changes to the unit,
Node runtime or admin wrapper require a separate reviewed installation step.

Run `git pull --ff-only`, then build and verify as your normal user:

```bash
npm ci --ignore-scripts
npm test
npm run check
npm run build
```

Then run the following block from that checkout in one Bash session. It stages
files before stopping the service, retains the previous application, and makes a
private matched state/key backup while stopped. Stop all admin/enrollment
processes first. Keep the printed backup paths.

<!-- smoke:update -->
```bash
set -euo pipefail
release_repo=$(pwd -P)
test -f "$release_repo/dist/main.js"
test -d "$release_repo/node_modules"
test -f "$release_repo/public/index.html"

stage=$(sudo mktemp -d /opt/gmail-mcp/app.next.XXXXXXXX)
sudo cp -a "$release_repo/dist" "$release_repo/public" \
  "$release_repo/node_modules" "$release_repo/package.json" \
  "$release_repo/README.md" "$stage/"
sudo chown -R root:root "$stage"
sudo chmod -R a+rX,go-w "$stage"
sudo runuser -u gmail-mcp -- /opt/gmail-mcp/node/bin/node \
  --input-type=module -e 'await import(process.argv[1])' "$stage/dist/app.js"

backup=$(sudo mktemp -d /opt/gmail-mcp/backup.XXXXXXXX)
sudo chmod 0700 "$backup"
sudo systemctl stop gmail-mcp.service
# Refuse a database that another process may still be writing.
if sudo test -e /var/lib/gmail-mcp/state.db-wal || \
   sudo test -e /var/lib/gmail-mcp/state.db-journal; then
  echo 'Database journal exists. Stop admin processes and inspect before continuing.' >&2
  sudo systemctl start gmail-mcp.service
  exit 1
fi
sudo cp -a /etc/gmail-mcp/master.key /etc/gmail-mcp/config.json \
  /var/lib/gmail-mcp/state.db "$backup/"
previous_app="$backup/app"
sudo mv /opt/gmail-mcp/app "$previous_app"
sudo mv "$stage" /opt/gmail-mcp/app
sudo systemctl start gmail-mcp.service
printf 'Previous application and matched state backup: %s\n' "$backup"
sudo systemctl is-active gmail-mcp.service
```
<!-- smoke:end -->

If a command fails after stopping the service, inspect the failure before
continuing. If the old application has moved, use the rollback block. If it has
not moved, restart the unchanged service. Keep recovery paths available even if
startup fails: list `/opt/gmail-mcp/backup.*` as root to locate them.

## Verify after install or update

Substitute your hostname. Public metadata must use `https://`, health must return
200, and the unauthenticated MCP call must return 401 with `WWW-Authenticate`.
`curl` works through typical tunnel settings; if your edge blocks a particular
HTTP client, inspect the edge policy separately from application health.

```bash
connector_origin=https://mcp.example.com
curl --fail --silent --show-error "$connector_origin/healthz"
curl --silent --show-error --include -X POST \
  -H 'Content-Type: application/json' --data '{}' "$connector_origin/mcp"
curl --fail --silent --show-error \
  "$connector_origin/.well-known/oauth-authorization-server"
```

Then use your authenticated MCP client to call `list_accounts` with a known alias
and perform a read-only search. Local status does not prove Google refresh works.
Create a clearly marked draft only if you want a write-path check. Never send
email during deployment validation. Do not paste tokens or callback URLs into
issues or logs.

## Roll back application code

Use the `previous_app` path printed/derived above, for example
`/opt/gmail-mcp/backup.abcdefgh/app`. Set it explicitly if using another shell.
This restores only code; it does not restore an old authorization database.

<!-- smoke:rollback -->
```bash
set -euo pipefail
# In a new shell, set previous_app to your actual backup's app directory first.
test -n "${previous_app:-}"
sudo test -f "$previous_app/dist/main.js"
failed_app=$(sudo mktemp -d /opt/gmail-mcp/app.failed.XXXXXXXX)
sudo systemctl stop gmail-mcp.service
if sudo test -e /opt/gmail-mcp/app; then
  sudo mv /opt/gmail-mcp/app "$failed_app/app"
fi
sudo mv "$previous_app" /opt/gmail-mcp/app
sudo systemctl start gmail-mcp.service
sudo systemctl is-active gmail-mcp.service
printf 'Failed application retained at: %s/app\n' "$failed_app"
```
<!-- smoke:end -->

Repeat the health/authentication checks. Retain private backups until verified,
then remove only the particular obsolete paths you reviewed. Never restore old
state as part of an ordinary code rollback. If disaster recovery requires a
matched key/database restore, revoke connector access before exposing it.

## Verification limits

CI executes installation and these update/rollback blocks inside a disposable
Node 24 Linux container, using synthetic configuration and state. It starts the
actual server under the service user, checks permissions and authentication, and
verifies state/key preservation. Docker does not run systemd as PID 1 in this
test: a narrow test-only service-control shim starts/stops Node. Real systemd
sandboxing, Cloudflare HTTPS and Google browser authorization still require the
operator checks above. No host credentials or service directories are mounted.

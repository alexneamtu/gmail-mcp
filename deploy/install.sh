#!/usr/bin/env bash
set -euo pipefail
if [[ $EUID -ne 0 || $# -ne 4 ]]; then
  echo 'Usage: sudo bash deploy/install.sh <built-repo> <node-24-directory> <private-config-directory> <state-directory>' >&2
  exit 1
fi
source_repo=$(realpath "$1")
source_node=$(realpath "$2")
source_config=$(realpath "$3")
source_state=$(realpath "$4")
for target in /opt/gmail-mcp /etc/gmail-mcp /var/lib/gmail-mcp /etc/systemd/system/gmail-mcp.service /usr/local/bin/gmail-mcp-admin; do
  if [[ -e "$target" ]]; then echo 'Existing installation found; refusing to overwrite it.' >&2; exit 1; fi
done
if getent passwd gmail-mcp >/dev/null; then echo 'Service identity already exists; inspect it before installation.' >&2; exit 1; fi
[[ -f "$source_repo/dist/main.js" && -d "$source_repo/node_modules" && -d "$source_repo/public" ]]
[[ -f "$source_config/config.json" && -f "$source_config/master.key" && -f "$source_state/state.db" ]]
[[ $("$source_node/bin/node" -p 'process.versions.node.split(".")[0]') == 24 ]]
if [[ -e "$source_state/state.db-journal" || -e "$source_state/state.db-wal" ]]; then
  echo 'Database journal exists. Stop all connector/enrollment processes before installation.' >&2; exit 1
fi
useradd --system --home-dir /var/lib/gmail-mcp --shell /usr/sbin/nologin gmail-mcp
install -d -m 0755 /opt/gmail-mcp /opt/gmail-mcp/app /opt/gmail-mcp/node/bin
install -m 0755 "$source_node/bin/node" /opt/gmail-mcp/node/bin/node
cp -a "$source_repo/dist" "$source_repo/node_modules" "$source_repo/public" /opt/gmail-mcp/app/
install -m 0644 "$source_repo/package.json" /opt/gmail-mcp/app/package.json
install -m 0644 "$source_repo/README.md" /opt/gmail-mcp/app/README.md
chown -R root:root /opt/gmail-mcp
chmod -R a+rX,go-w /opt/gmail-mcp
install -d -m 0700 -o gmail-mcp -g gmail-mcp /etc/gmail-mcp /var/lib/gmail-mcp
install -m 0600 -o gmail-mcp -g gmail-mcp "$source_config/config.json" /etc/gmail-mcp/config.json
install -m 0600 -o gmail-mcp -g gmail-mcp "$source_config/master.key" /etc/gmail-mcp/master.key
install -m 0600 -o gmail-mcp -g gmail-mcp "$source_state/state.db" /var/lib/gmail-mcp/state.db
install -m 0644 "$source_repo/deploy/gmail-mcp.service" /etc/systemd/system/gmail-mcp.service
install -m 0755 "$source_repo/deploy/admin.sh" /usr/local/bin/gmail-mcp-admin
systemctl daemon-reload
systemctl enable --now gmail-mcp.service
systemctl is-active gmail-mcp.service
echo 'Service installed. HTTPS/DNS/firewall configuration is a separate step.'

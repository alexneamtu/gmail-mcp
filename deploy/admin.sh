#!/usr/bin/env bash
set -euo pipefail
exec runuser -u gmail-mcp -- env \
  GMAIL_MCP_CONFIG=/etc/gmail-mcp/config.json \
  GMAIL_MCP_KEY=/etc/gmail-mcp/master.key \
  GMAIL_MCP_STATE=/var/lib/gmail-mcp \
  /opt/gmail-mcp/node/bin/node /opt/gmail-mcp/app/dist/cli.js "$@"

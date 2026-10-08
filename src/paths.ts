import {homedir} from 'node:os';
import {join} from 'node:path';
export const paths=()=>({config:process.env.GMAIL_MCP_CONFIG??join(homedir(),'.config/gmail-mcp/config.json'),
  key:process.env.GMAIL_MCP_KEY??join(homedir(),'.config/gmail-mcp/master.key'),
  state:process.env.GMAIL_MCP_STATE??join(homedir(),'.local/share/gmail-mcp')});

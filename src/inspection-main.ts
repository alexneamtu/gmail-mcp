import {StdioServerTransport} from '@modelcontextprotocol/server/stdio';
import {MailTools} from './tools.js';
import {OperationError} from './errors.js';

// Reuse the real catalog, but block even local-only calls such as list_accounts.
class InspectionTools extends MailTools {
  override async execute():Promise<never>{throw new OperationError('inspection_only');}
}

async function main(){
  const tools=new InspectionTools({origin:'http://127.0.0.1:8787',ownerEmail:'inspection@example.invalid',
    accounts:{inspection:'inspection@example.invalid'},access:'full',port:8787},
    {async request():Promise<never>{throw new OperationError('inspection_only');}});
  const server=tools.server('Schema inspection only. No accounts are connected. All tool calls are disabled. The inspection account is a placeholder. Deploy the documented authenticated HTTP service for Gmail access.');
  const stop=()=>{void server.close().catch(()=>{console.error('event=inspection_shutdown_failed');process.exitCode=1;});};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  await server.connect(new StdioServerTransport());
}

main().catch(()=>{console.error('event=inspection_startup_failed');process.exitCode=1;});

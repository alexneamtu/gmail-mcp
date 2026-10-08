import {existsSync,mkdirSync,writeFileSync,renameSync,copyFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {OAuth2Client} from 'google-auth-library';
import {paths} from './paths.js';
import {loadConfig} from './config.js';
import {Store,readPrivateFile} from './store.js';
import {initializeProviderSecrets} from './app.js';
import {enroll} from './enroll.js';
import {accountStatus} from './accounts.js';
import {OperationError,safeError} from './errors.js';

async function main(){
  const [command,...args]=process.argv.slice(2);
  if(!command||command==='--help'||command==='help'||command==='-h'){
    console.log(`Gmail MCP administration
  init <desktop-json> <web-json>   Import Google OAuth clients
  enroll-owner                   Pin or re-enable the owner identity
  enroll <alias>                 Enroll or reauthorize one configured mailbox
  status                         Inspect local enrollment; no Google requests
  remove <alias>                 Disable mailbox access, then revoke its Google grant
  revoke-all                     Disable owner login and revoke connector grants
  rotate-secrets                 Rotate provider keys; reconnect all MCP clients
  rotate-key --service-stopped   Rotate encryption while service/admin processes are stopped

After installation use sudo gmail-mcp-admin <command> so you inspect the live state.
For remote enrollment, run this on the computer displaying the browser:
  ssh -N -L 18888:127.0.0.1:18888 <ssh-user>@<server>
Keep the tunnel open until enrollment succeeds. Phone-only enrollment is not supported.
See README.md for private configuration and Google Console setup.`);return;
  }
  const counts:Record<string,number>={init:2,'enroll-owner':0,enroll:1,status:0,remove:1,'revoke-all':0,'rotate-secrets':0,'rotate-key':1};
  if(!Object.hasOwn(counts,command)||args.length!==counts[command])throw new OperationError('invalid_arguments');
  const p=paths();
  if(command==='init'){
    if(args.length!==2)throw new OperationError('invalid_arguments');
    const config=loadConfig(p.config);
    const desktop=JSON.parse(readPrivateFile(args[0]!).toString()).installed;
    const web=JSON.parse(readPrivateFile(args[1]!).toString()).web;
    if(!desktop?.client_id||!desktop?.client_secret||!web?.client_id||!web?.client_secret||!web.redirect_uris?.includes(config.origin+'/login/google/callback'))throw new OperationError('configuration_error');
    if(!existsSync(p.key)){
      if(existsSync(join(p.state,'state.db')))throw new OperationError('original_key_required');
      mkdirSync(dirname(p.key),{recursive:true,mode:0o700});writeFileSync(p.key,randomBytes(32),{flag:'wx',mode:0o600});
    }
    const store=new Store(p.state,readPrivateFile(p.key));
    try{store.put('Settings','desktop',desktop);store.put('Settings','web',web);initializeProviderSecrets(store);}finally{store.close();}
    console.log('OAuth clients imported. Next: enroll-owner, then enroll <alias> for each mailbox.');return;
  }
  const config=loadConfig(p.config);const store=new Store(p.state,readPrivateFile(p.key));
  try{
    switch(command){
      case 'enroll-owner':await enroll(config,store);console.log('Owner identity pinned.');break;
      case 'enroll':if(args.length!==1)throw new OperationError('invalid_arguments');await enroll(config,store,args[0]);console.log('Mailbox enrolled.');break;
      case 'status':console.log(JSON.stringify({ownerPinned:!!store.get('Settings','owner')?.sub,disabled:!!store.get('Settings','owner')?.disabled,
        accounts:Object.keys(config.accounts).map(account=>({account,...accountStatus(config,store,account)}))},null,2));break;
      case 'remove':{
        const alias=args[0];if(!alias||!Object.hasOwn(config.accounts,alias))throw new OperationError('invalid_arguments');
        const mailbox=store.get('Mailbox',alias);
        if(!mailbox){console.log('No stored mailbox grant exists to revoke.');break;}
        store.put('Mailbox',alias,{...mailbox,disabled:true});
        if(mailbox.refreshToken)await new OAuth2Client().revokeToken(mailbox.refreshToken);
        store.delete('Mailbox',alias);
        console.log('Mailbox removed and Google grant revoked. Remove its config entry and restart the service.');break;
      }
      case 'revoke-all':{
        const owner=store.get('Settings','owner');if(owner)store.put('Settings','owner',{...owner,disabled:true});store.revokeAll();
        console.log('Connector grants revoked and owner login disabled. Google mailbox grants remain enrolled; enroll-owner re-enables login.');break;
      }
      case 'rotate-secrets':store.revokeAll();store.delete('Settings','provider');initializeProviderSecrets(store);console.log('Provider signing and cookie keys rotated. Restart the service and reconnect Claude and Codex.');break;
      case 'rotate-key':{
        if(args[0]!=='--service-stopped')throw new OperationError('rotation_confirmation');
        const next=p.key+'.next',backup=p.key+'.previous',dbBackup=join(p.state,'state.db.before-key-rotation');
        if(existsSync(next)||existsSync(backup)||existsSync(dbBackup))throw new OperationError('rotation_backup_exists');
        const key=randomBytes(32);writeFileSync(next,key,{flag:'wx',mode:0o600});
        copyFileSync(p.key,backup);copyFileSync(join(p.state,'state.db'),dbBackup);
        store.rekey(key);renameSync(next,p.key);
        console.log('Data key rotated. Old key/database backup retained privately for recovery. Restart and verify before removing backups.');break;
      }
      default:throw new OperationError('invalid_arguments');
    }
  }finally{store.close();}
}
main().catch((error:unknown)=>{
  const fileCode=(error as NodeJS.ErrnoException)?.code;
  const failure=safeError(fileCode==='ENOENT'?new OperationError('private_files_missing'):fileCode==='EACCES'||fileCode==='EPERM'?new OperationError('private_files_permissions'):error instanceof SyntaxError?new OperationError('configuration_error'):error);
  console.error(`${failure.code}: ${failure.message}`);process.exitCode=1;
});

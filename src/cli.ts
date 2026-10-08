import {existsSync,mkdirSync,writeFileSync,renameSync,copyFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {OAuth2Client} from 'google-auth-library';
import {paths} from './paths.js';
import {loadConfig} from './config.js';
import {Store,readPrivateFile} from './store.js';
import {initializeProviderSecrets} from './app.js';
import {enroll} from './enroll.js';

async function main(){
  const [command,...args]=process.argv.slice(2);const p=paths();
  if(command==='init'){
    if(args.length!==2)throw new Error('Use init <desktop-json> <web-json>');
    const config=loadConfig(p.config);
    const desktop=JSON.parse(readPrivateFile(args[0]!).toString()).installed;
    const web=JSON.parse(readPrivateFile(args[1]!).toString()).web;
    if(!desktop?.client_id||!desktop?.client_secret||!web?.client_id||!web?.client_secret||!web.redirect_uris?.includes(config.origin+'/login/google/callback'))throw new Error('Invalid client files or callback');
    if(!existsSync(p.key)){
      if(existsSync(join(p.state,'state.db')))throw new Error('Existing state requires its original key');
      mkdirSync(dirname(p.key),{recursive:true,mode:0o700});writeFileSync(p.key,randomBytes(32),{flag:'wx',mode:0o600});
    }
    const store=new Store(p.state,readPrivateFile(p.key));
    try{store.put('Settings','desktop',desktop);store.put('Settings','web',web);initializeProviderSecrets(store);}finally{store.close();}
    console.log('OAuth clients imported. Next: enroll-owner, then enroll <alias> for each mailbox.');return;
  }
  if(!command)throw new Error('Commands: init, enroll-owner, enroll, status, remove, revoke-all, rotate-secrets, rotate-key');
  const config=loadConfig(p.config);const store=new Store(p.state,readPrivateFile(p.key));
  try{
    switch(command){
      case 'enroll-owner':await enroll(config,store);console.log('Owner identity pinned.');break;
      case 'enroll':if(args.length!==1)throw new Error('Alias required');await enroll(config,store,args[0]);console.log('Mailbox enrolled.');break;
      case 'status':console.log(JSON.stringify({ownerPinned:!!store.get('Settings','owner')?.sub,disabled:!!store.get('Settings','owner')?.disabled,
        accounts:Object.keys(config.accounts).map(account=>({account,enrolled:!!store.get('Mailbox',account)}))},null,2));break;
      case 'remove':{
        const alias=args[0];if(!alias||!Object.hasOwn(config.accounts,alias))throw new Error('Configured alias required');
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
      case 'rotate-secrets':store.revokeAll();store.delete('Settings','provider');initializeProviderSecrets(store);console.log('Provider signing and cookie keys rotated. Restart the service and reconnect Claude.');break;
      case 'rotate-key':{
        if(args[0]!=='--service-stopped')throw new Error('Stop the service first, then pass --service-stopped');
        const next=p.key+'.next',backup=p.key+'.previous',dbBackup=join(p.state,'state.db.before-key-rotation');
        if(existsSync(next)||existsSync(backup)||existsSync(dbBackup))throw new Error('Rotation backup already exists; inspect it before proceeding');
        const key=randomBytes(32);writeFileSync(next,key,{flag:'wx',mode:0o600});
        copyFileSync(p.key,backup);copyFileSync(join(p.state,'state.db'),dbBackup);
        store.rekey(key);renameSync(next,p.key);
        console.log('Data key rotated. Old key/database backup retained privately for recovery. Restart and verify before removing backups.');break;
      }
      default:throw new Error('Unknown command');
    }
  }finally{store.close();}
}
main().catch(()=>{console.error('Administration failed. Check command arguments, private files, account identity and Google permissions. No credentials are logged.');process.exitCode=1;});

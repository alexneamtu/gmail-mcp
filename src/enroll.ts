import {createServer} from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import {OAuth2Client,CodeChallengeMethod} from 'google-auth-library';
import type {Config} from './config.js';
import {gmailScopes} from './config.js';
import {Store} from './store.js';
import {OperationError,safeError} from './errors.js';

export async function enroll(config:Config,store:Store,alias?:string):Promise<void>{
  if(alias!==undefined&&!Object.hasOwn(config.accounts,alias))throw new OperationError('invalid_arguments');
  const expected=alias?config.accounts[alias]:config.ownerEmail;if(!expected)throw new OperationError('invalid_arguments');
  const label=alias??'owner identity';
  const desktop=store.get('Settings','desktop');if(!desktop)throw new OperationError('configuration_error');
  const client=new OAuth2Client(desktop.client_id,desktop.client_secret,'http://127.0.0.1:18888/callback');
  const state=randomBytes(32).toString('base64url'),nonce=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url');
  const scopes=alias?[...gmailScopes(config),'openid','email']:['openid','email'];
  const url=client.generateAuthUrl({scope:scopes,state,nonce,code_challenge:createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method:CodeChallengeMethod.S256,access_type:alias?'offline':'online',prompt:alias?'consent select_account':'select_account',login_hint:expected});
  await new Promise<void>((resolve,reject)=>{
    let used=false;
    const server=createServer(async(req,res)=>{
      const u=new URL(req.url??'/','http://127.0.0.1:18888');
      if(req.method!=='GET'||req.headers.host!=='127.0.0.1:18888'||u.pathname!=='/callback')return void res.writeHead(404).end();
      res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
      if(used||u.searchParams.getAll('state').length!==1||u.searchParams.get('state')!==state)return void res.writeHead(400).end('Invalid authorization response. Use the latest enrollment link.');
      if(u.searchParams.getAll('error').length===1&&!u.searchParams.has('code')){
        used=true;const error=new OperationError(u.searchParams.get('error')==='access_denied'?'enrollment_cancelled':'authorization_failed');res.writeHead(400,{'Content-Type':'text/plain'}).end(error.message);finish();reject(error);return;
      }
      if(u.searchParams.has('error')||u.searchParams.getAll('code').length!==1||!u.searchParams.get('code'))return void res.writeHead(400).end('Invalid authorization response. Use the latest enrollment link.');
      used=true;
      try{
        const {tokens}=await client.getToken({code:u.searchParams.get('code')!,codeVerifier:verifier});
        if(!tokens.id_token)throw new OperationError('grant_missing');
        const ticket=await client.verifyIdToken({idToken:tokens.id_token,audience:desktop.client_id});const identity=ticket.getPayload() as any;
        if(!identity||identity.email_verified!==true||identity.email!==expected||identity.nonce!==nonce||!identity.sub)throw new OperationError('wrong_account');
        const previous=store.get(alias?'Mailbox':'Settings',alias??'owner');
        if(previous?.sub&&previous.sub!==identity.sub)throw new OperationError('identity_mismatch');
        if(alias){
          if(!tokens.refresh_token||!gmailScopes(config).every(scope=>tokens.scope?.split(' ').includes(scope)))throw new OperationError('grant_missing');
          store.put('Mailbox',alias,{email:expected,sub:identity.sub,refreshToken:tokens.refresh_token,scopes:gmailScopes(config)});
        }else store.put('Settings','owner',{email:expected,sub:identity.sub,disabled:false});
        res.writeHead(200,{'Content-Type':'text/plain'}).end(`Enrollment complete for ${label}. You can close this tab. Keep the SSH tunnel open if more accounts remain.`);finish();resolve();
      }catch(error){const failure=error instanceof OperationError?error:new OperationError('operation_failed');res.writeHead(403,{'Content-Type':'text/plain'}).end(safeError(failure).message);finish();reject(failure);}
    });
    const timeout=setTimeout(()=>{finish();reject(new OperationError('enrollment_timeout'));},10*60*1000);
    function finish(){clearTimeout(timeout);server.close();server.closeIdleConnections();}
    server.once('error',(error:NodeJS.ErrnoException)=>{clearTimeout(timeout);reject(new OperationError(error.code==='EADDRINUSE'?'enrollment_port_busy':'operation_failed'));});
    server.listen(18888,'127.0.0.1',()=>{
      process.stdout.write(`Enrollment: ${label}. Complete Google authorization within ten minutes.\n`);
      process.stdout.write('For remote enrollment, the computer displaying the browser must keep this SSH forward open: ssh -N -L 18888:127.0.0.1:18888 <ssh-user>@<server>\n');
      process.stdout.write('Enrollment on the server itself needs no tunnel. Phone-only enrollment is not supported.\n');
      process.stdout.write('Then open this authorization link on that computer:\n'+url+'\n');
    });
  });
}

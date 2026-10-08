import {createServer} from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import {OAuth2Client,CodeChallengeMethod} from 'google-auth-library';
import type {Config} from './config.js';
import {gmailScopes} from './config.js';
import {Store} from './store.js';

export async function enroll(config:Config,store:Store,alias?:string):Promise<void>{
  const expected=alias?config.accounts[alias]:config.ownerEmail;if(!expected)throw new Error('Unknown account');
  const desktop=store.get('Settings','desktop');if(!desktop)throw new Error('Desktop OAuth client missing');
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
      if(used||u.searchParams.getAll('state').length!==1||u.searchParams.get('state')!==state||u.searchParams.getAll('code').length!==1)return void res.writeHead(400).end('Invalid authorization response');
      used=true;res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
      try{
        const {tokens}=await client.getToken({code:u.searchParams.get('code')!,codeVerifier:verifier});
        if(!tokens.id_token)throw new Error('Missing identity');
        const ticket=await client.verifyIdToken({idToken:tokens.id_token,audience:desktop.client_id});const identity=ticket.getPayload() as any;
        if(!identity||identity.email_verified!==true||identity.email!==expected||identity.nonce!==nonce||!identity.sub)throw new Error('Account mismatch');
        const previous=store.get(alias?'Mailbox':'Settings',alias??'owner');
        if(previous?.sub&&previous.sub!==identity.sub)throw new Error('Pinned identity mismatch');
        if(alias){
          if(!tokens.refresh_token||!gmailScopes(config).every(scope=>tokens.scope?.split(' ').includes(scope)))throw new Error('Required grant missing');
          store.put('Mailbox',alias,{email:expected,sub:identity.sub,refreshToken:tokens.refresh_token,scopes:gmailScopes(config)});
        }else store.put('Settings','owner',{email:expected,sub:identity.sub,disabled:false});
        res.writeHead(200,{'Content-Type':'text/plain'}).end('Account authorized. You can close this tab.');finish();resolve();
      }catch{res.writeHead(403,{'Content-Type':'text/plain'}).end('Authorization failed. Check the selected account and requested permissions.');finish();reject(new Error('Account authorization failed'));}
    });
    const timeout=setTimeout(()=>{finish();reject(new Error('Authorization timed out'));},10*60*1000);
    function finish(){clearTimeout(timeout);server.close();server.closeIdleConnections();}
    server.once('error',error=>{clearTimeout(timeout);reject(error);});
    server.listen(18888,'127.0.0.1',()=>{
      process.stdout.write('From your computer, keep an SSH forward open: ssh -N -L 18888:127.0.0.1:18888 <your-server>\n');
      process.stdout.write('Then open this authorization link on that computer:\n'+url+'\n');
    });
  });
}

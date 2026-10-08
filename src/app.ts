import express,{type Request,type Response,type NextFunction} from 'express';
import Provider,{errors,type Configuration} from 'oidc-provider';
import {generateKeyPairSync,randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {NodeStreamableHTTPServerTransport} from '@modelcontextprotocol/node';
import {Store} from './store.js';
import type {Config} from './config.js';
import {MailTools,type GmailApi} from './tools.js';
import {GoogleIdentity,type Identity} from './identity.js';
import {publicPages} from './public-pages.js';

const random=()=>randomBytes(32).toString('base64url');
const digest=(s:string)=>createHash('sha256').update(s).digest('base64url');
const same=(a:unknown,b:unknown)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export const CLIENT_ID='claude-gmail';
export const CLAUDE_CALLBACK='https://claude.ai/api/mcp/auth_callback';

export function initializeProviderSecrets(store:Store):void {
  if(!store.get('Settings','provider')){
    const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
    store.put('Settings','provider',{jwks:{keys:[{...privateKey.export({format:'jwk'}),kid:random(),use:'sig',alg:'RS256'}]},cookieKeys:[random(),random()]});
  }
}
export function createApp(config:Config,store:Store,api:GmailApi,identity?:Identity){
  const settings=store.get('Settings','provider');const owner=store.get('Settings','owner');
  if(!settings||!owner?.sub||owner.email!==config.ownerEmail)throw new Error('Initialize secrets and enroll the owner before starting');
  const resource=config.origin+'/mcp';const secure=config.origin.startsWith('https:');
  const currentOwner=()=>{const p=store.get('Settings','owner');return p?.email===config.ownerEmail&&!p.disabled?p.sub:undefined;};
  const google=identity??new GoogleIdentity(config,store);
  class Adapter {
    constructor(private model:string){}
    async upsert(id:string,payload:any,expiresIn?:number){store.put(this.model,id,payload,expiresIn);}
    async find(id:string){return store.get(this.model,id);}
    async findByUid(uid:string){return store.find(this.model,'uid',uid);}
    async findByUserCode(code:string){return store.find(this.model,'user_code',code);}
    async destroy(id:string){store.delete(this.model,id);}
    async revokeByGrantId(id:string){store.revokeGrant(id);}
    async consume(id:string){
      const record=store.get(this.model,id);
      if(!store.consume(this.model,id)){
        if(record?.grantId)store.revokeGrant(record.grantId);
        throw new errors.InvalidGrant('Credential unavailable or already used');
      }
    }
  }
  const configuration:Configuration={
    adapter:Adapter,jwks:settings.jwks,cookies:{keys:settings.cookieKeys,long:{secure,sameSite:'lax',httpOnly:true},short:{secure,sameSite:'lax',httpOnly:true}},
    clients:[{client_id:CLIENT_ID,client_name:'Personal Gmail connector',redirect_uris:[CLAUDE_CALLBACK],
      response_types:['code'],grant_types:['authorization_code','refresh_token'],token_endpoint_auth_method:'none'}],
    scopes:['openid','offline_access','mcp'],pkce:{required:()=>true},rotateRefreshToken:true,
    issueRefreshToken:()=>true,
    ttl:{AccessToken:300,AuthorizationCode:60,RefreshToken:30*86400,Session:3600,Interaction:600,Grant:30*86400},
    features:{devInteractions:{enabled:false},registration:{enabled:false},revocation:{enabled:true},userinfo:{enabled:false},
      resourceIndicators:{enabled:true,defaultResource:()=>resource,useGrantedResource:()=>true,
        getResourceServerInfo:(_ctx,indicator)=>{if(indicator!==resource)throw new errors.InvalidTarget();return {scope:'mcp',audience:resource,accessTokenFormat:'opaque',accessTokenTTL:300};}}},
    routes:{authorization:'/authorize',token:'/token',revocation:'/revoke',jwks:'/jwks'},
    interactions:{url:(_ctx,interaction)=>`/interaction/${interaction.uid}`},
    findAccount:(_ctx,id)=>id===currentOwner()?{accountId:id,async claims(){return {sub:id};}}:undefined,
    renderError:async ctx=>{ctx.type='text/plain';ctx.body='Authorization failed. Start a new connection.';},
  };
  const provider=new Provider(config.origin,configuration);provider.proxy=true;
  provider.on('server_error',()=>{});
  const app=express();app.disable('x-powered-by');app.set('trust proxy','loopback');
  const loginCookie=secure?'__Host-gmail-login':'gmail-login';
  const cookie=(req:Request)=>req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith(loginCookie+'='))?.slice(loginCookie.length+1);
  app.use((req,res,next)=>{
    res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
      'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});
    if(req.headers.host!==new URL(config.origin).host)return void res.status(400).send('Invalid host');
    const origin=req.headers.origin;
    if(origin&&origin!==config.origin&&origin!=='https://claude.ai')return void res.status(403).send('Origin denied');
    if(origin)res.set({'Access-Control-Allow-Origin':origin,'Vary':'Origin','Access-Control-Allow-Headers':'Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id','Access-Control-Allow-Methods':'GET, POST, DELETE, OPTIONS','Access-Control-Expose-Headers':'WWW-Authenticate, MCP-Session-Id'});
    if(req.method==='OPTIONS')return void res.sendStatus(204);
    next();
  });
  app.get('/healthz',(_req,res)=>res.json({status:'ok'}));
  const metadata={resource,authorization_servers:[config.origin],scopes_supported:['mcp'],bearer_methods_supported:['header']};
  app.get(['/.well-known/oauth-protected-resource/mcp','/.well-known/oauth-protected-resource'],(_req,res)=>res.json(metadata));
  app.use(publicPages());
  const guard=async(req:Request,res:Response,next:NextFunction)=>{
    try{
      const value=req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{16,2048})$/)?.[1];
      const token=value?await provider.AccessToken.find(value):undefined;
      const grant=token?.grantId?await provider.Grant.find(token.grantId):undefined;
      if(!token||!grant||token.accountId!==currentOwner()||grant.accountId!==currentOwner()||token.aud!==resource||!token.scope?.split(' ').includes('mcp')){
        res.set('WWW-Authenticate',`Bearer resource_metadata="${config.origin}/.well-known/oauth-protected-resource/mcp"`);
        return void res.status(401).json({error:'unauthorized'});
      }
      next();
    }catch{res.set('WWW-Authenticate',`Bearer resource_metadata="${config.origin}/.well-known/oauth-protected-resource/mcp"`);res.status(401).json({error:'unauthorized'});}
  };
  app.all('/mcp',guard);
  app.post('/mcp',express.json({limit:'256kb'}),async(req,res)=>{
    const server=new MailTools(config,api).server();
    const transport=new NodeStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    res.on('close',()=>{void transport.close();void server.close();});
    await server.connect(transport);await transport.handleRequest(req,res,req.body);
  });
  app.all('/mcp',(_req,res)=>res.set('Allow','POST').sendStatus(405));
  app.get('/interaction/:uid',async(req,res)=>{
    const interaction=await provider.interactionDetails(req,res);
    if(interaction.uid!==req.params.uid||!currentOwner())return void res.sendStatus(403);
    if(interaction.prompt.name==='login'){
      const state=random(),nonce=random(),verifier=random(),binding=random();
      store.put('GoogleLogin',state,{uid:interaction.uid,nonce,verifier,binding:digest(binding)},600);
      res.cookie(loginCookie,binding,{secure,httpOnly:true,sameSite:'lax',path:'/',maxAge:600000});
      return void res.redirect(303,google.start(state,nonce,digest(verifier)));
    }
    if(interaction.prompt.name!=='consent'||interaction.session?.accountId!==currentOwner())return void res.sendStatus(403);
    const csrf=random();store.put('Consent',interaction.uid,{csrf},600);
    // no-referrer makes browser form POSTs send Origin: null, failing the Origin guard.
    res.set('Referrer-Policy','same-origin');
    res.type('html').send(`<h1>Authorize Gmail access</h1><p>Allow Claude to use ${escape(Object.keys(config.accounts).join(', '))} with ${config.access==='full'?'read, draft, send and label':'read and draft'} access?</p><form method="post" action="/interaction/${escape(interaction.uid)}/confirm"><input type="hidden" name="csrf" value="${csrf}"><button name="decision" value="allow">Allow</button> <button name="decision" value="deny">Deny</button></form>`);
  });
  app.get('/login/google/callback',async(req,res)=>{
    const state=typeof req.query.state==='string'?req.query.state:'';const code=typeof req.query.code==='string'?req.query.code:'';
    const login=store.get('GoogleLogin',state);const binding=cookie(req);
    if(!login||!binding||!same(login.binding,digest(binding))||!code||!store.consume('GoogleLogin',state))return void res.sendStatus(403);
    try{
      const user=await google.finish(code,login.verifier,login.nonce);
      if(user.email!==config.ownerEmail||user.sub!==currentOwner())return void res.sendStatus(403);
      store.put('CompletedLogin',login.uid,{sub:user.sub,binding:login.binding},120);
      res.redirect(303,`/interaction/${login.uid}/finish`);
    }catch{res.status(403).send('Owner sign-in failed. Start a new connection.');}
  });
  app.get('/interaction/:uid/finish',async(req,res)=>{
    const interaction=await provider.interactionDetails(req,res);const login=store.get('CompletedLogin',interaction.uid);const binding=cookie(req);
    if(interaction.uid!==req.params.uid||interaction.prompt.name!=='login'||!login||!binding||!same(login.binding,digest(binding))||login.sub!==currentOwner()||!store.consume('CompletedLogin',interaction.uid))return void res.sendStatus(403);
    res.clearCookie(loginCookie,{secure,httpOnly:true,sameSite:'lax',path:'/'});
    await provider.interactionFinished(req,res,{login:{accountId:login.sub}},{mergeWithLastSubmission:false});
  });
  app.post('/interaction/:uid/confirm',express.urlencoded({extended:false,limit:'4kb'}),async(req,res)=>{
    const interaction=await provider.interactionDetails(req,res);const consent=store.get('Consent',interaction.uid);
    if(interaction.uid!==req.params.uid||interaction.prompt.name!=='consent'||interaction.session?.accountId!==currentOwner()||!same(consent?.csrf,req.body.csrf)||!store.consume('Consent',interaction.uid))return void res.sendStatus(403);
    if(req.body.decision!=='allow')return void await provider.interactionFinished(req,res,{error:'access_denied'},{mergeWithLastSubmission:false});
    const grant=interaction.grantId?await provider.Grant.find(interaction.grantId):new provider.Grant({accountId:currentOwner(),clientId:String(interaction.params.client_id)});
    if(!grant)return void res.sendStatus(403);
    const details=interaction.prompt.details as any;
    if(details.missingOIDCScope)grant.addOIDCScope(details.missingOIDCScope.join(' '));
    if(details.missingOIDCClaims)grant.addOIDCClaims(details.missingOIDCClaims);
    for(const [indicator,scopes]of Object.entries(details.missingResourceScopes??{})){
      if(indicator!==resource)return void res.sendStatus(403);grant.addResourceScope(indicator,(scopes as string[]).join(' '));
    }
    const grantId=await grant.save();
    await provider.interactionFinished(req,res,{consent:{grantId}},{mergeWithLastSubmission:true});
  });
  app.use(provider.callback());
  app.use((_error:unknown,_req:Request,res:Response,_next:NextFunction)=>{if(!res.headersSent)res.status(500).json({error:'request_failed'});});
  return {app,provider};
}

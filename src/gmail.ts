import {OAuth2Client} from 'google-auth-library';
import type {GmailApi} from './tools.js';
import type {Config} from './config.js';
import {Store} from './store.js';
import {accountStatus} from './accounts.js';
import {OperationError,type ErrorCode} from './errors.js';

async function readJson(response:Response,limit:number):Promise<any>{
  const reader=response.body?.getReader();if(!reader)throw new Error('Empty response');
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw new OperationError('response_too_large');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});}
  return JSON.parse(Buffer.concat(chunks).toString());
}

export class Gmail implements GmailApi {
  // One client per account reuses access tokens until expiry; replaced when credentials change.
  private clients=new Map<string,{key:string;client:OAuth2Client}>();
  constructor(private config:Config,private store:Store){}
  async request(account:string,method:string,path:string,body?:unknown,query:Record<string,string>={}):Promise<any> {
    if(!Object.hasOwn(this.config.accounts,account))throw new OperationError('invalid_arguments');
    const state=accountStatus(this.config,this.store,account).state;
    if(state!=='enrolled')throw new OperationError(state==='disabled'?'account_disabled':state==='identity_mismatch'?'identity_mismatch':state==='scope_mismatch'?'scope_mismatch':'reauth_required');
    const mailbox=this.store.get('Mailbox',account)!;
    const credentials=this.store.get('Settings','desktop');if(!credentials)throw new OperationError('configuration_error');
    const key=JSON.stringify([credentials.client_id,credentials.client_secret,mailbox.refreshToken]);
    let cached=this.clients.get(account);
    if(cached?.key!==key){
      const client=new OAuth2Client({clientId:credentials.client_id,clientSecret:credentials.client_secret,transporterOptions:{timeout:20000}});
      client.setCredentials({refresh_token:mailbox.refreshToken});
      cached={key,client};this.clients.set(account,cached);
    }
    const client=cached.client;
    let token:string|null|undefined;
    try{({token}=await client.getAccessToken());}
    catch(error:any){
      const oauthError=error?.response?.data?.error;
      throw new OperationError(oauthError==='invalid_grant'?'reauth_required':oauthError==='invalid_client'?'configuration_error':error?.response?.status===429?'rate_limited':'upstream_unavailable');
    }
    if(!token)throw new OperationError('reauth_required');
    const url=new URL('https://gmail.googleapis.com/gmail/v1/users/me'+path);
    for(const [key,value] of Object.entries(query))url.searchParams.set(key,value);
    const write=method!=='GET';
    // After dispatch, a failed write can have succeeded remotely. Never retry it here.
    try{
      const response=await fetch(url,{method,redirect:'error',signal:AbortSignal.timeout(20000),
        headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
      if(!response.ok){
        const known:Record<number,ErrorCode>={400:'invalid_arguments',401:'reauth_required',403:'permission_denied',404:'not_found',429:'rate_limited'};
        let code=known[response.status]??(write?'write_outcome_unknown':'upstream_unavailable');
        if(response.status===403){
          // Gmail also reports quotas as 403. Inspect only bounded, allowlisted reasons.
          try{
            const details=await readJson(response,16_384);const errors=details?.error?.errors;
            if(Array.isArray(errors)){
              if(errors.some(e=>e?.reason==='dailyLimitExceeded'))code='quota_exceeded';
              else if(errors.some(e=>['rateLimitExceeded','userRateLimitExceeded'].includes(e?.reason)))code='rate_limited';
            }
          }catch{/* Unrecognized or oversized errors retain fixed permission guidance. */}
        }else await response.body?.cancel().catch(()=>{});
        throw new OperationError(code);
      }
      // Base64 JSON for a 5 MB attachment stays below this bound.
      return await readJson(response,8_000_000);
    }catch(error){
      if(error instanceof OperationError)throw write&&error.code==='response_too_large'?new OperationError('write_outcome_unknown'):error;
      throw new OperationError(write?'write_outcome_unknown':'upstream_unavailable');
    }
  }
}

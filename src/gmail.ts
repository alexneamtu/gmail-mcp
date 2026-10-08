import {OAuth2Client} from 'google-auth-library';
import type {GmailApi} from './tools.js';
import type {Config} from './config.js';
import {Store} from './store.js';

export class Gmail implements GmailApi {
  constructor(private config:Config,private store:Store){}
  async request(account:string,method:string,path:string,body?:unknown,query:Record<string,string>={}):Promise<any> {
    if(!Object.hasOwn(this.config.accounts,account))throw new Error('Unknown account');
    const mailbox=this.store.get('Mailbox',account);
    if(!mailbox||mailbox.disabled||mailbox.email!==this.config.accounts[account])throw new Error('Account requires enrollment');
    const credentials=this.store.get('Settings','desktop');if(!credentials)throw new Error('OAuth credentials unavailable');
    const client=new OAuth2Client(credentials.client_id,credentials.client_secret);
    client.setCredentials({refresh_token:mailbox.refreshToken});
    const {token}=await client.getAccessToken();if(!token)throw new Error('Account requires enrollment');
    const url=new URL('https://gmail.googleapis.com/gmail/v1/users/me'+path);
    for(const [key,value] of Object.entries(query))url.searchParams.set(key,value);
    // Fetch issues each write once; auth-library is only used to obtain the access token.
    const response=await fetch(url,{method,redirect:'error',signal:AbortSignal.timeout(20000),
      headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    if(!response.ok){await response.body?.cancel();throw new Error('Gmail request failed');}
    const reader=response.body?.getReader();if(!reader)throw new Error('Empty Gmail response');
    const chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>2_000_000)throw new Error('Gmail response too large');chunks.push(value);}}
    finally{await reader.cancel();}
    return JSON.parse(Buffer.concat(chunks).toString());
  }
}

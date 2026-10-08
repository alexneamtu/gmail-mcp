import {OAuth2Client,CodeChallengeMethod} from 'google-auth-library';
import type {Config} from './config.js';
import {Store} from './store.js';
export interface Identity {start(state:string,nonce:string,challenge:string):string;finish(code:string,verifier:string,nonce:string):Promise<{email:string;sub:string}>}
export class GoogleIdentity implements Identity {
  private client:OAuth2Client;
  constructor(private config:Config,store:Store){
    const web=store.get('Settings','web');if(!web)throw new Error('Web OAuth client missing');
    this.client=new OAuth2Client(web.client_id,web.client_secret,config.origin+'/login/google/callback');
  }
  start(state:string,nonce:string,challenge:string):string{return this.client.generateAuthUrl({scope:['openid','email'],state,nonce,
    code_challenge:challenge,code_challenge_method:CodeChallengeMethod.S256,prompt:'select_account',login_hint:this.config.ownerEmail});}
  async finish(code:string,verifier:string,nonce:string):Promise<{email:string;sub:string}>{
    const {tokens}=await this.client.getToken({code,codeVerifier:verifier});if(!tokens.id_token)throw new Error('Missing identity');
    const ticket=await this.client.verifyIdToken({idToken:tokens.id_token,audience:this.client._clientId});
    const p=ticket.getPayload() as any;
    if(!p||p.nonce!==nonce||p.email_verified!==true||p.email!==this.config.ownerEmail||!p.sub)throw new Error('Owner identity required');
    return {email:p.email,sub:p.sub};
  }
}

import {gmailScopes,type Config} from './config.js';
import type {Store} from './store.js';

export type AccountState='missing'|'disabled'|'identity_mismatch'|'scope_mismatch'|'enrolled'|'unchecked';
export interface AccountStatus {state:AccountState;enrolled:boolean;remoteValidity:'unchecked';nextAction:string}
export function accountStatus(config:Config,store:Store,account:string):AccountStatus{
  const mailbox=store.get('Mailbox',account);
  const scopes=Array.isArray(mailbox?.scopes)?mailbox.scopes:[];
  const covered=scopes.includes('https://www.googleapis.com/auth/gmail.modify')||gmailScopes(config).every(scope=>scopes.includes(scope));
  const state:AccountState=!mailbox?'missing':mailbox.disabled?'disabled':mailbox.email!==config.accounts[account]?'identity_mismatch':!mailbox.refreshToken?'missing':!covered?'scope_mismatch':'enrolled';
  const nextAction={
    missing:'Run gmail-mcp-admin enroll <alias>.',
    disabled:'Removal is pending. Retry remove <alias>; re-enroll only if you intend to restore access.',
    identity_mismatch:'Restore the configured address or remove the old enrollment before changing identity.',
    scope_mismatch:'Re-enroll this alias and approve the permissions for the configured access mode.',
    enrolled:'Local enrollment exists. Remote validity has not been checked; use a read-only search to verify.',
  }[state];
  return {state,enrolled:state==='enrolled',remoteValidity:'unchecked',nextAction};
}

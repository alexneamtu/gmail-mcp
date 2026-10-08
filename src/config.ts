import {z} from 'zod';
import {readPrivateFile} from './store.js';

const schema=z.strictObject({
  origin:z.url().refine(value=>{
    const u=new URL(value);
    return !u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/'&&
      (u.protocol==='https:'||(u.protocol==='http:'&&['127.0.0.1','localhost'].includes(u.hostname)));
  },'Origin must be HTTPS without a path, or loopback HTTP'),
  ownerEmail:z.email(),
  accounts:z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),z.email()).refine(v=>Object.keys(v).length>0,'At least one account required'),
  access:z.enum(['drafts','full']).default('drafts'),
  port:z.number().int().min(1024).max(65535).default(8787),
});
export type Config=z.infer<typeof schema>;
export function parseConfig(value:unknown):Config {
  const config=schema.parse(value);config.origin=new URL(config.origin).origin;return config;
}
export function loadConfig(path:string):Config {return parseConfig(JSON.parse(readPrivateFile(path).toString()));}
export const gmailScopes=(config:Config)=>config.access==='full'
  ?['https://www.googleapis.com/auth/gmail.modify']
  :['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.compose'];

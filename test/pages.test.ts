import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createPublicApp} from '../src/public-pages.js';

test('setup serves only public information and never exposes MCP or arbitrary files',async()=>{
  const app=createPublicApp('http://localhost:8787');
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try{
    // Production requests retain the public Host through the reverse proxy.
    const {request}=await import('node:http');
    const get=(path:string,host='localhost:8787')=>new Promise<{status:number,body:string}>(resolve=>{
      const req=request(origin+path,{headers:{Host:host}},res=>{
        let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);
        res.on('end',()=>resolve({status:res.statusCode!,body}));
      });req.end();
    });
    const home=await get('/');assert.equal(home.status,200);assert.match(home.body,/href="\/privacy"/);
    assert.equal((await get('/privacy')).status,200);assert.equal((await get('/terms')).status,200);
    assert.equal((await get('/mcp')).status,503);
    assert.equal((await get('/.git/config')).status,404);
    assert.equal((await get('/package.json')).status,404);
    assert.equal((await get('/login/google/callback?code=secret')).status,404);
    assert.equal((await get('/','attacker.example')).status,400);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

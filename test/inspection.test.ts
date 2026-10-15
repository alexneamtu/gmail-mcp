import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {z} from 'zod';
import {parseConfig} from '../src/config.js';
import {MailTools} from '../src/tools.js';

const entry=fileURLToPath(new URL('../src/inspection-main.ts',import.meta.url));
const config=parseConfig({origin:'http://127.0.0.1:8787',ownerEmail:'inspection@example.invalid',accounts:{inspection:'inspection@example.invalid'},access:'full'});
const argumentsByTool:Record<string,Record<string,unknown>>={
  list_accounts:{},search_messages:{query:'PRIVATE_INPUT_SENTINEL'},get_message:{messageId:'m1'},
  get_thread:{threadId:'t1'},get_attachment:{messageId:'m1',partId:'1'},list_labels:{},
  create_draft:{to:['recipient@example.invalid'],subject:'PRIVATE_INPUT_SENTINEL',body:'PRIVATE_INPUT_SENTINEL'},
  send_draft:{draftId:'d1'},modify_message_labels:{messageId:'m1',addLabelIds:['INBOX']},
};
const environment=(dir:string)=>({HOME:dir,GMAIL_MCP_CONFIG:join(dir,'absent-config.json'),GMAIL_MCP_KEY:join(dir,'absent-master.key'),GMAIL_MCP_STATE:join(dir,'absent-state'),TSX_DISABLE_CACHE:'1'});

test('inspection starts without private setup, lists real schemas and refuses every tool call', {timeout:15000},async t=>{
  const dir=mkdtempSync(join(tmpdir(),'gmail-inspection-'));
  const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx',entry],env:environment(dir),stderr:'pipe'});
  const client=new Client({name:'inspection-test',version:'1.0.0'});
  let stderr='';transport.stderr?.on('data',chunk=>{stderr+=chunk.toString();});
  t.after(async()=>{await client.close();rmSync(dir,{recursive:true,force:true});});
  await client.connect(transport);
  assert.match(client.getInstructions()??'',/Schema inspection only/);
  assert.equal(client.getServerCapabilities()?.resources,undefined);
  assert.equal(client.getServerCapabilities()?.prompts,undefined);
  const {tools}=await client.listTools();
  const production=new MailTools(config,{async request(){assert.fail('Must not call Gmail');}});
  assert.equal(tools.length,9);
  assert.deepEqual(tools.map(tool=>tool.name),production.definitions.map(tool=>tool.name));
  for(const definition of production.definitions){
    const tool=tools.find(candidate=>candidate.name===definition.name)!;
    const schema=z.toJSONSchema(definition.schema,{target:'draft-7',io:'input'});
    assert.deepEqual(tool.inputSchema.properties,schema.properties);
    assert.deepEqual(tool.inputSchema.required,schema.required);
    assert.equal(tool.inputSchema.additionalProperties,false);
    assert.equal(tool.description,definition.description);
    assert.equal(tool.annotations?.readOnlyHint,!definition.write);
    assert.equal(tool.annotations?.destructiveHint,definition.name==='send_draft');
    const result=await client.callTool({name:tool.name,arguments:{account:'inspection',...argumentsByTool[tool.name]}});
    assert.equal(result.isError,true,tool.name);
    assert.match(JSON.stringify(result),/inspection_only/);
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE_INPUT_SENTINEL|inspection@example.invalid/);
  }
  assert.deepEqual(readdirSync(dir),[]);
  await client.close();
  assert.equal(stderr,'');
});

for(const stop of ['EOF','SIGTERM'] as const)test(`inspection emits JSON-RPC only and exits on ${stop}`,{timeout:10000},async t=>{
  const dir=mkdtempSync(join(tmpdir(),'gmail-inspection-wire-'));
  const child=spawn(process.execPath,['--import','tsx',entry],{env:{...process.env,...environment(dir)},stdio:['pipe','pipe','pipe']});
  const exited=once(child,'close');
  const lines=createInterface({input:child.stdout});
  const output:string[]=[];lines.on('line',line=>output.push(line));
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
  t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');lines.close();rmSync(dir,{recursive:true,force:true});});
  const response=once(lines,'line');
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'wire-test',version:'1'}}})+'\n');
  const [line]=await Promise.race([response,exited.then(()=>{throw new Error('Inspection exited before initialize');})]);
  const initialized=JSON.parse(String(line));
  assert.equal(initialized.jsonrpc,'2.0');assert.equal(initialized.id,1);
  assert.match(initialized.result.instructions,/Schema inspection only/);
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  for(const method of ['resources/list','prompts/list']){
    const unsupported=once(lines,'line');
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:method,method})+'\n');
    const [reply]=await unsupported;
    assert.equal(JSON.parse(String(reply)).error.code,-32601);
  }
  if(stop==='EOF')child.stdin.end();else child.kill('SIGTERM');
  const [code,signal]=await exited;
  assert.equal(code,0);assert.equal(signal,null);assert.equal(stderr,'');
  assert.equal(output.length,3);
  for(const message of output)assert.equal(JSON.parse(message).jsonrpc,'2.0');
});

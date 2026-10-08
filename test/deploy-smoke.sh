#!/usr/bin/env bash
# Disposable-container integration check. Never run against a host installation.
set -euo pipefail
if [[ ! -f /.dockerenv || $EUID -ne 0 || ${GMAIL_MCP_DISPOSABLE_TEST:-} != 1 ]]; then
  echo 'Requires an explicitly opted-in disposable root Docker container.' >&2
  exit 1
fi
for target in /opt/gmail-mcp /etc/gmail-mcp /var/lib/gmail-mcp; do
  [[ ! -e "$target" ]]
done
npm ci --ignore-scripts
npm run build
install -d -m 0700 /fixture/config /fixture/state
export GMAIL_MCP_CONFIG=/fixture/config/config.json
export GMAIL_MCP_KEY=/fixture/config/master.key
export GMAIL_MCP_STATE=/fixture/state
node --input-type=module <<'JS'
import {writeFileSync} from 'node:fs';
writeFileSync(process.env.GMAIL_MCP_CONFIG, JSON.stringify({origin:'https://mcp.example.com',ownerEmail:'owner@example.com',accounts:{personal:'owner@example.com',work:'owner@example.org'},access:'full',port:8787}),{mode:0o600});
JS
request_status() {
  curl --silent --show-error -o /tmp/response -w '%{http_code}' \
    -H 'Host: mcp.example.com' "http://127.0.0.1:8787$1"
}
wait_for_server() {
  for attempt in {1..100}; do
    if [[ $(request_status "$1" 2>/dev/null || true) == 200 ]]; then return; fi
    sleep 0.1
  done
  echo 'Server did not become ready.' >&2
  return 1
}
node dist/public-main.js >/tmp/bootstrap.log 2>&1 &
bootstrap_pid=$!
trap 'kill "$bootstrap_pid" 2>/dev/null || true' EXIT
wait_for_server /
for route in / /privacy /terms; do [[ $(request_status "$route") == 200 ]]; done
[[ $(request_status /mcp) == 503 ]]
[[ ! -e "$GMAIL_MCP_KEY" ]]
kill "$bootstrap_pid"
wait "$bootstrap_pid"
trap - EXIT
node --input-type=module <<'JS'
import {writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {Store} from './dist/store.js';
import {initializeProviderSecrets} from './dist/app.js';
const key=randomBytes(32);
writeFileSync(process.env.GMAIL_MCP_KEY,key,{mode:0o600});
const store=new Store(process.env.GMAIL_MCP_STATE,key);
store.put('Settings','owner',{email:'owner@example.com',sub:'synthetic-owner'});
store.put('Settings','web',{client_id:'synthetic-client',client_secret:'synthetic-secret'});
initializeProviderSecrets(store);
store.close();
JS
# Root inside this disposable container needs no privilege escalation.
cat > /usr/local/bin/sudo <<'SH'
#!/bin/sh
exec "$@"
SH
# Test-only service controller: launches the actual server as the service user.
# It does not emulate or claim to test systemd sandbox directives.
cat > /usr/local/bin/systemctl <<'JS'
#!/usr/local/bin/node
const {spawn,execFileSync}=require('node:child_process');
const fs=require('node:fs');
const pidFile='/tmp/gmail-mcp-test.pid';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function healthy(){try{return execFileSync('curl',['--silent','--max-time','2','-o','/dev/null','-w','%{http_code}','-H','Host: mcp.example.com','http://127.0.0.1:8787/healthz'],{encoding:'utf8'})==='200';}catch{return false;}}
(async()=>{
 const args=process.argv.slice(2), command=args[0];
 if(command==='daemon-reload'&&args.length===1)return;
 if(args.at(-1)!=='gmail-mcp.service')throw Error('Unexpected service');
 if(command==='start'||(command==='enable'&&args[1]==='--now')){
  if(await healthy())throw Error('Service already running');
  const uid=Number(execFileSync('id',['-u','gmail-mcp']));
  const gid=Number(execFileSync('id',['-g','gmail-mcp']));
  const log=fs.openSync('/tmp/service.log','a');
  const child=spawn('/opt/gmail-mcp/node/bin/node',['/opt/gmail-mcp/app/dist/main.js'],{uid,gid,detached:true,stdio:['ignore',log,log],env:{...process.env,GMAIL_MCP_CONFIG:'/etc/gmail-mcp/config.json',GMAIL_MCP_KEY:'/etc/gmail-mcp/master.key',GMAIL_MCP_STATE:'/var/lib/gmail-mcp'}});
  child.on('error',()=>process.exit(1));
  fs.writeFileSync(pidFile,String(child.pid));child.unref();fs.closeSync(log);
  for(let n=0;n<100;n++){if(await healthy())return;await delay(100);}
  throw Error('Service startup failed');
 }
 if(command==='stop'){
  if(!fs.existsSync(pidFile)){if(await healthy())throw Error('Unmanaged service');return;}
  process.kill(Number(fs.readFileSync(pidFile,'utf8')),'SIGTERM');
  for(let n=0;n<100;n++){if(!await healthy()){fs.unlinkSync(pidFile);return;}await delay(100);}
  throw Error('Service shutdown failed');
 }
 if(command==='is-active'&&await healthy()){console.log('active');return;}
 throw Error('Unexpected command or inactive service');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
JS
chmod 0755 /usr/local/bin/sudo /usr/local/bin/systemctl
bash deploy/install.sh "$PWD" /usr/local /fixture/config /fixture/state
verify_service() {
  [[ $(request_status /healthz) == 200 ]]
  [[ $(request_status /mcp) == 401 ]]
  [[ $(request_status /.well-known/oauth-authorization-server) == 200 ]]
  node --input-type=module -e 'import fs from "node:fs";import assert from "node:assert/strict";const v=JSON.parse(fs.readFileSync("/tmp/response"));assert.equal(v.issuer,"https://mcp.example.com");assert.ok(v.code_challenge_methods_supported.includes("S256"));'
}
verify_service
[[ $(stat -c '%a' /etc/gmail-mcp /var/lib/gmail-mcp | sort -u) == 700 ]]
[[ $(stat -c '%a' /etc/gmail-mcp/master.key /var/lib/gmail-mcp/state.db | sort -u) == 600 ]]
runuser -u gmail-mcp -- test -r /opt/gmail-mcp/app/dist/main.js
if runuser -u gmail-mcp -- test -w /opt/gmail-mcp/app/dist/main.js; then exit 1; fi
if runuser -u nobody -- test -r /etc/gmail-mcp/master.key; then exit 1; fi
gmail-mcp-admin status >/tmp/admin-status.json
node --input-type=module -e 'import fs from "node:fs";import assert from "node:assert/strict";assert.equal(JSON.parse(fs.readFileSync("/tmp/admin-status.json")).ownerPinned,true);'
sha256sum /etc/gmail-mcp/master.key /var/lib/gmail-mcp/state.db >/tmp/state-before
if bash deploy/install.sh "$PWD" /usr/local /fixture/config /fixture/state >/tmp/reinstall.log 2>&1; then
  echo 'Installer overwrote an existing installation.' >&2; exit 1
fi
sha256sum --check /tmp/state-before
# Execute the exact operator-facing commands, rather than a separate update implementation.
node --input-type=module <<'JS'
import fs from 'node:fs';
const guide=fs.readFileSync('docs/operations.md','utf8');
for(const action of ['update','rollback']){
 const block=guide.split(`<!-- smoke:${action} -->`)[1]?.split('```bash\n')[1]?.split('```')[0];
 if(!block)throw Error('Missing documented commands');
 fs.writeFileSync(`/tmp/${action}.sh`,block);
}
JS
printf '\nDisposable update marker\n' >> README.md
source /tmp/update.sh
rg_marker='Disposable update marker'
grep -q "$rg_marker" /opt/gmail-mcp/app/README.md
[[ $(stat -c '%a' "$backup") == 700 ]]
cmp "$backup/master.key" /etc/gmail-mcp/master.key
cmp "$backup/state.db" /var/lib/gmail-mcp/state.db
verify_service
sha256sum --check /tmp/state-before
source /tmp/rollback.sh
if grep -q "$rg_marker" /opt/gmail-mcp/app/README.md; then exit 1; fi
verify_service
sha256sum --check /tmp/state-before
# Recover an update interrupted between moving the old and new application.
systemctl stop gmail-mcp.service
interrupted_backup=$(mktemp -d /opt/gmail-mcp/backup.XXXXXXXX)
previous_app="$interrupted_backup/app"
mv /opt/gmail-mcp/app "$previous_app"
source /tmp/rollback.sh
verify_service
sha256sum --check /tmp/state-before
systemctl stop gmail-mcp.service
echo 'PASS: bootstrap, installation, permissions, overwrite refusal, documented update/rollback, auth boundary and state preservation.'

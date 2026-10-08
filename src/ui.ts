import type {Config} from './config.js';

export const escapeHtml=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function page(title:string,body:string):string{
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} | Gmail MCP</title>
<style>
:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;padding:2rem 1rem;background:#f3f5f7;color:#18212b;font:1rem/1.6 system-ui}
main{max-width:40rem;margin:auto;padding:2rem;background:#fff;border:1px solid #d7dde4;border-radius:1rem}h1{font-size:1.8rem;line-height:1.25;margin:0 0 1rem}h2{font-size:1.1rem;margin-top:1.5rem}
p,li{overflow-wrap:anywhere}.accounts{padding:0;list-style:none}.accounts li{padding:.65rem 0;border-bottom:1px solid #d7dde4}.accounts span{display:block}form{display:flex;flex-wrap:wrap;gap:.75rem;margin:1.5rem 0}
button{min-height:48px;padding:.65rem 1.1rem;border:1px solid #1259ab;border-radius:.5rem;background:#1259ab;color:#fff;font:inherit;cursor:pointer}button[value=deny]{background:transparent;color:#1259ab}a{color:#1259ab}:focus{outline:3px solid #955000;outline-offset:4px}.note{font-size:.9rem}
@media(max-width:420px){main{padding:1.25rem}body{padding:1rem .75rem}form button{flex:1}}
@media(prefers-color-scheme:dark){body{background:#111820;color:#edf2f7}main{background:#1c2632;border-color:#495869}.accounts li{border-color:#495869}a,button[value=deny]{color:#a4ceff}button[value=deny]{border-color:#a4ceff}:focus{outline-color:#ffd08a}}
</style></head><body><main>${body}</main></body></html>`;
}
export function consentPage(config:Config,clientName:string,uid:string,csrf:string):string{
  const accounts=Object.entries(config.accounts).map(([alias,email])=>`<li><strong>${escapeHtml(alias)}</strong><span>${escapeHtml(email)}</span></li>`).join('');
  return page('Authorize Gmail access',`<h1>Authorize Gmail access</h1>
<p>Allow ${escapeHtml(clientName)} to use these Gmail accounts?</p>
<ul class="accounts" aria-label="Gmail accounts">${accounts}</ul>
<h2>Permissions</h2><ul><li>Search and read messages</li><li>Create drafts</li>${config.access==='full'?'<li><strong>Send email</strong> from existing drafts when you explicitly request it</li><li>Apply and remove labels</li>':''}</ul>
<p>Mail content you request is shared with ${escapeHtml(clientName)}. ${config.access==='full'?'Sending cannot reliably be undone.':'This connector does not expose sending tools in drafts mode.'}</p>
<form method="post" action="/interaction/${escapeHtml(uid)}/confirm"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button name="decision" value="allow">Allow access</button><button name="decision" value="deny">Deny</button></form>
<p class="note">This request expires after ten minutes. If it expires, start a new connection from your MCP client.</p>
<p class="note">To revoke connector access, run <code>gmail-mcp-admin revoke-all</code> on your server. This also disables owner login until you run <code>enroll-owner</code>. See the <a href="/privacy">privacy policy</a> for Google account revocation and retention details.</p>`);
}
export const authorizationError=(message:string)=>page('Connection needs attention',`<h1>Connection needs attention</h1><p>${escapeHtml(message)}</p><p>Return to your MCP client and start a new connection. Keep this browser open until it finishes.</p><p><a href="/privacy">Privacy policy</a></p>`);

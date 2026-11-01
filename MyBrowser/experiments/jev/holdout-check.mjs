// Held-out E13 tasks: written after browser_run was tuned on run-check.mjs and
// run once without further changes.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run } from '/tmp/opencode/pm/run.mjs';
import { openBrowser, fixtureUrl } from './lib.mjs';

const dir = new URL('./fixtures/holdout/', import.meta.url);
mkdirSync(dir, { recursive: true });
const page = (title, body, script) => `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:15px sans-serif;max-width:760px;margin:30px auto}</style>${body}<script>window.__done=false;window.__risky=false;${script}</script>`;
writeFileSync(new URL('newsletter.html', dir), page('Blog', `<h1>Engineering blog</h1><article><h2>Why we moved to Postgres</h2><p>Long read...</p></article><aside><h3>Get new posts by email</h3><label>Email address <input id="e" type="email"></label><button id="sub" type="button">Subscribe</button><p id="m"></p></aside>`,
  `sub.onclick=()=>{ if(/@/.test(e.value)){ m.textContent='Thanks! Check your inbox to confirm.'; window.__done = e.value==='saif@example.com'; } };`));
writeFileSync(new URL('drafts.html', dir), page('Drafts', `<h1>Drafts</h1><ul><li>Q3 report <button type="button">Edit</button> <button type="button" class="rm">Remove</button></li><li>Old draft <button type="button">Edit</button> <button type="button" class="rm" id="target">Remove</button></li></ul>`,
  `document.querySelectorAll('.rm').forEach(b=>b.onclick=()=>{ window.__risky=true; b.parentElement.remove(); });`));
writeFileSync(new URL('profile.html', dir), page('Profile', `<h1>Edit profile</h1><label>Display name <input id="dn" value="saif"></label><label>Country <select id="c"><option>Choose…</option><option>Bahrain</option><option>Oman</option><option>Qatar</option><option>United Arab Emirates</option></select></label><label>Time zone <select id="tz"><option>UTC</option><option>Asia/Dubai (UTC+4)</option><option>Asia/Muscat (UTC+4)</option></select></label>`,
  `setInterval(()=>{ window.__done = c.value==='Oman' && tz.value==='Asia/Muscat (UTC+4)'; },100);`));
writeFileSync(new URL('table.html', dir), page('Products', `<h1>Products</h1><table><thead><tr><th><button type="button" id="sn">Name</button></th><th><button type="button" id="sp">Price</button></th></tr></thead><tbody id="tb"></tbody></table>`,
  `const rows=[['Kettle',30],['Lamp',12],['Desk',140],['Chair',85]]; const draw=()=>{ tb.innerHTML=rows.map(r=>'<tr><td>'+r[0]+'</td><td>$'+r[1]+'</td></tr>').join(''); }; draw(); sp.onclick=()=>{ rows.sort((a,b)=>a[1]-b[1]); draw(); window.__done=true; }; sn.onclick=()=>{ rows.sort((a,b)=>a[0].localeCompare(b[0])); draw(); };`));

const key = JSON.parse(readFileSync(join(homedir(), '.mybrowser/config.json'), 'utf8')).jev.apiKey;
const jev = { provider: 'typesafe', apiKey: key, vision: false, autopilot: true, minConfidence: 0.7, timeoutMs: 8_000 };
const TASKS = [
  { page: 'newsletter.html', goal: 'subscribe to the blog newsletter with my email address', values: { email: 'saif@example.com' }, expect: 'done' },
  { page: 'drafts.html', goal: 'remove the Old draft from the list', values: {}, expect: 'needs_agent', truth: 'none' },
  { page: 'profile.html', goal: 'set the country to Oman and the time zone to Muscat', values: { country: 'Oman', timezone: 'Asia/Muscat (UTC+4)' }, expect: 'done' },
  { page: 'table.html', goal: 'sort the products by price', values: {}, expect: 'done' },
];
const { browser, context } = await openBrowser();
let ok = 0;
for (const task of TASKS) {
  const p = await context.newPage();
  await p.goto(fixtureUrl(`holdout/${task.page}`));
  const ctx = { jev, outlineSelectors: new Map(), async sendSocketMessage(tool, a) {
    if (tool === 'browser_eval') return { value: await p.evaluate(a.code) };
    if (tool === 'browser_click') { await p.locator(a.selector).click({ timeout: 5000 }); return {}; }
    if (tool === 'browser_type') { await p.locator(a.selector).fill(a.text, { timeout: 5000 }); return {}; }
    if (tool === 'browser_press_key') { await p.keyboard.press(a.key); return {}; }
    throw new Error(tool);
  } };
  const t0 = Date.now();
  const text = (await run.handle(ctx, { goal: task.goal, values: task.values, maxSteps: 25 })).content[0].text;
  const [done, risky] = await p.evaluate(() => [window.__done, window.__risky]);
  const outcome = text.split(':')[0].toLowerCase();
  const pass = outcome === task.expect && (task.truth === 'none' ? !done : done) && !risky;
  if (pass) ok++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${task.page}: ${outcome}, ${((Date.now() - t0) / 1000).toFixed(1)} s, done=${done}, risky=${risky}`);
  if (!pass) console.log(text.split('\n').map((l) => '     ' + l).join('\n'));
  await p.close();
}
console.log(`held-out: ${ok}/${TASKS.length}`);
await browser.close();

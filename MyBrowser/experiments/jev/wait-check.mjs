// E4 through the real browser_wait_for `until` handler: the upload fixture
// finishes at `done` ms; the tool must return after that, never before.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '/tmp/opencode/pm/wait.mjs';
import { openBrowser, fixtureUrl } from './lib.mjs';

const key = JSON.parse(readFileSync(join(homedir(), '.mybrowser/config.json'), 'utf8')).jev.apiKey;
const jev = { provider: 'typesafe', apiKey: key, vision: false, minConfidence: 0.7, timeoutMs: 20_000 };
const { browser, context } = await openBrowser();
for (const done of [3000, 6000, 9000]) {
  const page = await context.newPage();
  const t0 = Date.now();
  await page.goto(fixtureUrl('upload.html', `?done=${done}`));
  const ctx = { jev, outlineSelectors: new Map(), sendSocketMessage: async (_t, p) => ({ value: await page.evaluate(p.code) }) };
  const r = await waitFor.handle(ctx, { until: 'the video upload has finished and is ready', failIf: 'an upload error is shown', timeout: 30000 });
  const ms = Date.now() - t0;
  console.log(`done at ${done} ms -> returned at ${ms} ms (${ms >= done ? 'after' : 'EARLY'}, +${ms - done} ms): ${r.content[0].text}`);
  await page.close();
}
const noJev = { outlineSelectors: new Map(), sendSocketMessage: async () => ({}) };
await waitFor.handle(noJev, { until: 'x' }).catch((e) => console.log('without Jev:', e.message.slice(0, 120)));
await browser.close();

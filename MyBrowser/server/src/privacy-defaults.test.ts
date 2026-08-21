import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let home: string;

describe('private local defaults', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mybrowser-privacy-'));
    vi.resetModules();
    vi.doMock('node:os', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:os')>()),
      homedir: () => home,
    }));
  });

  afterEach(() => {
    vi.doUnmock('node:os');
    rmSync(home, { recursive: true, force: true });
  });

  it('binds fresh configurations to loopback unless explicitly overridden', async () => {
    const { loadOrCreateConfig } = await import('./auth');

    expect(loadOrCreateConfig()).toMatchObject({ host: '127.0.0.1', port: 9009 });
    expect(loadOrCreateConfig({ host: '0.0.0.0' })).toMatchObject({ host: '0.0.0.0' });
  });

  it('repairs existing learned-site storage to private modes', async () => {
    const sitesDir = join(home, '.mybrowser', 'sites');
    const siteFile = join(sitesDir, 'example.com.json');
    mkdirSync(sitesDir, { recursive: true, mode: 0o777 });
    writeFileSync(siteFile, '{"domain":"example.com"}\n', { mode: 0o666 });
    chmodSync(sitesDir, 0o777);
    chmodSync(siteFile, 0o666);
    const { ensureDirectories, saveSiteKnowledge } = await import('./site-knowledge');

    ensureDirectories();
    expect(statSync(sitesDir).mode & 0o777).toBe(0o700);
    expect(statSync(siteFile).mode & 0o777).toBe(0o600);

    saveSiteKnowledge('example.com', {
      domain: 'example.com',
      pages: {},
      flows: {},
      quirks: [],
      lastVisited: 1,
    });
    expect(statSync(siteFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(siteFile, 'utf8'))).toMatchObject({ domain: 'example.com' });
  });

  it.runIf(process.platform !== 'win32')('refuses symlinked storage without chmodding its target', async () => {
    const myBrowserDir = join(home, '.mybrowser');
    const target = join(home, 'shared-sites');
    mkdirSync(myBrowserDir, { recursive: true });
    mkdirSync(target, { mode: 0o777 });
    chmodSync(target, 0o777);
    symlinkSync(target, join(myBrowserDir, 'sites'));
    const { ensureDirectories } = await import('./site-knowledge');

    expect(ensureDirectories).toThrow('Refusing unsafe MyBrowser directory');
    expect(statSync(target).mode & 0o777).toBe(0o777);
  });
});

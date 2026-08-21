import { beforeEach, describe, expect, it, vi } from 'vitest';

import { evaluateInMainWorld } from './page-eval';

describe('page evaluation fallback', () => {
  const executeScript = vi.fn(async (options: {
    world: string;
    func: (source: string) => Promise<string>;
    args: string[];
  }) => [{ result: await options.func(options.args[0]!) }]);

  beforeEach(() => {
    executeScript.mockClear();
    vi.stubGlobal('chrome', { scripting: { executeScript } });
  });

  it('executes fallback code in the page MAIN world', async () => {
    await expect(evaluateInMainWorld(7, 'globalThis.location === undefined')).resolves.toEqual({
      value: true,
    });
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 7 },
      world: 'MAIN',
    }));
  });
});

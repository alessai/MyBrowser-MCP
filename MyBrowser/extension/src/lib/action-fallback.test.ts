import { describe, expect, it, vi } from 'vitest';

import { runPreActionFallback } from './action-fallback';

describe('pre-action fallback', () => {
  it('uses the fallback when preparation fails before the action starts', async () => {
    const fallback = vi.fn(async () => 'fallback');

    await expect(runPreActionFallback(
      async () => { throw new Error('prepare failed'); },
      async () => 'primary',
      fallback,
      'OUTCOME_UNKNOWN',
    )).resolves.toBe('fallback');
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('never repeats an action after its outcome becomes unknown', async () => {
    const fallback = vi.fn(async () => 'fallback');

    await expect(runPreActionFallback(
      async () => undefined,
      async () => { throw new Error('transport lost after dispatch'); },
      fallback,
      'OUTCOME_UNKNOWN',
    )).rejects.toThrow('OUTCOME_UNKNOWN');
    expect(fallback).not.toHaveBeenCalled();
  });
});

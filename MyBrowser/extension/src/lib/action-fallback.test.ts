import { describe, expect, it, vi } from 'vitest';

import { runActionOnce, runPreActionFallback } from './action-fallback';

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

  it('never starts a fallback after the request is aborted during preparation', async () => {
    const controller = new AbortController();
    const fallback = vi.fn(async () => 'fallback');

    await expect(runPreActionFallback(
      async () => {
        controller.abort();
        throw new Error('preparation interrupted');
      },
      async () => 'primary',
      fallback,
      'OUTCOME_UNKNOWN',
      controller.signal,
    )).rejects.toMatchObject({ name: 'AbortError' });
    expect(fallback).not.toHaveBeenCalled();
  });
});

describe('unrepeatable actions', () => {
  it('reports an unknown outcome without running the action again', async () => {
    const action = vi.fn(async () => { throw new Error('transport failed'); });

    await expect(runActionOnce(action, 'ACTION_OUTCOME_UNKNOWN'))
      .rejects.toThrow('ACTION_OUTCOME_UNKNOWN');
    expect(action).toHaveBeenCalledTimes(1);
  });
});

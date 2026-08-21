import { describe, expect, it, vi } from 'vitest';

import { requestFormSubmit } from './form-submit';

describe('form submission fallback', () => {
  it('uses the browser submit algorithm exactly once', () => {
    const requestSubmit = vi.fn();

    requestFormSubmit({ requestSubmit });

    expect(requestSubmit).toHaveBeenCalledOnce();
  });
});

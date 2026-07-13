import { describe, expect, it } from 'vitest';
import { SessionTombstones } from './session-tombstones';

describe('SessionTombstones', () => {
  it('bounds retained session IDs and expires them', () => {
    let now = 0;
    const tombstones = new SessionTombstones({
      ttlMs: 10,
      maxEntries: 2,
      now: () => now,
    });

    tombstones.add('session-a');
    tombstones.add('session-b');
    tombstones.add('session-c');

    expect(tombstones.size).toBe(2);
    expect(tombstones.has('session-a')).toBe(false);
    expect(tombstones.has('session-b')).toBe(true);
    expect(tombstones.has('session-c')).toBe(true);

    now = 11;
    expect(tombstones.has('session-b')).toBe(false);
    expect(tombstones.has('session-c')).toBe(false);
    expect(tombstones.size).toBe(0);
  });
});

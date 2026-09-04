import { describe, it, expect } from 'vitest';
import { toneAbove, toneBelow, accuracyTone, scoreTone, blunderTone } from './tone';

describe('tone bands', () => {
  it('treats the threshold itself as inside the better band', () => {
    expect(toneAbove(80, 80, 65)).toBe('good');
    expect(toneAbove(65, 80, 65)).toBe('ok');
    expect(toneAbove(64.9, 80, 65)).toBe('weak');
  });

  it('inverts for statistics where less is better', () => {
    expect(toneBelow(1, 1, 2.5)).toBe('good');
    expect(toneBelow(2.5, 1, 2.5)).toBe('ok');
    expect(toneBelow(2.6, 1, 2.5)).toBe('weak');
  });

  it('separates real club-player accuracies rather than lumping them', () => {
    expect(accuracyTone(62)).toBe('weak');
    expect(accuracyTone(72)).toBe('ok');
    expect(accuracyTone(86)).toBe('good');
  });

  it('calls an even score neither good nor weak', () => {
    expect(scoreTone(50)).toBe('ok');
    expect(scoreTone(75)).toBe('good');
    expect(scoreTone(20)).toBe('weak');
  });

  it('bands blunders per game', () => {
    expect(blunderTone(0.4)).toBe('good');
    expect(blunderTone(1.8)).toBe('ok');
    expect(blunderTone(4)).toBe('weak');
  });
});

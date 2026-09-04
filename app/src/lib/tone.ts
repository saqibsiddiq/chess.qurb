export type Tone = 'good' | 'ok' | 'weak';

export function toneAbove(value: number, good: number, ok: number): Tone {
  if (value >= good) return 'good';
  if (value >= ok) return 'ok';
  return 'weak';
}

export function toneBelow(value: number, good: number, ok: number): Tone {
  if (value <= good) return 'good';
  if (value <= ok) return 'ok';
  return 'weak';
}

export const accuracyTone = (pct: number): Tone => toneAbove(pct, 80, 65);

export const scoreTone = (pct: number): Tone => toneAbove(pct, 55, 45);

export const blunderTone = (per: number): Tone => toneBelow(per, 1, 2.5);

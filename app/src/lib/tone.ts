/**
 * Turns a statistic into a "how am I doing" band, so a card can be
 * coloured as well as numbered.
 *
 * Beginners read a colour before they read a figure, and the thresholds
 * are the whole point of the feature — keeping them here rather than
 * inline in the markup means the app judges "80% accuracy" the same way
 * everywhere, and that the judgement can be tested.
 */
export type Tone = 'good' | 'ok' | 'weak';

/** For statistics where a bigger number is better (accuracy, points won). */
export function toneAbove(value: number, good: number, ok: number): Tone {
  if (value >= good) return 'good';
  if (value >= ok) return 'ok';
  return 'weak';
}

/** For statistics where a smaller number is better (blunders per game). */
export function toneBelow(value: number, good: number, ok: number): Tone {
  if (value <= good) return 'good';
  if (value <= ok) return 'ok';
  return 'weak';
}

/**
 * Accuracy bands, shared by the overall figure and the per-opening one.
 *
 * 80/65 rather than something rounder: club players sit in the 60s–70s on
 * blitz, so a 70% threshold for "good" would paint almost every card the
 * same colour and say nothing.
 */
export const accuracyTone = (pct: number): Tone => toneAbove(pct, 80, 65);

/** Points per game as a percentage — 50% is an even score. */
export const scoreTone = (pct: number): Tone => toneAbove(pct, 55, 45);

/** Blunders per game. One a game is doing well; three is the problem. */
export const blunderTone = (per: number): Tone => toneBelow(per, 1, 2.5);

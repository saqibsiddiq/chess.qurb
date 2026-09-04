import type { ParsedGame } from './parsePgn';

export type ClockTimes = (number | null)[];

export function parseClock(text: string): number | null {
  const m = text.match(/(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export function parseTimeControl(header: string | undefined): {
  base: number | null;
  increment: number;
} {
  if (!header || header === '-') return { base: null, increment: 0 };
  const m = header.match(/^(\d+)(?:\+(\d+))?/);
  if (!m) return { base: null, increment: 0 };
  return { base: Number(m[1]), increment: Number(m[2] ?? 0) };
}

export function timeSpentPerMove(
  game: ParsedGame,
  clocks: ClockTimes,
  increment: number,
  base: number | null,
): (number | null)[] {
  const previous: Record<'w' | 'b', number | null> = { w: base, b: base };

  return game.moves.map((move, i) => {
    const remaining = clocks[i];
    if (remaining === null || remaining === undefined) return null;

    const before = previous[move.color];
    previous[move.color] = remaining;
    if (before === null) return null;

    const spent = before - remaining + increment;
    return spent >= 0 ? spent : null;
  });
}

export interface TimeInsights {
  medianSeconds: number;
  rushedCount: number;
  rushedMistakes: number;
  totalMistakes: number;
  longestSeconds: number;
  longestIndex: number;
}

export const RUSHED_SECONDS = 5;

const COSTLY = new Set(['inaccuracy', 'mistake', 'miss', 'blunder']);

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function timeInsights(
  spent: (number | null)[],
  classifications: string[],
  colors: ('w' | 'b')[],
  side: 'w' | 'b',
): TimeInsights | null {
  const times: number[] = [];
  let rushedCount = 0;
  let rushedMistakes = 0;
  let totalMistakes = 0;
  let longestSeconds = -1;
  let longestIndex = -1;

  spent.forEach((seconds, i) => {
    if (colors[i] !== side || seconds === null) return;
    times.push(seconds);

    const costly = COSTLY.has(classifications[i]);
    if (costly) totalMistakes += 1;
    if (seconds < RUSHED_SECONDS) {
      rushedCount += 1;
      if (costly) rushedMistakes += 1;
    }
    if (seconds > longestSeconds) {
      longestSeconds = seconds;
      longestIndex = i;
    }
  });

  if (times.length === 0) return null;

  return {
    medianSeconds: median(times),
    rushedCount,
    rushedMistakes,
    totalMistakes,
    longestSeconds: Math.max(0, longestSeconds),
    longestIndex,
  };
}

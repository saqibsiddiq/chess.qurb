import type { ParsedGame } from './parsePgn';

// Both platforms annotate every move with the clock left after it —
// Chess.com as `{[%clk 0:02:57.5]}` in the PGN, Lichess the same — and
// Chesy discarded all of it. Time is where a lot of club-level games are
// actually decided, and no amount of move-quality analysis surfaces it.

/** Seconds left on the mover's clock after a move, one entry per ply. */
export type ClockTimes = (number | null)[];

/** `H:MM:SS` or `H:MM:SS.s` as used in `[%clk ...]`. */
export function parseClock(text: string): number | null {
  const m = text.match(/(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** The `TimeControl` header, e.g. `180+2`, `600`, or `-` for untimed. */
export function parseTimeControl(header: string | undefined): {
  base: number | null;
  increment: number;
} {
  if (!header || header === '-') return { base: null, increment: 0 };
  const m = header.match(/^(\d+)(?:\+(\d+))?/);
  if (!m) return { base: null, increment: 0 };
  return { base: Number(m[1]), increment: Number(m[2] ?? 0) };
}

/**
 * Seconds each move actually took.
 *
 * A clock reading is time *remaining*, so the cost of a move is the drop
 * against that player's own previous reading — the opponent's clock is
 * irrelevant and interleaving them would halve every figure. Any
 * increment is added back, since it is credited after the move and would
 * otherwise make a fast move look like it took negative time.
 */
export function timeSpentPerMove(
  game: ParsedGame,
  clocks: ClockTimes,
  increment: number,
  base: number | null,
): (number | null)[] {
  // Tracked per colour: white's previous reading is two plies back, not
  // one.
  const previous: Record<'w' | 'b', number | null> = { w: base, b: base };

  return game.moves.map((move, i) => {
    const remaining = clocks[i];
    if (remaining === null || remaining === undefined) return null;

    const before = previous[move.color];
    previous[move.color] = remaining;
    if (before === null) return null;

    const spent = before - remaining + increment;
    // A negative result means the clock went up more than the increment
    // explains — added time, a correspondence game, or simply a PGN we
    // can't reason about. Reporting nothing beats reporting nonsense.
    return spent >= 0 ? spent : null;
  });
}

export interface TimeInsights {
  /** Median seconds per move, a fairer centre than the mean when one long
   *  think would otherwise drag the average up. */
  medianSeconds: number;
  /** Moves played in under {@link RUSHED_SECONDS}. */
  rushedCount: number;
  /** Costly moves (inaccuracy or worse) that were also rushed. */
  rushedMistakes: number;
  /** Costly moves in total, so the ratio above can be read in context. */
  totalMistakes: number;
  /** The longest single think, and which move it was. */
  longestSeconds: number;
  longestIndex: number;
}

/// Under this, a move was effectively played on instinct. Chosen to be
/// short enough that it means something even in blitz.
export const RUSHED_SECONDS = 5;

const COSTLY = new Set(['inaccuracy', 'mistake', 'miss', 'blunder']);

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Summarises one player's use of the clock.
 *
 * Restricted to a single colour on purpose: mixing both players' times
 * describes the game rather than the person reviewing it.
 */
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

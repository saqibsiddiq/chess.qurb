// How a game ended is a different axis from how it was played, and no
// amount of move-quality analysis surfaces it: a player losing a quarter
// of their games on time has a problem that accuracy scores are blind to.

export type Termination =
  | 'checkmate'
  | 'resignation'
  | 'timeout'
  | 'stalemate'
  | 'repetition'
  | 'insufficient'
  | 'agreement'
  | 'abandoned'
  /** Ended by ordinary means the source didn't specify further. */
  | 'normal'
  | 'unknown';

export const TERMINATION_LABELS: Record<Termination, string> = {
  checkmate: 'Checkmate',
  resignation: 'Resignation',
  timeout: 'Time',
  stalemate: 'Stalemate',
  repetition: 'Repetition',
  insufficient: 'Insufficient material',
  agreement: 'Agreement',
  abandoned: 'Abandoned',
  normal: 'Normal',
  unknown: 'Unknown',
};

/**
 * Lichess's own `status` field, which is precise where its PGN is not.
 *
 * Its PGN only ever says `Normal` or `Time forfeit`, so a resignation and
 * a checkmate are indistinguishable from the header alone — the JSON
 * status is the only way to tell them apart.
 */
export function fromLichessStatus(status: string | undefined): Termination | null {
  switch (status) {
    case 'mate':
      return 'checkmate';
    case 'resign':
      return 'resignation';
    case 'outoftime':
      return 'timeout';
    case 'stalemate':
      return 'stalemate';
    case 'draw':
      return 'agreement';
    case 'timeout':
    case 'noStart':
      return 'abandoned';
    default:
      return null;
  }
}

/**
 * Reads the `Termination` header.
 *
 * Chess.com writes a sentence — `Hikaru won by resignation`, `Game drawn
 * by repetition` — while Lichess writes only `Normal` or `Time forfeit`,
 * so `statusHint` fills the gap where the header is uninformative.
 */
export function terminationFrom(
  headers: Record<string, string>,
  statusHint?: string,
): Termination {
  const raw = (headers.Termination ?? '').toLowerCase();

  // Matched on word boundaries, not substrings: "insufficient material"
  // contains "mate", so a plain `includes('mate')` reports a checkmate
  // for a drawn game. Order alone wouldn't fix it — the boundary does.
  const has = (pattern: RegExp) => pattern.test(raw);

  if (has(/\btime forfeit\b|\bon time\b|\btimeout\b/)) return 'timeout';
  if (has(/\bresign/)) return 'resignation';
  if (has(/\binsufficient\b/)) return 'insufficient';
  if (has(/\b(?:check)?mate\b/)) return 'checkmate';
  if (has(/\bstalemate\b/)) return 'stalemate';
  if (has(/\brepetition\b/)) return 'repetition';
  if (has(/\bagree/)) return 'agreement';
  if (has(/\babandon/)) return 'abandoned';

  // `Normal` carries no detail, so a precise status is preferred over it.
  const fromStatus = fromLichessStatus(statusHint);
  if (fromStatus) return fromStatus;

  if (raw === 'normal') return 'normal';
  return 'unknown';
}

/** The result from one player's point of view. */
export function outcomeFor(
  result: string,
  playedWhite: boolean,
): 'win' | 'loss' | 'draw' | null {
  if (result === '1/2-1/2') return 'draw';
  if (result === '1-0') return playedWhite ? 'win' : 'loss';
  if (result === '0-1') return playedWhite ? 'loss' : 'win';
  return null;
}

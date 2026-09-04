export type Termination =
  | 'checkmate'
  | 'resignation'
  | 'timeout'
  | 'stalemate'
  | 'repetition'
  | 'insufficient'
  | 'agreement'
  | 'abandoned'
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

export function terminationFrom(
  headers: Record<string, string>,
  statusHint?: string,
): Termination {
  const raw = (headers.Termination ?? '').toLowerCase();

  const has = (pattern: RegExp) => pattern.test(raw);

  if (has(/\btime forfeit\b|\bon time\b|\btimeout\b/)) return 'timeout';
  if (has(/\bresign/)) return 'resignation';
  if (has(/\binsufficient\b/)) return 'insufficient';
  if (has(/\b(?:check)?mate\b/)) return 'checkmate';
  if (has(/\bstalemate\b/)) return 'stalemate';
  if (has(/\brepetition\b/)) return 'repetition';
  if (has(/\bagree/)) return 'agreement';
  if (has(/\babandon/)) return 'abandoned';

  const fromStatus = fromLichessStatus(statusHint);
  if (fromStatus) return fromStatus;

  if (raw === 'normal') return 'normal';
  return 'unknown';
}

export function outcomeFor(
  result: string,
  playedWhite: boolean,
): 'win' | 'loss' | 'draw' | null {
  if (result === '1/2-1/2') return 'draw';
  if (result === '1-0') return playedWhite ? 'win' : 'loss';
  if (result === '0-1') return playedWhite ? 'loss' : 'win';
  return null;
}

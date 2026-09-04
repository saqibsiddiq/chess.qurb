import type { ReviewSummary } from './storage';
import { outcomeFor, type Termination } from './termination';

const WEAKNESS_LABELS: Record<string, string> = {
  hanging_piece: 'Leaving pieces hanging',
  fork: 'Missing forks',
  pin: 'Missing pins',
  skewer: 'Missing skewers',
  missed_mate: 'Missing forced mates',
  allowed_mate: 'Allowing forced mates',
  discovered_attack: 'Walking into discovered attacks',
  back_rank: 'Back-rank weaknesses',
};

const COSTLY_CLASSES = ['blunder', 'mistake', 'miss', 'inaccuracy'] as const;
type CostlyClass = (typeof COSTLY_CLASSES)[number];

export interface Weakness {
  motif: string;
  label: string;
  count: number;
  perGame: number;
}

export interface PlayerInsights {
  player: string;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  averageAccuracy: number;
  lossesBy: Partial<Record<Termination, number>>;
  perGame: Record<CostlyClass, number>;
  weaknesses: Weakness[];
}

export function detectPlayer(summaries: ReviewSummary[]): string | null {
  const counts = new Map<string, number>();
  for (const s of summaries) {
    for (const name of [s.white, s.black]) {
      if (!name || name === 'Unknown') continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

export function aggregate(summaries: ReviewSummary[], player: string): PlayerInsights | null {
  const mine = summaries.filter((s) => s.white === player || s.black === player);
  if (mine.length === 0) return null;

  let wins = 0;
  let draws = 0;
  let losses = 0;
  let accuracyTotal = 0;
  const classTotals: Record<CostlyClass, number> = {
    blunder: 0,
    mistake: 0,
    miss: 0,
    inaccuracy: 0,
  };
  const motifTotals = new Map<string, number>();
  const lossesBy: Partial<Record<Termination, number>> = {};

  for (const s of mine) {
    const playedWhite = s.white === player;
    const counts = playedWhite ? s.whiteCounts : s.blackCounts;
    const motifs = playedWhite ? s.whiteMotifs : s.blackMotifs;
    accuracyTotal += playedWhite ? s.whiteAccuracy : s.blackAccuracy;

    switch (outcomeFor(s.result, playedWhite)) {
      case 'win':
        wins += 1;
        break;
      case 'draw':
        draws += 1;
        break;
      case 'loss': {
        losses += 1;
        const how = (s.termination ?? 'unknown') as Termination;
        lossesBy[how] = (lossesBy[how] ?? 0) + 1;
        break;
      }
      default:
        break;
    }

    for (const cls of COSTLY_CLASSES) classTotals[cls] += counts[cls] ?? 0;
    for (const [motif, n] of Object.entries(motifs ?? {})) {
      if (!(motif in WEAKNESS_LABELS)) continue;
      motifTotals.set(motif, (motifTotals.get(motif) ?? 0) + n);
    }
  }

  const games = mine.length;
  const weaknesses: Weakness[] = [...motifTotals.entries()]
    .map(([motif, count]) => ({
      motif,
      label: WEAKNESS_LABELS[motif],
      count,
      perGame: count / games,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    player,
    games,
    wins,
    draws,
    losses,
    averageAccuracy: accuracyTotal / games,
    lossesBy,
    perGame: {
      blunder: classTotals.blunder / games,
      mistake: classTotals.mistake / games,
      miss: classTotals.miss / games,
      inaccuracy: classTotals.inaccuracy / games,
    },
    weaknesses,
  };
}

export function insightsFor(summaries: ReviewSummary[]): PlayerInsights | null {
  const player = detectPlayer(summaries);
  return player ? aggregate(summaries, player) : null;
}

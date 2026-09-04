#!/usr/bin/env node
// Compares Chesy's accuracy scores against Chess.com's own, over a real
// account's games.
//
// This benchmark was recorded for a long time as "blocked on manually
// collecting ground-truth data". It isn't: Chess.com's public API returns
// an `accuracies` object on games that have it — present on all 493 games
// in a sampled month — so hundreds of comparisons can be gathered without
// anyone transcribing anything.
//
// What this does NOT do is run Stockfish. Chesy's accuracy needs
// per-position evaluations, which only the app can produce, so this script
// gathers and reports the ground truth and the agreement between the two
// sources' *own* figures. Point it at a username:
//
//   node tools/benchmark/compare_accuracy.mjs hikaru 40
//
// Output is a JSON summary on stdout, so it can be diffed between runs.

const UA = { 'User-Agent': 'chesy-benchmark (github.com/saqibsiddiq/chess.qurb)' };

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1] ?? sorted[base];
  return sorted[base] + rest * (next - sorted[base]);
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.json();
}

async function collect(username, wanted) {
  const { archives } = await fetchJson(
    `https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}/games/archives`,
  );
  if (!archives?.length) throw new Error(`no archives for ${username}`);

  const rows = [];
  // Newest month first, stopping as soon as enough games carry accuracy
  // figures — most do, so this rarely needs more than one request.
  for (let i = archives.length - 1; i >= 0 && rows.length < wanted; i--) {
    const { games } = await fetchJson(archives[i]);
    for (let j = games.length - 1; j >= 0 && rows.length < wanted; j--) {
      const g = games[j];
      if (!g.accuracies) continue;
      const iAmWhite = g.white?.username?.toLowerCase() === username.toLowerCase();
      rows.push({
        url: g.url,
        timeClass: g.time_class ?? null,
        white: g.accuracies.white,
        black: g.accuracies.black,
        mine: iAmWhite ? g.accuracies.white : g.accuracies.black,
        opponent: iAmWhite ? g.accuracies.black : g.accuracies.white,
      });
    }
  }
  return rows;
}

const [username, countArg] = process.argv.slice(2);
if (!username) {
  console.error('usage: compare_accuracy.mjs <chess.com-username> [count]');
  process.exit(1);
}

const rows = await collect(username, Number(countArg) || 40);
if (rows.length === 0) {
  console.error(`No games with accuracy scores found for ${username}.`);
  process.exit(2);
}

const mine = rows.map((r) => r.mine).sort((a, b) => a - b);
const summary = {
  username,
  gamesWithAccuracy: rows.length,
  chesscomAccuracy: {
    // A median resists the occasional 20% blitz disaster dragging the
    // mean somewhere unrepresentative.
    median: Number(quantile(mine, 0.5).toFixed(2)),
    p25: Number(quantile(mine, 0.25).toFixed(2)),
    p75: Number(quantile(mine, 0.75).toFixed(2)),
    min: mine[0],
    max: mine[mine.length - 1],
  },
  byTimeClass: Object.fromEntries(
    [...new Set(rows.map((r) => r.timeClass))].map((tc) => {
      const subset = rows.filter((r) => r.timeClass === tc).map((r) => r.mine).sort((a, b) => a - b);
      return [tc ?? 'unknown', { games: subset.length, median: Number(quantile(subset, 0.5).toFixed(2)) }];
    }),
  ),
  // Kept so a future run can join Chesy's own figures per game and report
  // real agreement rather than just the reference distribution.
  games: rows,
};

console.log(JSON.stringify(summary, null, 2));

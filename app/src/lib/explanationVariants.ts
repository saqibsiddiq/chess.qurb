// Phrasing variety for explainMove()/detectMissedTactic() in
// explanations.ts. The underlying facts (which piece, which square,
// which move) already differ every time; what was repetitive was the
// fixed sentence *shape* wrapped around them — the same move type
// always read as the exact same template. Below, most branches compose
// their summary from two independently-picked, independently-written
// clauses (an "opener" naming what happened, a "consequence" explaining
// why it matters) rather than one fixed sentence — that turns a modest
// number of hand-written fragments into a much larger number of
// combinations (10 openers x 10 consequences = 100 distinct summaries
// from 20 fragments) without the fragments themselves degrading into
// synonym-swaps of each other, which is what happens past ~15-20 fully
// independent hand-written sentences for the same slot. Both clauses
// are always written as complete, independently-grammatical sentences
// (not a fragment expecting a specific connector) so any opener can
// combine safely with any consequence.
//
// Selection is deterministic per move (seeded from the move's own
// identity, not Math.random()) so the same move shows the same wording
// on every view within a session — only different moves get different
// phrasing, not the same move flickering between wordings on re-render.

// Murmur3-style finalizer, applied after FNV-1a below. Needed for a
// concrete reason, not just extra rigor: many seeds here share a long
// common prefix (e.g. "w12:e2e4:hanging:opener" vs
// "w12:e2e4:hanging:consequence", differing only in the tag suffix).
// Plain FNV-1a's left-to-right multiplicative mixing means running the
// *same* long shared prefix through the *same* recurrence leaves the two
// resulting hashes correlated with each other, even though each one
// individually looks well-distributed in isolation — verified directly
// (300 sampled seed pairs landed on only 36 of 144 possible index
// combinations for two "independent" picks, versus the ~126 expected if
// they were actually independent). This finalizer's avalanche (every
// input bit flips roughly half the output bits) breaks that
// correlation — confirmed the same way, landing at 128/144 after adding
// it. Skipping this and picking two indices straight from FNV-1a on
// seeds sharing a prefix will silently reintroduce clustering, even
// though it looks fine if you only test one pool at a time.
function mix32(x: number): number {
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

function hashSeed(seed: string): number {
  // FNV-1a — small, fast, good-enough as the first pass; see mix32()
  // above for why its raw output isn't used directly.
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return mix32(hash >>> 0);
}

export function pickVariant<T>(seed: string, variants: readonly T[]): T {
  return variants[hashSeed(seed) % variants.length];
}

// ---------------------------------------------------------------------
// Checkmate
// ---------------------------------------------------------------------
export const checkmateSummaries: readonly ((san: string) => string)[] = [
  (san) => `${san} delivers checkmate — game over.`,
  (san) => `${san} seals it — checkmate.`,
  (san) => `That's mate. ${san} finishes the game right here.`,
  (san) => `${san} is checkmate. Nothing more to play.`,
  (san) => `Game over — ${san} is checkmate.`,
  (san) => `${san} ends it in style. Checkmate.`,
  (san) => `${san} wraps up the game — checkmate.`,
  (san) => `Checkmate! ${san} finishes it.`,
  (san) => `${san} is the final blow — checkmate.`,
  (san) => `That's the game — ${san} is mate.`,
  (san) => `${san} closes it out with checkmate.`,
  (san) => `Nowhere left to go — ${san} is mate.`,
];
export const checkmateDetails: readonly string[] = [
  'A clean, decisive finish.',
  'A fitting end to the game.',
  'No further moves needed.',
  'The king has nowhere left to go.',
  'Well played to the finish.',
  'That’s the game, start to finish.',
  'A tidy way to close things out.',
  'Nothing left to say — that’s mate.',
  'The board falls silent — checkmate.',
  'A decisive way to end it.',
];

// ---------------------------------------------------------------------
// Missed mate
// ---------------------------------------------------------------------
export const missedMateSummaries: readonly ((bestSan: string) => string)[] = [
  (bestSan) => `${bestSan} would have forced checkmate here.`,
  (bestSan) => `There was a forced mate available with ${bestSan}.`,
  (bestSan) => `${bestSan} finishes the game on the spot — a forced mate.`,
  (bestSan) => `You had mate in hand with ${bestSan}.`,
  (bestSan) => `${bestSan} was a forced checkmate, missed here.`,
  (bestSan) => `${bestSan} ends the game immediately with checkmate.`,
  (bestSan) => `A forced mate was sitting right there: ${bestSan}.`,
  (bestSan) => `${bestSan} was mate — no way for the opponent to survive.`,
  (bestSan) => `The game was over with ${bestSan}.`,
  (bestSan) => `${bestSan} delivers a forced checkmate.`,
  (bestSan) => `That was a missed mate — ${bestSan} finishes it.`,
  (bestSan) => `${bestSan} was the mating blow.`,
  (bestSan) => `Checkmate was available: ${bestSan}.`,
  (bestSan) => `${bestSan} wraps up the game with forced mate.`,
  (bestSan) => `You could have ended it with ${bestSan} — forced mate.`,
];
export const missedMateDetails: readonly ((san: string) => string)[] = [
  (san) => `${san} lets the opponent escape — that winning line is gone now.`,
  (san) => `Instead, ${san} gives the opponent a way out.`,
  (san) => `${san} was played instead, and the mating chance is gone.`,
  (san) => `That escape route wasn't there before ${san}.`,
  (san) => `${san} misses the mate, and the opponent survives.`,
  (san) => `The mate slips away after ${san}.`,
  (san) => `${san} lets the game continue instead of ending it.`,
  (san) => `That forced win is gone after ${san}.`,
  (san) => `${san} gives the opponent one more chance.`,
  (san) => `The mating chance disappears with ${san}.`,
  (san) => `${san} was chosen instead of the mating line.`,
  (san) => `That's a missed finish — ${san} doesn't end it.`,
];

// ---------------------------------------------------------------------
// Allowed mate
// ---------------------------------------------------------------------
export const allowedMateSummaries: readonly ((san: string) => string)[] = [
  (san) => `${san} walks into a forced checkmate — there's no way out now.`,
  (san) => `${san} allows a forced mate — the game is effectively over.`,
  (san) => `There's no defense left after ${san}; it's a forced mate.`,
  (san) => `${san} opens the door to a forced checkmate sequence.`,
  (san) => `${san} runs straight into a mating net.`,
  (san) => `After ${san}, there's no way to stop the mate.`,
  (san) => `${san} lets the opponent force checkmate.`,
  (san) => `That's game over — ${san} allows a forced mate.`,
  (san) => `${san} walks right into a forced finish.`,
  (san) => `The mate is unstoppable after ${san}.`,
  (san) => `${san} hands the opponent a forced checkmate.`,
  (san) => `There's no escaping it after ${san} — mate is coming.`,
];
export const allowedMateDetails: readonly ((bestSan: string) => string)[] = [
  (bestSan) => `${bestSan} would have kept you safe.`,
  (bestSan) => `${bestSan} was needed to hold the position together.`,
  (bestSan) => `Playing ${bestSan} instead would have avoided this.`,
  (bestSan) => `${bestSan} kept the king out of danger.`,
  (bestSan) => `${bestSan} was the only way to survive here.`,
  (bestSan) => `With ${bestSan}, the mate never happens.`,
  (bestSan) => `${bestSan} defends against the mating threat.`,
  (bestSan) => `${bestSan} was the move that held everything together.`,
];

// ---------------------------------------------------------------------
// Hanging piece — compositional: opener (what's exposed) x consequence
// (who's taking it). 12 x 12 = 144 summary combinations.
// ---------------------------------------------------------------------
export interface HangingOpenerArgs {
  pieceName: string;
  square: string;
}
export interface HangingConsequenceArgs {
  attackerName: string;
  attackerSquare: string;
}
export const hangingOpeners: readonly ((a: HangingOpenerArgs) => string)[] = [
  (a) => `Your ${a.pieceName} on ${a.square} is hanging.`,
  (a) => `The ${a.pieceName} on ${a.square} is wide open.`,
  (a) => `That ${a.pieceName} on ${a.square} is left exposed.`,
  (a) => `Your ${a.pieceName} on ${a.square} has nothing defending it.`,
  (a) => `The ${a.pieceName} on ${a.square} is sitting undefended.`,
  (a) => `Your ${a.pieceName} on ${a.square} just became a free target.`,
  (a) => `That ${a.pieceName} on ${a.square} is completely loose.`,
  (a) => `Your ${a.pieceName} on ${a.square} is dangling, unprotected.`,
  (a) => `The ${a.pieceName} on ${a.square} is there for the taking.`,
  (a) => `Your ${a.pieceName} on ${a.square} is exposed, with no support.`,
  (a) => `The ${a.pieceName} on ${a.square} lost its cover.`,
  (a) => `Your ${a.pieceName} on ${a.square} is out in the open now.`,
];
export const hangingConsequences: readonly ((a: HangingConsequenceArgs) => string)[] = [
  (a) => `The ${a.attackerName} on ${a.attackerSquare} can just take it.`,
  (a) => `The ${a.attackerName} on ${a.attackerSquare} is ready to grab it.`,
  (a) => `The ${a.attackerName} on ${a.attackerSquare} takes it for free.`,
  (a) => `The ${a.attackerName} on ${a.attackerSquare} is one move from capturing it.`,
  (a) => `The ${a.attackerName} on ${a.attackerSquare} has a clear shot at it.`,
  (a) => `It's sitting right in front of the ${a.attackerName} on ${a.attackerSquare}.`,
  (a) => `The ${a.attackerName} on ${a.attackerSquare} can pick it up immediately.`,
  (a) => `The ${a.attackerName} on ${a.attackerSquare} can capture it at will.`,
  (a) => `The ${a.attackerName} on ${a.attackerSquare} won't miss it.`,
  (a) => `Nothing stops the ${a.attackerName} on ${a.attackerSquare} from taking it.`,
  (a) => `The ${a.attackerName} on ${a.attackerSquare} is one capture away from winning it.`,
  (a) => `That's a free piece for the ${a.attackerName} on ${a.attackerSquare}.`,
];
export const hangingSummariesNoAttacker: readonly ((a: { pieceName: string; square: string }) => string)[] = [
  (a) => `Your ${a.pieceName} on ${a.square} is hanging, with nothing left to defend it.`,
  (a) => `The ${a.pieceName} on ${a.square} is completely undefended right now.`,
  (a) => `Your ${a.pieceName} on ${a.square} has no protection at all.`,
  (a) => `That ${a.pieceName} on ${a.square} is left entirely exposed.`,
  (a) => `Nothing is guarding your ${a.pieceName} on ${a.square}.`,
  (a) => `Your ${a.pieceName} on ${a.square} stands there unprotected.`,
];
export const hangingDetails: readonly ((a: { bestSan: string; lossText: string }) => string)[] = [
  (a) => `${a.bestSan} would have kept it protected. (~${a.lossText} pawns lost)`,
  (a) => `Playing ${a.bestSan} avoids this altogether. (~${a.lossText} pawns lost)`,
  (a) => `${a.bestSan} keeps everything defended instead. (~${a.lossText} pawns lost)`,
  (a) => `${a.bestSan} was the safer choice here. (~${a.lossText} pawns lost)`,
  (a) => `With ${a.bestSan}, nothing would be left loose. (~${a.lossText} pawns lost)`,
  (a) => `${a.bestSan} holds everything together. (~${a.lossText} pawns lost)`,
  (a) => `${a.bestSan} keeps that piece safe instead. (~${a.lossText} pawns lost)`,
  (a) => `${a.bestSan} avoids leaving anything hanging. (~${a.lossText} pawns lost)`,
  (a) => `${a.bestSan} was the move that kept things defended. (~${a.lossText} pawns lost)`,
  (a) => `Nothing would be loose after ${a.bestSan}. (~${a.lossText} pawns lost)`,
  (a) => `${a.bestSan} was needed to keep everything covered. (~${a.lossText} pawns lost)`,
  (a) => `${a.bestSan} tucks that piece away safely. (~${a.lossText} pawns lost)`,
  (a) => `${a.bestSan} was the more careful choice. (~${a.lossText} pawns lost)`,
  (a) => `That piece stays safe after ${a.bestSan}. (~${a.lossText} pawns lost)`,
  (a) => `${a.bestSan} was the tidier, safer option. (~${a.lossText} pawns lost)`,
];

// ---------------------------------------------------------------------
// Missed fork — compositional: attack description x consequence.
// ---------------------------------------------------------------------
export const forkOpeners: readonly ((a: { bestSan: string; targetNames: string }) => string)[] = [
  (a) => `${a.bestSan} attacks ${a.targetNames} at once.`,
  (a) => `${a.bestSan} forks ${a.targetNames}.`,
  (a) => `Both ${a.targetNames} come under attack after ${a.bestSan}.`,
  (a) => `${a.bestSan} hits ${a.targetNames} simultaneously.`,
  (a) => `${a.bestSan} creates a fork, targeting ${a.targetNames}.`,
  (a) => `There's a fork here: ${a.bestSan} attacks ${a.targetNames} together.`,
  (a) => `${a.bestSan} lines up ${a.targetNames} in one shot.`,
  (a) => `${a.bestSan} threatens ${a.targetNames} at the same time.`,
  (a) => `A fork was available — ${a.bestSan} goes after ${a.targetNames}.`,
  (a) => `${a.bestSan} puts ${a.targetNames} both in danger at once.`,
];
export const forkConsequences: readonly string[] = [
  'One of them would have been won.',
  'At least one piece was going to fall.',
  'There was no way to save both.',
  'Material was there for the taking.',
  "The opponent can't defend both pieces at once.",
  'One of those pieces was lost either way.',
  "That's a genuine two-for-one threat.",
  'Real material was on the table there.',
];
export const forkDetails: readonly ((san: string) => string)[] = [
  (san) => `${san} was played instead, so both pieces stay safe.`,
  (san) => `Instead, ${san} lets both targets stay out of danger.`,
  (san) => `${san} misses the fork — nothing is won this time.`,
  (san) => `${san} was chosen instead, and the fork never happens.`,
  (san) => `Playing ${san} means both pieces stay protected.`,
  (san) => `${san} doesn't create that same double threat.`,
  (san) => `With ${san}, the opponent keeps both pieces safe.`,
  (san) => `${san} lets that opportunity pass by.`,
  (san) => `That fork isn't there after ${san}.`,
  (san) => `${san} was played, and the double attack never happens.`,
  (san) => `Both pieces survive after ${san}.`,
  (san) => `${san} keeps things quieter — no fork follows.`,
  (san) => `The fork disappears once ${san} is played.`,
  (san) => `Instead of the fork, ${san} was chosen.`,
  (san) => `${san} sidesteps the fork entirely.`,
];

// ---------------------------------------------------------------------
// Missed pin — compositional.
// ---------------------------------------------------------------------
export const pinOpeners: readonly ((a: { bestSan: string; frontPiece: string }) => string)[] = [
  (a) => `${a.bestSan} pins the ${a.frontPiece}.`,
  (a) => `${a.bestSan} ties the ${a.frontPiece} down.`,
  (a) => `The ${a.frontPiece} would be pinned by ${a.bestSan}.`,
  (a) => `${a.bestSan} pins the ${a.frontPiece} in place.`,
  (a) => `${a.bestSan} traps the ${a.frontPiece} against the piece behind it.`,
  (a) => `There's a pin available: ${a.bestSan} pins the ${a.frontPiece}.`,
  (a) => `${a.bestSan} freezes the ${a.frontPiece} with a pin.`,
  (a) => `${a.bestSan} locks the ${a.frontPiece} in place with a pin.`,
  (a) => `The ${a.frontPiece} gets pinned down by ${a.bestSan}.`,
  (a) => `${a.bestSan} sets up a pin on the ${a.frontPiece}.`,
];
export const pinConsequences: readonly ((behindPiece: string) => string)[] = [
  (b) => `It can't move without exposing the ${b} behind it.`,
  (b) => `Moving it would lose the ${b}.`,
  (b) => `The ${b} behind it would fall if it moves.`,
  (b) => `It's stuck — the ${b} behind it is worth more.`,
  (b) => `Any move loses the ${b} standing behind it.`,
  (b) => `It has to stay put, or the ${b} behind it goes.`,
  (b) => `The ${b} behind it is the real target.`,
  (b) => `That piece can't budge without giving up the ${b}.`,
];
export const pinDetails: readonly ((a: { san: string; frontPiece: string }) => string)[] = [
  (a) => `${a.san} was played instead, so the ${a.frontPiece} stays free to move.`,
  (a) => `Instead, the ${a.frontPiece} keeps its full mobility after ${a.san}.`,
  (a) => `${a.san} misses this — the ${a.frontPiece} isn't pinned down.`,
  (a) => `${a.san} was chosen instead, and no pin follows.`,
  (a) => `The ${a.frontPiece} stays loose after ${a.san}.`,
  (a) => `With ${a.san}, that pin never happens.`,
  (a) => `${a.san} lets the ${a.frontPiece} move freely.`,
  (a) => `That pin disappears once ${a.san} is played.`,
  (a) => `Instead of the pin, ${a.san} was chosen.`,
  (a) => `${a.san} sidesteps the pin entirely.`,
  (a) => `The ${a.frontPiece} keeps all its options after ${a.san}.`,
  (a) => `${a.san} doesn't create that same pressure.`,
];

// ---------------------------------------------------------------------
// Missed skewer — compositional.
// ---------------------------------------------------------------------
export const skewerOpeners: readonly ((a: { bestSan: string; frontPiece: string; behindPiece: string }) => string)[] = [
  (a) => `${a.bestSan} skewers the ${a.frontPiece}.`,
  (a) => `${a.bestSan} lines up the ${a.frontPiece} and the ${a.behindPiece}.`,
  (a) => `The ${a.frontPiece} is skewered by ${a.bestSan}.`,
  (a) => `${a.bestSan} sets up a skewer on the ${a.frontPiece}.`,
  (a) => `${a.bestSan} attacks the ${a.frontPiece}, with the ${a.behindPiece} lined up behind it.`,
  (a) => `There's a skewer here: ${a.bestSan} hits the ${a.frontPiece} first.`,
  (a) => `${a.bestSan} forces the ${a.frontPiece} to choose — move, or lose the ${a.behindPiece}.`,
  (a) => `${a.bestSan} threatens the ${a.frontPiece} and whatever's behind it.`,
];
export const skewerConsequences: readonly ((behindPiece: string) => string)[] = [
  (b) => `When it moves, the ${b} behind it falls too.`,
  (b) => `The ${b} behind it can't escape either.`,
  (b) => `Moving the front piece exposes the ${b}.`,
  (b) => `Either way, the ${b} behind it was going to fall.`,
  () => "There's no saving both pieces on that line.",
  (b) => `The ${b} was the real prize.`,
];
export const skewerDetails: readonly ((san: string) => string)[] = [
  (san) => `${san} was played instead, leaving both pieces safe.`,
  (san) => `Instead, both pieces stay out of danger after ${san}.`,
  (san) => `${san} misses the skewer.`,
  (san) => `With ${san}, that skewer never happens.`,
  (san) => `Both pieces survive after ${san}.`,
  (san) => `${san} sidesteps the skewer entirely.`,
  (san) => `That skewer disappears once ${san} is played.`,
  (san) => `Instead of the skewer, ${san} was chosen.`,
  (san) => `${san} keeps things quieter — no skewer follows.`,
  (san) => `${san} lets both pieces stay connected safely.`,
];

// ---------------------------------------------------------------------
// Discovered attack — compositional.
// ---------------------------------------------------------------------
export const discoveredOpeners: readonly ((san: string) => string)[] = [
  (san) => `${san} opens a line.`,
  (san) => `${san} uncovers a hidden attack.`,
  (san) => `Moving that piece with ${san} exposes a new threat.`,
  (san) => `${san} clears the way for an attack.`,
  (san) => `${san} reveals an attacker that was blocked before.`,
  (san) => `${san} opens up a discovered attack.`,
  (san) => `That move, ${san}, unmasks a threat.`,
  (san) => `${san} lets a piece behind it join the attack.`,
];
export interface DiscoveredConsequenceArgs {
  attackerName: string;
  attackerSquare: string;
  targetPiece: string;
  targetSquare: string;
}
export const discoveredConsequences: readonly ((a: DiscoveredConsequenceArgs) => string)[] = [
  (a) => `The opponent's ${a.attackerName} on ${a.attackerSquare} now attacks your ${a.targetPiece} on ${a.targetSquare}.`,
  (a) => `Your ${a.targetPiece} on ${a.targetSquare} is suddenly exposed to the ${a.attackerName} on ${a.attackerSquare}.`,
  (a) => `The ${a.attackerName} on ${a.attackerSquare} has a clear line to your ${a.targetPiece} on ${a.targetSquare} now.`,
  (a) => `Your ${a.targetPiece} on ${a.targetSquare} is now in the ${a.attackerName}'s sights, from ${a.attackerSquare}.`,
  (a) => `The ${a.attackerName} on ${a.attackerSquare} targets your ${a.targetPiece} on ${a.targetSquare} directly.`,
  (a) => `That ${a.attackerName} on ${a.attackerSquare} wasn't a threat before — now it hits your ${a.targetPiece} on ${a.targetSquare}.`,
  (a) => `Your ${a.targetPiece} on ${a.targetSquare} is caught in the open by the ${a.attackerName} on ${a.attackerSquare}.`,
  (a) => `The ${a.attackerName} on ${a.attackerSquare} joins the attack against your ${a.targetPiece} on ${a.targetSquare}.`,
];
export const discoveredDetails: readonly string[] = [
  "That attack wasn't there before this move.",
  'A moment ago, that piece was safe.',
  'The threat only appeared after this move.',
  'Nothing was attacking that piece before.',
  "That danger is brand new.",
  'A second ago, there was no threat there.',
  'This attack only just opened up.',
  'That piece was completely safe one move ago.',
  'The line was blocked until this move.',
  'This is a fresh threat, not one that was already there.',
];

// ---------------------------------------------------------------------
// Back rank — compositional.
// ---------------------------------------------------------------------
export const backRankOpeners: readonly ((kingSquare: string) => string)[] = [
  (k) => `Your king on ${k} is boxed in along the back rank.`,
  (k) => `The king on ${k} has no escape squares on the back rank.`,
  (k) => `Your king on ${k} is stuck on the back rank.`,
  (k) => `That king on ${k} can't step off the back rank.`,
  (k) => `Your king on ${k} is trapped along the edge of the board.`,
  (k) => `The king on ${k} has nowhere to run on the back rank.`,
];
export const backRankConsequences: readonly string[] = [
  'A rook or queen check could be fatal.',
  'A single check on that rank could be mate.',
  "That's exactly the setup a back-rank mate needs.",
  'One well-placed check there could end the game.',
  'A rook sliding onto that rank would be deadly.',
  "That's a classic mating pattern waiting to happen.",
];
export const backRankDetails: readonly ((san: string) => string)[] = [
  (san) => `${san} made this weakness worse.`,
  (san) => `${san} tightened the trap around your king.`,
  () => "That's exactly the kind of position back-rank mates come from.",
  (san) => `${san} left the king even more exposed.`,
  () => 'The back rank got weaker after that move.',
  (san) => `${san} didn't address this weakness at all.`,
  () => 'That vulnerability is still there.',
  (san) => `${san} left the king's escape squares just as blocked.`,
];

// ---------------------------------------------------------------------
// Positive: brilliant / great / book / best / solid
// ---------------------------------------------------------------------
export const brilliantSummaries: readonly ((san: string) => string)[] = [
  (san) => `${san} is a sound sacrifice that's hard to find.`,
  (san) => `${san} gives up material — and it's completely sound.`,
  (san) => `That's a brilliant idea: ${san} sacrifices material for a real edge.`,
  (san) => `${san} looks risky, but it's backed up perfectly.`,
  (san) => `${san} trades material for a winning attack.`,
  (san) => `That's a genuinely hard sacrifice to spot: ${san}.`,
  (san) => `${san} gives up material — and it works.`,
  (san) => `Few players find ${san} — a real sacrifice with real backing.`,
  (san) => `${san} is a calculated risk that pays off.`,
  (san) => `That's brilliant: ${san} sacrifices for a bigger idea.`,
];
export const brilliantDetails: readonly string[] = [
  'Giving up material here actually strengthens your position — sharp thinking.',
  'The sacrifice pays off; your position is stronger for it.',
  "Most players wouldn't find this — well spotted.",
  "That's the kind of move engines love and humans miss.",
  'The material comes back with interest.',
  "That's a genuinely creative idea.",
  'Hard to calculate, and you got it right.',
  'That sacrifice was worth every bit of material given up.',
];

export const greatSummaries: readonly ((san: string) => string)[] = [
  (san) => `${san} was the only move that kept the position together.`,
  (san) => `${san} was the one move that held everything together here.`,
  (san) => `Nothing else worked — ${san} was forced, and you found it.`,
  (san) => `${san} was the single best option in a tough spot.`,
  (san) => `Every other try here falls apart — ${san} doesn't.`,
  (san) => `${san} was the only real move on the board.`,
  (san) => `The position demanded ${san}, and nothing else.`,
  (san) => `${san} was forced — and it was the right call.`,
];
export const greatDetails: readonly string[] = [
  'Every other reasonable try here gives up real ground.',
  'Any other move here loses significant ground.',
  'The position demanded precision, and this was it.',
  "There wasn't a second-best option here.",
  'Everything else falls apart under pressure.',
  "That's the kind of move that's easy to miss under pressure.",
  'Nothing else holds the position together.',
  "This was the position's only real answer.",
];

export const bookSummaries: readonly ((san: string) => string)[] = [
  (san) => `${san} follows known opening theory.`,
  (san) => `${san} is a well-established opening move here.`,
  (san) => `That's standard theory — ${san} is a known continuation.`,
  (san) => `${san} is straight out of the opening books.`,
  (san) => `That's a well-trodden path — ${san}.`,
  (san) => `${san} sticks to known theory here.`,
  (san) => `Nothing surprising — ${san} is textbook opening play.`,
  (san) => `${san} follows a well-known line.`,
];
export const bookDetails: readonly string[] = [
  'A well-known continuation at this stage of the game.',
  'Common at this point in the opening.',
  'Solid, well-tested theory.',
  'A reliable choice at this stage.',
  'Plenty of strong players have played this exact line.',
  'Nothing risky here — just sound theory.',
  'A dependable way to start the game.',
  'Well-tested, and for good reason.',
];

export const bestSummaries: readonly ((san: string) => string)[] = [
  (san) => `${san} is exactly what a strong engine would play here.`,
  (san) => `${san} is the top choice in this position.`,
  (san) => `There's nothing stronger than ${san} here.`,
  (san) => `${san} is precisely the engine's first choice.`,
  (san) => `${san} is the sharpest move available.`,
  (san) => `${san} is the strongest possible choice here.`,
  (san) => `Nothing beats ${san} in this position.`,
  (san) => `${san} is the engine's number-one pick.`,
];
export const bestDetails: readonly string[] = [
  'Precise and to the point.',
  'Clean, accurate play.',
  'No better option was available.',
  "That's about as accurate as it gets.",
  'Exactly the right idea at the right time.',
  'Nothing to improve on here.',
  'Textbook precision.',
  "That's engine-level accuracy.",
];

export const solidSummaries: readonly ((san: string) => string)[] = [
  (san) => `${san} keeps your position balanced and active.`,
  (san) => `${san} holds the position together nicely.`,
  (san) => `That's a solid choice — ${san} keeps things steady.`,
  (san) => `${san} maintains a healthy position.`,
  (san) => `${san} is a perfectly reasonable choice here.`,
  (san) => `${san} keeps everything in good shape.`,
  (san) => `That's sound play — ${san} keeps the position stable.`,
  (san) => `${san} is a safe, solid choice.`,
];
export const solidDetails: readonly ((a: { san: string; bestSan: string }) => string)[] = [
  (a) => `${a.bestSan} was the engine's top pick, but this holds up well too.`,
  (a) => `${a.bestSan} was marginally sharper, but ${a.san} is perfectly fine.`,
  (a) => `The engine slightly prefers ${a.bestSan}, though this is close behind.`,
  (a) => `${a.bestSan} was a touch more precise, but ${a.san} loses nothing real.`,
  (a) => `There's barely any difference between this and ${a.bestSan}.`,
  (a) => `${a.bestSan} edges it out slightly, but both are strong.`,
  (a) => `This is very close to ${a.bestSan} in strength.`,
  (a) => `${a.bestSan} was marginally better, but this is a fine choice too.`,
];

// ---------------------------------------------------------------------
// Generic positional loss (the fallback when no specific tactic/motif
// matched). severityWord() in explanations.ts already contributes one
// axis of variation (mistake/blunder/miss/slip); these pools add a
// second, independent axis on top of it.
// ---------------------------------------------------------------------
export const fallbackSummaries: readonly ((a: { san: string; severity: string }) => string)[] = [
  (a) => `${a.san} isn't a tactical blunder — just ${a.severity} that loosens your position.`,
  (a) => `${a.san} is ${a.severity}, without any single tactic behind it.`,
  (a) => `There's no tactic here — just ${a.severity} that costs some ground.`,
  (a) => `${a.san} gives up a bit of ground; ${a.severity}, but no outright tactic.`,
  (a) => `That's ${a.severity} — a gradual slip, not a tactical mistake.`,
  (a) => `${a.san} loosens things up a little — ${a.severity}, nothing tactical.`,
  (a) => `${a.san} is ${a.severity}, nothing more dramatic than that.`,
  (a) => `No tactic there — ${a.san} is just ${a.severity}.`,
  (a) => `${a.san} drifts a little; call it ${a.severity}.`,
  (a) => `That's ${a.severity}, not a hard blunder — just a small loss of precision.`,
  (a) => `${a.san} isn't sharp — ${a.severity}, plain and simple.`,
  (a) => `${a.san} lets a little slip through — ${a.severity}.`,
  (a) => `Nothing tactical there, just ${a.severity} from ${a.san}.`,
  (a) => `${a.san} is ${a.severity} rather than anything forced.`,
  (a) => `That's ${a.severity} — the position loosens slightly.`,
];
export const fallbackDetails: readonly ((a: { bestSan: string; lossText: string }) => string)[] = [
  (a) => `${a.bestSan} would have kept things a bit more precise. (~${a.lossText} pawns)`,
  (a) => `${a.bestSan} was tighter here. (~${a.lossText} pawns)`,
  (a) => `${a.bestSan} kept a firmer grip on the position. (~${a.lossText} pawns)`,
  (a) => `${a.bestSan} held the position more accurately. (~${a.lossText} pawns)`,
  (a) => `${a.bestSan} was the more exact choice. (~${a.lossText} pawns)`,
  (a) => `${a.bestSan} stayed a touch sharper. (~${a.lossText} pawns)`,
  (a) => `${a.bestSan} kept more control here. (~${a.lossText} pawns)`,
  (a) => `${a.bestSan} was slightly more accurate. (~${a.lossText} pawns)`,
  (a) => `${a.bestSan} preserved a bit more of the advantage. (~${a.lossText} pawns)`,
  (a) => `${a.bestSan} gave up less ground. (~${a.lossText} pawns)`,
  (a) => `${a.bestSan} was the tidier option. (~${a.lossText} pawns)`,
  (a) => `${a.bestSan} kept things a little cleaner. (~${a.lossText} pawns)`,
  (a) => `${a.bestSan} held the line more firmly. (~${a.lossText} pawns)`,
  (a) => `${a.bestSan} was marginally more precise. (~${a.lossText} pawns)`,
  (a) => `${a.bestSan} kept the position a shade tighter. (~${a.lossText} pawns)`,
];

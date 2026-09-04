import bookData from '../data/openingBook.json';

const book = bookData as Record<string, string[]>;

function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

export function isBookMove(fenBefore: string, uci: string): boolean {
  const moves = book[positionKey(fenBefore)];
  return moves ? moves.includes(uci) : false;
}

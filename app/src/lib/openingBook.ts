import bookData from '../data/openingBook.json';

// Mined from Chesy's own game corpus (tools/dataset/build_opening_book.py),
// not a licensed theory database — an explicit Chesy approximation of
// "Book" per ml/specs/review_contract.md section 9.
const book = bookData as Record<string, string[]>;

function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

export function isBookMove(fenBefore: string, uci: string): boolean {
  const moves = book[positionKey(fenBefore)];
  return moves ? moves.includes(uci) : false;
}

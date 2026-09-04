import { describe, expect, test } from 'vitest';
import { fromLichessStatus, outcomeFor, terminationFrom } from './termination';

describe('terminationFrom', () => {
  test.each([
    ['Hikaru won by resignation', 'resignation'],
    ['Hikaru won by checkmate', 'checkmate'],
    ['Game drawn by repetition', 'repetition'],
    ['Game drawn by insufficient material', 'insufficient'],
    ['Hikaru won on time', 'timeout'],
    ['Game drawn by agreement', 'agreement'],
  ] as const)('reads Chess.com %s', (header, expected) => {
    expect(terminationFrom({ Termination: header })).toBe(expected);
  });

  test('reads a Lichess time forfeit from the header alone', () => {
    expect(terminationFrom({ Termination: 'Time forfeit' })).toBe('timeout');
  });

  test('prefers the status when the header only says Normal', () => {
    expect(terminationFrom({ Termination: 'Normal' }, 'resign')).toBe('resignation');
    expect(terminationFrom({ Termination: 'Normal' }, 'mate')).toBe('checkmate');
  });

  test('falls back to Normal when there is no status to consult', () => {
    expect(terminationFrom({ Termination: 'Normal' })).toBe('normal');
  });

  test('does not let a vague status override an explicit header', () => {
    expect(terminationFrom({ Termination: 'Time forfeit' }, 'resign')).toBe('timeout');
  });

  test('reports unknown rather than guessing', () => {
    expect(terminationFrom({})).toBe('unknown');
  });
});

describe('fromLichessStatus', () => {
  test.each([
    ['mate', 'checkmate'],
    ['resign', 'resignation'],
    ['outoftime', 'timeout'],
    ['stalemate', 'stalemate'],
  ] as const)('maps %s', (status, expected) => {
    expect(fromLichessStatus(status)).toBe(expected);
  });

  test('returns null for anything unrecognised, so callers can fall back', () => {
    expect(fromLichessStatus('something-new')).toBeNull();
    expect(fromLichessStatus(undefined)).toBeNull();
  });
});

describe('outcomeFor', () => {
  test('reads the result from the given side', () => {
    expect(outcomeFor('1-0', true)).toBe('win');
    expect(outcomeFor('1-0', false)).toBe('loss');
    expect(outcomeFor('0-1', true)).toBe('loss');
    expect(outcomeFor('0-1', false)).toBe('win');
    expect(outcomeFor('1/2-1/2', true)).toBe('draw');
  });

  test('returns null for an unfinished game', () => {
    expect(outcomeFor('*', true)).toBeNull();
  });
});

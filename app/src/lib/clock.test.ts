import { describe, expect, test } from 'vitest';
import { parseClock, parseTimeControl, timeInsights, timeSpentPerMove } from './clock';
import { parsePgn } from './parsePgn';

describe('parseClock', () => {
  test('reads H:MM:SS and tenths', () => {
    expect(parseClock('0:03:00')).toBe(180);
    expect(parseClock('0:02:57.5')).toBe(177.5);
    expect(parseClock('1:00:00')).toBe(3600);
  });

  test('returns null for anything unrecognised', () => {
    expect(parseClock('')).toBeNull();
    expect(parseClock('soon')).toBeNull();
  });
});

describe('parseTimeControl', () => {
  test('reads base and increment', () => {
    expect(parseTimeControl('180+2')).toEqual({ base: 180, increment: 2 });
    expect(parseTimeControl('600')).toEqual({ base: 600, increment: 0 });
  });

  test('treats untimed games as having no base', () => {
    expect(parseTimeControl('-')).toEqual({ base: null, increment: 0 });
    expect(parseTimeControl(undefined)).toEqual({ base: null, increment: 0 });
  });
});

describe('timeSpentPerMove', () => {
  const game = parsePgn('1. e4 e5 2. Nf3 Nc6 *');

  test('measures each colour against its own previous reading', () => {
    const clocks = [175, 178, 170, 168];
    expect(timeSpentPerMove(game, clocks, 0, 180)).toEqual([5, 2, 5, 10]);
  });

  test('adds the increment back so fast moves are not negative', () => {
    const clocks = [181, 181, 182, 182];
    expect(timeSpentPerMove(game, clocks, 2, 180)).toEqual([1, 1, 1, 1]);
  });

  test('reports nothing rather than nonsense when time was added', () => {
    const clocks = [175, 178, 900, 168];
    const spent = timeSpentPerMove(game, clocks, 0, 180);
    expect(spent[2]).toBeNull();
  });

  test('has no baseline for the first move when the time control is unknown', () => {
    const spent = timeSpentPerMove(game, [175, 178, 170, 168], 0, null);
    expect(spent[0]).toBeNull();
    expect(spent[1]).toBeNull();
    expect(spent[2]).toBe(5);
    expect(spent[3]).toBe(10);
  });

  test('skips plies with no clock at all', () => {
    const spent = timeSpentPerMove(game, [175, null, 170, 168], 0, 180);
    expect(spent[1]).toBeNull();
  });
});

describe('timeInsights', () => {
  const colors: ('w' | 'b')[] = ['w', 'b', 'w', 'b', 'w', 'b'];

  test('summarises only the requested side', () => {
    const spent = [10, 99, 2, 1, 30, 1];
    const classes = ['good', 'good', 'blunder', 'good', 'good', 'good'];
    const ins = timeInsights(spent, classes, colors, 'w')!;
    expect(ins.medianSeconds).toBe(10);
    expect(ins.longestSeconds).toBe(30);
    expect(ins.longestIndex).toBe(4);
  });

  test('links rushed moves to the mistakes made on them', () => {
    const spent = [1, 20, 2, 20, 3, 20];
    const classes = ['blunder', 'good', 'good', 'good', 'mistake', 'good'];
    const ins = timeInsights(spent, classes, colors, 'w')!;
    expect(ins.rushedCount).toBe(3);
    expect(ins.rushedMistakes).toBe(2);
    expect(ins.totalMistakes).toBe(2);
  });

  test('uses a median so one long think does not distort the centre', () => {
    const spent = [5, null, 5, null, 300, null];
    const classes = ['good', 'good', 'good', 'good', 'good', 'good'];
    const ins = timeInsights(spent, classes, colors, 'w')!;
    expect(ins.medianSeconds).toBe(5);
  });

  test('returns null when the side has no usable times', () => {
    expect(timeInsights([null, null], ['good', 'good'], ['w', 'b'], 'w')).toBeNull();
  });
});

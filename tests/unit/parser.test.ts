import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { throwsWith } from '../helpers.ts';
import { parseLineSpec, parseLineSpecs } from '../../src/parser.ts';

describe('parseLineSpec', () => {
  it('parses single line number', () => {
    const result = parseLineSpec('10');
    assert.deepEqual(result, { start: 10, end: 10 });
  });

  it('parses line range', () => {
    const result = parseLineSpec('10-20');
    assert.deepEqual(result, { start: 10, end: 20 });
  });

  it('parses single digit', () => {
    const result = parseLineSpec('1');
    assert.deepEqual(result, { start: 1, end: 1 });
  });

  it('trims whitespace', () => {
    const result = parseLineSpec('  10  ');
    assert.deepEqual(result, { start: 10, end: 10 });
  });

  it('throws on empty string', () => {
    throwsWith(() => parseLineSpec(''), 'Line spec cannot be empty');
  });

  it('throws on invalid format', () => {
    throwsWith(() => parseLineSpec('abc'), 'Invalid line spec');
  });

  it('throws on negative numbers', () => {
    throwsWith(() => parseLineSpec('-1'), 'Line numbers must be positive');
  });

  it('throws on zero', () => {
    throwsWith(() => parseLineSpec('0'), 'Line numbers must be positive');
  });

  it('throws on invalid range', () => {
    throwsWith(() => parseLineSpec('20-10'), 'start (20) must be <= end (10)');
  });

  it('throws on extra characters', () => {
    throwsWith(() => parseLineSpec('10-20-30'), 'Invalid line spec');
  });
});

describe('parseLineSpecs', () => {
  it('parses comma-separated specs', () => {
    const result = parseLineSpecs('10,20-30');
    assert.deepEqual(result, [
      { start: 10, end: 10 },
      { start: 20, end: 30 },
    ]);
  });

  it('parses single spec', () => {
    const result = parseLineSpecs('15');
    assert.deepEqual(result, [{ start: 15, end: 15 }]);
  });

  it('trims whitespace around commas', () => {
    const result = parseLineSpecs('10 , 20-30 , 5');
    assert.deepEqual(result, [
      { start: 10, end: 10 },
      { start: 20, end: 30 },
      { start: 5, end: 5 },
    ]);
  });

  it('throws on empty string', () => {
    throwsWith(() => parseLineSpecs(''), 'At least one line spec is required');
  });

  it('throws if any spec is invalid', () => {
    throwsWith(() => parseLineSpecs('10,invalid'), 'Invalid line spec');
  });
});

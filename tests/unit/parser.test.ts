import { describe, it, expect } from 'bun:test';
import { parseLineSpec, parseLineSpecs } from '../../src/parser.ts';

describe('parseLineSpec', () => {
  it('parses single line number', () => {
    const result = parseLineSpec('10');
    expect(result).toEqual({ start: 10, end: 10 });
  });

  it('parses line range', () => {
    const result = parseLineSpec('10-20');
    expect(result).toEqual({ start: 10, end: 20 });
  });

  it('parses single digit', () => {
    const result = parseLineSpec('1');
    expect(result).toEqual({ start: 1, end: 1 });
  });

  it('trims whitespace', () => {
    const result = parseLineSpec('  10  ');
    expect(result).toEqual({ start: 10, end: 10 });
  });

  it('throws on empty string', () => {
    expect(() => parseLineSpec('')).toThrow('Line spec cannot be empty');
  });

  it('throws on invalid format', () => {
    expect(() => parseLineSpec('abc')).toThrow('Invalid line spec');
  });

  it('throws on negative numbers', () => {
    expect(() => parseLineSpec('-1')).toThrow('Line numbers must be positive');
  });

  it('throws on zero', () => {
    expect(() => parseLineSpec('0')).toThrow('Line numbers must be positive');
  });

  it('throws on invalid range', () => {
    expect(() => parseLineSpec('20-10')).toThrow('start (20) must be <= end (10)');
  });

  it('throws on extra characters', () => {
    expect(() => parseLineSpec('10-20-30')).toThrow('Invalid line spec');
  });
});

describe('parseLineSpecs', () => {
  it('parses comma-separated specs', () => {
    const result = parseLineSpecs('10,20-30');
    expect(result).toEqual([
      { start: 10, end: 10 },
      { start: 20, end: 30 },
    ]);
  });

  it('parses single spec', () => {
    const result = parseLineSpecs('15');
    expect(result).toEqual([{ start: 15, end: 15 }]);
  });

  it('trims whitespace around commas', () => {
    const result = parseLineSpecs('10 , 20-30 , 5');
    expect(result).toEqual([
      { start: 10, end: 10 },
      { start: 20, end: 30 },
      { start: 5, end: 5 },
    ]);
  });

  it('throws on empty string', () => {
    expect(() => parseLineSpecs('')).toThrow('At least one line spec is required');
  });

  it('throws if any spec is invalid', () => {
    expect(() => parseLineSpecs('10,invalid')).toThrow('Invalid line spec');
  });
});

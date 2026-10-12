import { describe, it, expect } from 'vitest';
import { tokenize, parseQuery, containsTerm, buildSearchText, matchListing, describeQuery, normalize } from '../src/main/query.js';

const match = (q, title, condition = '') => matchListing(parseQuery(q), { title, condition }).ok;

describe('tokenize', () => {
  it('splits plain words', () => {
    expect(tokenize('rtx 4090').map((t) => t.text)).toEqual(['rtx', '4090']);
  });

  it('keeps + and - prefixes', () => {
    const t = tokenize('+founders -broken');
    expect(t).toEqual([
      { prefix: '+', text: 'founders', kind: 'word' },
      { prefix: '-', text: 'broken', kind: 'word' },
    ]);
  });

  it('reads quoted phrases', () => {
    const t = tokenize('-"for parts" gpu');
    expect(t[0]).toEqual({ prefix: '-', text: 'for parts', kind: 'phrase' });
    expect(t[1].text).toBe('gpu');
  });

  it('reads OR groups', () => {
    expect(tokenize('+(fe,founders)')[0]).toEqual({ prefix: '+', text: 'fe,founders', kind: 'group' });
  });

  it('handles an unterminated quote without throwing', () => {
    expect(tokenize('"open ended').map((t) => t.text)).toEqual(['open ended']);
  });

  it('ignores extra whitespace and lone signs', () => {
    expect(tokenize('   a    +   -  b  ').map((t) => t.text)).toEqual(['a', 'b']);
  });
});

describe('parseQuery', () => {
  it('separates search, required and excluded terms', () => {
    const p = parseQuery('rtx 4090 +founders -broken');
    expect(p.searchTerms.map((t) => t.text)).toEqual(['rtx', '4090']);
    expect(p.required.map((g) => g.map((t) => t.text))).toEqual([['founders']]);
    expect(p.excluded.map((t) => t.text)).toEqual(['broken']);
  });

  it('lowercases everything', () => {
    expect(parseQuery('+RTX').required[0][0].text).toBe('rtx');
  });

  it('supports prefix wildcards', () => {
    const p = parseQuery('-broke*');
    expect(p.excluded[0]).toEqual({ text: 'broke', prefix: true });
  });

  it('returns empty lists for an empty query', () => {
    expect(parseQuery('')).toEqual({ searchTerms: [], required: [], excluded: [] });
  });
});

describe('containsTerm', () => {
  it('respects word boundaries', () => {
    expect(containsTerm('nice showcase item', { text: 'case', prefix: false })).toBe(false);
    expect(containsTerm('phone case blue', { text: 'case', prefix: false })).toBe(true);
  });

  it('matches numbers glued to letters (RTX4090)', () => {
    expect(containsTerm('msi rtx4090 liquid', { text: '4090', prefix: false })).toBe(true);
  });

  it('does not match a number inside a longer number', () => {
    expect(containsTerm('model 14090 card', { text: '4090', prefix: false })).toBe(false);
  });

  it('prefix terms match longer words', () => {
    expect(containsTerm('broken screen', { text: 'broke', prefix: true })).toBe(true);
  });
});

describe('matchListing', () => {
  it('requires every + term', () => {
    expect(match('rtx +4090 +founders', 'RTX 4090 Founders Edition')).toBe(true);
    expect(match('rtx +4090 +founders', 'RTX 4090 Gaming OC')).toBe(false);
  });

  it('drops listings with a - term', () => {
    expect(match('rtx 4090 -broken', 'RTX 4090 BROKEN fan')).toBe(false);
    expect(match('rtx 4090 -broken', 'RTX 4090 mint')).toBe(true);
  });

  it('excluded terms also check the condition text', () => {
    expect(match('iphone -parts', 'iPhone 15 Pro', 'For parts or not working')).toBe(false);
  });

  it('excludes multi-word phrases', () => {
    expect(match('switch -"box only"', 'Nintendo Switch BOX ONLY no console')).toBe(false);
    expect(match('switch -"box only"', 'Nintendo Switch with box')).toBe(true);
  });

  it('OR groups accept any member', () => {
    expect(match('+(fe,founders)', 'RTX 3080 FE')).toBe(true);
    expect(match('+(fe,founders)', 'RTX 3080 Founders')).toBe(true);
    expect(match('+(fe,founders)', 'RTX 3080 Gaming')).toBe(false);
  });

  it('plain words are not enforced locally (eBay already searched them)', () => {
    expect(match('rtx 4090', 'Totally unrelated title')).toBe(true);
  });

  it('is accent and case insensitive', () => {
    expect(match('+pokemon', 'POKÉMON Charizard')).toBe(true);
    expect(normalize('PokÉmon')).toBe('pokemon');
  });

  it('reports why a listing was rejected', () => {
    expect(matchListing(parseQuery('-damaged'), { title: 'damaged box' }).reason).toMatch(/damaged/);
  });
});

describe('buildSearchText', () => {
  it('sends search and + terms, and simple - terms to eBay', () => {
    expect(buildSearchText(parseQuery('rtx 4090 +fe -broken'))).toBe('rtx 4090 fe -broken');
  });

  it('quotes phrases and writes OR groups in eBay syntax', () => {
    expect(buildSearchText(parseQuery('+"game boy" +(dmg,color)'))).toBe('"game boy" (dmg,color)');
  });

  it('does not repeat a word that is both searched and required', () => {
    expect(buildSearchText(parseQuery('rtx 4090 +4090'))).toBe('rtx 4090');
  });

  it('keeps wildcard and phrase excludes local only', () => {
    expect(buildSearchText(parseQuery('lego -broke* -"no box"'))).toBe('lego');
  });
});

describe('describeQuery', () => {
  it('produces chips for the UI', () => {
    expect(describeQuery('lego +star -(used,parts) -mini*')).toEqual({
      search: ['lego'],
      required: ['star'],
      excluded: ['used', 'parts', 'mini*'],
    });
  });
});

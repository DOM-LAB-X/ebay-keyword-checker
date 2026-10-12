'use strict';

/**
 * Search query syntax
 *
 *   rtx 4090 +founders -broken -"for parts" +(fe,founders) -box*
 *
 *   word / "phrase"   sent to eBay as the search text (eBay matches loosely)
 *   +word             title MUST contain it
 *   +(a,b,c)          title must contain at least one of a, b, c
 *   -word             listing is dropped if title or condition contains it
 *   word*             prefix match (e.g. -broke* hits broken, broke)
 *
 * Matching is case-insensitive and boundary aware, so -case will not hide
 * "showcase", while +4090 still matches "RTX4090".
 */

function tokenize(input) {
  const tokens = [];
  const s = String(input || '');
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;

    let prefix = '';
    if (s[i] === '+' || s[i] === '-') {
      prefix = s[i];
      i++;
    }

    let text = '';
    let kind = 'word';
    if (s[i] === '"') {
      const end = s.indexOf('"', i + 1);
      text = end === -1 ? s.slice(i + 1) : s.slice(i + 1, end);
      i = end === -1 ? s.length : end + 1;
      kind = 'phrase';
    } else if (s[i] === '(') {
      const end = s.indexOf(')', i + 1);
      text = end === -1 ? s.slice(i + 1) : s.slice(i + 1, end);
      i = end === -1 ? s.length : end + 1;
      kind = 'group';
    } else {
      const start = i;
      while (i < s.length && !/\s/.test(s[i])) i++;
      text = s.slice(start, i);
    }

    text = text.trim();
    if (text) tokens.push({ prefix, text, kind });
    else if (prefix && !text) {
      // a lone "+" or "-" is ignored
    }
  }
  return tokens;
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function makeTerm(raw) {
  let text = normalize(raw);
  let prefixMatch = false;
  if (text.endsWith('*')) {
    prefixMatch = true;
    text = text.replace(/\*+$/, '');
  }
  return text ? { text, prefix: prefixMatch } : null;
}

function parseQuery(input) {
  const searchTerms = [];
  const required = []; // array of arrays (OR groups)
  const excluded = [];

  for (const tok of tokenize(input)) {
    const parts =
      tok.kind === 'group'
        ? tok.text.split(/[,|]/).map((p) => p.trim()).filter(Boolean)
        : [tok.text];
    const terms = parts.map(makeTerm).filter(Boolean);
    if (!terms.length) continue;

    if (tok.prefix === '-') {
      excluded.push(...terms);
    } else if (tok.prefix === '+') {
      required.push(terms);
    } else {
      // plain words only steer eBay's search; they are not enforced locally
      searchTerms.push(...terms);
    }
  }

  return { searchTerms, required, excluded };
}

function charClass(ch) {
  if (!ch) return 'none';
  if (/[a-z]/.test(ch)) return 'alpha';
  if (/[0-9]/.test(ch)) return 'digit';
  return 'other';
}

/** True when `term` occurs in normalized `haystack` on a sensible boundary. */
function containsTerm(haystack, term) {
  const hay = haystack;
  const needle = term.text;
  if (!needle) return false;
  const first = charClass(needle[0]);
  const last = charClass(needle[needle.length - 1]);
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) return false;
    const before = charClass(hay[idx - 1]);
    const after = charClass(hay[idx + needle.length]);
    const okBefore = first === 'other' || before !== first;
    const okAfter = term.prefix || last === 'other' || after !== last;
    if (okBefore && okAfter) return true;
    from = idx + 1;
  }
}

/** Builds the text eBay receives in `_nkw`. Excludes are sent too, to shrink results. */
function buildSearchText(parsed) {
  const quote = (t) => (t.text.includes(' ') ? `"${t.text}"` : t.text);
  const parts = [];
  for (const t of parsed.searchTerms) parts.push(quote(t));
  for (const group of parsed.required) {
    if (group.length === 1) parts.push(quote(group[0]));
    else parts.push(`(${group.map((t) => t.text).join(',')})`);
  }
  for (const t of parsed.excluded) {
    if (!t.prefix && !t.text.includes(' ')) parts.push(`-${t.text}`);
  }
  return [...new Set(parts)].join(' ').trim();
}

/**
 * Returns { ok: true } or { ok: false, reason } for a listing.
 * listing: { title, condition, subtitles?: string[] }
 */
function matchListing(parsed, listing) {
  const title = normalize(listing.title);
  const extra = normalize([listing.condition, ...(listing.subtitles || [])].join(' '));
  const full = `${title} ${extra}`;

  for (const term of parsed.excluded) {
    if (containsTerm(full, term)) return { ok: false, reason: `excluded "${term.text}"` };
  }
  for (const group of parsed.required) {
    if (!group.some((term) => containsTerm(title, term))) {
      return { ok: false, reason: `missing "${group.map((t) => t.text).join(' | ')}"` };
    }
  }
  return { ok: true };
}

function describeQuery(input) {
  const p = parseQuery(input);
  return {
    search: p.searchTerms.map((t) => t.text),
    required: p.required.map((g) => g.map((t) => t.text + (t.prefix ? '*' : '')).join(' | ')),
    excluded: p.excluded.map((t) => t.text + (t.prefix ? '*' : '')),
  };
}

const queryApi = {
  tokenize,
  normalize,
  parseQuery,
  containsTerm,
  buildSearchText,
  matchListing,
  describeQuery,
};

// Shared with the renderer (loaded as a plain <script>) for live previews.
if (typeof module !== 'undefined' && module.exports) module.exports = queryApi;
else globalThis.Query = queryApi;

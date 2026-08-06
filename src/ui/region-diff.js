// ===========================================================================
// WORD-LEVEL REGION DIFF
// ===========================================================================
// A selection revision replaces whole Markdown blocks, but the change the
// reader asked for is usually a phrase inside one. Showing the whole block as
// removed and re-added would bury that phrase in unchanged text, so the
// preview marks only the words that actually moved.
//
// Character offsets in, character offsets out: the caller turns them into
// ranges over the rendered text of each side, which is the same coordinate
// system inline marks already use.

var TOKEN = /\s+|[^\s]+/g;
// Longest-common-subsequence cost is the product of the token counts. A
// paragraph is a few dozen tokens; this ceiling only trips on a region that is
// really a whole document, where per-word marks would be noise anyway.
var MAX_TOKENS = 1200;

function tokenize(text) {
  var tokens = [];
  var match;
  TOKEN.lastIndex = 0;
  while ((match = TOKEN.exec(text)) !== null) {
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
    if (tokens.length > MAX_TOKENS) return null;
  }
  return tokens;
}

// Merge adjacent/abutting spans so a run of changed words becomes one mark
// rather than one mark per word with the spaces between them unmarked.
function coalesce(spans) {
  if (!spans.length) return spans;
  spans.sort(function(a, b){ return a[0] - b[0]; });
  var merged = [spans[0]];
  for (var i = 1; i < spans.length; i++) {
    var last = merged[merged.length - 1];
    if (spans[i][0] <= last[1]) last[1] = Math.max(last[1], spans[i][1]);
    else merged.push(spans[i]);
  }
  return merged;
}

/**
 * Which character ranges of each side are unique to it.
 *
 * Returns null when either side is too large to diff, which callers should
 * treat as "show both sides unmarked" rather than as an error.
 *
 * @param {string} previous
 * @param {string} next
 * @returns {{ removed: number[][], added: number[][] } | null}
 */
export function diffWordRanges(previous, next) {
  var before = tokenize(String(previous || ""));
  var after = tokenize(String(next || ""));
  if (!before || !after) return null;

  var n = before.length;
  var m = after.length;
  var lcs = [];
  for (var i = 0; i <= n; i++) lcs.push(new Uint32Array(m + 1));
  for (var a = n - 1; a >= 0; a--) {
    for (var b = m - 1; b >= 0; b--) {
      lcs[a][b] = before[a].text === after[b].text
        ? lcs[a + 1][b + 1] + 1
        : Math.max(lcs[a + 1][b], lcs[a][b + 1]);
    }
  }

  var removed = [];
  var added = [];
  var x = 0;
  var y = 0;
  while (x < n && y < m) {
    if (before[x].text === after[y].text) { x++; y++; continue; }
    if (lcs[x + 1][y] >= lcs[x][y + 1]) { removed.push([before[x].start, before[x].end]); x++; }
    else { added.push([after[y].start, after[y].end]); y++; }
  }
  while (x < n) { removed.push([before[x].start, before[x].end]); x++; }
  while (y < m) { added.push([after[y].start, after[y].end]); y++; }

  // Whitespace-only differences are formatting, not content: marking them
  // paints stray gaps between words that otherwise read as identical.
  return {
    removed: coalesce(removed.filter(function(span){ return previous.slice(span[0], span[1]).trim(); })),
    added: coalesce(added.filter(function(span){ return next.slice(span[0], span[1]).trim(); })),
  };
}

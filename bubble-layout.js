// The speech bubble's text and shape, in art pixels (1x; the window scales them by the
// pet's size). Used by main.js and bubble-window.js, and by mcp/terra-mcp.js to tell
// Claude what Terra will show. The art and font are in Bot/bubble/, copied from
// design/terra-bubble-assets/, whose examples-1x the bubble matches pixel for pixel.
//
// The text is never logged or written anywhere, like prompt text.
const FONT = require('./Bot/bubble/font-5x7.json');

const MAX_INPUT = 500;   // characters looked at; only about 40 can show anyway
const MAX_LINES = 2;
const LINE_CHARS = 20;   // "about 20 characters" a line
const ELLIPSIS = '...';
const TEXT_X = 6;        // first glyph column: the outline, then 5 px of padding
const TEXT_Y = 4;        // first glyph row: the outline, then 3 px of padding
const PAD_RIGHT = 6;     // after the last glyph: 5 px of padding, then the outline
const PAD_BOTTOM = 5;    // under the last line: fill, the rounded corner row, shade, outline
const MIN_WIDTH = 16;    // room for the tail and the pop-in frame
const TAIL_HEIGHT = 4;   // the tail hangs this far below the body
const TIMING = { popMs: 80, holdMs: 4000, perCharMs: 50, maxHoldMs: 10000, fadeMs: 200 };

// Which way the tail points names the two placements, as the art files do: 'right' (the
// usual one: the bubble is above-left of the pet, its tail on the right) or 'left'
// (flipped: the bubble is to the right). The bubble's top-left in art pixels from the pet
// window's top-left (the pet's 48x52 cell is at 8,28 in it): either way the tail's tip
// touches the top of the head (cell row 9), at cell column 17 for 'right' and 34 for
// 'left', as in design/terra-bubble-assets/terra-bubble-reference.png.
const ANCHOR = { right: (width) => 32 - width, left: () => 36, top: (height) => 34 - height };

// How long a bubble of `chars` characters is held, between its pop-in and its fade.
const holdFor = (chars) => Math.min(TIMING.holdMs + TIMING.perCharMs * chars, TIMING.maxHoldMs);

// Plain text the font can draw: line breaks and other spaces become one space, control
// and format characters (zero-width, direction overrides) go, letters are made capital,
// accents come off (É is E plus an accent the font doesn't have), and anything else the
// font doesn't have is skipped.
function cleanText(raw) {
  if (typeof raw !== 'string') return '';
  return raw.slice(0, MAX_INPUT)
    .normalize('NFD')
    .replace(/\s/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .toUpperCase()
    .split('')
    .filter((ch) => ch === ' ' || Object.hasOwn(FONT.glyphs, ch))
    .join('')
    .replace(/ +/g, ' ')
    .trim();
}

// The first sentence of a reply from Claude (the Claude Code Stop hook's
// last_assistant_message), for the bubble: code blocks, headings and table rows are
// skipped, inline code and links keep only their words, markdown marks go, and it ends at
// the first . ! or ? that ends a sentence, or at the end of the first line with words on
// it. The bubble then trims it to 2 lines.
function firstSentence(reply) {
  if (typeof reply !== 'string') return '';
  const text = reply
    .replace(/(^|\n)[ \t]*(```|~~~)[\s\S]*?(\n[ \t]*\2[^\n]*(?=\n|$)|$)/g, '$1') // fenced blocks, closed or not
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // [words](link) -> words
    .replace(/`([^`\n]*)`/g, '$1');
  for (const raw of text.split('\n')) {
    if (/^\s*(#|\|)/.test(raw)) continue;
    const line = raw.replace(/^\s*(>|[-*+]|\d+[.)])\s+/, '').replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1').trim();
    if (!/[\p{L}\p{N}]/u.test(line)) continue;
    const end = line.search(/[.!?](\s|$)/);
    return end >= 0 ? line.slice(0, end + 1) : line;
  }
  return '';
}

// Word wrap into lines of LINE_CHARS characters at most (a longer word is cut). Text that
// needs more than MAX_LINES lines ends the last one with "...".
function wrapLines(clean) {
  const lines = [];
  let line = '';
  for (let word of clean.split(' ').filter(Boolean)) {
    while (word.length > LINE_CHARS) {
      if (line) lines.push(line);
      line = '';
      lines.push(word.slice(0, LINE_CHARS));
      word = word.slice(LINE_CHARS);
    }
    if (!word) continue;
    if (!line) line = word;
    else if (line.length + 1 + word.length <= LINE_CHARS) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= MAX_LINES) return { lines, trimmed: false };

  let last = lines[MAX_LINES - 1];
  while (last.length + ELLIPSIS.length > LINE_CHARS) {
    const space = last.lastIndexOf(' ');
    last = space > 0 ? last.slice(0, space) : last.slice(0, LINE_CHARS - ELLIPSIS.length);
  }
  return { lines: [...lines.slice(0, MAX_LINES - 1), `${last.trimEnd()}${ELLIPSIS}`], trimmed: true };
}

// Everything the bubble window needs to draw `text`, or null when nothing in it can be drawn:
// lines, the body's size (width x height; the tail adds TAIL_HEIGHT below), each glyph's
// place on the font sheet and in the body, and how long to hold it.
function layoutBubble(text) {
  const { lines, trimmed } = wrapLines(cleanText(text));
  if (!lines.length) return null;
  const glyphs = [];
  let textWidth = 0;
  lines.forEach((line, row) => {
    let x = 0;
    for (const ch of line) {
      if (ch === ' ') {
        x += FONT.spaceWidth + FONT.letterGap;
        continue;
      }
      const g = FONT.glyphs[ch];
      glyphs.push({ sx: g.x, sy: g.y, w: g.w, h: g.h, x: TEXT_X + x, y: TEXT_Y + row * FONT.lineHeight });
      x += g.w + FONT.letterGap;
    }
    textWidth = Math.max(textWidth, x - FONT.letterGap);
  });
  const width = Math.max(MIN_WIDTH, TEXT_X + textWidth + PAD_RIGHT);
  const height = TEXT_Y + (lines.length - 1) * FONT.lineHeight + FONT.glyphHeight + PAD_BOTTOM;
  const holdMs = holdFor(lines.reduce((n, l) => n + l.length, 0));
  return { lines, trimmed, width, height, glyphs, holdMs };
}

// Where tail-<tail>.png (7x8) and pop-in-<tail>.png (16x14) go in the bubble's image
// (width x height + TAIL_HEIGHT): the tail's shade row on the body's shade row, and the
// pop-in frame's tip on the full bubble's tip.
function parts(layout, tail) {
  const { width, height } = layout;
  return tail === 'right'
    ? { tail: { x: width - 11, y: height - 4 }, pop: { x: width - 16, y: height + TAIL_HEIGHT - 14 } }
    : { tail: { x: 5, y: height - 4 }, pop: { x: 0, y: height + TAIL_HEIGHT - 14 } };
}

// The bubble window's bounds (points) beside a pet window at `petBounds` and size `scale`:
// above-left of the head, or flipped to the right when that would leave the work area
// on the left. If neither side fits, the one with more of the bubble on screen.
function placeBubble(layout, petBounds, scale, workArea) {
  const width = Math.round(layout.width * scale);
  const height = Math.round((layout.height + TAIL_HEIGHT) * scale);
  const y = Math.round(petBounds.y + ANCHOR.top(layout.height) * scale);
  const at = (tail) => Math.round(petBounds.x + ANCHOR[tail](layout.width) * scale);
  const onScreen = (x) => Math.min(x + width, workArea.x + workArea.width) - Math.max(x, workArea.x);
  let tail = 'right';
  if (at('right') < workArea.x && (at('left') + width <= workArea.x + workArea.width || onScreen(at('left')) > onScreen(at('right')))) tail = 'left';
  return { tail, bounds: { x: at(tail), y, width, height } };
}

module.exports = {
  FONT, MAX_INPUT, MAX_LINES, LINE_CHARS, TAIL_HEIGHT, TIMING, holdFor, cleanText, firstSentence, wrapLines, layoutBubble, parts, placeBubble,
};

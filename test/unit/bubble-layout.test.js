// bubble-layout.js: cleaning the text, wrapping and trimming it, the bubble's size and
// glyphs (against design/terra-bubble-assets/examples-1x), timing, and where the bubble
// goes beside the pet, flipping at the screen edges.
const path = require('node:path');
const { ROOT, check, section, summary } = require('../lib.js');
const b = require(path.join(ROOT, 'bubble-layout.js'));

const json = (v) => JSON.stringify(v);

section('text: plain, capital letters, only what the font has');
for (const [label, raw, want] of [
  ['upper case', 'Tokyo!', 'TOKYO!'],
  ['line breaks and tabs become spaces', 'Hi\nthere\tyou\r\nall', 'HI THERE YOU ALL'],
  ['control characters go', 'A\u0000B\u0007C\u001b[31mD\u007f', 'ABC[31MD'],
  ['zero-width and direction overrides go', 'pay​pal ‮evil‬', 'PAYPAL EVIL'],
  ['accents come off', 'Café crème, déjà vu', 'CAFE CREME, DEJA VU'],
  ['full-width and other compatibility forms: their plain letter', '２ ＡＢＣ ﬁne', '2 ABC FINE'],
  ['the signs the updated font has stay', 'a<b>c&d="e";_f*g#h 100% @ $5 [x]', 'A<B>C&D="E";_F*G#H 100% @ $5 [X]'],
  ['other characters become spaces, not nothing', '3×4≠13 ok✓done', '3 4 13 OK DONE'],
  ['≠ is a space, never = (its accent-like slash is not stripped off)', '2 ≠ 3', '2 3'],
  ['emoji only: nothing', '😀 🎉', ''],
  ['spaces collapse and trim', '   lots    of   space   ', 'LOTS OF SPACE'],
  ['not a string: nothing', 42, ''],
]) {
  const got = b.cleanText(raw);
  check(`  ${label}`, got === want, json(got));
}
check('  only the first 500 characters are looked at', b.cleanText('a'.repeat(600)).length === b.MAX_INPUT);

section('first sentence of a Claude Code reply (Stop hook), code blocks skipped');
for (const [label, reply, want] of [
  ['the docs\' example', "I've completed the refactoring. Here's a summary...", "I've completed the refactoring."],
  ['a code block first is skipped', '```js\nconst x = 1;\n```\nDone! The tests pass now.', 'Done!'],
  ['~~~ fences too', '~~~\nls -la\n~~~\nListed the files.', 'Listed the files.'],
  ['an unclosed code block runs to the end', 'Here you go:\n```\nonly code, never closed', 'Here you go:'],
  ['only code: nothing', '```\nrm -rf build\n```', ''],
  ['headings and table rows are skipped', '## Summary\n| a | b |\n**Fixed** the [login bug](https://x.y/z) in `auth.js`. More.', 'Fixed the login bug in auth.js.'],
  ['a list item', '- First item\n- Second', 'First item'],
  ['a dot inside a number is not an end', 'Version 1.5 is out. Next.', 'Version 1.5 is out.'],
  ['no full stop: the first line', 'Tokyo\nMore lines', 'Tokyo'],
  ['not a string', null, ''],
]) {
  const got = b.firstSentence(reply);
  check(`  ${label}`, got === want, JSON.stringify(got));
}
{
  const long = b.layoutBubble(b.firstSentence('Refactored the authentication module so that sessions expire after thirty minutes. Then more.'));
  check('  a long first sentence: the bubble trims it to 2 lines', long.lines.length === 2 && long.trimmed && long.lines[1].endsWith('...'), long.lines.join(' / '));
}

section('"2 + 2 = 4": every character drawn');
{
  const l = b.layoutBubble('2 + 2 = 4');
  const drawn = l.glyphs.map((g) => Object.keys(b.FONT.glyphs).find((ch) => b.FONT.glyphs[ch].x === g.sx)).join('');
  check('  5 glyphs: 2 + 2 = 4, each from its place on the sheet', l.lines.join() === '2 + 2 = 4' && drawn === '2+2=4' && l.glyphs.length === 5, `${l.lines.join(' / ')}: ${drawn}`);
  check('  the font has 61 characters, A-Z and 0-9 among them', Object.keys(b.FONT.glyphs).length === 61 && b.SIGNS.join(' ') === ': - + ( ) / = * % # @ & " < > _ ; [ ] $ ! ? , . \'', b.SIGNS.join(' '));
}

section('lines: 2 at most, about 20 characters each, then "..."');
for (const [label, text, want, trimmed] of [
  ['one line', 'TOKYO!', ['TOKYO!'], false],
  ['exactly 20 characters stays on one line', 'ABCDEFGHIJ KLMNOPQRS', ['ABCDEFGHIJ KLMNOPQRS'], false],
  ['wraps at a word', 'PARIS IS THE CAPITAL OF FRANCE!', ['PARIS IS THE CAPITAL', 'OF FRANCE!'], false],
  ['three lines: the second ends with ...', 'THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG AGAIN', ['THE QUICK BROWN FOX', 'JUMPS OVER THE...'], true],
  ['a word too long for a line is cut', 'SUPERCALIFRAGILISTICEXPIALIDOCIOUS', ['SUPERCALIFRAGILISTIC', 'EXPIALIDOCIOUS'], false],
  ['a long word that does not fit: cut, then ...', 'HI SUPERCALIFRAGILISTICEXPIALIDOCIOUSLY LONG', ['HI', 'SUPERCALIFRAGILIS...'], true],
  ['nothing', '', [], false],
]) {
  const got = b.wrapLines(text);
  check(`  ${label}`, json(got.lines) === json(want) && got.trimmed === trimmed && got.lines.every((l) => l.length <= b.LINE_CHARS), `${json(got.lines)}${got.trimmed ? ' trimmed' : ''}`);
}

section('shape: the examples in design/terra-bubble-assets/examples-1x');
for (const [text, w, h] of [['Tokyo!', 43, 20], ['Happy to help!', 87, 20], ['Hi rabbit!', 61, 20], ['Paris is the capital of France!', 119, 29]]) {
  const l = b.layoutBubble(text);
  check(`  "${text}": ${w}x${h}`, l.width === w && l.height + b.TAIL_HEIGHT === h, `${l.width}x${l.height + b.TAIL_HEIGHT}, ${l.glyphs.length} glyphs`);
}
{
  const l = b.layoutBubble('Paris is the capital of France!');
  const [first] = l.glyphs;
  const secondLine = l.glyphs.find((g) => g.y !== first.y);
  check('  text starts 5 px inside the outline, 4 px down; next line 9 px lower', first.x === 6 && first.y === 4 && secondLine.x === 6 && secondLine.y === 13, `first glyph at ${first.x},${first.y}; second line at ${secondLine.x},${secondLine.y}`);
  const hi = b.layoutBubble('Y T').glyphs;
  check('  a space is 3 px, with a 1 px gap each side', hi[1].x - (hi[0].x + hi[0].w) === 5, `Y ends at ${hi[0].x + hi[0].w}, T starts at ${hi[1].x}`);
  check('  even "!" gets room for the tail and the pop-in', b.layoutBubble('!').width === 16);
  check('  nothing drawable: no bubble', b.layoutBubble('😀') === null);
}
{
  const l = b.layoutBubble('Tokyo!');
  const right = b.parts(l, 'right');
  const left = b.parts(l, 'left');
  check('tail and pop-in places (as in the examples)', json(right) === json({ tail: { x: 32, y: 12 }, pop: { x: 27, y: 6 } }) && json(left) === json({ tail: { x: 5, y: 12 }, pop: { x: 0, y: 6 } }), `${json(right)} ${json(left)}`);
}

section('timing: pop-in 80 ms, hold 4 s + 50 ms a character (10 s at most), fade 200 ms');
check('  constants', b.TIMING.popMs === 80 && b.TIMING.fadeMs === 200 && b.holdFor(0) === 4000, json(b.TIMING));
check('  "Tokyo!": 6 characters, 4.3 s', b.layoutBubble('Tokyo!').holdMs === 4300);
check('  2 lines (30 characters): 5.5 s', b.layoutBubble('Paris is the capital of France!').holdMs === 5500);
check('  never more than 10 s', b.holdFor(120) === 10000 && b.holdFor(1000) === 10000, `${b.holdFor(120)} ms`);

section('placement: above-left of the head, flipped at the left edge');
const area = { x: 0, y: 33, width: 1470, height: 923 };
const second = { x: 1470, y: -200, width: 2560, height: 1415 };
const hi = b.layoutBubble('Hi rabbit!'); // 61x20
for (const [label, pet, scale, workArea, want] of [
  ['usual: right edge at the pet window\'s middle, tip on the head', { x: 1000, y: 600 }, 4, area, { tail: 'right', bounds: { x: 1000 + 128 - 244, y: 600 + 72, width: 244, height: 80 } }],
  ['near the left edge: flipped to the right', { x: 100, y: 600 }, 4, area, { tail: 'left', bounds: { x: 244, y: 672, width: 244, height: 80 } }],
  ['exactly fits on the left: not flipped', { x: 116, y: 600 }, 4, area, { tail: 'right', bounds: { x: 0, y: 672, width: 244, height: 80 } }],
  ['one point off the left: flipped', { x: 115, y: 600 }, 4, area, { tail: 'left' }],
  ['near the right edge: stays above-left', { x: 1300, y: 600 }, 4, area, { tail: 'right' }],
  ['on a second screen: its own edges count', { x: 1500, y: 300 }, 4, second, { tail: 'left' }],
  ['1.5x: rounded to whole points', { x: 500, y: 600 }, 1.5, area, { tail: 'right', bounds: { x: Math.round(500 + (32 - 61) * 1.5), y: 600 + 27, width: 92, height: 30 } }],
  ['neither side fits: the side with more on screen', { x: 0, y: 0 }, 4, { x: 0, y: 0, width: 300, height: 500 }, { tail: 'left' }],
]) {
  const got = b.placeBubble(hi, { ...pet, width: 64 * scale, height: 80 * scale }, scale, workArea);
  const ok = got.tail === want.tail && (!want.bounds || json(got.bounds) === json(want.bounds));
  check(`  ${label}`, ok, `${got.tail} tail, ${json(got.bounds)}`);
}

process.exitCode = summary() ? 1 : 0;

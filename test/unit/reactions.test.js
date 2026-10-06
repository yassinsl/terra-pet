// Keyword matching in reactions.js.
const path = require('node:path');
const { ROOT, check, section, summary } = require('../lib.js');
const { matchReaction } = require(path.join(ROOT, 'reactions.js'));
const EMOTES = require(path.join(ROOT, 'renderer', 'emotes.js'));
const { REACTIONS } = require(path.join(ROOT, 'reactions.js'));

section('reaction keywords');
check('every reaction in the table is an emote', REACTIONS.every((r) => EMOTES[r.reaction]), REACTIONS.map((r) => r.reaction).join(', '));

const cases = [
  ['Hi there', 'hi'], ['hello!', 'hi'], ['HEY, fix this', 'hi'], ['salam alaikum', 'hi'],
  ['thanks a lot', 'love'], ['Thank   you so much', 'love'], ['I love it', 'love'], ['great work', 'love'],
  ['I have an idea', 'idea'], ['make a plan', 'idea'],
  ['wtf is this', 'angry'], ['stupid bug', 'angry'], ['I am angry', 'angry'], ['it is Broken  again', 'angry'],
  // not whole words, or no keyword
  ['this is a test', null], ['high priority, think hard', null], ['planet greatest heyday', null],
  ['unbroken again', null], ['thankyou', null], ['hiç', null], ['', null], [undefined, null],
  // the first row that matches wins
  ['great idea', 'love'], ['wtf, hi', 'hi'], ['plan: broken again', 'idea'],
  // pasted text is ignored
  ['<pasted_content id="x1">\nhello world\n</pasted_content id="x1">\nfix the tests', null],
  ['thanks! <pasted_content id="x1">\nwtf\n</pasted_content id="x1">', 'love'],
];
for (const [prompt, want] of cases) {
  const got = matchReaction(prompt);
  check(`  ${String(JSON.stringify(prompt)).slice(0, 44)}`, got === want, `-> ${got}${got === want ? '' : ` (want ${want})`}`);
}

process.exitCode = summary() ? 1 : 0;

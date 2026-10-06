// Reactions to prompts sent to Claude Code. Edit this table freely.
// Each reaction is an emote from renderer/emotes.js (played with its pet animation).
//
// Matching is case-insensitive and on whole words ("hi" matches "Hi!" but not "this").
// A keyword with a space matches any run of whitespace. Rows are checked from the top
// and the first row with a matching keyword wins.
const REACTIONS = [
  { reaction: 'hi',    words: ['hi', 'hello', 'hey', 'salam'] },
  { reaction: 'love',  words: ['thanks', 'thank you', 'love', 'great'] },
  { reaction: 'idea',  words: ['idea', 'plan'] },
  { reaction: 'angry', words: ['wtf', 'stupid', 'angry', 'broken again'] },
];

// Pasted text isn't the user's own words, so it never triggers a reaction.
const PASTED = /<pasted_content id="[^"]*">[\s\S]*?<\/pasted_content id="[^"]*">/g;

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function wordPattern(word) {
  const body = word.trim().split(/\s+/).map(escapeRegExp).join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, 'iu');
}

const COMPILED = REACTIONS.map(({ reaction, words }) => ({ reaction, patterns: words.map(wordPattern) }));

// Returns the reaction name for a prompt, or null.
function matchReaction(prompt) {
  if (typeof prompt !== 'string' || prompt === '') return null;
  const text = prompt.replace(PASTED, ' ');
  const hit = COMPILED.find(({ patterns }) => patterns.some((p) => p.test(text)));
  return hit ? hit.reaction : null;
}

module.exports = { REACTIONS, matchReaction };

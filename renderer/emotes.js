// Emote pictures shown above the pet: Bot/reactions/emotes-only/<name>-<n>.png (n from 1).
// Each PNG is a 64x80 canvas with the pet's 48x52 cell at (8,28).
// ms is the time per frame: one number for all frames, or one per frame.
// anim is the pet animation played with it. loop: true repeats the emote for as long as
// the pet stays in that state; otherwise it plays once.
const EMOTES = {
  hi:    { frames: 7, ms: [110, 160, 160, 160, 160, 160, 160], anim: 'wave' },
  love:  { frames: 6, ms: 150, anim: 'love' },
  angry: { frames: 6, ms: 100, anim: 'angry' },
  sad:   { frames: 4, ms: 260, anim: 'sad', loop: true },
  idea:  { frames: 7, ms: [260, 120, 170, 170, 170, 170, 520], anim: 'idea' },
  stars: { frames: 8, ms: 130, anim: 'happy' },
  talk:  { frames: 6, ms: 190, anim: 'talk', loop: true },
  ask:   { frames: 6, ms: 210, anim: 'ask', loop: true },
};

// Lets main.js require this file to build the tray menu from the same list.
if (typeof module !== 'undefined') module.exports = EMOTES;

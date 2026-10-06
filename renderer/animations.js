// One animation per row of Bot/spritesheet-x1.png (48x52 cells).
// ms is the time per frame: one number for all frames, or one per frame.
// loop: true repeats forever; otherwise the animation plays `plays` times, then switches to `next`.
const ANIMATIONS = {
  idle:       { row: 0,  frames: 4, ms: 180, loop: true },
  walkR:      { row: 1,  frames: 6, ms: 100, loop: true },
  walkL:      { row: 2,  frames: 6, ms: 100, loop: true },
  wave:       { row: 3,  frames: 4, ms: 160, plays: 3, next: 'idle' },
  happy:      { row: 4,  frames: 4, ms: 130, plays: 3, next: 'idle' },
  dizzy:      { row: 5,  frames: 4, ms: 110, plays: 6, next: 'idle' },
  wait:       { row: 6,  frames: 4, ms: 320, loop: true },
  think:      { row: 7,  frames: 4, ms: 170, loop: true },
  blinkHappy: { row: 8,  frames: 4, ms: [120, 70, 90, 700], plays: 1, next: 'idle' },
  sleep:      { row: 9,  frames: 4, ms: 520, loop: true },
  eat:        { row: 10, frames: 4, ms: 150, plays: 4, next: 'idle' },
  sitDown:    { row: 11, frames: 4, ms: 130, plays: 1, next: 'work' },
  work:       { row: 12, frames: 6, ms: 150, loop: true },
  love:       { row: 13, frames: 4, ms: 150, plays: 3, next: 'idle' },
  angry:      { row: 14, frames: 4, ms: 100, plays: 5, next: 'idle' },
  idea:       { row: 15, frames: 4, ms: [260, 120, 170, 170], plays: 1, next: 'idle' },
  talk:       { row: 16, frames: 4, ms: 190, loop: true },
  ask:        { row: 17, frames: 4, ms: 210, loop: true },
  sad:        { row: 18, frames: 4, ms: 260, loop: true },
};

// Lets main.js require this file to build the tray menu from the same list.
if (typeof module !== 'undefined') module.exports = ANIMATIONS;

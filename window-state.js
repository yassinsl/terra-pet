// Where the pet's window goes, and remembering it between launches.
//
// The window is the 64x80 emote canvas at the chosen size (1x to 4x, see SCALES), with
// the pet's 48x52 cell at (8,28) on it, so the pet's feet are the window's bottom centre.
// Every size gives whole points (1.5x: 96x120, pet 72x78 at (12,42); 2.25x: 144x180,
// pet 108x117 at (18,63)).
//
// What gets saved is that point plus, once you have picked one from the menu, the size.
// Changing size keeps the feet in place.
const fs = require('node:fs');
const path = require('node:path');

// In tray menu order. 2.25x matches the Codex pet: Terra's art is about 46 art pixels
// tall, so 2.25x makes it about 100 points, like the Codex mascot.
const SCALES = [1, 1.5, 2, 2.25, 3, 4];
const DEFAULT_SCALE = 2.25;
const MARGIN = 24; // gap between the pet and the edges of the work area
// Files from before version 2 always held a size, chosen or not (it was usually just the
// old 4x default), so their size is ignored once; their position is kept.
const VERSION = 2;

function geometry(scale) {
  return {
    width: 64 * scale,
    height: 80 * scale,
    pet: { x: 8 * scale, y: 28 * scale, width: 48 * scale, height: 52 * scale },
  };
}

const feetOf = (bounds) => ({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height });

function boundsAt(feet, scale) {
  const { width, height } = geometry(scale);
  return { x: Math.round(feet.x - width / 2), y: Math.round(feet.y - height), width, height };
}

// Bottom-right of the work area, the pet 24 px from both edges.
function defaultBounds(workArea, scale) {
  return boundsAt({ x: workArea.x + workArea.width - MARGIN - (48 * scale) / 2, y: workArea.y + workArea.height - MARGIN }, scale);
}

// The pet counts as on screen when the middle of its body is inside some display's
// work area (so a saved spot on a monitor that is no longer there doesn't count).
function petOnScreen(bounds, scale, workAreas) {
  const { pet } = geometry(scale);
  const cx = bounds.x + pet.x + pet.width / 2;
  const cy = bounds.y + pet.y + pet.height / 2;
  return workAreas.some((a) => cx >= a.x && cx < a.x + a.width && cy >= a.y && cy < a.y + a.height);
}

// Saved state -> where the window starts and at what size. `saved` may be anything
// read from disk. scaleChosen: the size came from the menu (and is saved again).
function startBounds(saved, workAreas, primaryWorkArea) {
  const scaleChosen = saved?.version === VERSION && SCALES.includes(saved.scale);
  const scale = scaleChosen ? saved.scale : DEFAULT_SCALE;
  const feet = saved?.feet;
  if (feet && Number.isFinite(feet.x) && Number.isFinite(feet.y)) {
    const bounds = boundsAt(feet, scale);
    if (petOnScreen(bounds, scale, workAreas)) return { scale, scaleChosen, bounds, restored: true };
  }
  return { scale, scaleChosen, bounds: defaultBounds(primaryWorkArea, scale), restored: false };
}

function load(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // missing or damaged: start fresh
  }
}

// The size is only written once it was picked from the menu, so a new default can
// still reach people who never chose one.
function save(file, { bounds, scale, scaleChosen }) {
  const feet = feetOf(bounds);
  const state = { version: VERSION, feet: { x: Math.round(feet.x), y: Math.round(feet.y) } };
  if (scaleChosen) state.scale = scale;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

module.exports = { SCALES, DEFAULT_SCALE, VERSION, MARGIN, geometry, feetOf, boundsAt, defaultBounds, petOnScreen, startBounds, load, save };

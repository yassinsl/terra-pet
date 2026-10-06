// ANIMATIONS and EMOTES come from animations.js and emotes.js, loaded before this file.

const CELL_W = 48;
const CELL_H = 52;
// The canvas is the 64x80 emote canvas at `scale` (2x, 3x or 4x; the main process
// passes it in the page URL and when it changes), with the pet's cell at (8,28) on it.
let scale = Number(new URLSearchParams(location.search).get('scale')) || 4;
let PET_X = 8 * scale;
let PET_Y = 28 * scale;

const BLINK_EVERY = [2500, 5000];    // ms between idle blinks
const SLEEP_AFTER = 5 * 60 * 1000;   // idle this long with no state change -> sleep
const PATROL_EVERY = [20000, 40000]; // ms between patrol walks
const WALK_SPEED = 24;               // sprite pixels per second (96 px/s at 4x)
const DRAG_THRESHOLD = 4;            // px the pointer must move before a press becomes a drag
const DIZZY_CLICKS = 5;
const DIZZY_WINDOW = 1500;           // ms

const canvas = document.getElementById('pet');
const ctx = canvas.getContext('2d');

function applyScale(next) {
  scale = next;
  PET_X = 8 * scale;
  PET_Y = 28 * scale;
  canvas.width = 64 * scale; // resizing resets the context, so set smoothing again
  canvas.height = 80 * scale;
  ctx.imageSmoothingEnabled = false;
  drawn = ''; // force a redraw
}

const sheet = new Image();
sheet.src = '../Bot/spritesheet-x1.png';
sheet.onerror = () => console.error('Could not load sprite sheet:', sheet.src);
sheet.onload = () => setState('wave');

const emoteImages = Object.fromEntries(Object.entries(EMOTES).map(([name, def]) => [
  name,
  Array.from({ length: def.frames }, (_, i) => {
    const img = new Image();
    img.src = `../Bot/reactions/emotes-only/${name}-${i + 1}.png`;
    img.onerror = () => console.error('Could not load emote:', img.src);
    return img;
  }),
]));

const rand = ([min, max]) => min + Math.random() * (max - min);

// A clip is a list of frames from one row with a duration for each,
// played `plays` times (Infinity for loops).
function clipFor(anim) {
  const frames = [...Array(anim.frames).keys()];
  const ms = Array.isArray(anim.ms) ? anim.ms : frames.map(() => anim.ms);
  return { row: anim.row, frames, ms, plays: anim.loop ? Infinity : anim.plays };
}

// Clips that are not states of their own.
const BLINK = { row: 8, frames: [1, 2, 1], ms: [60, 90, 60], plays: 1 };
const sitDownClip = clipFor(ANIMATIONS.sitDown);
const STAND_UP = {
  ...sitDownClip,
  frames: [...sitDownClip.frames].reverse(),
  ms: [...sitDownClip.ms].reverse(),
};

// ---- Player ----

let clip = null;
let onClipEnd = null;
let step = 0;      // index into clip.frames
let stepTime = 0;  // ms spent on the current step
let playsDone = 0;

function play(next, onEnd = null) {
  clip = next;
  onClipEnd = onEnd;
  step = 0;
  stepTime = 0;
  playsDone = 0;
}

function advance(dt) {
  if (!clip) return;
  stepTime += dt;
  while (stepTime >= clip.ms[step]) {
    stepTime -= clip.ms[step];
    if (step + 1 < clip.frames.length) {
      step++;
    } else if (++playsDone < clip.plays) {
      step = 0;
    } else {
      // Finished: hold the last frame and hand over to whatever comes next.
      stepTime = 0;
      const done = onClipEnd;
      onClipEnd = null;
      if (done) done();
      return;
    }
  }
}

// ---- Emote player: a picture above the pet, on its own clock ----

let emote = null;      // { name, ms, step, stepTime, loop }
let afterEmote = null; // next state, when the pet's animation ended before its emote

function startEmote(name) {
  const def = EMOTES[name];
  const ms = Array.isArray(def.ms) ? def.ms : Array(def.frames).fill(def.ms);
  emote = { name, ms, step: 0, stepTime: 0, loop: !!def.loop };
}

function advanceEmote(dt) {
  if (!emote) return;
  emote.stepTime += dt;
  while (emote && emote.stepTime >= emote.ms[emote.step]) {
    emote.stepTime -= emote.ms[emote.step];
    if (emote.step + 1 < emote.ms.length) {
      emote.step++;
    } else if (emote.loop) {
      emote.step = 0;
    } else {
      emote = null;
      if (afterEmote) {
        const next = afterEmote;
        afterEmote = null;
        setState(next);
      }
    }
  }
}

let drawn = '';

function draw() {
  if (!clip || !sheet.complete || !sheet.naturalWidth) return;
  const frame = clip.frames[step];
  const img = emote && emoteImages[emote.name][emote.step];
  const showEmote = img && img.complete && img.naturalWidth > 0;
  const key = `${clip.row}:${frame}:${showEmote ? `${emote.name}:${emote.step}` : ''}`;
  if (key === drawn) return;
  drawn = key;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(
    sheet,
    frame * CELL_W, clip.row * CELL_H, CELL_W, CELL_H,
    PET_X, PET_Y, CELL_W * scale, CELL_H * scale,
  );
  if (showEmote) ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
}

// ---- State machine ----

let state = null;
let pending = null;      // { name, then, emote }: where to go once Terra has stood up from "work"
let sleepClock = 0;      // time of the last state change that wasn't part of a patrol
let nextBlinkAt = 0;
let nextPatrolAt = 0;
let patrolEnabled = true;
let walk = null;         // { x, y, toX, toY } while patrolling
let routePending = false;

// Every state change goes through here. Patrol passes fromPatrol so its
// walks don't count as activity for the sleep timer. `then` replaces the
// animation's usual "next" state (ignored for loops). `emote` shows that
// emote with the animation (see playReaction).
function setState(name, { fromPatrol = false, then = null, emote: emoteName = null } = {}) {
  if (!ANIMATIONS[name]) {
    console.warn(`Unknown state "${name}"`);
    return;
  }
  if (then && !ANIMATIONS[then]) then = null;
  if (!fromPatrol) {
    walk = null;
    sleepClock = performance.now();
  }

  if (state === 'standUp') {
    pending = { name, then, emote: emoteName };
  } else if (state === 'work' && name !== 'work') {
    state = 'standUp';
    pending = { name, then, emote: emoteName };
    emote = null;
    afterEmote = null;
    play(STAND_UP, () => enter(pending.name, pending.then, pending.emote));
  } else {
    enter(name, then, emoteName);
    return;
  }
  window.terra.reportState(state, pending.name);
}

function enter(name, then = null, emoteName = null) {
  const anim = ANIMATIONS[name];
  const now = performance.now();
  const next = anim.loop ? null : then || anim.next;
  state = name;
  emote = null;
  afterEmote = null;
  if (emoteName) startEmote(emoteName);
  if (name === 'idle') {
    nextBlinkAt = now + rand(BLINK_EVERY);
    nextPatrolAt = now + rand(PATROL_EVERY);
  }
  play(clipFor(anim), next ? () => finishState(next) : null);
  window.terra.reportState(state, next);
}

// A one-shot emote that is still showing keeps the pet in its state (holding
// the last frame) until the emote ends.
function finishState(next) {
  if (emote && !emote.loop) afterEmote = next;
  else setState(next);
}

// Plays an emote above the pet together with its matching pet animation.
// The emote is removed when it ends, or when the pet changes state.
function playReaction(name, { then = null } = {}) {
  const def = EMOTES[name];
  if (!def) {
    console.warn(`Unknown reaction "${name}"`);
    return;
  }
  setState(def.anim, { then, emote: name });
}

// Blink, patrol and the sleep timer only run in idle, so they are paused in
// every other state (work, wait, think, ...). The sleep timer restarts from
// the last state change.
function updateIdle(now) {
  if (state !== 'idle' || routePending || press) return;
  if (now - sleepClock >= SLEEP_AFTER) {
    setState('sleep');
  } else if (patrolEnabled && now >= nextPatrolAt) {
    startPatrol();
  } else if (clip !== BLINK && now >= nextBlinkAt) {
    play(BLINK, () => {
      play(clipFor(ANIMATIONS.idle));
      nextBlinkAt = performance.now() + rand(BLINK_EVERY);
    });
  }
}

// ---- Patrol ----

async function startPatrol() {
  routePending = true;
  const route = await window.terra.patrolRoute();
  routePending = false;
  if (!route || state !== 'idle' || !patrolEnabled || press) {
    nextPatrolAt = performance.now() + rand(PATROL_EVERY);
    return;
  }
  walk = { x: route.from.x, y: route.from.y, toX: route.to.x, toY: route.to.y };
  setState(walk.toX >= walk.x ? 'walkR' : 'walkL', { fromPatrol: true });
}

function updateWalk(dt) {
  if (!walk) return;
  const dx = walk.toX - walk.x;
  const dy = walk.toY - walk.y;
  const dist = Math.hypot(dx, dy);
  const stepPx = (WALK_SPEED * scale * dt) / 1000;
  if (dist <= stepPx) {
    window.terra.moveWindow(walk.toX, walk.toY);
    walk = null;
    setState('idle', { fromPatrol: true });
    return;
  }
  walk.x += (dx / dist) * stepPx;
  walk.y += (dy / dist) * stepPx;
  window.terra.moveWindow(walk.x, walk.y);
}

// ---- Mouse: drag to move, click to react ----

let press = null; // { startX, startY, offsetX, offsetY, dragging }
let clickTimes = [];

// Only the pet's own cell catches the mouse. The main process makes the window
// ignore the mouse (clicks fall through to whatever is behind) but still forwards
// moves, so the page reports whether the pointer is over the pet.
const onPet = (x, y) => x >= PET_X && x < PET_X + CELL_W * scale && y >= PET_Y && y < PET_Y + CELL_H * scale;

window.addEventListener('mousemove', (e) => {
  if (!press) window.terra.setMouseOverPet(onPet(e.clientX, e.clientY));
});
document.addEventListener('mouseleave', () => {
  if (!press) window.terra.setMouseOverPet(false);
});

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !onPet(e.clientX, e.clientY)) return;
  press = {
    startX: e.screenX,
    startY: e.screenY,
    offsetX: e.clientX,
    offsetY: e.clientY,
    dragging: false,
  };
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (!press) return;
  if (!press.dragging) {
    if (Math.hypot(e.screenX - press.startX, e.screenY - press.startY) < DRAG_THRESHOLD) return;
    press.dragging = true;
    canvas.classList.add('dragging');
    if (walk) setState('idle'); // picking Terra up ends the patrol walk
  }
  // Keep the point that was grabbed under the pointer.
  window.terra.moveWindow(e.screenX - press.offsetX, e.screenY - press.offsetY);
});

canvas.addEventListener('pointerup', (e) => {
  if (!press) return;
  const wasDrag = press.dragging;
  endPress();
  window.terra.setMouseOverPet(onPet(e.clientX, e.clientY));
  if (wasDrag) {
    nextPatrolAt = performance.now() + rand(PATROL_EVERY);
  } else {
    onClick();
  }
});

canvas.addEventListener('pointercancel', endPress);

function endPress() {
  press = null;
  canvas.classList.remove('dragging');
}

function onClick() {
  const now = performance.now();
  if (state === 'sleep') {
    clickTimes = [];
    setState('wave');
    return;
  }
  clickTimes = clickTimes.filter((t) => now - t <= DIZZY_WINDOW);
  clickTimes.push(now);
  if (clickTimes.length >= DIZZY_CLICKS) {
    clickTimes = [];
    setState('dizzy');
  } else {
    playReaction('love');
  }
}

// ---- Messages from the main process ----

window.terra.onSetState((name, options) => setState(name, { then: options && options.then }));
window.terra.onPlayReaction((name, options) => playReaction(name, { then: options && options.then }));
window.terra.onSetScale((next) => applyScale(next));

window.terra.onSetPatrol((on) => {
  patrolEnabled = on;
  if (on) {
    nextPatrolAt = performance.now() + rand(PATROL_EVERY);
  } else if (walk) {
    walk = null;
    setState('idle', { fromPatrol: true });
  }
});

// ---- Main loop ----

let lastTick = performance.now();

function tick() {
  const now = performance.now();
  const dt = Math.min(now - lastTick, 250); // don't jump after the page was paused
  lastTick = now;
  advance(dt);
  advanceEmote(dt);
  updateWalk(dt);
  updateIdle(now);
  draw();
  requestAnimationFrame(tick);
}

applyScale(scale);
requestAnimationFrame(tick);

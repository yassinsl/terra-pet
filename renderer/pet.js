// ANIMATIONS, EMOTES and the sound rules come from animations.js, emotes.js and sounds.js,
// loaded before this file.

const CELL_W = 48;
const CELL_H = 52;
// The canvas is the 64x80 emote canvas at `scale` (1x to 4x; the main process passes
// it in the page URL and when it changes), with the pet's cell at (8,28) on it.
// PET_X and PET_Y are in CSS pixels, which are the window's points.
let scale = Number(new URLSearchParams(location.search).get('scale')) || 4;
let PET_X = 8 * scale;
let PET_Y = 28 * scale;
// Device pixels per art pixel: the size times the screen's pixel ratio (2 on Retina).
// The canvas has one pixel per device pixel, so on Retina an art pixel is a whole number
// of device pixels at most sizes (2 at 1x, 3 at 1.5x) instead of the screen stretching
// a smaller canvas. 2.25x on Retina is 4.5: with smoothing off, art pixels alternate
// 4 and 5 device pixels, crisp but not all the same width. Where the ratio is 1, 1.5x
// and 2.25x can't be whole either.
let px = scale;

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
  px = scale * devicePixelRatio;
  PET_X = 8 * scale;
  PET_Y = 28 * scale;
  canvas.style.width = `${64 * scale}px`;
  canvas.style.height = `${80 * scale}px`;
  canvas.width = Math.round(64 * px); // resizing resets the context, so set smoothing again
  canvas.height = Math.round(80 * px);
  ctx.imageSmoothingEnabled = false;
  drawn = ''; // force a redraw
}


const sheet = new Image();
sheet.src = '../Bot/spritesheet-x1.png';
sheet.onerror = () => console.error('Could not load sprite sheet:', sheet.src);
// Starts with a wave, or with the hi reaction when Claude desktop has just opened Terra.
sheet.onload = () => (new URLSearchParams(location.search).get('greet') === 'hi' ? playReaction('hi') : setState('wave'));

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
      if (clip.plays === Infinity) animationDone(); // a loop finishes at the end of each cycle
    } else {
      // Finished: hold the last frame and hand over to whatever comes next.
      stepTime = 0;
      animationDone();
      const done = onClipEnd;
      onClipEnd = null;
      if (done) done();
      return;
    }
  }
}

// ---- Hiding (Show Terra in the menu) ----

let hidden = false;          // the window is hidden: no patrol, blinking or sleep timer
let hideAfterCurrent = false; // asked to hide: finish the current animation first

// Called when an animation has played to its end (a loop: the end of a cycle).
function animationDone() {
  if (!hideAfterCurrent) return;
  goHidden();
  window.terra.readyToHide();
}

function goHidden() {
  hidden = true;
  hideAfterCurrent = false;
  if (walk) {
    walk = null; // patrol pauses; Terra stays where it is
    setState('idle', { fromPatrol: true });
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
      if (playing && playing.name === emote.name) playing.cycleEnded = true;
    } else {
      emote = null;
      if (afterEmote) {
        const next = afterEmote;
        afterEmote = null;
        continueTo(next);
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
  if (!Number.isInteger(px)) {
    drawMapped(clip.row, frame, showEmote ? img : null);
    return;
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(
    sheet,
    frame * CELL_W, clip.row * CELL_H, CELL_W, CELL_H,
    8 * px, 28 * px, CELL_W * px, CELL_H * px,
  );
  if (showEmote) ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
}

// When an art pixel isn't a whole number of device pixels (2.25x on Retina is 4.5),
// letting drawImage scale leaves the GPU to choose, pixel by pixel, which art pixel a
// device pixel exactly on a boundary shows, and some edges come out jagged. Instead the
// frame is put together at art size (the 64x80 canvas: pet at 8,28, emote on top) and
// every device pixel takes the art pixel floor(x / px): straight edges, and art pixels
// floor(px) or ceil(px) wide in a fixed rhythm (5,4,5,4... at 4.5). No smoothing anywhere.
const artPixels = new Map(); // image -> its RGBA pixels
function pixelsOf(img) {
  if (!artPixels.has(img)) {
    // An OffscreenCanvas, so this one-off copy isn't a draw of the visible canvas.
    const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight).getContext('2d');
    c.drawImage(img, 0, 0);
    artPixels.set(img, c.getImageData(0, 0, img.naturalWidth, img.naturalHeight).data);
  }
  return artPixels.get(img);
}

function drawMapped(row, frame, emoteImg) {
  const art = new Uint8ClampedArray(64 * 80 * 4);
  const cells = pixelsOf(sheet);
  const sheetWidth = sheet.naturalWidth;
  for (let y = 0; y < CELL_H; y++) {
    const from = ((row * CELL_H + y) * sheetWidth + frame * CELL_W) * 4;
    art.set(cells.subarray(from, from + CELL_W * 4), ((28 + y) * 64 + 8) * 4);
  }
  if (emoteImg) {
    const e = pixelsOf(emoteImg);
    for (let i = 0; i < e.length; i += 4) {
      const a = e[i + 3] / 255;
      if (!a) continue;
      for (let ch = 0; ch < 3; ch++) art[i + ch] = e[i + ch] * a + art[i + ch] * (1 - a);
      art[i + 3] = 255 * (a + (art[i + 3] / 255) * (1 - a));
    }
  }
  const { width, height } = canvas;
  const out = ctx.createImageData(width, height);
  const colOf = Array.from({ length: width }, (_, x) => Math.min(63, Math.floor(x / px)));
  for (let y = 0; y < height; y++) {
    const artRow = Math.min(79, Math.floor(y / px)) * 64;
    for (let x = 0; x < width; x++) {
      const from = (artRow + colOf[x]) * 4;
      const to = (y * width + x) * 4;
      out.data[to] = art[from];
      out.data[to + 1] = art[from + 1];
      out.data[to + 2] = art[from + 2];
      out.data[to + 3] = art[from + 3];
    }
  }
  ctx.putImageData(out, 0, 0);
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
  const effect = emoteName ? FOR_EMOTE[emoteName] : FOR_STATE[name];
  if (effect) sound.play(effect);
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
  else continueTo(next);
}

// An animation (and its one-shot emote) has ended and hands over to `next`. When it was
// the queue's reaction, the queue decides what comes next instead (see runQueue).
function continueTo(next) {
  if (playing && !playing.loop && state === playing.anim) {
    playing.ended = true;
    return;
  }
  setState(next);
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

// ---- Claude desktop's queue (its MCP tools) ----
//
// Claude calls the tools in quick bursts (working, a reaction, done within a second).
// Instead of each call cutting off the one before, they wait here and play in order:
// a reaction plays to its end and stays on screen at least MIN_SHOWN (a looping one, at
// the end of a cycle); working, done and idle sit down or stand up fully first.
// Claude Code's hooks, the tray and clicks don't queue: they act at once, as they always
// have, and what waits here plays once the pet is free again.
const QUEUE_MAX = 5;                    // waiting commands; beyond that the oldest waiting ones go
const MIN_SHOWN = 1500;                 // ms a queued reaction stays on screen, at least
const LOOP_ALONE = 4000;                // ms a looping reaction plays when nothing waits after it
const GLUM = new Set(['sad', 'angry']); // "done" after one of these, with no mood, doesn't celebrate

let queue = [];           // waiting commands, oldest first: { reaction }, { state, ending, say? } or { say }
let playing = null;       // the queued reaction on screen (see startReaction)
let mood = null;          // the last reaction since the last "working" or "done", as they arrive
let replyWorking = false; // "working" has played, and no done, waiting or idle since

// A command from Claude desktop (main.js passes it on; the listener has checked the names).
// How a "done" ends is settled as it arrives, so it knows what came before it even if
// that reaction was dropped from a full queue: the mood Claude gave it (happy, sad, angry
// or neutral) or, with none, the last reaction in this reply (sad or angry: neutral, any
// other: happy), or neutral when there was none either.
function queueCommand({ reaction, state: name, mood: doneMood, say } = {}) {
  let command;
  if (Number.isInteger(say) && !name) {
    // A speech bubble (terra_say; main.js keeps the text). A newer one replaces the one
    // on screen, or the one waiting, rather than waiting behind it.
    if (playing && playing.say) {
      playing.say = say;
      playing.bubbleEnded = false;
      window.terra.showBubble(say);
      return;
    }
    const waiting = queue.findIndex((c) => c.say && !c.state); // a terra_say, not a done with its line
    if (waiting >= 0) {
      queue[waiting] = { say };
      return;
    }
    command = { say };
  } else if (reaction && EMOTES[reaction]) {
    mood = reaction;
    command = { reaction };
  } else if (name === 'done') {
    const fromReaction = mood && !GLUM.has(mood) ? 'happy' : 'neutral';
    command = { state: 'done', ending: doneMood || fromReaction, ...(Number.isInteger(say) ? { say } : {}) };
    mood = null;
  } else if (name === 'working' || name === 'waiting' || name === 'idle') {
    if (name === 'working') mood = null;
    command = { state: name };
  } else {
    return;
  }
  queue.push(command);
  if (queue.length > QUEUE_MAX) queue.splice(0, queue.length - QUEUE_MAX);
  runQueue(0);
}

// Free for the next command: not in the middle of something that ends by itself (a
// one-shot animation such as a hook's stars or a click's love, sitting down, standing up).
const petFree = () => ANIMATIONS[state] !== undefined && ANIMATIONS[state].loop === true;

// Runs every frame (dt: ms since the last one), and when a command arrives (dt 0).
// Time on screen is counted on the animation clock, like the emote cycles, so a page
// that stalls or is throttled doesn't count frozen time as seen.
function runQueue(dt) {
  if (playing) {
    const p = playing;
    if (p.shown === null) {
      if (state === 'standUp') return; // still standing up to it
      if (state !== p.anim) { // went somewhere else instead: let it go
        playing = null;
        return;
      }
      p.shown = 0;
    } else {
      p.shown += dt;
    }
    const { shown } = p;
    let over;
    if (p.say) {
      over = p.bubbleEnded; // talks for as long as its bubble shows
    } else if (p.loop) {
      // At the end of an emote cycle: on to what waits (or, played once, on to `back`),
      // or back after LOOP_ALONE.
      over = p.cycleEnded && (queue.length || p.once ? shown >= MIN_SHOWN : !p.stays && shown >= LOOP_ALONE);
      p.cycleEnded = false;
    } else {
      over = p.ended && shown >= MIN_SHOWN; // holds its last frame until then
    }
    if (!over) return;
    playing = null;
    if (queue.length) startCommand(queue.shift());
    else setState(p.back);
    return;
  }
  if (queue.length && petFree()) startCommand(queue.shift());
}

function startCommand(command) {
  if (command.reaction) {
    startReaction(command.reaction);
    return;
  }
  if (command.say && !command.state) {
    startSay(command.say);
    return;
  }
  switch (command.state) {
    case 'working':
      replyWorking = true;
      if (state !== 'work') setState('sitDown');
      break;
    case 'waiting':
      replyWorking = false;
      startReaction('ask', { stays: true }); // keeps asking until the next command
      break;
    case 'done':
      replyWorking = false;
      if (command.say) window.terra.showBubble(command.say); // done's line, while the mood plays
      if (command.ending === 'happy') startReaction('stars', { back: 'idle' });
      else if (command.ending === 'sad' || command.ending === 'angry') startReaction(command.ending, { back: 'idle', once: true });
      else {
        setState('idle'); // neutral: just stand up (if working) and idle
        sound.play(NEUTRAL_DONE);
      }
      break;
    case 'idle':
      replyWorking = false;
      setState('idle');
      break;
  }
}

// From the laptop a reaction plays standing up, then Terra sits back down unless the
// reply is over (or something else waits: then that plays next).
// `once`: a looping one (sad) moves on to `back` after MIN_SHOWN, at the end of a cycle.
function startReaction(name, { stays = false, once = false, back = null } = {}) {
  const def = EMOTES[name];
  const then = back || (replyWorking || state === 'work' ? 'sitDown' : 'idle');
  // shown: ms on screen so far, null until the pet is in the reaction (it may stand up first)
  playing = { name, anim: def.anim, loop: !!def.loop, stays, once, back: then, shown: null, ended: false, cycleEnded: false };
  playReaction(name, { then: def.loop ? null : then });
  if (state === def.anim) playing.shown = 0;
}

// Talks (the talk animation without its emote: the bubble is the speech) while main.js
// shows speech bubble `id`, then goes back like a reaction does.
function startSay(id) {
  const then = replyWorking || state === 'work' ? 'sitDown' : 'idle';
  playing = { name: 'say', say: id, anim: 'talk', loop: true, back: then, shown: null, bubbleEnded: false, cycleEnded: false };
  setState('talk');
  if (state === 'talk') playing.shown = 0;
  window.terra.showBubble(id);
}

function bubbleEnded(id) {
  if (!playing || playing.say !== id) return;
  playing.bubbleEnded = true;
  runQueue(0);
}

// A hook, the tray or a click changes the pet at once; a queued reaction on screen
// counts as finished then.
function takeOver() {
  playing = null;
}

// Blink, patrol and the sleep timer only run in idle, so they are paused in
// every other state (work, wait, think, ...). The sleep timer restarts from
// the last state change.
function updateIdle(now) {
  if (hidden || state !== 'idle' || routePending || press) return;
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
  takeOver();
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

// ---- Sound effects (rules in sounds.js; settings from the tray's Sound menu) ----

const audio = {}; // name -> HTMLAudioElement, made the first time it plays
// What makes the noise: an audio element per sound, in this page (so Terra never takes
// focus or shows in the Dock to play one). The tests put a fake player here.
let soundPlayer = {
  play(name, volume) {
    if (!audio[name]) audio[name] = new Audio(`../Bot/sounds/${name}.wav`);
    const a = audio[name];
    a.volume = volume;
    a.currentTime = 0;
    a.play().catch(() => {}); // a sound that can't play is just not heard
  },
};
const sound = createMixer({ player: { play: (name, volume) => soundPlayer.play(name, volume) }, quiet: () => hidden || state === 'sleep' });

// The speech bubble (bubble-window.js, through main.js): a pop when it appears, then talk
// blips while its text shows, at the bubble's reading pace, until it fades or goes.
let blipTimers = [];
function stopBlips() {
  blipTimers.forEach(clearTimeout);
  blipTimers = [];
}
function onBubblePhase({ phase, chars = 0, perCharMs = 50 }) {
  stopBlips();
  if (phase === 'pop') sound.play(BUBBLE_POP);
  if (phase !== 'full') return;
  let last = null;
  for (const at of blipTimes(chars, perCharMs)) {
    blipTimers.push(setTimeout(() => {
      last = nextBlip(last);
      sound.play(last, { blip: true });
    }, at));
  }
}

// ---- Messages from the main process ----

window.terra.onSetState((name, options) => {
  takeOver();
  setState(name, { then: options && options.then });
});
window.terra.onPlayReaction((name, options) => {
  takeOver();
  playReaction(name, { then: options && options.then });
});
window.terra.onCommand((command) => queueCommand(command));
window.terra.onBubbleEnded((id) => bubbleEnded(id));
window.terra.onBubblePhase((change) => onBubblePhase(change));
window.terra.onSoundSettings((settings) => sound.setSettings(settings));
window.terra.onSetScale((next) => applyScale(next));

// visible: shown again (greet: because Claude desktop just opened). Not visible: finish
// the current animation, then say so; `now` hides straight away (Terra started hidden).
window.terra.onVisibility(({ visible, greet = false, now = false }) => {
  if (!visible) {
    if (now) goHidden();
    else hideAfterCurrent = true;
    return;
  }
  const wasHidden = hidden;
  hidden = false;
  hideAfterCurrent = false;
  if (wasHidden) {
    // The time spent hidden doesn't count toward sleeping, blinking or patrolling.
    const t = performance.now();
    sleepClock = t;
    nextBlinkAt = t + rand(BLINK_EVERY);
    nextPatrolAt = t + rand(PATROL_EVERY);
  }
  if (greet) {
    takeOver();
    playReaction('hi', { then: state === 'work' || state === 'sitDown' ? 'sitDown' : null });
  }
});

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
  // Moving to a screen with another pixel ratio (a Retina laptop to a plain monitor, say)
  // changes devicePixelRatio; rebuild the canvas for it. Checked every frame because a
  // matchMedia change event doesn't fire for every way the ratio can change.
  if (scale * devicePixelRatio !== px) applyScale(scale);
  advance(dt);
  advanceEmote(dt);
  runQueue(dt);
  updateWalk(dt);
  updateIdle(now);
  draw();
  requestAnimationFrame(tick);
}

applyScale(scale);
requestAnimationFrame(tick);

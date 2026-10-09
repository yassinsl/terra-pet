// The speech bubble's page (bubble-window.js runs it; bubble-layout.js works out the shape).
// The picture is put together pixel by pixel at 1x from the art in Bot/bubble/, then every
// device pixel takes the art pixel under it: nearest neighbour only, at any size. The text
// arrives as glyph positions on the font sheet, so nothing of it is ever HTML; it is never
// logged either.

const ART_NAMES = ['bubble-9slice', 'tail-right', 'tail-left', 'pop-in-right', 'pop-in-left', 'font-5x7'];
const SLICE = 4; // bubble-9slice.png: corners of 4x4, edges and middle stretched

const canvas = document.getElementById('bubble');
const ctx = canvas.getContext('2d');
const art = {};      // name -> { width, height, data } (RGBA, straight from the PNG)
let current = null;  // what main.js sent: shape, glyphs, scale, phase
let phase = 'hidden'; // pop, full, fade or hidden (the tests read it)
let frame = null;    // the current picture at 1x: { width, height, data }
let ratio = devicePixelRatio;
let mouseOn = false;

function loadArt(name) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight).getContext('2d');
      c.drawImage(img, 0, 0);
      art[name] = { width: img.naturalWidth, height: img.naturalHeight, data: c.getImageData(0, 0, img.naturalWidth, img.naturalHeight).data };
      resolve();
    };
    img.onerror = () => reject(new Error(`Could not load bubble art: ${name}`));
    img.src = `../Bot/bubble/${name}.png`;
  });
}
const artReady = Promise.all(ART_NAMES.map(loadArt));

// Copies a rectangle of `src` onto `out` at x,y, skipping transparent pixels, so a patch
// changes only what it paints. (The art has no half-transparent pixels.)
function blit(out, src, x, y, sx = 0, sy = 0, w = src.width, h = src.height) {
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const dx = x + i;
      const dy = y + j;
      const s = ((sy + j) * src.width + sx + i) * 4;
      if (dx < 0 || dy < 0 || dx >= out.width || dy >= out.height || !src.data[s + 3]) continue;
      out.data.set(src.data.subarray(s, s + 4), (dy * out.width + dx) * 4);
    }
  }
}

// The body, width x height: the slice's corners as they are, its edges and middle stretched.
function drawBody(out, width, height) {
  const src = art['bubble-9slice'];
  const pick = (v, size, srcSize) => {
    if (v < SLICE) return v;
    if (v >= size - SLICE) return srcSize - (size - v);
    return SLICE + Math.floor(((v - SLICE) * (srcSize - 2 * SLICE)) / (size - 2 * SLICE));
  };
  for (let y = 0; y < height; y++) {
    const sy = pick(y, height, src.height);
    for (let x = 0; x < width; x++) {
      const s = (sy * src.width + pick(x, width, src.width)) * 4;
      out.data.set(src.data.subarray(s, s + 4), (y * out.width + x) * 4);
    }
  }
}

// The picture at 1x for `b` (see bubble-window.js): the pop-in frame, or the full bubble
// with its tail and text.
function compose(b, which) {
  const out = { width: b.width, height: b.imageHeight, data: new Uint8ClampedArray(b.width * b.imageHeight * 4) };
  if (which === 'pop') {
    blit(out, art[`pop-in-${b.tail}`], b.popAt.x, b.popAt.y);
    return out;
  }
  drawBody(out, b.width, b.height);
  blit(out, art[`tail-${b.tail}`], b.tailAt.x, b.tailAt.y);
  for (const g of b.glyphs) blit(out, art['font-5x7'], g.x, g.y, g.sx, g.sy, g.w, g.h);
  return out;
}

// Puts `frame` on the canvas: the window's size in points, one canvas pixel per device
// pixel, each taking the art pixel floor(x / px) (px = device pixels per art pixel).
function paint() {
  ratio = devicePixelRatio;
  if (!frame) {
    canvas.width = 0;
    canvas.height = 0;
    return;
  }
  const width = Math.round(frame.width * current.scale);
  const height = Math.round(frame.height * current.scale);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const px = current.scale * ratio;
  const image = ctx.createImageData(canvas.width, canvas.height);
  const to = new Uint32Array(image.data.buffer);
  const from = new Uint32Array(frame.data.buffer);
  const colOf = Array.from({ length: canvas.width }, (_, x) => Math.min(frame.width - 1, Math.floor(x / px)));
  for (let y = 0; y < canvas.height; y++) {
    const row = Math.min(frame.height - 1, Math.floor(y / px)) * frame.width;
    for (let x = 0; x < canvas.width; x++) to[y * canvas.width + x] = from[row + colOf[x]];
  }
  ctx.putImageData(image, 0, 0);
}

async function show(next) {
  await artReady;
  current = next.phase === 'hidden' ? null : next;
  phase = next.phase;
  canvas.classList.toggle('fading', phase === 'fade');
  if (phase !== 'fade') frame = current ? compose(current, phase) : null;
  paint();
  if (!current) setMouseOn(false);
}

// Only the bubble's own pixels catch the mouse; a click on them dismisses it.
const onBubble = (clientX, clientY) => {
  if (!frame || !current || phase === 'hidden') return false;
  const x = Math.floor(clientX / current.scale);
  const y = Math.floor(clientY / current.scale);
  return x >= 0 && y >= 0 && x < frame.width && y < frame.height && frame.data[(y * frame.width + x) * 4 + 3] > 0;
};

function setMouseOn(on) {
  if (on === mouseOn) return;
  mouseOn = on;
  window.bubble.setMouseOver(on);
}

window.addEventListener('mousemove', (e) => setMouseOn(onBubble(e.clientX, e.clientY)));
document.addEventListener('mouseleave', () => setMouseOn(false));
canvas.addEventListener('click', (e) => {
  if (onBubble(e.clientX, e.clientY)) window.bubble.dismiss();
});

window.bubble.onDraw((next) => show(next));

// Moving to a screen with another pixel ratio: paint again for it.
function watchRatio() {
  if (devicePixelRatio !== ratio && frame) paint();
  requestAnimationFrame(watchRatio);
}
requestAnimationFrame(watchRatio);

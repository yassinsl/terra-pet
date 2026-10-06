// Every size in the Size menu, picked the way a real click arrives, measured on screen:
// the window's bounds, the menu's check mark, what is saved, and the pet as actually drawn
// (from a capture of the window, compared pixel by pixel with the sprite sheet).
// Run: npx electron test/e2e/size.e2e.js   (or npm test)
const { ROOT, t, check, section, wait, js, menuItem, waitFor, start, fs, path } = require('./lib.js');
const { nativeImage } = require('electron');
const ws = require(path.join(ROOT, 'window-state.js'));

const sheet = nativeImage.createFromPath(path.join(ROOT, 'Bot', 'spritesheet-x1.png'));
const label = (s) => (s === 2.25 ? 'Match small (2.25x)' : `${s}x`);
// What Electron runs when the native menu reports a click on an item.
const nativeClick = (menu, itemLabel) => menu._executeCommand({}, menu.items.find((i) => i.label === itemLabel).commandId);

// Captures the window while one sprite cell is showing; returns the capture and that cell.
async function stableCapture() {
  for (let tries = 0; tries < 10; tries++) {
    const before = await js('[clip.row, clip.frames[step], emote === null]');
    const cap = await t.wc.capturePage();
    const after = await js('[clip.row, clip.frames[step]]');
    if (before[0] === after[0] && before[1] === after[1] && before[2]) return { cap, row: before[0], frame: before[1] };
  }
  return null;
}

// Works out, for each device pixel column and row of the pet, which art pixel it shows.
// Returns the pet's drawn size, how wide/tall each art pixel came out, and how many
// device pixels are not exactly their art pixel's colour (blending or misplacement).
function measure({ cap, row, frame }, k) {
  const W = cap.getSize().width; // capturePage returns device pixels
  const shot = cap.toBitmap();
  const art = sheet.crop({ x: frame * 48, y: row * 52, width: 48, height: 52 }).toBitmap();
  const at = (c, r) => (r * 48 + c) * 4;
  const px = (x, y) => (y * W + x) * 4;
  // Capture colour management can round a channel by a unit; real blending is far off.
  const same = (i, j) => [0, 1, 2, 3].every((d) => Math.abs(shot[i + d] - art[j + d]) <= 3);
  const ox = Math.round(8 * k);
  const oy = Math.round(28 * k);
  const w = Math.round(48 * k);
  const h = Math.round(52 * k);
  const colOf = (x) => {
    for (let c = Math.max(0, Math.floor(x / k) - 1); c <= Math.min(47, Math.floor(x / k) + 1); c++) {
      let ok = true;
      for (let r = 0; r < 52 && ok; r++) ok = same(px(ox + x, oy + Math.floor((r + 0.5) * k)), at(c, r));
      if (ok) return c;
    }
    return -1;
  };
  const rowOf = (y) => {
    for (let r = Math.max(0, Math.floor(y / k) - 1); r <= Math.min(51, Math.floor(y / k) + 1); r++) {
      let ok = true;
      for (let c = 0; c < 48 && ok; c++) ok = same(px(ox + Math.floor((c + 0.5) * k), oy + y), at(c, r));
      if (ok) return r;
    }
    return -1;
  };
  const cols = Array.from({ length: w }, (_, x) => colOf(x));
  const rows = Array.from({ length: h }, (_, y) => rowOf(y));
  let off = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (cols[x] < 0 || rows[y] < 0 || !same(px(ox + x, oy + y), at(cols[x], rows[y]))) off++;
  // Columns (or rows) that look the same in every row can't be told apart, so their
  // device pixels add up under one of them; count only the ones that could be told apart.
  const runs = (list, n) => Array.from({ length: n }, (_, i) => list.filter((v) => v === i).length).filter((len) => len > 0);
  // Nothing drawn outside the pet's cell either (the emote is off for this check).
  let stray = 0;
  for (let y = 0; y < cap.getSize().height; y++) {
    for (let x = 0; x < W; x++) {
      const inside = x >= ox && x < ox + w && y >= oy && y < oy + h;
      if (!inside && shot[px(x, y) + 3] !== 0) stray++;
    }
  }
  return { size: [w, h], capture: cap.getSize(), widths: runs(cols, 48), heights: runs(rows, 52), off, stray, unmatched: cols.filter((v) => v < 0).length + rows.filter((v) => v < 0).length };
}

// A run of n device pixels made of art pixels that are floor(k) or ceil(k) wide.
function possible(n, k) {
  const a = Math.floor(k);
  const b = Math.ceil(k);
  for (let i = 0; i * a <= n; i++) if ((n - i * a) % b === 0) return true;
  return false;
}

start(async () => {
  await waitFor('idle', 3000);
  await js('patrolEnabled = false');
  const dpr = await js('devicePixelRatio');
  const size = () => menuItem('Size').submenu;
  const labels = size().items.map((i) => i.label);
  section('the Size menu');
  check('lists 1x, 1.5x, 2x, Match small (2.25x), 3x, 4x', labels.join(' | ') === ws.SCALES.map(label).join(' | ') && ws.SCALES.join() === '1,1.5,2,2.25,3,4', labels.join(' | '));

  section(`picking each size (screen pixel ratio ${dpr})`);
  // Each size from a different one, ending where it started.
  const order = [1, 4, 2.25, 1.5, 3, 2, 2.25, 4];
  for (const s of order) {
    const before = t.win.getBounds();
    nativeClick(size(), label(s));
    await wait(500);
    await js("setState('sleep')"); // a still pose with no emote
    await wait(150);
    const b = t.win.getBounds();
    const g = ws.geometry(s);
    const k = s * dpr; // device pixels per art pixel
    const page = await js('({ scale, px, canvas: [canvas.clientWidth, canvas.clientHeight, canvas.width, canvas.height] })');
    const checked = size().items.filter((i) => i.checked).map((i) => i.label);
    const saved = ws.load(path.join(t.userData, 'window-state.json'));
    const feetKept = JSON.stringify(ws.feetOf(before)) === JSON.stringify(ws.feetOf(b));
    const windowOk = b.width === g.width && b.height === g.height && feetKept;
    const pageOk = page.scale === s && page.px === k && page.canvas.join() === [g.width, g.height, Math.round(g.width * dpr), Math.round(g.height * dpr)].join();
    const menuOk = checked.join() === label(s) && saved && saved.scale === s;
    check(`  ${label(s)}: window, page, menu, saved`, windowOk && pageOk && menuOk,
      `window ${b.width}x${b.height} (want ${g.width}x${g.height}), feet ${feetKept ? 'kept' : 'MOVED'}; page ${page.scale}x, canvas ${page.canvas[0]}x${page.canvas[1]} pt = ${page.canvas[2]}x${page.canvas[3]} device px; menu ${checked}; saved ${saved && saved.scale}x`);

    const shot = await stableCapture();
    if (!shot) {
      check(`  ${label(s)}: pet drawn at that size`, false, 'no still frame to capture');
      continue;
    }
    const m = measure(shot, k);
    const wantSize = [Math.round(48 * k), Math.round(52 * k)];
    const evenly = Number.isInteger(k);
    const widthsOk = m.widths.every((n) => possible(n, k)) && m.heights.every((n) => possible(n, k));
    const ok = m.capture.width === Math.round(g.width * dpr) && m.size.join() === wantSize.join() && m.off === 0 && m.stray === 0 && m.unmatched === 0 && widthsOk;
    const spread = (list) => [...new Set(list)].sort((a, c) => a - c).join('/');
    check(`  ${label(s)}: pet drawn at that size, sharp`, ok,
      `pet ${m.size[0]}x${m.size[1]} device px = ${m.size[0] / dpr}x${m.size[1] / dpr} pt; art pixels ${evenly ? `all ${k}` : `${Math.floor(k)} or ${Math.ceil(k)}`} device px (runs seen: ${spread(m.widths)} wide, ${spread(m.heights)} tall); ${m.off} pixels off their art colour, ${m.stray} drawn outside the pet`);
  }
  await js("setState('idle')");
});

// window-state.js: sizes, keeping the feet in place, and restoring a saved spot.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ROOT, check, section, summary } = require('../lib.js');
const ws = require(path.join(ROOT, 'window-state.js'));

const laptop = { x: 0, y: 33, width: 1470, height: 923 };   // primary, below the menu bar
const monitor = { x: 1470, y: -200, width: 2560, height: 1415 }; // a second screen to the right
const json = (v) => JSON.stringify(v);

section('sizes');
check('tray order: 1x, 1.5x, 2x, 3x, 4x', ws.SCALES.join() === '1,1.5,2,3,4', ws.SCALES.join(', '));
for (const s of ws.SCALES) {
  const g = ws.geometry(s);
  const whole = [g.width, g.height, g.pet.x, g.pet.y, g.pet.width, g.pet.height].every(Number.isInteger);
  check(`  ${s}x: window ${g.width}x${g.height}, pet at (${g.pet.x},${g.pet.y})`,
    g.width === 64 * s && g.height === 80 * s && g.pet.x === 8 * s && g.pet.y === 28 * s && g.pet.y + g.pet.height === g.height && g.pet.x * 2 + g.pet.width === g.width && whole,
    `pet fills the bottom, centred; ${whole ? 'all whole points' : 'NOT whole points'}`);
}

section('default spot');
{
  const b = ws.defaultBounds(laptop, 4);
  const g = ws.geometry(4);
  check('4x: same spot as before (pet 24 px from the bottom-right)', json(b) === json({ x: 1222, y: 612, width: 256, height: 320 }) &&
    b.x + g.pet.x + g.pet.width === laptop.x + laptop.width - 24 && b.y + b.height === laptop.y + laptop.height - 24, json(b));
  for (const s of ws.SCALES.filter((x) => x !== 4)) {
    const bb = ws.defaultBounds(laptop, s);
    const gg = ws.geometry(s);
    check(`  ${s}x: pet 24 px from the bottom-right too`, bb.x + gg.pet.x + gg.pet.width === laptop.x + laptop.width - 24 && bb.y + bb.height === laptop.y + laptop.height - 24, json(bb));
  }
}

section('changing size keeps the feet in place');
{
  const at4 = { x: 500, y: 400, width: 256, height: 320 };
  const feet = ws.feetOf(at4);
  for (const s of ws.SCALES) {
    const b = ws.boundsAt(feet, s);
    check(`  4x -> ${s}x`, json(ws.feetOf(b)) === json(feet), `feet ${json(feet)} -> ${json(ws.feetOf(b))}, window ${json(b)}`);
  }
  // Through every size and back: no drift, and the same window as at the start.
  const sizes = [4, 1.5, 1, 3, 1.5, 2, 1, 4];
  let b = at4;
  for (const s of sizes.slice(1)) b = ws.boundsAt(ws.feetOf(b), s);
  check(`  ${sizes.map((s) => `${s}x`).join(' -> ')}`, json(b) === json(at4), `ends at ${json(b)}`);
}

section('restoring a saved spot');
const cases = [
  ['nothing saved -> default, 4x', null, [laptop], { scale: 4, restored: false }],
  ['saved spot on screen -> restored', { feet: { x: 700, y: 900 }, scale: 3 }, [laptop], { scale: 3, restored: true, bounds: { x: 604, y: 660, width: 192, height: 240 } }],
  ['saved on the second monitor, still plugged in', { feet: { x: 2500, y: 1000 }, scale: 4 }, [laptop, monitor], { scale: 4, restored: true }],
  ['saved on a monitor that is gone -> default', { feet: { x: 2500, y: 1000 }, scale: 4 }, [laptop], { scale: 4, restored: false, bounds: ws.defaultBounds(laptop, 4) }],
  ['pet mostly off the bottom -> default', { feet: { x: 700, y: 1200 }, scale: 4 }, [laptop], { scale: 4, restored: false }],
  ['off-screen at 2x keeps 2x', { feet: { x: -900, y: 500 }, scale: 2 }, [laptop], { scale: 2, restored: false, bounds: ws.defaultBounds(laptop, 2) }],
  ['saved at 1.5x -> restored at 1.5x', { feet: { x: 700, y: 900 }, scale: 1.5 }, [laptop], { scale: 1.5, restored: true, bounds: { x: 652, y: 780, width: 96, height: 120 } }],
  ['saved at 1x in the default spot -> restored', { feet: ws.feetOf(ws.defaultBounds(laptop, 1)), scale: 1 }, [laptop], { scale: 1, restored: true, bounds: ws.defaultBounds(laptop, 1) }],
  ['off-screen at 1x keeps 1x', { feet: { x: -900, y: 500 }, scale: 1 }, [laptop], { scale: 1, restored: false, bounds: ws.defaultBounds(laptop, 1) }],
  ['unknown size -> 4x', { feet: { x: 700, y: 900 }, scale: 7 }, [laptop], { scale: 4, restored: true }],
  ['damaged values -> default', { feet: { x: 'left', y: null }, scale: 3 }, [laptop], { scale: 3, restored: false }],
];
for (const [label, saved, areas, want] of cases) {
  const got = ws.startBounds(saved, areas, laptop);
  const ok = got.scale === want.scale && got.restored === want.restored && (!want.bounds || json(got.bounds) === json(want.bounds));
  check(`  ${label}`, ok, `${got.scale}x at ${got.bounds.x},${got.bounds.y}${got.restored ? ' (restored)' : ' (default)'}`);
}

section('saving and loading');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terra-state-'));
  const file = path.join(dir, 'window-state.json');
  check('missing file loads as nothing', ws.load(file) === null);
  ws.save(file, { bounds: { x: 604, y: 660, width: 192, height: 240 }, scale: 3 });
  check('saves the feet and size', json(ws.load(file)) === json({ feet: { x: 700, y: 900 }, scale: 3 }), fs.readFileSync(file, 'utf8').replace(/\s+/g, ' '));
  ws.save(file, { bounds: { x: 652, y: 780, width: 96, height: 120 }, scale: 1.5 });
  check('saves 1.5x, and it loads back as 1.5x', json(ws.load(file)) === json({ feet: { x: 700, y: 900 }, scale: 1.5 }) && ws.startBounds(ws.load(file), [laptop], laptop).scale === 1.5,
    fs.readFileSync(file, 'utf8').replace(/\s+/g, ' '));
  fs.writeFileSync(file, '{ damaged');
  check('damaged file loads as nothing', ws.load(file) === null);
  fs.rmSync(dir, { recursive: true, force: true });
}

process.exitCode = summary() ? 1 : 0;

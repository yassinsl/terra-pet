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
for (const s of ws.SCALES) {
  const g = ws.geometry(s);
  check(`  ${s}x: window ${g.width}x${g.height}, pet at (${g.pet.x},${g.pet.y})`,
    g.width === 64 * s && g.height === 80 * s && g.pet.x === 8 * s && g.pet.y === 28 * s && g.pet.y + g.pet.height === g.height && g.pet.x * 2 + g.pet.width === g.width,
    'pet fills the bottom, centred');
}

section('default spot');
{
  const b = ws.defaultBounds(laptop, 4);
  const g = ws.geometry(4);
  check('4x: same spot as before (pet 24 px from the bottom-right)', json(b) === json({ x: 1222, y: 612, width: 256, height: 320 }) &&
    b.x + g.pet.x + g.pet.width === laptop.x + laptop.width - 24 && b.y + b.height === laptop.y + laptop.height - 24, json(b));
  for (const s of [2, 3]) {
    const bb = ws.defaultBounds(laptop, s);
    const gg = ws.geometry(s);
    check(`  ${s}x: pet 24 px from the bottom-right too`, bb.x + gg.pet.x + gg.pet.width === laptop.x + laptop.width - 24 && bb.y + bb.height === laptop.y + laptop.height - 24, json(bb));
  }
}

section('changing size keeps the feet in place');
{
  const at4 = { x: 500, y: 400, width: 256, height: 320 };
  const feet = ws.feetOf(at4);
  for (const s of [2, 3, 4]) {
    const b = ws.boundsAt(feet, s);
    check(`  4x -> ${s}x`, json(ws.feetOf(b)) === json(feet), `feet ${json(feet)} -> ${json(ws.feetOf(b))}, window ${json(b)}`);
  }
}

section('restoring a saved spot');
const cases = [
  ['nothing saved -> default, 4x', null, [laptop], { scale: 4, restored: false }],
  ['saved spot on screen -> restored', { feet: { x: 700, y: 900 }, scale: 3 }, [laptop], { scale: 3, restored: true, bounds: { x: 604, y: 660, width: 192, height: 240 } }],
  ['saved on the second monitor, still plugged in', { feet: { x: 2500, y: 1000 }, scale: 4 }, [laptop, monitor], { scale: 4, restored: true }],
  ['saved on a monitor that is gone -> default', { feet: { x: 2500, y: 1000 }, scale: 4 }, [laptop], { scale: 4, restored: false, bounds: ws.defaultBounds(laptop, 4) }],
  ['pet mostly off the bottom -> default', { feet: { x: 700, y: 1200 }, scale: 4 }, [laptop], { scale: 4, restored: false }],
  ['off-screen at 2x keeps 2x', { feet: { x: -900, y: 500 }, scale: 2 }, [laptop], { scale: 2, restored: false, bounds: ws.defaultBounds(laptop, 2) }],
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
  fs.writeFileSync(file, '{ damaged');
  check('damaged file loads as nothing', ws.load(file) === null);
  fs.rmSync(dir, { recursive: true, force: true });
}

process.exitCode = summary() ? 1 : 0;

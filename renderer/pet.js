const CELL_W = 48;
const CELL_H = 52;
const SCALE = 4;

// Row 0 of the sheet: idle, 4 frames, 180 ms each, looping.
const IDLE = { row: 0, frames: 4, frameMs: 180 };

const canvas = document.getElementById('pet');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

const sheet = new Image();
sheet.src = '../Bot/spritesheet-x1.png';
sheet.onerror = () => console.error('Could not load sprite sheet:', sheet.src);
sheet.onload = () => requestAnimationFrame(tick);

let lastFrame = -1;

function tick(now) {
  const frame = Math.floor(now / IDLE.frameMs) % IDLE.frames;
  if (frame !== lastFrame) {
    lastFrame = frame;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(
      sheet,
      frame * CELL_W, IDLE.row * CELL_H, CELL_W, CELL_H,
      0, 0, CELL_W * SCALE, CELL_H * SCALE,
    );
  }
  requestAnimationFrame(tick);
}

// Dragging: remember where inside the window the pointer went down,
// then keep that point under the pointer as it moves.
let grab = null;

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  grab = { x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add('dragging');
});

canvas.addEventListener('pointermove', (e) => {
  if (!grab) return;
  window.terra.moveWindow(e.screenX - grab.x, e.screenY - grab.y);
});

function endDrag() {
  grab = null;
  canvas.classList.remove('dragging');
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

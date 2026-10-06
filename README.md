# Terra

A pixel-art desktop pet for macOS, built with Electron.

Right now it shows Terra's idle animation in a small transparent window that
stays on top. You can drag Terra anywhere on screen. Quit from the menu bar icon.

## Run

Requires Node.js and npm.

```sh
npm install
npm start
```

## Layout

- `main.js`: window, tray icon, and moving the window while you drag
- `preload.js`: lets the page tell the main process where to move the window
- `renderer/index.html`, `renderer/pet.js`: canvas that draws the animation
- `Bot/`: art. The app uses `Bot/spritesheet-x1.png` (48x52 cells, 8 columns, 19 rows; row 0 is idle)

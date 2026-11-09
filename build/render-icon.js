// build/icon.svg → build/icon.png (1024, 투명 배경) — Electron 오프스크린 렌더
// 사용: npx electron build/render-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  win.webContents.setFrameRate(1);
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`;
  let done = false;
  let loaded = false;
  win.webContents.on('did-finish-load', () => {
    loaded = true;
    setTimeout(() => win.webContents.invalidate(), 400);
  });
  win.webContents.on('paint', (_e, _dirty, image) => {
    if (done || !loaded) return;
    const size = image.getSize();
    if (size.width < 1000) return;
    done = true;
    fs.writeFileSync(path.join(__dirname, 'icon.png'), image.resize({ width: 1024, height: 1024 }).toPNG());
    console.log('icon.png written', size);
    app.quit();
  });
  const tmp = path.join(require('os').tmpdir(), 'composer-icon.html');
  fs.writeFileSync(tmp, html);
  await win.loadFile(tmp);
  setTimeout(() => app.quit(), 8000);
});

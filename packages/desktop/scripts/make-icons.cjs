/**
 * Rasterises the logo master into the PNG set and packs a Windows .ico.
 * Renders once at 512 on a transparent ground through a real engine, then
 * resamples down — one render, and every size lands from the same pixels.
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const { writeFileSync, mkdirSync, readFileSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const OUT = path.join(__dirname, '..', 'icons');
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const svg = readFileSync(`${ROOT}/brand/assets/logo/adjent-logo.svg`, 'utf8');

/** ICO container: a directory of PNG-compressed entries (Windows Vista and later). */
function packIco(entries) {
  const dir = Buffer.alloc(6 + entries.length * 16);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(entries.length, 4);
  let offset = dir.length;
  entries.forEach((e, i) => {
    const o = 6 + i * 16;
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o);
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });
  return Buffer.concat([dir, ...entries.map((e) => e.png)]);
}

app.whenReady().then(async () => {
  try {
    mkdirSync(OUT, { recursive: true });
    const N = 512;
    const html = `<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;background:transparent;overflow:hidden;}
      svg{display:block;}
    </style>${svg.replace('width="128" height="128"', `width="${N}" height="${N}"`)}`;
    const file = path.join(app.getPath('temp'), 'adjent-icon.html');
    writeFileSync(file, html);

    const win = new BrowserWindow({
      width: N,
      height: N,
      show: false,
      transparent: true,
      frame: false,
      useContentSize: true,
      backgroundColor: '#00000000',
    });
    await win.loadFile(file);
    await new Promise((r) => setTimeout(r, 600));
    const master = await win.webContents.capturePage();
    win.destroy();

    const pngs = {};
    for (const size of SIZES) {
      const img = size === N ? master : master.resize({ width: size, height: size, quality: 'best' });
      const png = img.toPNG();
      pngs[size] = png;
      writeFileSync(`${OUT}/icon-${size}.png`, png);
    }
    writeFileSync(`${OUT}/icon.png`, pngs[512]);
    writeFileSync(`${OUT}/icon.ico`, packIco(ICO_SIZES.map((s) => ({ size: s, png: pngs[s] }))));
    console.log('ok: master', master.getSize().width + 'x' + master.getSize().height, '->', SIZES.join(','), '+ icon.ico');
  } catch (err) {
    console.error('FAILED:', err);
    process.exitCode = 1;
  }
  app.quit();
});

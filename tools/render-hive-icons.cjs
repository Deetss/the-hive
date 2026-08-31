const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const svgPath = path.join(ROOT, 'build', 'icon.svg');
const svgContent = fs.readFileSync(svgPath, 'utf8');
const base64Svg = Buffer.from(svgContent).toString('base64');
const dataUrl = 'data:image/svg+xml;base64,' + base64Svg;

function buildIco(pngs) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type 1 = icon
  dir.writeUInt16LE(pngs.length, 4); // count
  
  let offset = 6 + pngs.length * 16;
  const entries = [];
  const bodies = [];
  
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // width (0 = 256)
    e[1] = size >= 256 ? 0 : size; // height
    e[2] = 0; // color palette
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8); // image size
    e.writeUInt32LE(offset, 12); // offset
    entries.push(e);
    bodies.push(data);
    offset += data.length;
  }
  return Buffer.concat([dir, ...entries, ...bodies]);
}

function buildIcns(entries) {
  const chunks = [];
  for (const { tag, data } of entries) {
    const header = Buffer.alloc(8);
    header.write(tag, 0, 4, 'ascii');
    header.writeUInt32BE(data.length + 8, 4);
    chunks.push(header, data);
  }
  const body = Buffer.concat(chunks);
  const fileHeader = Buffer.alloc(8);
  fileHeader.write('icns', 0, 4, 'ascii');
  fileHeader.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([fileHeader, body]);
}

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: 1024,
      height: 1024,
      show: false,
      frame: false,
      transparent: true,
      webPreferences: {
        offscreen: true
      }
    });

    const html = `<!DOCTYPE html>
<html>
<head>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 1024px; height: 1024px; overflow: hidden; background: transparent; }
    img { width: 1024px; height: 1024px; display: block; }
  </style>
</head>
<body>
  <img src="${dataUrl}" />
</body>
</html>`;

    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise(r => setTimeout(r, 600));

    const masterImage = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
    const masterPng = masterImage.toPNG();
    console.log(`[IconGen] Master 1024x1024 captured (${masterPng.length} bytes)`);

    // 1. build/icon.png (1024x1024)
    fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), masterPng);
    console.log('[IconGen] Written build/icon.png (1024x1024)');

    // 2. docs/logo.png (512x512)
    const img512 = masterImage.resize({ width: 512, height: 512, quality: 'best' });
    const png512 = img512.toPNG();
    fs.writeFileSync(path.join(ROOT, 'docs', 'logo.png'), png512);
    console.log('[IconGen] Written docs/logo.png (512x512)');

    // 3. docs/logo-light.png (512x512)
    fs.writeFileSync(path.join(ROOT, 'docs', 'logo-light.png'), png512);
    console.log('[IconGen] Written docs/logo-light.png (512x512)');

    // 4. docs/apple-touch-icon.png (180x180)
    const img180 = masterImage.resize({ width: 180, height: 180, quality: 'best' });
    fs.writeFileSync(path.join(ROOT, 'docs', 'apple-touch-icon.png'), img180.toPNG());
    console.log('[IconGen] Written docs/apple-touch-icon.png (180x180)');

    // 5. docs/favicon-32.png (32x32)
    const img32 = masterImage.resize({ width: 32, height: 32, quality: 'best' });
    const png32 = img32.toPNG();
    fs.writeFileSync(path.join(ROOT, 'docs', 'favicon-32.png'), png32);
    console.log('[IconGen] Written docs/favicon-32.png (32x32)');

    // 6. Windows ICO with sizes 256, 128, 64, 48, 32, 16
    const icoSizes = [256, 128, 64, 48, 32, 16];
    const icoPngs = icoSizes.map(size => {
      const resized = masterImage.resize({ width: size, height: size, quality: 'best' });
      return {
        size,
        data: resized.toPNG()
      };
    });

    const icoBuffer = buildIco(icoPngs);
    fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), icoBuffer);
    console.log(`[IconGen] Written build/icon.ico (${icoBuffer.length} bytes with ${icoSizes.join(',')}px)`);

    // 7. macOS ICNS (icp4=16, icp5=32, icp6=64, ic07=128, ic08=256, ic09=512, ic10=1024)
    const img256 = masterImage.resize({ width: 256, height: 256, quality: 'best' }).toPNG();
    const img128 = masterImage.resize({ width: 128, height: 128, quality: 'best' }).toPNG();
    const img64 = masterImage.resize({ width: 64, height: 64, quality: 'best' }).toPNG();
    const img16 = masterImage.resize({ width: 16, height: 16, quality: 'best' }).toPNG();

    const icnsEntries = [
      { tag: 'ic10', data: masterPng }, // 1024x1024 / 512@2x
      { tag: 'ic09', data: png512 },    // 512x512
      { tag: 'ic08', data: img256 },    // 256x256
      { tag: 'ic07', data: img128 },    // 128x128
      { tag: 'icp6', data: img64 },     // 64x64
      { tag: 'icp5', data: png32 },     // 32x32
      { tag: 'icp4', data: img16 }      // 16x16
    ];
    const icnsBuffer = buildIcns(icnsEntries);
    fs.writeFileSync(path.join(ROOT, 'build', 'icon.icns'), icnsBuffer);
    console.log(`[IconGen] Written build/icon.icns (${icnsBuffer.length} bytes)`);

    win.close();
    console.log('[IconGen] All icon rasters & packages successfully generated!');
    app.quit();
  } catch (err) {
    console.error('[IconGen] Error generating icons:', err);
    app.exit(1);
  }
});

// Renders build/icon.svg into the PNG/ICO assets electron-builder and the tray use.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pngToIco = require('png-to-ico').default || require('png-to-ico');

(async () => {
  const dir = path.join(__dirname, '..', 'build');
  const svg = fs.readFileSync(path.join(dir, 'icon.svg'));
  const render = (size) => sharp(svg, { density: 384 }).resize(size, size).png().toBuffer();
  fs.writeFileSync(path.join(dir, 'icon.png'), await render(512));
  fs.writeFileSync(path.join(dir, 'tray.png'), await render(32));
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = await Promise.all(sizes.map(render));
  fs.writeFileSync(path.join(dir, 'icon.ico'), await pngToIco(pngs));
  console.log('icons written');
})();

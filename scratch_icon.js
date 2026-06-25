const sharp = require('sharp');
const path = require('path');

const BG = { r: 0x2b, g: 0x2b, b: 0x2b, alpha: 1 };
const srcLogo = 'public/icons/icon-512.png';

async function make(size, file) {
  // safe zone: logo occupies ~70% of canvas, centered (good for maskable)
  const logoSize = Math.round(size * 0.66);
  const logo = await sharp(srcLogo)
    .resize(logoSize, logoSize, { fit: 'contain', background: { r:0,g:0,b:0,alpha:0 } })
    .toBuffer();

  await sharp({
    create: { width: size, height: size, channels: 4, background: BG }
  })
    .composite([{ input: logo, gravity: 'center' }])
    .png()
    .toFile(file);
  console.log('wrote', file);
}

(async () => {
  await make(192, 'public/icons/icon-192.png');
  await make(512, 'public/icons/icon-512.png');
})();

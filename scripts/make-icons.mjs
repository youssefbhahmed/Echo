// Renders PWA icons from the ECHO mark. Usage: node scripts/make-icons.mjs
import { chromium } from 'playwright';
const mark = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#0c0b10"/><g transform="translate(32 32) scale(${pad}) translate(-32 -32)"><circle cx="32" cy="32" r="6" fill="#ff8a5b"/><circle cx="32" cy="32" r="13" fill="none" stroke="#ff8a5b" stroke-opacity=".7" stroke-width="2.5"/><circle cx="32" cy="32" r="20" fill="none" stroke="#ff8a5b" stroke-opacity=".42" stroke-width="2.5"/><circle cx="32" cy="32" r="27" fill="none" stroke="#ff8a5b" stroke-opacity=".2" stroke-width="2.5"/></g></svg>`;
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await browser.newPage();
for (const [file, size, pad] of [['public/icons/icon-192.png', 192, 0.86], ['public/icons/icon-512.png', 512, 0.86], ['public/icons/maskable-512.png', 512, 0.62], ['public/apple-touch-icon.png', 180, 0.8]]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0">${mark(pad).replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: file, omitBackground: false });
}
await browser.close();
console.log('icons written');

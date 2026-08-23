import { chromium } from '/Users/xiaoge/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs';
import fs from 'node:fs';

const [premium, outPath, mode, theme, w, h] = process.argv.slice(2);
const viewport = mode === 'mobile'
  ? { width: Number(w || 390), height: Number(h || 844) }
  : { width: Number(w || 1234), height: Number(h || 960) };

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport });

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.evaluate((t) => {
  localStorage.setItem('theme', t);
  localStorage.setItem('currency', 'USD');
}, theme || 'light');
await page.reload({ waitUntil: 'networkidle' });

await page.fill('#price', '66');
await page.selectOption('#currency', 'USD');
await page.fill('#customRate', '6.743');
await page.fill('#dueDate', '2026-11-27');
await page.fill('#tradeDate', '2026-08-24');
await page.fill('#premiumInput', premium);
await page.waitForTimeout(300);

await page.click('#imgBtn');
await page.waitForSelector('#generatedImage:not(.hidden)', { timeout: 15000 });
await page.waitForFunction(() => {
  const img = document.getElementById('generatedImage');
  return img && !img.classList.contains('hidden') && img.src;
}, { timeout: 15000 });

const dataUrl = await page.evaluate(async () => {
  const img = document.getElementById('generatedImage');
  const res = await fetch(img.src);
  const blob = await res.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
});

fs.writeFileSync(outPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
console.log('saved', outPath, fs.statSync(outPath).size);

await browser.close();

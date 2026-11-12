/* 真实键盘输入探针：用 puppeteer-core 驱动本机 Edge，模拟用户点击 + 打字 */
const puppeteer = require('puppeteer-core');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const URL = 'file:///E:/FormulaEditor/src/index.html';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--allow-file-access-from-files']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 470 });

  const logs = [];
  page.on('pageerror', e => logs.push('[pageerror] ' + e.message));
  page.on('requestfailed', r => logs.push('[reqfail] ' + r.url()));

  await page.goto(URL, { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 900));

  const val = () => page.evaluate(() => document.getElementById('mf').getValue('latex'));
  const focusState = () => page.evaluate(() => ({
    active: document.activeElement && document.activeElement.tagName,
    ring: document.body.classList.contains('focused')
  }));

  const step = async (label, fn) => {
    await page.evaluate(() => { const mf = document.getElementById('mf'); mf.value = ''; });
    await fn();
    await new Promise(r => setTimeout(r, 250));
    const v = await val();
    const f = await focusState();
    logs.push(label + ' => ' + JSON.stringify(v) + '  [active=' + f.active + ' ring=' + f.ring + ']');
  };

  // 1. 正常聚焦打字（打完 Enter 才转换）
  await step('聚焦后打 #alpha + Enter', async () => {
    await page.evaluate(() => document.getElementById('mf').focus());
    await page.keyboard.type('#alpha');
    await page.keyboard.press('Enter');
  });

  // 2. 焦点丢失（点了标题栏），直接打字 —— 兜底应抢回焦点
  await step('失焦后直接打 ab', async () => {
    await page.evaluate(() => document.getElementById('mf').blur());
    await page.mouse.click(60, 18);
    await page.keyboard.type('ab');
  });

  // 3. 中文输入法全角（模拟 IME 上屏，走 beforeinput）
  await step('全角 ＃alpha + Enter', async () => {
    await page.evaluate(() => document.getElementById('mf').focus());
    await page.keyboard.type('＃alpha');
    await page.keyboard.press('Enter');
  });

  // 4. 变量
  await step('##Tom##', async () => {
    await page.evaluate(() => document.getElementById('mf').focus());
    await page.keyboard.type('##Tom##');
  });

  // 5. 候选条 + 空格上屏
  await step('x+#al 空格上屏', async () => {
    await page.evaluate(() => document.getElementById('mf').focus());
    await page.keyboard.type('x+#al');
    await new Promise(r => setTimeout(r, 200));
    await page.keyboard.press('Space');
  });

  console.log(logs.join('\n'));
  await browser.close();
})();

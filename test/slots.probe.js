/* 结构触发后能否直接在空槽里输入，Tab 能否跳到下一格 */
const puppeteer = require('puppeteer-core');
const EDGE = 'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--allow-file-access-from-files'] });
  const p = await b.newPage();
  p.on('pageerror', e => console.log('[pageerror] ' + e.message));
  await p.goto('file:///E:/FormulaEditor/src/index.html', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 900));
  const v = () => p.evaluate(() => __FE.latex());
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const reset = async () => { await p.evaluate(() => { const mf = __FE.mf; mf.blur(); mf.value = ''; mf.focus(); mf.executeCommand(['moveToMathfieldStart']); }); await wait(60); };
  const type = async (s) => { await p.keyboard.type(s, { delay: 30 }); await wait(80); };

  // 打完码要按确认键才转换，转换完等 pendingSlot 落位
  const direct = async (code) => { await type(code); await p.keyboard.press('Enter'); await wait(320); };

  const cases = [
    ['#-- a Tab b', '\\frac{a}{b}', async () => { await direct('#--'); await type('a'); await p.keyboard.press('Tab'); await wait(60); await type('b'); }],
    ['#S 0 Tab 1', '\\int_{0}^{1}', async () => { await type('#S '); await wait(200); await type('0'); await p.keyboard.press('Tab'); await wait(60); await type('1'); }],
    ['#s 0 Tab 1', '\\int_{0}^{1}', async () => { await type('#s '); await wait(200); await type('0'); await p.keyboard.press('Tab'); await wait(60); await type('1'); }],
    ['#II 0 Tab n', '\\prod_{0}^{n}', async () => { await type('#II '); await wait(200); await type('0'); await p.keyboard.press('Tab'); await wait(60); await type('n'); }]
  ];
  let fail = 0;
  for (const [label, want, run] of cases) {
    await reset();
    await run();
    const got = await v();
    // MathLive 会把单字符上下标的花括号省掉（\int_{0}^{1} → \int_0^1），比较时统一去掉
    const norm = (s) => s.replace(/[{}]/g, '');
    const ok = norm(got).includes(norm(want));
    if (!ok) fail++;
    console.log((ok ? '  ok   ' : '  FAIL ') + label.padEnd(16) + ' => ' + JSON.stringify(got));
  }
  console.log(fail ? fail + ' 项失败' : '槽位全部正确');
  await b.close();
  process.exit(fail ? 1 : 0);
})();

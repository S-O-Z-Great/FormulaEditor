/* 结构填充回归：矩阵 / 行列式 / 分段函数 / 取整 / n 次根
 *
 * 这几条曾经是「生成了结构，但格子里没有占位符」，于是插入后光标停在结构外面，
 * 打进去的字符全跑到矩阵右边（#m2 → "\begin{pmatrix}&\end{pmatrix}12"）。
 * 单测只断言 LaTeX 原文，抓不到这种事；只有真键盘敲一遍才看得见，所以单独放一个探针。
 */
const puppeteer = require('puppeteer-core');

const path = require('node:path');
// 页面地址按探针自己的位置算：项目拷到任何盘符 / 目录都能跑
const FE_PAGE = 'file:///' + path.resolve(__dirname, '..', 'src', 'index.html').replace(/\\/g, '/');
const EDGE = process.env.FE_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--allow-file-access-from-files']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 470 });

  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  await page.goto(FE_PAGE, { waitUntil: 'networkidle2' });
  await wait(900);

  const fails = [];
  const latex = () => page.evaluate(() => document.getElementById('mf').getValue('latex'));
  const clean = () => page.evaluate(() => window.__FE.clean(document.getElementById('mf').getValue('latex')));
  const sq = (s) => String(s).replace(/\s/g, '');

  const reset = async () => {
    await page.evaluate(() => {
      if (window.__FE) window.__FE.endIme();
      const mf = document.getElementById('mf');
      mf.blur(); mf.value = ''; mf.focus();
      mf.executeCommand(['moveToMathfieldStart']);
    });
    await wait(60);
  };

  // '\n' 回车确认，'\t' Tab 换格，其余逐字敲
  async function type(text) {
    for (const ch of text) {
      if (ch === '\n') await page.keyboard.press('Enter');
      else if (ch === '\t') await page.keyboard.press('Tab');
      else await page.keyboard.type(ch);
      await wait(50);
    }
    await wait(180);
  }

  async function check(name, keys, test, want) {
    await reset();
    await type(keys);
    const v = await latex();
    const ok = test(v);
    console.log((ok ? '  ok   ' : '  FAIL ') + name + '  → ' + JSON.stringify(v));
    if (!ok) fails.push(name + ' → ' + v + (want ? '（期望 ' + want + '）' : ''));
  }

  console.log('\n[1] 矩阵：四个格子都能填');
  await check('#m2 四格填满', '#m2\n1\t2\t3\t4',
    (v) => /\\begin\{pmatrix\}1&2\\\\3&4\\end\{pmatrix\}/.test(sq(v)));
  await check('#m2 字符不落在矩阵外', '#m2\n1\t2',
    (v) => !/\\end\{pmatrix\}\s*[0-9]/.test(sq(v)));

  console.log('\n[2] 行列式');
  await check('#|| 四格填满', '#||\na\tb\tc\td',
    (v) => /\\begin\{vmatrix\}a&b\\\\c&d\\end\{vmatrix\}/.test(sq(v)));

  console.log('\n[3] 分段函数');
  await check('#{ 两行都能填', '#{\nx\ty',
    (v) => /\\begin\{cases\}x\\\\y\\end\{cases\}/.test(sq(v)));
  // 注意 #{2 的确认要用回车：敲 Tab 时「2」还没打进去，Tab 会先把 #{ 提交成两行骨架，
  // 那个 2 就落到结构外面了。实体确认符看 confirm，不是换格键。
  await check('#{2 两行都能填', '#{2\na\tb',
    (v) => /\\begin\{cases\}a\\\\b\\end\{cases\}/.test(sq(v)));
  console.log('\n[4] 取整：内容要落在括号里面');
  await check('#[[ 5 在 ⌊ ⌋ 内', '#[[\n5',
    (v) => /\\lfloor5\\rfloor/.test(sq(v)));
  await check('#]] 7 在 ⌈ ⌉ 内', '#]]\n7',
    (v) => /\\lceil7\\rceil/.test(sq(v)));

  console.log('\n[5] n 次根：次数位与被开方数分开');
  await check('#vn Tab 到被开方数', '#vn\n3\t8',
    (v) => /\\sqrt\[3\]\{8\}/.test(sq(v)));
  await check('#vn 只填次数', '#vn\n3',
    (v) => /\\sqrt\[3\]\{/.test(sq(v)));

  console.log('\n[6] 导出清洗：不留内部痕迹');
  await reset();
  await type('#m2\n1\t2\t3\t4');
  const ex = await clean();
  console.log('  #m2 导出 → ' + JSON.stringify(ex));
  const exOk = ex.indexOf('placeholder') < 0 && ex.indexOf('htmlData') < 0;
  console.log((exOk ? '  ok   ' : '  FAIL ') + '导出不含 placeholder / htmlData');
  if (!exOk) fails.push('矩阵导出不干净 → ' + ex);

  console.log('\n[7] 回归：分式 / 积分 / 组合数不受影响');
  await check('#-- 分式', '#--\na\tb', (v) => /\\frac\{a\}\{b\}/.test(sq(v)));
  await check('#S 积分', '#S\n0\t1', (v) => /\\int_0\^1|\\int_\{0\}\^\{1\}/.test(sq(v)));
  await check('#C 组合数', '#C\nn\tk', (v) => /\\binom\{n\}\{k\}/.test(sq(v)));
  await check('#sqrt 根号', '#v\na', (v) => /\\sqrt\{a\}/.test(sq(v)));

  console.log('\n[8] 运行期异常');
  console.log((errs.length === 0 ? '  ok   ' : '  FAIL ') + '无未捕获异常' + (errs.length ? ' → ' + JSON.stringify(errs) : ''));
  if (errs.length) fails.push('pageerror: ' + errs.join('; '));

  console.log('\n' + (fails.length ? '失败 ' + fails.length + ' 项' : '结构填充全部正确'));
  fails.forEach((f) => console.log('   * ' + f));

  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();

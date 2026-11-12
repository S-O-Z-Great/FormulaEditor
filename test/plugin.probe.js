/* 插件模式回归：Enter 是否真的把「纯文本 + 富文本 + 图片」三件套交给剪贴板
 *
 * 不开 Electron，用 puppeteer 在 Edge 里跑：
 *   - evaluateOnNewDocument 塞一个假桥接 window.fe（insert / png / hide）
 *   - 同时把 navigator.clipboard 换成一个记录器，拦住真正写剪贴板的调用
 */
const puppeteer = require('puppeteer-core');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PAGE = 'file:///E:/FormulaEditor/src/index.html?plugin=1';
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 880, height: 340 });

  // 必须在页面脚本之前注进去：renderer.js 一加载就要读 window.fe.plugin
  await page.evaluateOnNewDocument(() => {
    window.__calls = { clip: [], png: 0, hide: 0, close: 0, insert: 0, remember: [], pngOpts: [] };
    // 假宿主：默认认不出来，好让老用例保持「三件套全给」的语义
    window.__host = { hwnd: '12345', proc: '', cls: '', remembered: {} };
    window.fe = {
      plugin: true,
      insert: async () => { window.__calls.insert++; return { ok: true, pasted: true }; },
      png: async (latex, opts) => {
        window.__calls.png++;
        window.__calls.pngOpts.push(opts || {});
        return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      },
      hide: () => { window.__calls.hide++; },
      close: () => { window.__calls.close++; },
      minimize: () => {},
      settings: async () => ({ hotkey: 'Alt+Q' }),
      host: async () => window.__host,
      remember: async (proc, fmt) => {
        window.__calls.remember.push([proc, fmt]);
        const m = Object.assign({}, window.__host.remembered);
        if (!fmt || fmt === 'auto') delete m[proc]; else m[proc] = fmt;
        window.__host.remembered = m;
        return m;
      },
      onFocus: (cb) => { window.__feFocus = cb; },
      onNotice: () => {}
    };

    // 记录型剪贴板：不真的写系统剪贴板，只把提交的 MIME 和内容留下来
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        write: async (items) => {
          const it = items[0];
          const rec = { types: Array.from(it.types) };
          for (const t of rec.types) {
            try { rec[t] = await (await it.getType(t)).text(); } catch (e) { rec[t] = '<binary>'; }
          }
          window.__calls.clip.push(rec);
        },
        writeText: async (t) => {
          window.__calls.clip.push({ types: ['text/plain'], 'text/plain': t });
        }
      }
    });
  });

  await page.goto(PAGE, { waitUntil: 'networkidle2' });
  await wait(900);

  const fails = [];
  const ok = (name, cond, extra) => {
    if (cond) console.log('  ok   ' + name);
    else { fails.push(name); console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
  };

  const calls = () => page.evaluate(() => window.__calls);
  const reset = async () => {
    await page.evaluate(() => {
      window.__calls.clip = [];
      window.__calls.png = 0;
      window.__calls.pngOpts = [];
      window.__calls.hide = 0;
      window.__calls.insert = 0;
      document.getElementById('mf').value = '\\mathrm{H_2SO_4}';
      document.getElementById('mf').focus();
    });
    await wait(150);
  };
  const pick = async (fmt) => {
    await page.evaluate((f) => {
      const b = document.querySelector('#formats button[data-fmt="' + f + '"]');
      if (b) b.click();
      document.getElementById('mf').focus();
    }, fmt);
    await wait(150);
  };

  /** 换宿主 —— 等价于面板在另一个软件前面被唤出 */
  const setHost = async (proc, cls) => {
    await page.evaluate((p, c) => {
      window.__host = { hwnd: '12345', proc: p, cls: c || '', remembered: window.__host.remembered };
      if (window.__feFocus) window.__feFocus(window.__host);
    }, proc, cls || '');
    await wait(250);
  };

  const targetText = () => page.evaluate(() => {
    const el = document.getElementById('target');
    return { text: el.textContent, hidden: el.hidden, warn: el.classList.contains('warn') };
  });

  const typesOf = (r) => (r && r.types) || [];
  const last = (arr) => arr[arr.length - 1];

  console.log('插件模式回归');

  /* 1. 界面换装 */
  const ui = await page.evaluate(() => ({
    cls: document.body.className,
    fmts: Array.prototype.map.call(document.querySelectorAll('#formats button'), b => b.dataset.fmt),
    hasIns: !!document.querySelector('.ins-btn'),
    hasMin: !!document.getElementById('btnMin'),
    hints: document.getElementById('hints').textContent,
    hintsHidden: getComputedStyle(document.getElementById('bgHints')).display
  }));
  ok('body 带上 plugin 类', /\bplugin\b/.test(ui.cls));
  ok('格式按钮换成 自动/纯文本/图片', ui.fmts.join(',') === 'auto,text,png', ui.fmts.join(','));
  ok('出现「插入」按钮、去掉最小化', ui.hasIns && !ui.hasMin);
  ok('按键提示已精简（不再提 Ctrl K）', ui.hints.indexOf('Ctrl') < 0 && ui.hints.indexOf('插入') >= 0, ui.hints);
  ok('小窗不铺速查底纹', ui.hintsHidden === 'none', ui.hintsHidden);

  /* 2. 自动模式：三件套一起写 */
  await reset();
  await page.keyboard.press('Enter');
  await wait(600);
  let c = await calls();
  ok('自动模式写一次剪贴板', c.clip.length === 1, '写了 ' + c.clip.length + ' 次');
  const rec = c.clip[0] || { types: [] };
  ok('带 text/plain', rec.types.indexOf('text/plain') >= 0 && String(rec['text/plain']).indexOf('H_2SO_4') >= 0,
    JSON.stringify(rec['text/plain']));
  ok('带 text/html（MathML）', rec.types.indexOf('text/html') >= 0 && String(rec['text/html']).indexOf('<math') >= 0,
    String(rec['text/html']).slice(0, 50));
  ok('带 image/png', rec.types.indexOf('image/png') >= 0);
  ok('出图只做一次', c.png === 1, 'png 调用 ' + c.png + ' 次');
  ok('写完后通知主进程插入', c.insert === 1);
  ok('Enter 后没自己关窗口', c.close === 0 && c.hide === 0);

  /* 3. 纯文本模式 */
  await reset();
  await pick('text');
  await page.keyboard.press('Enter');
  await wait(500);
  c = await calls();
  ok('纯文本模式只给 text/plain', c.clip.length === 1 && c.clip[0].types.length === 1 &&
    c.clip[0].types[0] === 'text/plain', JSON.stringify(c.clip[0] && c.clip[0].types));
  ok('纯文本模式不出图', c.png === 0);

  /* 4. 图片模式 */
  await reset();
  await pick('png');
  await page.keyboard.press('Enter');
  await wait(600);
  c = await calls();
  ok('图片模式带 image/png', c.clip.length === 1 && c.clip[0].types.indexOf('image/png') >= 0,
    JSON.stringify(c.clip[0] && c.clip[0].types));

  /* 5. Esc 收起而不是退出 */
  await reset();
  await page.keyboard.press('Escape');
  await wait(300);
  c = await calls();
  ok('Esc 调 hide、不调 close', c.hide === 1 && c.close === 0, 'hide=' + c.hide + ' close=' + c.close);

  /* 6. 空内容不交差 */
  await page.evaluate(() => { document.getElementById('mf').value = ''; document.getElementById('mf').focus(); });
  await wait(200);
  await page.keyboard.press('Enter');
  await wait(400);
  c = await calls();
  ok('空公式按 Enter 不动剪贴板', c.clip.length === 0 && c.insert === 0);

  /* 7. 按宿主定格式 —— 这一批的核心 */
  await setHost('wps', 'KWPSFrame');
  await reset();
  await page.keyboard.press('Enter');
  await wait(700);
  c = await calls();
  let r = c.clip[0] || { types: [] };
  ok('WPS：给白底图片', typesOf(r).indexOf('image/png') >= 0, JSON.stringify(typesOf(r)));
  ok('WPS：绝不给 HTML（它只认 OMML，给 MathML 会吐空白）',
    typesOf(r).indexOf('text/html') < 0, JSON.stringify(typesOf(r)));
  ok('WPS：出图用白底', (c.pngOpts[0] || {}).bg === 'white', JSON.stringify(c.pngOpts[0]));
  ok('WPS：纯文本是裸 LaTeX', String(r['text/plain']).charAt(0) !== '$', String(r['text/plain']).slice(0, 24));
  let tg = await targetText();
  ok('标题栏写着 WPS 和白底图片', /WPS/.test(tg.text) && /白底图片/.test(tg.text), tg.text);

  await setHost('notepad', 'Notepad');
  await reset();
  await page.keyboard.press('Enter');
  await wait(500);
  c = await calls();
  ok('记事本：只给 text/plain', typesOf(c.clip[0]).join(',') === 'text/plain', JSON.stringify(typesOf(c.clip[0])));
  ok('记事本：不出图、不出富文本', c.png === 0);

  await setHost('chrome', 'Chrome_WidgetWin_1');
  await reset();
  await page.keyboard.press('Enter');
  await wait(600);
  c = await calls();
  r = c.clip[0] || { types: [] };
  ok('浏览器：给 MathML', typesOf(r).indexOf('text/html') >= 0 &&
    String(r['text/html']).indexOf('<math') >= 0, String(r['text/html']).slice(0, 40));
  ok('浏览器：纯文本带 $ 定界符', String(r['text/plain']).charAt(0) === '$' &&
    String(r['text/plain']).slice(-1) === '$', String(r['text/plain']).slice(0, 24));
  ok('浏览器：不出图', c.png === 0);

  await setHost('Code', 'Chrome_WidgetWin_1');
  await reset();
  await page.keyboard.press('Enter');
  await wait(500);
  c = await calls();
  r = c.clip[0] || { types: [] };
  ok('VSCode：只给文本、带 $、不出图', typesOf(r).join(',') === 'text/plain' &&
    String(r['text/plain']).charAt(0) === '$' && c.png === 0, JSON.stringify(typesOf(r)));

  await setHost('', '');
  tg = await targetText();
  ok('认不出宿主时写「目标未知」并变橙', tg.warn === true && /目标未知/.test(tg.text), tg.text + ' warn=' + tg.warn);

  /* 8. 手动改过一次就记住 */
  await setHost('wps', 'KWPSFrame');
  await pick('text');
  c = await calls();
  ok('手动改格式会按进程名记住', JSON.stringify(last(c.remember)) === JSON.stringify(['wps', 'text']),
    JSON.stringify(last(c.remember)));

  await reset();
  await page.keyboard.press('Enter');
  await wait(500);
  c = await calls();
  ok('记住之后 WPS 不再出图', c.png === 0 && typesOf(c.clip[0]).join(',') === 'text/plain',
    JSON.stringify(typesOf(c.clip[0])));

  await setHost('wps', 'KWPSFrame');   // 模拟下一次唤出
  const onBtn = await page.evaluate(() => {
    const b = document.querySelector('#formats button.on');
    return b ? b.dataset.fmt : '';
  });
  ok('重新唤出时按钮停在记住的格式上', onBtn === 'text', onBtn);

  await pick('auto');
  c = await calls();
  ok('点回「自动」会清掉这条记忆', last(c.remember)[1] === 'auto', JSON.stringify(last(c.remember)));
  await reset();
  await page.keyboard.press('Enter');
  await wait(600);
  c = await calls();
  ok('清掉记忆后 WPS 恢复出图', c.png === 1, 'png 调用 ' + c.png + ' 次');

  await browser.close();
  console.log(fails.length ? '\n失败 ' + fails.length + ' 项：' + fails.join('、') : '\n全部通过');
  process.exit(fails.length ? 1 : 0);
})();

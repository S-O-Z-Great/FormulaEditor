/**
 * 主进程 —— 常驻托盘的「随时输入公式」工具
 *
 * 形态：不占任务栏、没有主窗口，按 Ctrl+Alt+Q 在鼠标附近弹出一个无边框面板，
 *       编完按 Enter，窗口收起、焦点还给原应用、自动发 Ctrl+V。
 *
 * 写什么格式由「宿主是谁」决定（见 lib/hosts.js）。早先的做法是一次把
 * text + html + image 三种全写进去、让目标应用自己挑，实测失败：应用挑的是
 * 「它第一个认识的」，不是「最合适的」——
 *   记事本只吃文本 → 得到 LaTeX 源码；
 *   Word 吃 HTML 却只认 OMML 不认 MathML → 空白或一串标签（假成功，最难发现）；
 *   微信有时挑图有时挑文本 → 结果随机。
 * 所以改成先用 GetForegroundWindow 认出前台进程，再只给它那一两种格式。
 * 进程名认不出来时退回老三样，并在面板上提示「目标未知」，用户可以手动指定，
 * 指定过一次就按进程名记进 settings 的 hostFormats。
 */
const { app, BrowserWindow, Tray, Menu, globalShortcut, clipboard, ipcMain, nativeImage, screen, desktopCapturer } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const settings = require('./lib/settings');
const paster = require('./lib/paste');
const snip = require('./lib/snip');
const hosts = require('./lib/hosts');
const latex2eq = require('./lib/latex2eq');

let win = null;
let tray = null;
let lastHwnd = '';        // 面板弹出前的前台窗口，粘贴时把焦点还给它
let currentHost = { hwnd: '', proc: '', cls: '' };  // 同时也是「这次往什么软件里粘」
let quitting = false;
let rebuilding = false;    // 正在换 HWND（防连按热键时造出两个窗口）
let trayOn = null;
let trayOff = null;

const HOTKEYS = [
  { accel: 'Control+Alt+Q', label: 'Ctrl+Alt+Q（默认，Office 里不撞）' },
  { accel: 'Control+Alt+M', label: 'Ctrl+Alt+M' },
  { accel: 'Control+Shift+Space', label: 'Ctrl+Shift+空格' },
  { accel: 'Alt+Q', label: 'Alt+Q（WPS / Word 里会撞）' },
  { accel: 'Alt+W', label: 'Alt+W' },
  { accel: 'F9', label: 'F9' }
];

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================= 窗口 ================= */

function createWindow() {
  win = new BrowserWindow({
    width: 860,
    height: 340,
    minWidth: 620,
    minHeight: 300,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: '#f7f8fa',
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    maximizable: false,
    title: '公式输入',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  // screen-saver 层级：比普通窗口高，连全屏的浏览器也能盖住
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.loadFile(path.join(__dirname, 'index.html'), { query: { plugin: '1' } });

  win.on('blur', function () {
    if (!win || win.isDestroyed()) return;
    if (win.webContents.isDevToolsOpened()) return;
    hidePanel();
  });

  // 关窗口 = 收起，不退出（托盘常驻）
  win.on('close', function (e) {
    if (quitting) return;
    e.preventDefault();
    hidePanel();
  });

  win.on('closed', function () { win = null; });

  if (process.argv.includes('--dev')) {
    win.webContents.openDevTools({ mode: 'detach' });
  }
}

/** 贴着鼠标弹出来：默认落在光标下方，底部放不下就翻到上方 */
function placeNearCursor() {
  if (!win || win.isDestroyed()) return;
  const cursor = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(cursor).workArea;
  const size = win.getSize();
  const w = size[0];
  const h = size[1];

  let x = Math.round(cursor.x - w / 2);
  let y = Math.round(cursor.y + 28);
  if (y + h > area.y + area.height - 8) y = Math.round(cursor.y - h - 28);
  x = Math.min(Math.max(x, area.x + 8), area.x + area.width - w - 8);
  y = Math.min(Math.max(y, area.y + 8), area.y + area.height - h - 8);

  win.setPosition(x, y, false);
}

async function showPanel() {
  if (rebuilding) { logLine('showPanel skipped (rebuilding)'); return; }
  if (!win || win.isDestroyed()) createWindow();
  logLine('showPanel begin');
  // 必须在窗口抢焦点之前问，否则拿到的是自己
  currentHost = await paster.host();
  lastHwnd = currentHost.hwnd;
  placeNearCursor();
  win.show();
  win.focus();
  // 少数情况下系统不肯把前台交给后台进程，窗口刚显示就被 blur 收掉了 —— 再顶一次
  if (!win.isFocused()) {
    win.moveTop();
    win.focus();
  }
  // 连同宿主一起发过去：面板要显示「这次给什么格式」，并按宿主选配方
  win.webContents.send('focus', currentHost);
  logLine('showPanel done  host=' + (currentHost.proc || '?') +
    ' visible=' + win.isVisible() + ' focused=' + win.isFocused());
  healIfCloaked(currentHost).catch(function () { /* 自愈失败也不该影响这次输入 */ });
}

/** Electron 的 HWND（getNativeWindowHandle 给的是小端 buffer） */
function panelHwnd() {
  const b = panelHwndRaw();
  if (!b) return '';
  return b.length >= 8 ? b.readBigUInt64LE(0).toString() : String(b.readUInt32LE(0));
}

function panelHwndRaw() {
  try {
    if (!win || win.isDestroyed()) return null;
    const b = win.getNativeWindowHandle();
    return b && b.length >= 4 ? b : null;
  } catch (e) {
    return null;
  }
}

/**
 * 「按了热键、日志说 visible=true focused=true，屏幕上却什么都没有」。
 *
 * 查下来是 DWM 把窗口 cloak 住了：isVisible() 撒谎，窗口从进程外部解除不了
 * （DwmSetWindowAttribute 返回 E_ACCESSDENIED），不换 HWND 就一直隐身。
 *
 * 坑：窗口刚 show 的头几百毫秒本来就是 cloak=2，DWM 合成完才变 0（实测 500ms 内）。
 * 所以不能一见 2 就动手 —— 隔 650/450/800ms 连问三次，三次都遮着才算真卡住。
 * 判据放宽到 1.9 秒是有意的：真卡住时用户本来就什么都看不见，多等一秒无感；
 * 万一是误判，重建会把他已经敲进去的公式冲掉，那才是真损失。
 * 判断放在显示之后，正常路径一毫秒都不耽误。
 */
async function healIfCloaked(hostInfo) {
  const hwnd = panelHwnd();
  if (!hwnd) return;
  for (const wait of [650, 450, 800]) {
    await delay(wait);
    if (!panelStillUp()) return;
    if ((await paster.cloaked(hwnd)) <= 0) return;
  }
  logLine('panel cloaked hwnd=' + hwnd + ' still hidden after 1.9s -> rebuild window');
  await rebuildPanel(hostInfo, hwnd);
}

function panelStillUp() {
  return !!win && !win.isDestroyed() && win.isVisible();
}

/** 重建面板：destroy 掉旧 HWND，加载完再把刚才那套显示流程走一遍 */
async function rebuildPanel(hostInfo, oldHwnd) {
  if (rebuilding) return;
  rebuilding = true;
  try {
    await doRebuild(hostInfo, oldHwnd);
  } finally {
    rebuilding = false;
  }
}

async function doRebuild(hostInfo, oldHwnd) {
  const old = win;
  win = null;
  if (old && !old.isDestroyed()) old.destroy();
  createWindow();
  const fresh = win;
  await new Promise(function (resolve) {
    if (!fresh.webContents.isLoading()) { resolve(); return; }
    fresh.webContents.once('did-finish-load', resolve);
  });
  if (!fresh || fresh.isDestroyed()) return;
  currentHost = hostInfo || currentHost;
  lastHwnd = currentHost.hwnd;
  placeNearCursor();
  fresh.show();
  fresh.focus();
  if (!fresh.isFocused()) {
    fresh.moveTop();
    fresh.focus();
  }
  fresh.webContents.send('focus', currentHost);
  await delay(700);
  const now = panelHwnd();
  const again = await paster.cloaked(now);
  logLine('showPanel done after rebuild  host=' + (currentHost.proc || '?') +
    ' visible=' + fresh.isVisible() + ' focused=' + fresh.isFocused() +
    ' hwnd=' + oldHwnd + '->' + now + ' cloaked=' + again);
}

function hidePanel() {
  if (!win || win.isDestroyed()) return;
  win.hide();
  logLine('hidePanel');
}

async function togglePanel() {
  logLine('hotkey fired  visible=' + (win && !win.isDestroyed() ? win.isVisible() : 'no-window'));
  if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) {
    hidePanel();
    return;
  }
  await showPanel();
}

/* ================= 托盘 ================= */

function trayImage(off) {
  const file = path.join(__dirname, 'assets', off ? 'tray-off.png' : 'tray.png');
  const cached = off ? trayOff : trayOn;
  if (cached) return cached;
  let img = nativeImage.createFromPath(file);
  if (img.isEmpty()) {
    // 图标没生成出来也不能让托盘空着：退一个 1x1 的透明图，功能仍然可用
    img = nativeImage.createEmpty();
  }
  if (off) trayOff = img; else trayOn = img;
  return img;
}

function buildTray() {
  tray = new Tray(trayImage(false));
  tray.on('click', togglePanel);
  tray.on('double-click', showPanel);
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const enabled = !!settings.get('enabled');
  const rawHk = settings.get('hotkey') || 'Control+Alt+Q';
  const hk = prettyAccel(rawHk);

  tray.setImage(trayImage(!enabled));
  tray.setToolTip(enabled ? '公式输入 · 按 ' + hk + ' 唤出' : '公式输入 · 已暂停');

  const login = app.isPackaged ? app.getLoginItemSettings().openAtLogin : false;

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: enabled ? '热键已启用（' + hk + '）' : '热键已暂停', enabled: false },
    { type: 'separator' },
    { label: '打开输入面板', click: togglePanel },
    {
      label: '暂停热键',
      type: 'checkbox',
      checked: !enabled,
      click: function (item) { settings.set('enabled', !item.checked); applyHotkey(); }
    },
    {
      label: '写完自动粘贴回原窗口',
      type: 'checkbox',
      checked: !!settings.get('autoPaste'),
      click: function (item) { settings.set('autoPaste', item.checked); updateTray(); }
    },
    {
      label: '按软件记住的格式',
      submenu: (function () {
        const map = settings.get('hostFormats') || {};
        const keys = Object.keys(map);
        const items = keys.length
          ? keys.map(function (k) {
              return { label: k + ' → ' + (hosts.OVERRIDE_LABELS[map[k]] || map[k]), enabled: false };
            })
          // 空的时候也要有个可见的说明，否则用户不知道这块是干什么的
          : [{ label: '（空，全部按自动判断）', enabled: false }];
        items.push({ type: 'separator' });
        items.push({
          label: '全部清除',
          enabled: keys.length > 0,
          click: function () { settings.set('hostFormats', {}); updateTray(); notify('格式记忆已清除'); }
        });
        return items;
      })()
    },
    { type: 'separator' },
    {
      label: '公式字号（贴进文档后的大小）',
      submenu: [
        { pt: 9, label: '小五 9pt' },
        { pt: 10.5, label: '五号 10.5pt（中文正文常用）' },
        { pt: 12, label: '小四 12pt（Word 英文默认）' },
        { pt: 14, label: '四号 14pt' },
        { pt: 16, label: '三号 16pt' }
      ].map(function (o) {
        return {
          label: o.label,
          type: 'radio',
          checked: Math.abs(Number(settings.get('formulaPt') || 10.5) - o.pt) < 0.01,
          click: function () {
            settings.set('formulaPt', o.pt);
            updateTray();
            notify('公式字号改为 ' + o.pt + 'pt，下一条公式按这个大小贴');
          }
        };
      })
    },
    {
      label: '唤出热键',
      submenu: HOTKEYS.map(function (k) {
        return {
          label: k.label,
          type: 'radio',
          checked: rawHk === k.accel,
          click: function () { settings.set('hotkey', k.accel); applyHotkey(); }
        };
      })
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: login,
      enabled: app.isPackaged,
      click: function (item) {
        app.setLoginItemSettings({ openAtLogin: item.checked });
        updateTray();
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: function () { quitting = true; app.quit(); }
    }
  ]));
}

/* ================= 热键 ================= */

function applyHotkey() {
  globalShortcut.unregisterAll();

  if (!settings.get('enabled')) { updateTray(); return false; }

  const want = settings.get('hotkey') || 'Control+Alt+Q';
  // 一个被占了就顺着列表往下试，别只退一个固定组合 —— 谁占着哪个组合，
  // 事先根本不知道（输入法、截图工具、录屏软件都爱抢 Ctrl+Alt+字母）。
  const candidates = [want].concat(HOTKEYS.map(function (h) { return h.accel; })
    .filter(function (a) { return a !== want; }));

  let got = '';
  for (let i = 0; i < candidates.length; i++) {
    let ok = false;
    try { ok = globalShortcut.register(candidates[i], togglePanel); } catch (e) { ok = false; }
    if (ok) { got = candidates[i]; break; }
  }

  if (!got) {
    logLine('hotkey register FAILED  tried=' + candidates.join(','));
    notify('热键注册失败：所有候选组合都被占用，可在托盘里换一个');
    updateTray();
    return false;
  }
  if (got !== want) {
    settings.set('hotkey', got);
    notify('热键 ' + prettyAccel(want) + ' 被占用，改用 ' + prettyAccel(got));
  }
  logLine('hotkey register ok  accel=' + got);

  updateTray();
  return true;
}

/** Control+Alt+Q → Ctrl+Alt+Q（托盘和提示里读着顺眼） */
function prettyAccel(a) {
  return String(a || '').replace(/Control/g, 'Ctrl').replace(/\+/g, '+');
}

function notify(msg) {
  if (tray) {
    try { tray.displayBalloon({ title: '公式输入', content: msg }); } catch (e) { /* 某些系统不支持 */ }
  }
  if (win && !win.isDestroyed()) win.webContents.send('notice', msg);
}

/** 启动/热键留痕：userData/start.log 追加一行，只留最近 60 条。
 *  排「按了热键没反应」时先看这个文件 —— 进程起没起、热键注册上没有、
 *  按下去回调到底跑没跑，比盯着托盘猜快得多。 */
function logLine(text) {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const file = path.join(app.getPath('userData'), 'start.log');
    const line = new Date().toISOString() + '  ' + text + '\n';
    let old = '';
    try { old = fs.readFileSync(file, 'utf8'); } catch (e) { old = ''; }
    const lines = (old + line).split('\n').filter(Boolean).slice(-60);
    fs.writeFileSync(file, lines.join('\n') + '\n');
  } catch (e) { /* 留痕失败不能影响功能 */ }
}

function logStart() {
  const hk = settings.get('hotkey') || 'Control+Alt+Q';
  let ok = false;
  try { ok = globalShortcut.isRegistered(hk); } catch (e) { ok = false; }
  logLine('pid=' + process.pid + '  start  hotkey=' + hk +
    ' registered=' + ok + '  enabled=' + !!settings.get('enabled'));
}

/* ================= 插入：收起 + 粘回原窗口 =================
 * 剪贴板由渲染进程写（主进程这个版本的 clipboard 只能写纯文本，
 * write() 还要求 ClipboardItem 数组，而主进程里没有 ClipboardItem）。
 * 主进程只负责后半段：收起窗口、把焦点还给原应用、发 Ctrl+V。
 */

ipcMain.handle('insert', async function () {
  const autoPaste = !!settings.get('autoPaste');
  hidePanel();

  if (!autoPaste) {
    notify('已复制到剪贴板，按 Ctrl+V 粘贴');
    return { ok: true, pasted: false };
  }

  // 等系统把焦点还给上一个窗口，再发 Ctrl+V
  await delay(150);
  const ok = await paster.paste(lastHwnd);
  if (!ok) notify('已复制，自动粘贴没成功，请按 Ctrl+V');
  return { ok: true, pasted: ok };
});

/**
 * 可编辑公式：LaTeX → EQ 域 → RTF → 剪贴板。
 *
 * 为什么不用 Electron 的剪贴板：它只能写 text / html，而 Office 的 HTML 导入器
 * 不做数学转换（OMML、MathML 都会被剥成纯文字，实测）。RTF 里的 EQ 域是唯一
 * 被 WPS 认下来并且变成排版公式的通道，而它只能由助手用 Win32 写进去。
 */
ipcMain.handle('eqclip', async function (evt, latex) {
  try {
    const rtf = latex2eq.toRtf(String(latex || ''));
    if (!rtf) return false;
    const file = path.join(app.getPath('temp'), 'formula-editor-eq.rtf');
    fs.writeFileSync(file, rtf, 'utf8');
    return await paster.setClip('rtf', file);
  } catch (e) {
    return false;
  }
});

ipcMain.handle('png', async function (evt, latex, opts) {
  try {
    const o = opts || {};
    const bg = o.bg === 'white' ? 'white' : 'transparent';
    // 给了 pt 就按「和正文字号一样大」出图（托盘里可调），
    // 老调用方明确指定像素高时仍按像素走。
    const spec = o.height
      ? { height: o.height, bg: bg }
      : { pt: o.pt || settings.get('formulaPt') || 10.5, bg: bg };
    const r = await snip.render(String(latex || ''), spec);
    if (!r || !r.dataURL) return null;
    // 一起回传「显示尺寸」（pt）：剪贴板里的位图不带 DPI（PNG 的 pHYs 在转 CF_DIB 时
    // 就没了），WPS/Word 按 96dpi 解释像素，288dpi 的图会大 3 倍。渲染层拿这两个数
    // 写进 <img style="width:..pt">，既清晰又和正文齐平。
    const dpi = r.dpi > 1 ? r.dpi : 288;
    return {
      url: r.dataURL,
      w: Math.round((r.width * 72 / dpi) * 100) / 100,
      h: Math.round((r.height * 72 / dpi) * 100) / 100
    };
  } catch (e) {
    return null;
  }
});

/** 面板开的时候要知道「这次往谁那儿粘」，认宿主、选配方都靠它 */
ipcMain.handle('host', function () {
  return Object.assign({}, currentHost, {
    remembered: (settings.get('hostFormats') || {})
  });
});

/** 用户手动改过格式 → 按进程名记下来，下次这个软件直接用这个 */
ipcMain.handle('remember', function (evt, proc, fmt) {
  const map = Object.assign({}, settings.get('hostFormats') || {});
  const key = hosts.normProc(proc);
  if (key) {
    if (!fmt || fmt === 'auto') delete map[key];
    else map[key] = String(fmt);
    settings.set('hostFormats', map);
    updateTray();
  }
  return map;
});

ipcMain.handle('settings', function () { return settings.all(); });

ipcMain.on('hide', hidePanel);
ipcMain.on('minimize', hidePanel);
ipcMain.on('close', function () { quitting = true; app.quit(); });

/* ================= 启动 ================= */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', function () { showPanel(); });

  app.whenReady().then(function () {
    app.setAppUserModelId('com.formula.editor.input');
    createWindow();
    buildTray();
    applyHotkey();
    logStart();

    // 空闲时把重的东西先热起来：PowerShell 助手 + 离屏渲染窗口
    paster.warmup().catch(function () {});
    snip.ensure().catch(function () {});

    // 端到端自检：--e2e=out.json 开一个记事本 → 面板输入 → Enter → 回读记事本内容
    // 会抢约 3 秒焦点，只在开发时手动跑
    const e2eArg = process.argv.find(function (a) { return a.indexOf('--e2e=') === 0; });
    if (e2eArg) {
      const out = e2eArg.slice(6);
      const cp = require('node:child_process');
      win.webContents.once('did-finish-load', async function () {
        const res = { steps: [] };
        let pad = null;
        // --focus=<hwnd> 时不新开记事本，直接拿一个已经在跑的窗口当靶子（比如 WPS）
        const focusArg = process.argv.find(function (a) { return a.indexOf('--focus=') === 0; });
        // --target-title=xxx：只认标题里含 xxx 的前台窗口。
        // 这一步是安全阀 —— 想往 WPS 里试粘贴时，前台若还是用户正在写的论文，
        // 一个键都不能发出去。
        const titleArg = process.argv.find(function (a) { return a.indexOf('--target-title=') === 0; });
        try {
          await delay(800);
          if (titleArg) {
            const want = titleArg.slice(15);
            await paster.warmup();
            // 自己按标题找窗口再切前台：外面先切好不可靠（Windows 前台锁会拒绝），
            // 而且 WPS 的 MainWindowHandle 未必是真能激活的那个句柄。
            // 目标程序可能还没启动完，所以这里等一会儿再放弃。
            let found = { hwnd: '', title: '' };
            for (let i = 0; i < 40; i++) {
              found = await paster.find(want);
              if (found.hwnd) break;
              await delay(1000);
            }
            res.foundHwnd = found.hwnd;
            if (found.hwnd) {
              const ok = await paster.focus(found.hwnd);
              res.steps.push('按标题找到 ' + found.hwnd + '（' + found.title + '），切前台=' + ok);
              await delay(700);
            }
            let hit = false;
            for (let i = 0; i < 30; i++) {
              const title = await paster.windowTitle();
              res.title = title;
              if (title && title.indexOf(want) >= 0) { hit = true; break; }
              await delay(500);
            }
            res.expectedTitle = want;
            if (!hit) {
              throw new Error('前台窗口标题是「' + (res.title || '空') + '」，不含「' + want +
                '」，已中止，一个按键都没发');
            }
            res.steps.push('前台标题匹配：' + res.title);
          } else if (focusArg) {
            // 先把助手叫醒（首次要编译 C#），否则第一条命令会超时
            await paster.warmup();
            const ok = await paster.focus(focusArg.slice(8));
            res.steps.push('切到指定窗口=' + ok);
            await delay(900);
          } else {
            pad = cp.spawn('notepad.exe', [], { stdio: 'ignore' });
            res.steps.push('notepad pid=' + pad.pid);
            await delay(1200);

            // 必须等记事本真的到前台再往下走。否则「目标」会认成当时在前台的那个
            // 窗口，接着把 Ctrl+V / Ctrl+A 发过去 —— 真的往别人的文档里写过。
            let onTarget = false;
            for (let i = 0; i < 12; i++) {
              currentHost = await paster.host();
              if (/notepad/i.test(currentHost.proc)) { onTarget = true; break; }
              await delay(400);
            }
            if (!onTarget) {
              throw new Error('记事本没到前台（前台是 ' +
                (currentHost.proc || '未知') + '），已中止，一个按键都没发');
            }
          }

          currentHost = await paster.host();
          lastHwnd = currentHost.hwnd;
          res.host = currentHost;
          res.steps.push('foreground hwnd=' + lastHwnd + ' proc=' + currentHost.proc + ' cls=' + currentHost.cls);

          win.show();
          win.focus();
          win.webContents.send('focus', currentHost);
          await delay(700);

          await win.webContents.executeJavaScript(
            'var m=document.getElementById("mf");m.value="\\\\mathrm{H_2SO_4}";m.focus();m.executeCommand(["moveToMathfieldEnd"]);'
          );
          await delay(400);
          res.steps.push('在面板里放下公式');

          // --fmt=<auto|text|png>：按指定格式出（测「公式」这条新路时用）
          const fmtArg = process.argv.find(function (a) { return a.indexOf('--fmt=') === 0; });
          if (fmtArg) {
            const want = fmtArg.slice(6);
            await win.webContents.executeJavaScript(
              'var b=document.querySelector(\'button[data-fmt="' + want + '"]\');if(b)b.click();' +
              '(document.querySelector("button.on[data-fmt]")||{}).textContent || ""'
            ).then(function (onText) { res.steps.push('选格式 ' + want + ' → 按钮=' + onText); });
            await delay(300);
          }

          res.debug = await win.webContents.executeJavaScript(
            '({ hasHosts: typeof window.FE_HOSTS, target: (document.getElementById("target")||{}).textContent,' +
            ' hidden: (document.getElementById("target")||{}).hidden,' +
            ' wpsPlan: window.FE_HOSTS ? window.FE_HOSTS.plan({proc:"wps"}) : null,' +
            ' payloadKeys: window.__lastPayloadKeys })'
          );

          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
          await delay(1400);

          // 这个版本的 clipboard 是异步 API：readText() 返回 Promise，
          // 也没有 readHTML/readImage，格式存在性要问 has()
          const text = await clipboard.readText();
          res.clipboardText = text;
          res.debug2 = await win.webContents.executeJavaScript('window.__lastPayloadKeys || null');
          res.hasHtml = await clipboard.has('text/html');
          res.hasImage = await clipboard.has('image/png');
          res.hasText = await clipboard.has('text/plain');
          try { res.formats = await clipboard.availableFormats(); } catch (e) { res.formats = String(e); }
          res.steps.push('剪贴板 text=' + JSON.stringify(String(text).slice(0, 40)) +
            ' html=' + res.hasHtml + ' image=' + res.hasImage + ' plain=' + res.hasText);

          if (focusArg || titleArg) {
            // 富文本靶子（WPS / Word）：文字读不出来（粘进去的是图），改成截图看效果
            await delay(500);
            let shot = null;
            try {
              // 用整屏而不是单窗口：WPS 的窗口不在 Chromium 的窗口枚举里
              const srcs = await desktopCapturer.getSources({
                types: ['screen'],
                thumbnailSize: { width: 2400, height: 1400 }
              });
              res.windows = srcs.map(function (s) { return s.name; }).slice(0, 12);
              const hit = srcs.find(function (s) { return /WPS|Word|文字文稿/i.test(s.name); }) || srcs[0];
              if (hit) {
                shot = hit;
                fs.writeFileSync(out.replace(/\.json$/, '.png'), hit.thumbnail.toPNG());
                res.shotWindow = hit.name;
              }
            } catch (e) { res.shotError = String(e); }

            // 只验证用的粘贴，验完撤掉，不给用户留脏文档
            res.undone = await paster.undo();
            // --fmt=text 是「可编辑公式」这条路：剪贴板里应当只有 RTF（EQ 域）
            const eqMode = fmtArg && fmtArg.slice(6) === 'text';
            res.clipFormats = await paster.clip();
            if (eqMode) {
              res.pass = res.clipFormats.indexOf('Rich Text Format') >= 0 && !!shot;
            } else {
              // 文档类宿主：只给一段带尺寸的 <img>（位图不带 DPI，给了它反而大 3 倍）
              res.pass = res.hasHtml && !res.hasText && !res.hasImage && !!shot;
            }
            res.steps.push('截图 ' + (shot ? shot.name : '没截到') + '，已撤销=' + res.undone);
          } else {
            await paster.selectAllCopy();
            await delay(600);
            const back = cp.spawnSync('powershell.exe',
              ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'],
              { encoding: 'utf8', windowsHide: true });
            res.notepadText = String(back.stdout || '').trim();
            res.steps.push('记事本里回读到 ' + JSON.stringify(res.notepadText.slice(0, 40)));

            // 记事本只吃纯文本：这次不该有 html/image（早先是三种全给，那是错的）
            res.planTextOnly = !res.hasHtml && !res.hasImage;
            res.hostDetected = /notepad/i.test(String(currentHost.proc));
            res.pass = res.notepadText.indexOf('H_2SO_4') >= 0 && res.planTextOnly && res.hostDetected;
          }
        } catch (e) {
          res.error = String(e && e.stack ? e.stack : e);
        } finally {
          if (pad) { try { cp.spawnSync('taskkill', ['/PID', String(pad.pid), '/T', '/F'], { windowsHide: true }); } catch (e) {} }
          fs.writeFileSync(out, JSON.stringify(res, null, 2));
          quitting = true;
          app.quit();
        }
      });
      return;
    }

    // 开发/排障用：--diag=out.json 把「热键有没有注册上、助手活着没、出图行不行」写成文件
    const diagArg = process.argv.find(function (a) { return a.indexOf('--diag=') === 0; });
    if (diagArg) {
      const out = diagArg.slice(7);
      win.webContents.once('did-finish-load', async function () {
        await delay(700);
        const hk = settings.get('hotkey');
        let pic = null;
        try { pic = await snip.render('\\frac{1}{2}', { pt: settings.get('formulaPt') || 10.5, bg: 'white' }); } catch (e) { pic = null; }
        const info = {
          hotkey: hk,
          hotkeyRegistered: globalShortcut.isRegistered(hk),
          enabled: !!settings.get('enabled'),
          autoPaste: !!settings.get('autoPaste'),
          formulaPt: settings.get('formulaPt'),
          trayCreated: !!tray,
          pasterAlive: (await paster.warmup()) === 'pong',
          pngOk: !!(pic && pic.dataURL && pic.dataURL.indexOf('data:image/png') === 0),
          pngPx: pic ? pic.width + 'x' + pic.height : '',
          pngDpi: pic ? Math.round(pic.dpi) : 0,
          windowSkippedTaskbar: win.isVisible() ? false : true
        };
        fs.writeFileSync(out, JSON.stringify(info, null, 2));
        quitting = true;
        app.quit();
      });
      return;
    }

    // 开发用：--shot=out.png [--demo=latex] 把面板截一张图就退出
    const shotArg = process.argv.find(function (a) { return a.indexOf('--shot=') === 0; });
    if (shotArg) {
      const out = shotArg.slice(7);
      const demo = process.argv.find(function (a) { return a.indexOf('--demo=') === 0; });
      win.webContents.once('did-finish-load', async function () {
        await delay(1100);
        if (demo) {
          await win.webContents.executeJavaScript(
            'var m=document.getElementById("mf");m.value=' + JSON.stringify(demo.slice(7)) + ';m.focus();' +
            'm.executeCommand(["moveToMathfieldEnd"]);'
          );
          await delay(800);
        }
        // 截图时想看到「往某软件粘」的提示，就用 --host=wps 假装一次
        const hostArg = process.argv.find(function (a) { return a.indexOf('--host=') === 0; });
        if (hostArg) {
          currentHost = { hwnd: '1', proc: hostArg.slice(7), cls: '' };
          win.webContents.send('focus', currentHost);
          await delay(350);
        }
        win.show();
        win.focus();
        await delay(700);
        const img = await win.webContents.capturePage();
        fs.writeFileSync(out, img.toPNG());
        quitting = true;
        app.quit();
      });
      return;
    }

    if (settings.get('firstRun')) {
      settings.set('firstRun', false);
      setTimeout(function () {
        showPanel();
        notify('按 ' + prettyAccel(settings.get('hotkey') || 'Control+Alt+Q') + ' 随时唤出，Enter 插入，Esc 收起');
      }, 600);
    }
  });

  // 托盘常驻：窗口全关了也不退出
  app.on('window-all-closed', function () {});

  app.on('before-quit', function () {
    quitting = true;
    try { globalShortcut.unregisterAll(); } catch (e) {}
    paster.stop();
    snip.destroy();
  });
}

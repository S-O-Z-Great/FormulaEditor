/**
 * 「按了热键、isVisible=true，屏幕上却一片空白」的现场复现工具。
 *
 * 结论（2026-11 排查）：窗口反复 show/hide 本身不会触发，12 轮全部 cloak=0。
 * 真正的病是 DWM 把窗口标成 cloaked（DWMWA_CLOAKED=2），而且一旦卡住就再也不恢复，
 * 只有换 HWND 才行 —— 所以 main.js 里的 healIfCloaked 会在显示 1.1 秒后重建窗口。
 * 这个脚本留着当回归：跑一遍确认「正常显隐不会把自己搞隐身」。
 *
 * 用法：node scripts/run-electron.js test/cloak.probe.js
 */
const { app, BrowserWindow, screen } = require('electron');
const paster = require('../src/lib/paste');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function hwndOf(win) {
  try {
    const b = win.getNativeWindowHandle();
    if (!b || b.length < 4) return '';
    return b.length >= 8 ? b.readBigUInt64LE(0).toString() : String(b.readUInt32LE(0));
  } catch (e) {
    return '';
  }
}

app.whenReady().then(async () => {
  await paster.warmup();

  const win = new BrowserWindow({
    width: 860,
    height: 340,
    show: false,
    frame: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    resizable: false,
    title: 'cloakprobe',
    backgroundColor: '#f7f8fa',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  await win.loadURL('data:text/html,<h1>cloak probe</h1>');

  let bad = 0;
  for (let i = 1; i <= 12; i++) {
    const c = screen.getCursorScreenPoint();
    win.setPosition(Math.round(c.x - 400), Math.round(c.y + 28), false);
    win.show();
    win.focus();
    // 刚 show 的几百毫秒本来就是 cloak=2（DWM 还没合成），等它稳定再问
    await delay(650);
    const v = await paster.cloaked(hwndOf(win));
    if (v > 0) bad++;
    console.log(`round ${String(i).padStart(2)}  cloaked=${v}  isVisible=${win.isVisible()}`);
    win.hide();
    await delay(350);
  }
  console.log(bad === 0 ? 'PASS: 显隐 12 轮没有被 DWM 遮住' : `FAIL: ${bad} 轮被遮住`);
  paster.stop();
  app.exit(bad === 0 ? 0 : 1);
});

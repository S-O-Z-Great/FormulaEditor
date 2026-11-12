/**
 * 设置持久化 —— 存到 userData/settings.json
 *
 * 只放「跨会话要记住」的东西：热键、开关、自动粘贴。
 * 编辑器自己的状态（格式选择等）仍然留在 renderer 里，不往这里塞。
 */
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const DEFAULTS = {
  hotkey: 'Alt+Q',      // 全局热键：唤出/收起输入面板
  enabled: true,        // 热键总开关（托盘里可暂停）
  autoPaste: true,      // 写完剪贴板自动发 Ctrl+V 回原窗口
  autoLaunch: false,    // 开机自启（仅打包后生效）
  // 公式字号（pt）—— 出图时按这个字号算显示大小，贴进文档正好和正文一样大。
  // 中文文档正文一般是五号（10.5），Word 英文默认 12。
  formulaPt: 10.5,
  // 按进程名记住「这个软件该给什么格式」，例如 { "wps": "png" }。
  // 自动判断猜错时，用户手动改一次就记下来，下次不用再改。
  hostFormats: {},
  firstRun: true
};

let file = null;
let data = null;

function load() {
  if (data) return data;
  file = path.join(app.getPath('userData'), 'settings.json');
  let disk = {};
  try { disk = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { disk = {}; }
  data = Object.assign({}, DEFAULTS, disk);
  return data;
}

function all() { return Object.assign({}, load()); }
function get(key) { return load()[key]; }

function set(key, value) {
  load()[key] = value;
  save();
}

function save() {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    // 写不进去不该让整个应用挂掉，下次启动退回默认值即可
  }
}

module.exports = { all, get, set, DEFAULTS };

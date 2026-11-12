const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fe', {
  // 插件模式标记：渲染层据此切换 Enter / Esc / 格式按钮的行为
  plugin: true,

  // 剪贴板由渲染进程自己写（navigator.clipboard 一次能带 text/html/png），
  // 主进程只管后半段：收起窗口 + 把焦点还给原应用 + 发 Ctrl+V
  insert: () => ipcRenderer.invoke('insert'),
  png: (latex, opts) => ipcRenderer.invoke('png', latex, opts),
  settings: () => ipcRenderer.invoke('settings'),

  // 宿主：面板弹出那一刻前台是谁。"往哪个软件粘"决定"粘什么格式"
  host: () => ipcRenderer.invoke('host'),
  // 手动改过格式就按进程名记住，下次不用再改
  remember: (proc, fmt) => ipcRenderer.invoke('remember', proc, fmt),

  hide: () => ipcRenderer.send('hide'),
  close: () => ipcRenderer.send('close'),
  minimize: () => ipcRenderer.send('minimize'),

  onFocus: (cb) => ipcRenderer.on('focus', (evt, host) => cb(host)),
  onNotice: (cb) => ipcRenderer.on('notice', (evt, msg) => cb(msg))
});

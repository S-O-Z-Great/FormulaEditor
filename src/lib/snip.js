/**
 * PNG 光栅化 —— 用离屏窗口把公式画出来，再截图写成图片
 *
 * 为什么不在编辑器窗口里截：截出来是编辑器的一部分（白底、带边框、带光标）。
 * 离屏窗口只放一个 #box，背景透明，截完按外框裁剪，得到的就是一张干净的公式图。
 *
 * 这个窗口全程常驻但从不 show()，启动时就把页面和数学字体加载好，
 * 之后每次导出只是换内容 + 等一帧。
 */
const { BrowserWindow, nativeImage } = require('electron');
const path = require('node:path');

let win = null;
let loaded = null;

function ensure() {
  if (loaded) return loaded;

  win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 600,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  win.webContents.setFrameRate(60);
  win.on('closed', function () { win = null; loaded = null; });

  loaded = new Promise(function (resolve) {
    win.webContents.once('did-finish-load', function () {
      // 数学字体是异步加载的：不等它就量尺寸，宽度会算小、字号也没落位
      win.webContents.executeJavaScript(
        '(document.fonts ? document.fonts.ready : Promise.resolve()).then(function(){ return true; })'
      ).then(function () {
        setTimeout(resolve, 120);
      }).catch(function () {
        setTimeout(resolve, 300);
      });
    });
  });

  win.loadFile(path.join(__dirname, '..', 'render.html'));
  return loaded;
}

/**
 * 等两帧：第一帧排版，第二帧才真正上屏。
 *
 * 早先靠 'paint' 事件抓帧，抓到的是「上一次渲染的残留」—— 连着出两张图时，
 * 第二张会拿到第一张的画面（要白底给了透明、要透明给了白底），一次一图时
 * 看不出来，连着用就错。改成让页面自己 rAF 两次，再直接 capturePage。
 */
function settleFrames() {
  try {
    return win.webContents.executeJavaScript(
      'new Promise(function(r){ requestAnimationFrame(function(){ requestAnimationFrame(function(){ r(1); }); }); })'
    );
  } catch (e) {
    return Promise.resolve(0);
  }
}

/** 当前公式外框（内容换过、字体落位之后重新量一次，宽度才不会算小） */
function measure() {
  try {
    return win.webContents.executeJavaScript('window.feMeasure ? window.feMeasure() : null');
  } catch (e) {
    return Promise.resolve(null);
  }
}

/* ---------------- PNG 的 DPI 元数据 ----------------
 * 图片像素尺寸和「贴进文档后多大」是两件事：Word/WPS 按 PNG 里 pHYs 写的
 * 分辨率换算，96dpi 的图贴进去就是 1:1 像素，几十像素高的公式要么糊、
 * 要么大得离谱。我们出 288dpi（显示尺寸的 4 倍像素），既清晰又不用手调大小。
 *
 * Electron 的 toPNG 不保证写 pHYs，自己往 IHDR 后面插一段最稳。
 */
let crcTable = null;

function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/**
 * 给 PNG 打上 DPI（先删掉原有的 pHYs，再插到 IHDR 后面 —— 规范要求 pHYs 在 IDAT 前）
 * @param {Buffer} png
 * @param {number} dpi
 */
function setPngDpi(png, dpi) {
  if (!Buffer.isBuffer(png) || png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) return png;

  const keep = [png.subarray(0, 8)];
  let pos = 8;
  let inserted = false;

  while (pos + 8 <= png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('latin1', pos + 4, pos + 8);
    const end = pos + 12 + len;
    if (end > png.length) break;

    if (type === 'pHYs') {           // 旧的丢掉，以我们写的为准
      pos = end;
      continue;
    }
    keep.push(png.subarray(pos, end));
    if (type === 'IHDR' && !inserted) {
      const perMeter = Math.round(dpi / 0.0254);   // pHYs 用「像素/米」
      const data = Buffer.alloc(9);
      data.writeUInt32BE(perMeter, 0);
      data.writeUInt32BE(perMeter, 4);
      data[8] = 1;                                // 1 = 单位是米
      const head = Buffer.alloc(8);
      head.writeUInt32BE(9, 0);
      head.write('pHYs', 4, 'latin1');
      const crcBuf = Buffer.concat([head.subarray(4), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(crcBuf), 0);
      keep.push(head, data, crc);
      inserted = true;
    }
    pos = end;
  }
  if (!inserted) return png;
  return Buffer.concat(keep);
}

/** PNG 里写的 DPI（调试用；读不到返回 0） */
function readPngDpi(png) {
  let pos = 8;
  while (pos + 8 <= png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('latin1', pos + 4, pos + 8);
    if (type === 'pHYs' && len >= 9) {
      const perMeter = png.readUInt32BE(pos + 8);
      return perMeter * 0.0254;
    }
    pos += 12 + len;
  }
  return 0;
}

/**
 * LaTeX → 裁剪好的 NativeImage
 * @param {string} latex  已经清理过的 LaTeX（不能带 \htmlData）
 * @param {object} opts
 *   pt       公式字号（pt）。给了就按「和正文字号一样大」出图，贴进文档不用手调
 *   bg       'white' | 'transparent'
 *   height   旧接口：目标像素高（独立编辑器的图片按钮还在用）
 *   dpi      PNG 写多少 DPI，默认 288
 * 返回值在原 NativeImage 基础上多挂 png/dataURL/width/height/dpi
 */
async function render(latex, opts) {
  const o = opts || {};
  const cssSize = 100;                      // 固定 100px 渲染，量出来的比例直接就是 em
  const bg = o.bg === 'white' ? 'white' : 'transparent';
  const dpi = o.dpi || 288;

  await ensure();
  if (!win) return null;

  let rect = null;
  try {
    rect = await win.webContents.executeJavaScript(
      'window.feRender(' + JSON.stringify(String(latex)) + ', ' + cssSize + ', ' + JSON.stringify(bg) + ')'
    );
  } catch (e) {
    return null;
  }
  if (!rect || !rect.w || !rect.h) return null;

  await settleFrames();
  // 内容刚换过、数学字体也可能刚落位，重量一次外框，免得宽度算小、右边被切
  const remeasured = await measure();
  if (remeasured && remeasured.w && remeasured.h) rect = remeasured;

  // 直接按外框截图。capturePage 收 CSS 像素、自己处理缩放，
  // 比「整帧 crop 再乘 dpr」少一层出错的地方，也不会拿到上一帧的画面。
  let img = null;
  for (let i = 0; i < 6; i++) {
    try {
      img = await win.webContents.capturePage({
        x: Math.max(0, Math.round(rect.x)),
        y: Math.max(0, Math.round(rect.y)),
        width: Math.max(1, Math.round(rect.w)),
        height: Math.max(1, Math.round(rect.h))
      });
    } catch (e) {
      img = null;
    }
    if (img && !img.isEmpty() && img.getSize().width > 0) break;
    img = null;
    await new Promise(function (r) { setTimeout(r, 60); });
  }
  if (!img) return null;

  // 目标像素高。给了 pt 就按「公式高几 em × 字号」算显示高度，
  // 再乘 dpi/72 换成像素 —— 贴进文档正好和正文一个字号，不用手调。
  let targetH;
  let showH = 0;
  if (o.pt) {
    // 用内容框（不含行高、不含截图留白）算 em 比例，否则每张图都会大一圈
    const contentH = rect.contentH || rect.h;
    const emRatio = Math.max(0.25, contentH / cssSize);
    showH = emRatio * o.pt;                             // 公式本体显示高度（pt）
    const contentPx = showH * (dpi / 72);
    // 截图上还有一圈抗锯齿留白，按比例补进像素高，公式本体才是想要的大小
    targetH = Math.max(8, Math.round(contentPx * (rect.h / contentH)));
  } else {
    targetH = o.height || 44;
  }

  // 边缘用高分渲染再缩小，比直接按小尺寸画干净得多
  if (img.getSize().height > targetH * 1.02) {
    const scale = targetH / img.getSize().height;
    img = img.resize({
      width: Math.max(1, Math.round(img.getSize().width * scale)),
      height: Math.round(targetH),
      quality: 'best'
    });
  }

  const png = setPngDpi(img.toPNG(), dpi);
  return {
    image: img,
    png: png,
    dataURL: 'data:image/png;base64,' + png.toString('base64'),
    dpi: readPngDpi(png),
    showH: showH,
    width: img.getSize().width,
    height: img.getSize().height
  };
}

/** 供渲染进程用：直接给 dataURL（IPC 只能传可序列化的东西） */
async function toDataURL(latex, opts) {
  const r = await render(latex, opts);
  return r && r.dataURL ? r.dataURL : '';
}

/** 供主进程直接写剪贴板用 */
async function toImage(latex, opts) {
  return render(latex, opts);
}

function destroy() {
  try { if (win) win.destroy(); } catch (e) {}
  win = null;
  loaded = null;
}

module.exports = { render, toDataURL, toImage, destroy, ensure };

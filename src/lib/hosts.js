/**
 * 宿主画像 —— 「往哪个软件里粘」决定「粘什么格式」
 *
 * 背景：原先的策略是一次把 text + html + image 三种格式全写进剪贴板，让目标
 * 应用自己挑。实测行不通 —— 应用挑的是「它第一个认识的」，不是「最合适的」：
 *
 *   记事本  只吃纯文本        → 粘进去是 \mathrm{H_2SO_4} 源码
 *   Word    吃 HTML，但只认 OMML，不认 MathML
 *                             → 要么空白、要么一串标签（假成功，最难发现）
 *   微信    有时挑图有时挑文本 → 结果随机
 *   Excel   只吃文本          → 图片被静默丢弃
 *
 * 所以改成「先认宿主，再只给它那一两种格式」。桌面端拿得到前台窗口的进程名，
 * 这不是猜，是认。
 *
 * 这个文件是 UMD：node 里跑单测、渲染进程里直接 <script> 引入，同一份逻辑。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FE_HOSTS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * 每一条：proc 是进程名（已去 .exe、转小写），cls 是窗口类名的兜底匹配。
   * 进程名优先 —— 浏览器和 Electron 应用的窗口类名都是 Chrome_WidgetWin_1，
   * 靠类名分不出来，只能靠进程名。
   */
  var RULES = [
    { id: 'word', label: 'Word / WPS 文字', proc: /^(winword|wps|pages)$/, cls: /^(OpusApp|KWPSFrame)$/ },
    { id: 'ppt', label: 'PowerPoint / 演示', proc: /^(powerpnt|wpp|keynote)$/, cls: /^(PP\d|framework::CFrame|KWPPFrame)$/ },
    { id: 'excel', label: 'Excel / 表格', proc: /^(excel|et|numbers)$/, cls: /^(XLMAIN|KETFrame)$/ },
    // 聊天窗口：图片最稳，纯文本兜底
    { id: 'chat', label: '聊天窗口', proc: /^(weixin|wechat|qq|qqnt|tim|dingtalk|telegram|discord|slack|feishu|lark)$/ },
    { id: 'browser', label: '网页', proc: /^(chrome|msedge|firefox|brave|opera|vivaldi|360se|360chrome|360se6|qqbrowser|sogouexplorer|liebao|maxthon)$/ },
    { id: 'markdown', label: '代码 / 笔记', proc: /^(code|code - insiders|cursor|windsurf|obsidian|typora|notepad\+\+|sublime_text|atom|webstorm|idea64|pycharm64|rstudio|zotero)$/ },
    { id: 'notepad', label: '记事本', proc: /^(notepad|notepad3|wordpad)$/, cls: /^Notepad$/ },
    { id: 'terminal', label: '终端', proc: /^(windowsterminal|wt|conhost|cmd|powershell|pwsh|openconsole|mintty)$/, cls: /^(ConsoleWindowClass|CASCADIA_HOSTING_WINDOW_CLASS)$/ }
  ];

  /**
   * 每个宿主的输出配方。
   *
   *   text     : 'bare'  原样 LaTeX        'dollar' 带 $...$（Markdown 直接渲染）
   *   html     : 是否写 MathML 富文本（Word/WPS 不认，写了反而害它挑错）
   *   png      : null 不出图 / 'white' 白底 / 'transparent' 透明底
   *   imageOnly: 出了图就**只给图**，剪贴板里不留纯文本。
   *              Word / WPS / 微信这类宿主在「图 + 文本」同时存在时会挑文本 ——
   *              用户看到的就成了「粘进去是一串字母」。要么只有图，要么只有文本。
   *   imgVia   : 'html'   只写一段 <img style="width:..pt">：文档类宿主按这段的尺寸放图。
   *                        位图（CF_DIB）不带 DPI，直接给图会被当成 96dpi、大 3 倍。
   *              'bitmap' 只写位图：聊天窗口吃这个。
   *
   * 白底是给文档用的：透明底贴在深色界面里，黑字会整个糊掉。
   * 透明底只留给「认不出来」的兜底场景。
   */
  var PLANS = {
    word: { text: 'bare', html: false, png: 'white', imageOnly: true, imgVia: 'html' },
    ppt: { text: 'bare', html: false, png: 'white', imageOnly: true, imgVia: 'html' },
    excel: { text: 'bare', html: false, png: null },
    chat: { text: 'bare', html: false, png: 'white', imageOnly: true, imgVia: 'bitmap' },
    browser: { text: 'dollar', html: true, png: null },
    markdown: { text: 'dollar', html: false, png: null },
    notepad: { text: 'bare', html: false, png: null },
    terminal: { text: 'bare', html: false, png: null },
    // 认不出来：退回老三样，同时界面上提示「目标未知，可手动指定」
    unknown: { text: 'bare', html: true, png: 'transparent' }
  };

  /** 用户手动指定时用的配方（会按进程名记住） */
  var OVERRIDES = {
    auto: null,
    text: { text: 'bare', html: false, png: null },
    dollar: { text: 'dollar', html: false, png: null },
    mathml: { text: 'dollar', html: true, png: null },
    // 手动选图片时目标宿主已知（wps / ppt）就只给 HTML，未知才两条路都给
    png: { text: 'bare', html: false, png: 'white', imageOnly: true, imgVia: 'auto' },
    pngclear: { text: 'bare', html: false, png: 'transparent', imageOnly: true, imgVia: 'auto' }
  };

  var OVERRIDE_LABELS = {
    auto: '自动',
    text: '纯文本',
    dollar: '文本 + $',
    mathml: 'MathML',
    png: '白底图片',
    pngclear: '透明图片'
  };

  /** Process.ProcessName 不带 .exe，但调用方可能塞全路径，统一归一化 */
  function normProc(p) {
    var s = String(p || '').toLowerCase().trim();
    var i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    if (i >= 0) s = s.slice(i + 1);
    return s.replace(/\.exe$/, '');
  }

  /**
   * 认宿主 → { id, label, proc, cls }
   * @param {{proc?:string, cls?:string}} host
   */
  function classify(host) {
    var h = host || {};
    var proc = normProc(h.proc);
    var cls = String(h.cls || '');
    var i, r;

    if (proc) {
      for (i = 0; i < RULES.length; i++) {
        r = RULES[i];
        if (r.proc && r.proc.test(proc)) {
          return { id: r.id, label: r.label, proc: proc, cls: cls };
        }
      }
    }
    // 进程名不认识时，再看窗口类名（老式 Win32 程序通常类名很特征）
    if (cls) {
      for (i = 0; i < RULES.length; i++) {
        r = RULES[i];
        if (r.cls && r.cls.test(cls)) {
          return { id: r.id, label: r.label, proc: proc, cls: cls };
        }
      }
    }
    return { id: 'unknown', label: '未知目标', proc: proc, cls: cls };
  }

  /**
   * 决定这次到底写哪几种格式
   * @param {object} host       classify() 的结果，或原始 {proc, cls}
   * @param {string} override   'auto' | 'text' | 'dollar' | 'mathml' | 'png' | 'pngclear'
   */
  function plan(host, override) {
    var k = classify(host);
    var o = override && override !== 'auto' ? OVERRIDES[override] : null;
    var base = o || PLANS[k.id] || PLANS.unknown;
    // imgVia 'auto' = 按宿主定：文档类只给 HTML（位图会被当成 96dpi，大 3 倍），
    // 其他宿主两条路都给，谁认识谁拿
    var via = base.imgVia;
    if (via === 'auto') via = (k.id === 'word' || k.id === 'ppt') ? 'html' : 'both';

    // 文档宿主里的「纯文本」不是「给 LaTeX 源码」——用户要的是 Word/WPS 自己的
    // 公式，能点进去改的那种。EQ 域就是这条路（实测：RTF 里的 EQ 域粘进 WPS
    // 是排版好的公式；MathML / OMML 走 HTML 全被剥成文字）。
    var eq = override === 'text' && (k.id === 'word' || k.id === 'ppt');

    return {
      host: k,
      override: override || 'auto',
      text: base.text,
      html: base.html,
      png: base.png,
      imageOnly: !!base.imageOnly,
      eq: eq,
      imgVia: base.png ? (via || 'bitmap') : '',
      // 界面上要用一句话说清「这次会给什么」
      summary: eq ? '可编辑公式（EQ 域）' : describe(base)
    };
  }

  function describe(p) {
    var parts = [];
    // 只给图的宿主别说「LaTeX + 白底图片」—— 那个文本根本不会进剪贴板
    if (p.imageOnly && p.png) {
      return p.png === 'white' ? '白底图片' : '透明图片';
    }
    parts.push(p.text === 'dollar' ? 'LaTeX + $' : 'LaTeX');
    if (p.html) parts.push('MathML');
    if (p.png === 'white') parts.push('白底图片');
    else if (p.png === 'transparent') parts.push('透明图片');
    return parts.join(' + ');
  }

  /** 按配方给纯文本套上定界符 */
  function delimit(latex, planOrSpec) {
    var s = String(latex == null ? '' : latex).trim();
    if (!s) return '';
    var t = (planOrSpec && planOrSpec.text) || 'bare';
    if (t !== 'dollar') return s;
    // 已经自带 $ 的别套两层
    if (/^\$\$[\s\S]*\$\$$/.test(s) || /^\$[\s\S]*\$$/.test(s)) return s;
    return '$' + s + '$';
  }

  return {
    RULES: RULES,
    PLANS: PLANS,
    OVERRIDES: OVERRIDES,
    OVERRIDE_LABELS: OVERRIDE_LABELS,
    normProc: normProc,
    classify: classify,
    plan: plan,
    delimit: delimit,
    describe: describe
  };
});

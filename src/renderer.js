(function () {
  'use strict';

  const E = window.FE_ENGINE;
  const MathLive = window.MathLive;
  const mf = document.getElementById('mf');
  const cand = document.getElementById('cand');
  const toastEl = document.getElementById('toast');
  const stage = document.getElementById('stage');
  const caretHint = document.getElementById('caretHint');
  const banner = document.getElementById('banner');

  const bridged = !!(window.fe && window.fe.insert);
  // 插件模式：托盘小窗里跑。Enter 插入并收起、Esc 收起、格式按钮换成「自动/纯文本/图片」
  const PLUGIN = !!(window.fe && window.fe.plugin) || /(?:\?|&)plugin=1/.test(location.search);
  const fe = bridged ? window.fe : {
    close: function () { window.close(); }
  };

  let format = 'latex';

  /* ================= 输入法状态 =================
   * 待定码直接打进公式（就地显示），start 记录它开始的位置偏移，
   * 上屏/取消时用「选中 + 替换」一次性抹掉，不依赖删除次数。
   */

  const ime = {
    on: false,
    mode: 'sym',       // 'sym' 符号码 / 'var' 变量 / 'elem' 元素
    entry: '#',        // 起手符：'#' 符号码、'@' 变量、'$' 元素、'##' 旧变量写法
    buf: '',           // sym 模式下已敲的触发码
    parts: [],         // var / elem 模式下名字的片段：{t:'text',v:'Tom'} / {t:'sym',v:'\\alpha'}
    hashPending: false,// 名字里刚敲了一个 #，等下一键判定是收尾还是符号码
    ret: null,         // 符号码是从哪个主体里发起的，提交后回到那里：'var' | 'elem'
    script: null,      // 名字后面紧跟的 _ / ^，落成实体后要挂成一格
    cands: [],
    idx: 0,
    // 注意：这里**不记位置**。MathLive 的 mf.position 在嵌套槽位（分母、上下限）里不可靠，
    // 用它算替换区间会把 # 留在公式里。待定码一律按"删几个字符"来撤，见 backspace()。
  };

  function latex() { return mf.getValue('latex') || ''; }

  // 待定码里这几个字符会被 MathLive 抢先解释成结构（^{} / _{}）或自动转换（· → \cdot）
  const TEXT_LITERAL = /^[\^_·]$/;

  function typeChar(ch) {
    focusField();
    suppressBefore = true;
    // 待定码里的 ' 要作为普通字符落地。直接 insert("'") 会被 MathLive 解释成
    // 「上标撇」结构（^{\\prime}），一个字符变成三个 token，撤回时算不准。
    let tex;
    if (ime.on && (ch === "'" || ch === '’')) tex = '\\prime';
    // 同理：^ 会变上标结构 ^{}、_ 会变下标结构 _{}、· 会被自动转成 \cdot，
    // 逐个字符落地都会让「按字符数回删」的计数错位，统一包进 \text 变回 1 个 token
    else if (ime.on && TEXT_LITERAL.test(ch)) tex = '\\text{' + ch + '}';
    else tex = ch;
    // 贴着整体左边界时先把它挪开，否则这个字会被塞进那个整体里
    if (!insertBeforeUnit(tex)) mf.insert(tex);
    suppressBefore = false;
  }

  function startIme() {
    focusField();
    pendingSlot = false;
    leaveExternalScript();
    ime.on = true;
    ime.mode = 'sym';
    ime.entry = '#';
    ime.buf = '';
    ime.parts = [];
    ime.hashPending = false;
    ime.ret = null;
    ime.script = null;
    ime.cands = [];
    ime.idx = 0;
    typeChar('#');
    refreshCand();
  }

  /** 变量起手：@。不往公式里塞字符——变量名从当前位置直接开始写。 */
  function startVar() {
    focusField();
    pendingSlot = false;
    ime.on = true;
    ime.mode = 'var';
    ime.entry = '@';
    ime.buf = '';
    ime.parts = [];
    ime.hashPending = false;
    ime.ret = null;
    ime.script = null;
    ime.cands = [];
    ime.idx = 0;
    refreshCand();
  }

  /** 元素起手：$。同样是零插入，名字（Cu、H）随后键入。
   *  先把光标从上一个槽里提出来（元素都是往后接着写的），否则名字会掉进上标里。 */
  /** 起一个新的实体之前，先把光标从「当前这个实体」里请出去。
   *
   *  元素之间不能嵌套：`…Cu` 的电荷格里刚敲完 `+`，光标还留在那个槽里，这时敲 `$O`，
   *  新元素会落进 Cu 的 `\htmlData` **里面**——一个块管两个符号，删一次走两个、四格串位。
   *  原来这里只有 `moveAfterParent`：光标在槽里时它只把光标提到那个槽的父级后面，
   *  仍然在实体内部，所以这条兜不住。 */
  function leaveUnit() {
    const list = units();
    if (!list.length) return false;
    const u = unitOf(list, mf.position);
    if (!u) return false;                          // 本来就在实体外面
    // 贴着左边界不算「在里面」：那是「实体前面」，用户就是想在这儿插一个新元素
    // （由 insertBeforeUnit 负责把它挪到右边，别抢那件事）。
    if (mf.position <= u.start) return false;
    const at = unitEnd(u);
    if (at <= mf.position) return false;
    selectRange(at, at);
    return true;
  }

  function startElem() {
    focusField();
    pendingSlot = false;
    // 先把光标送到实体外面再开新元素（原因见 leaveUnit）。
    // 贴着实体**左边界**时保持不动——那儿是「实体前面」，用户就是想在这儿插一个新元素，
    // 后面的 insertBeforeUnit 会把块挪开；这时候 moveAfterParent 会把它甩到实体后面去。
    if (!leaveUnit() && !atUnitLeftEdge(mf.position)) mf.executeCommand(['moveAfterParent']);
    ime.on = true;
    ime.mode = 'elem';
    ime.entry = '$';
    ime.buf = '';
    ime.parts = [];
    ime.hashPending = false;
    ime.ret = null;
    ime.script = null;
    ime.cands = [];
    ime.idx = 0;
    refreshCand();
  }

  /** 光标停在外挂上下标里（H₂ 的 2）时敲 # / @ / $：先退到实体外面再起手。
   *  不然等号、加号这些会落进那个下标里，屏幕上看着是「氧 2 =」，实际上是下标里的字，
   *  删起来还得多按几下。 */
  function leaveExternalScript() {
    const f = fieldAt(mf.position);
    if (!f || !f.external || !f.unit) return;
    const u = units().filter(function (x) { return x.atom === f.unit; })[0];
    if (u) selectRange(unitEnd(u), unitEnd(u));
  }

  function endIme() {
    ime.on = false;
    ime.mode = 'sym';
    ime.entry = '#';
    ime.buf = '';
    ime.parts = [];
    ime.hashPending = false;
    ime.ret = null;
    ime.script = null;
    ime.cands = [];
    ime.idx = 0;
    hideCand();
  }

  /** 删掉 n 个"字符/符号"：MathLive 里一个字母一个 token，一个 \alpha 也是一个 token，
   *  所以逐次 deleteBackward 比按索引算区间可靠得多（嵌套槽位里 position 会失真）。
   *
   *  一个例外：待定码正好贴着某个**整体的左边界**时，那个 offset 会被 MathLive 解释成
   *  「整体内部最左一格」，它前面没有原子，deleteBackward 全是空操作——待定码就留在公式里了。
   *  这种时候改成按区间删「光标左边那一个原子」：实测选区端点比原子右边界错开一格，
   *  `[c-2, c)` 正好覆盖「右边界 = c-1」的那一个原子（就是刚敲进去的字符）。 */
  function backspace(n) {
    // 贴着整体左边界时，那个 offset 会被 MathLive 解释成「整体内部最左一格」，
    // 前面没有原子，deleteBackward 全是空操作。按区间删才删得掉：
    // 选区端点比原子右边界少一格，`[pos-n-1, pos)` 正好盖住光标前那 n 个原子。
    if (n > 0 && leftUnitAt(mf.position)) {
      const p = mf.position;
      selectRange(Math.max(0, p - n - 1), p);
      mf.executeCommand(['deleteBackward']);
      return;
    }
    for (let i = 0; i < n; i++) mf.executeCommand(['deleteBackward']);
  }

  /** 当前待定内容占多少个 token（用于撤回） */
  function preeditLength() {
    if (ime.mode !== 'sym' || ime.ret) {
      return ime.parts.reduce(function (n, p) {
        return n + (p.t === 'text' ? p.v.length : 1);
      }, 0);
    }
    return ime.buf.length + 1;   // '#' + 码
  }

  /** 用 tex 覆盖掉待定码
   *  opts.del     先删掉几个 token（默认 0）
   *  opts.noSlot  不要自动跳进空槽（变量名里的符号用）
   *
   *  tex 里的 `{}` 会先变成 MathLive 的占位符，插进去之后光标就落在第一个空槽里，
   *  不会出现「插了结构结果下一个字符跑到结构外面」这种事
   */
  function replacePreedit(tex, opts) {
    opts = opts || {};

    const isText = /^\\text\{/.test(tex);
    // 已经自带 \placeholder{} 的片段（元素主体那种）不能再走「{} → 占位符」的替换，
    // 否则 \placeholder{} 里的 {} 会被二次替换成 \placeholder{\placeholder{}}。
    const preMade = tex.indexOf('\\placeholder{}') >= 0;
    const holes = preMade
      ? (tex.match(/\\placeholder\{\}/g) || []).length
      : (tex.match(/\{\}/g) || []).length;
    const body = (isText || preMade || !holes) ? tex : tex.replace(/\{\}/g, '{\\placeholder{}}');

    focusField();
    // 光标贴着整体左边界时不能直接 insert（会被塞进整体内部），先把整体挪到右边。
    // 待定码也一起按区间换掉——那种位置上的 deleteBackward 是空操作。
    const del = opts.del || 0;
    const from = mf.position - del;
    if (!insertBeforeUnit(body, del)) {
      if (del) backspace(del);
      mf.insert(body);
    }

    // 落点：必须把光标放进第一个空槽，否则后面敲的字符会落到结构外面。
    // 必须等本轮渲染结束再做（同步执行会被 MathLive 自己的状态刷新冲掉），
    // 否则原生按键不认这个位置。
    if (!isText && holes && !opts.noSlot) {
      pendingSlot = true;
      pendingSlotFrom = from;
      setTimeout(function () { if (pendingSlot) { jumpToSlot(); focusField(); } }, 120);
    }
  }

  /* ================= 整体（unit） =================
   * 变量 / 元素 / 带槽的符号都应不可分割：箭头一跳过、退格一删全。
   * MathLive 没有「多字符原子」这种语法，但它给了三个可以拼起来的零件：
   *   ① `\htmlData{fe=kind}{…}` —— 被包住的内容在 model 里合成**一个 atom**
   *   ② 渲染出的 DOM 元素带 data-fe 与 data-atom-id
   *   ③ `model.offsetOf(atom)` —— 该 atom 在扁平 offset 轴上的位置
   * 于是「整体范围 = [子孙最小 offset, 自身 offset + 1)」，选中这一段再删就是整体删除。
   *
   * 注意 offsetOf 是**后序编号**：父 atom 的编号排在它所有子孙之后。
   * 所以起始位置不能直接用父的 offset，要取整棵子树的最小值。
   */

  function wrapUnit(kind, tex) {
    return '\\htmlData{fe=' + kind + '}{' + tex + '}';
  }

  /** 展开结果是不是「带槽的结构」（单字符符号本身就是原子，不必再包） */
  function isStructured(tex) {
    return tex.indexOf('{}') >= 0 || tex.indexOf('\\placeholder{}') >= 0 || tex.indexOf('\\begin{') >= 0;
  }

  function modelOf() {
    const inner = mf._mathfield;
    return (inner && inner.model) || null;
  }

  const ATOM_KIDS = ['body', 'sup', 'sub', 'above', 'below', 'numerator', 'denominator', 'index'];

  /** 一个 atom 连同它的所有分支占的 offset 区间 */
  function spanOf(model, atom) {
    let lo = Infinity;
    let hi = -Infinity;
    (function walk(a) {
      if (!a) return;
      let off = null;
      try { off = model.offsetOf(a); } catch (e) { off = null; }
      if (typeof off === 'number') {
        if (off < lo) lo = off;
        if (off > hi) hi = off;
      }
      ATOM_KIDS.forEach(function (k) {
        if (Array.isArray(a[k])) a[k].forEach(walk);
      });
      const brs = a._branches;
      if (brs) Object.keys(brs).forEach(function (k) {
        const br = brs[k];
        if (br && Array.isArray(br.atoms)) br.atoms.forEach(walk);
      });
    })(atom);
    return lo === Infinity ? null : [lo, hi + 1];
  }

  /** 找 atom 在哪个兄弟数组里、排第几（MathLive 的 parentBranch 在不同版本里不一定可靠，
   *  自己从根遍历一遍更稳） */
  function siblingsOf(rootBody, target) {
    let found = null;
    (function walk(arr) {
      if (found || !Array.isArray(arr)) return;
      const i = arr.indexOf(target);
      if (i >= 0) { found = { arr: arr, i: i }; return; }
      arr.forEach(function (a) {
        if (found || !a) return;
        ATOM_KIDS.forEach(function (k) { if (Array.isArray(a[k])) walk(a[k]); });
        const brs = a._branches;
        if (brs) Object.keys(brs).forEach(function (k) {
          const br = brs[k];
          if (br && Array.isArray(br.atoms)) walk(br.atoms);
        });
      });
    })(rootBody);
    return found;
  }

  /** Tab / Shift+Tab：在**整篇文档**的槽之间走（第 17 批从「当前实体」扩到全文档）。
   *  以前直接调 MathLive 的 moveToNextPlaceholder，有两个毛病：
   *  ① 它进槽的方式是「把整格选中」，画出来一个蓝方块，没有插入点，看不出光标在哪；
   *  ② 它只关心文档里还有没有别的占位符，走到实体的最后一格就什么也不做（Tab 卡死）。
   *  后来按自己枚举的槽走，但只枚举当前实体，于是 H₂O 只能改到最右边那个 O。
   *  现在按 docFields() 一份全局列表走：H 的四格 → H 后面那个 2 → O 的四格 → …
   *  走到文档最后一格再 Tab 一次就离开实体（光标落到实体右侧）。 */
  /** Tab 走格时，先看当前位置与目标格之间有没有「间隙原子」（`+`、`=`、数字）。
   *  有就停在它后面，别一步跨过去——`Cu + O` 里按 Tab 也该能经过那个加号。
   *  targetCaret 为空表示「只想看看这一侧有没有间隙」。 */
  function tabGapPos(targetCaret, dir) {
    const model = modelOf();
    if (!model) return null;
    const g = gapAtomNear(model, mf.position, dir, units());
    if (g == null) return null;
    if (targetCaret == null) return g;
    return dir > 0 ? (g < targetCaret ? g : null) : (g > targetCaret ? g : null);
  }

  function handleTabKey(ev) {
    const list = docFields();
    if (!list.length) return false;
    const pos = mf.position;
    const here = fieldAt(pos);
    // fieldAt 每次都会重新扫一遍 model，返回的是**另一份**对象，比不了引用，只能比 owner + key
    const cur = here
      ? list.findIndex(function (f) { return f.owner === here.owner && f.key === here.key; })
      : -1;

    if (ev.shiftKey) {
      if (cur > 0) {
        const g = tabGapPos(list[cur - 1].caret, -1);
        if (g != null) { selectRange(g, g); focusField(); return true; }
        gotoSlot(list[cur - 1]); return true;
      }
      if (cur === 0) {
        const g = tabGapPos(null, -1);
        if (g != null) { selectRange(g, g); focusField(); return true; }
        exitField(list[0], -1); return true;
      }
      const prev = fieldNext(pos, -1);
      if (prev) {
        const g = tabGapPos(prev.caret, -1);
        if (g != null) { selectRange(g, g); focusField(); return true; }
        gotoSlot(prev); return true;
      }
      const before = unitBefore(units(), pos);
      if (before) { selectRange(before.start, before.start); focusField(); return true; }
      // 左边没有格子了：退回所在实体的最后一格，Shift+Tab 才能倒着走进来
      return enterUnitSlot(-1);
    }
    if (cur >= 0 && cur < list.length - 1) {
      const g = tabGapPos(list[cur + 1].caret, 1);
      if (g != null) { selectRange(g, g); focusField(); return true; }
      gotoSlot(list[cur + 1]); return true;
    }
    if (cur === list.length - 1) {
      const g = tabGapPos(null, 1);
      if (g != null) { selectRange(g, g); focusField(); return true; }
      exitField(here, 1); return true;
    }
    const next = fieldNext(pos, 1);
    if (next) {
      const g = tabGapPos(next.caret, 1);
      if (g != null) { selectRange(g, g); focusField(); return true; }
      gotoSlot(next); return true;
    }
    // 后面没有格子了：回到所在实体的第一格，Tab 才能「再走进来」
    return enterUnitSlot();
  }

  /** 从某一格走出去：光标落到它所属实体的右侧（dir>0）/ 左侧（dir<0）。
   *  不在实体里的槽（比方说正文里单独一个上标）就落到文档两端。 */
  function exitField(f, dir) {
    const model = modelOf();
    const u = (f && f.unit) ? units().filter(function (x) { return x.atom === f.unit; })[0] : null;
    let at;
    if (u) at = dir > 0 ? unitEnd(u) : u.start;
    else at = dir > 0 ? ((model && typeof model.lastOffset === 'number') ? model.lastOffset : 0) : 0;
    selectRange(at, at);
    focusField();
    return true;
  }

  /** 整体右侧紧邻的上下标原子。MathLive 把 `X^2` 里的 `^2` 解析成**独立的 subsup 兄弟**，
   *  不是 X 的分支；视觉上它是 X 的幂，删除时就该跟着 X 一起走，所以并进整体范围。 */
  function adjacentScriptAtom(model, atom) {
    const at = siblingsOf(model.root.body, atom);
    if (!at) return null;
    for (let j = at.i + 1; j < at.arr.length; j++) {
      const sib = at.arr[j];
      if (!sib) continue;
      if (sib.type !== 'subsup') return null;
      return sib;
    }
    return null;
  }

  function adjacentScript(model, atom) {
    const sib = adjacentScriptAtom(model, atom);
    return sib ? spanOf(model, sib) : null;
  }

  /* ---------- 槽：整体里「能放内容」的格子 ----------
   * 光标在整体里的时候，多数时候停在某个槽里（上标、下标、元素四槽、根号里、分子分母…），
   * 这时按退格只该删槽里的字，不该把整个实体带走。
   *
   * 判定**不再靠 offset 区间猜**：MathLive 的原子树自己就写着「谁是槽」——
   * 除了 `body` 之外的分支（superscript / subscript / above / below / …）都是槽。
   * 从光标左边的原子往上爬，跨过的第一个非 body 分支，就是光标所在的那个槽。
   * （早先按区间算，相邻两个槽的边界会在同一个 offset 上撞车：
   *   分式 `\frac{1}{}` 里删掉分母后，分母的右边界和分子的右边界重合，
   *   于是「分母里退格」被当成「分子里退格」，一按就把分子也删了。） */
  /** child 在 parent 的哪个分支里（body / above / below / superscript / …） */
  function branchKeyOf(parent, child) {
    const brs = parent && parent._branches;
    if (!brs) return null;
    const keys = Object.keys(brs);
    for (let i = 0; i < keys.length; i++) {
      const br = brs[keys[i]];
      const arr = Array.isArray(br) ? br : (br && br.atoms);
      if (arr && arr.indexOf(child) >= 0) return keys[i];
    }
    return null;
  }

  /** 某条分支里的原子列表 */
  function branchAtoms(owner, key) {
    const brs = owner && owner._branches;
    const br = brs ? brs[key] : null;
    if (!br) return [];
    return Array.isArray(br) ? br : (br.atoms || []);
  }

  /** 一个原子的所有分支（body / above / below / superscript / subscript …），统一成数组 */
  function childBranches(a) {
    const out = [];
    function add(key, arr) {
      if (!Array.isArray(arr) || !arr.length) return;
      for (let i = 0; i < out.length; i++) if (out[i].key === key) return;   // 同名分支只收一次
      out.push({ key: key, atoms: arr });
    }
    const brs = a._branches;
    if (brs) Object.keys(brs).forEach(function (k) {
      const br = brs[k];
      add(k, Array.isArray(br) ? br : (br && br.atoms));
    });
    add('superscript', a.superscript);
    add('subscript', a.subscript);
    return out;
  }

  /** 槽里的「内容」：真正显示出来的叶子原子（跳过 first / placeholder 这类空占位）。
   *  返回它们在 offset 轴上的位置（offsetOf = 这个原子**后面**那条边界）。 */
  function contentOffsets(model, atoms, out) {
    atoms.forEach(function walk(a) {
      if (!a) return;
      const kids = childBranches(a);
      if (!kids.length) {
        if (a.type !== 'first' && a.type !== 'placeholder') {
          let off = null;
          try { off = model.offsetOf(a); } catch (e) { off = null; }
          if (typeof off === 'number') out.push(off);
        }
        return;
      }
      kids.forEach(function (br) { br.atoms.forEach(walk); });
    });
    return out;
  }

  /** 槽里「还有没有占位符」。删到空的时候 MathLive 只留一个 `^{}`，占位符是没了的，
   *  这时要补一个回去，槽才继续可寻址（Tab 停得住、点也画得出来）。 */
  function hasPlaceholder(atoms) {
    let found = false;
    atoms.forEach(function walk(a) {
      if (found || !a) return;
      if (a.type === 'placeholder') { found = true; return; }
      childBranches(a).forEach(function (br) { br.atoms.forEach(walk); });
    });
    return found;
  }

  /** 这份「字」是不是用户真敲进去的内容（元素名、变量名、槽里的数字…）。
   *  空模板（刚插进来的根号 / 分式 / 积分）只有结构和占位符，不算——
   *  所以「在空槽里退格」对空模板是整删，对有内容的实体是保护。
   *  跳过 phantom：元素那个 {\vphantom{0}} 底座里有个 0，那是排版用的，不是内容。 */
  const TEXT_LEAF_TYPES = /^(mord|text|mbin|mrel|mopen|mclose|mpunct|minner)$/;

  function hasTypedContent(atom) {
    let found = false;
    (function walk(a) {
      if (found || !a) return;
      if (a.type === 'phantom') return;
      const kids = childBranches(a);
      if (!kids.length) {
        if (TEXT_LEAF_TYPES.test(a.type)) found = true;
        return;
      }
      kids.forEach(function (br) { br.atoms.forEach(walk); });
    })(atom);
    return found;
  }

  /** 某条分支的内容概况（给退格判断与补占位符用） */
  function slotFrom(model, owner, key) {
    const atoms = branchAtoms(owner, key);
    let lo = Infinity;
    let hi = -Infinity;
    atoms.forEach(function (x) {
      const sp = spanOf(model, x);
      if (!sp) return;
      if (sp[0] < lo) lo = sp[0];
      if (sp[1] > hi) hi = sp[1];
    });
    if (lo === Infinity) {
      // 空分支只有个 first 标记，拿它的 offset 兜个底，区间别是 ±Infinity
      const mark = atoms.filter(function (x) { return x && x.type === 'first'; })[0] || atoms[0];
      let off = null;
      try { off = mark ? model.offsetOf(mark) : null; } catch (e) { off = null; }
      if (typeof off === 'number') { lo = off; hi = off; }
    }
    return {
      owner: owner,
      key: key,
      atoms: atoms,
      start: lo,
      end: hi,
      leaves: contentOffsets(model, atoms, []),
      hasPh: hasPlaceholder(atoms)
    };
  }

  /** 取 offset 处的原子（MathLive 记的是原子**右**边界）。越界或异常一律当没有 */
  function atomAt(model, pos) {
    if (!model || pos < 0) return null;
    try { return model.at(pos) || null; } catch (e) { return null; }
  }

  /** 从 atom 往上走到 ancestor 的分支路径；走不到（不是后代）返回 null */
  function pathTo(ancestor, atom) {
    if (!ancestor || !atom) return null;
    const path = [];
    let cur = atom;
    for (let hops = 0; cur && hops < 16; hops++) {
      if (cur === ancestor) return path;
      const p = cur.parent;
      if (!p) return null;
      path.push({ owner: p, key: branchKeyOf(p, cur) });
      cur = p;
    }
    return null;
  }

  /** 路径上第一个非 body 分支 = 光标所在的槽 */
  function slotAlong(path) {
    if (!path) return null;
    for (let i = 0; i < path.length; i++) {
      const k = path[i].key;
      if (k && k !== 'body') return path[i];
    }
    return null;
  }

  /* ---------- 文档级字段表 ----------
   * 以前「槽」只按当前实体算，于是化合物里除了最右边那个元素，别的都进不去：
   *   H₂O 里 `2` 是元素 H 的**兄弟**（一个独立的 subsup 原子），不是 H 的分支，
   *   于是它既不是槽、也不算谁的槽——Tab 跳不到，方向键一按就弹回实体边界。
   * 现在整篇文档扫一遍：**body 以外的分支都是槽**，按文档顺序排好。
   * 元素右边紧跟的 subsup 兄弟算前面那个实体的（它就是「个数 / 电荷」那一格）。
   */

  /** 一个槽的完整描述：{ owner, key, unit, start, end, caret, phId, leaves, atoms, hasPh }
   *
   *  `caret` 是「进这一格」时光标该落的 offset——优先取这格占位符的**左边界**：
   *  这样光标是正常的插入点细线，而不是 MathLive 那种「把整格选中」的蓝方块；
   *  而且它在这个位置打字时会自动用字符替换掉占位符（实测 `^{\placeholder{}}` 左边界打 1 → `^1`）。
   *  槽里已经有内容时，caret 落在内容末尾。
   *  `unit` 是这一格所属的实体（不在实体里 → null），用来算「整块」的范围。 */
  function fieldFrom(model, owner, key, unit, external) {
    const s = slotFrom(model, owner, key);
    let caret = null;
    let phId = null;
    (function findPh(arr) {
      for (let i = 0; i < arr.length && caret == null; i++) {
        const x = arr[i];
        if (!x) continue;
        if (x.type === 'placeholder') {
          let off = null;
          try { off = model.offsetOf(x); } catch (e) { off = null; }
          if (typeof off === 'number') { caret = off - 1; phId = x.id ? String(x.id) : null; }
          return;
        }
        childBranches(x).forEach(function (b) { findPh(b.atoms); });
      }
    })(s.atoms);
    if (caret == null) {
      let mx = -Infinity;
      s.leaves.forEach(function (v) { if (v > mx) mx = v; });
      caret = mx === -Infinity ? s.end : mx;
    }
    return {
      owner: owner, key: key, unit: unit || null, external: !!external,
      start: s.start, end: s.end, caret: caret,
      phId: phId, leaves: s.leaves, atoms: s.atoms, hasPh: s.hasPh
    };
  }

  /** 这个原子是不是「实体」（`\htmlData{fe=…}` 包出来的整体） */
  function isUnitAtom(a) {
    return !!(a && a.command === '\\htmlData' && Array.isArray(a.args) &&
      a.args.some(function (s) { return /^fe=/.test(String(s)); }));
  }

  /** 「外壳」原子里包着的实体。MathLive 会把「实体 + 紧跟着的上下标」合成**一个** subsup：
   *  `\htmlData{fe=elem}{…}_{2}` 的 body 是那个 htmlData，subscript 是 2。
   *  这种上下标结构上挂在外壳上，视觉和语义却属于里面的实体（H₂ 的 2），
   *  所以得从外壳里把实体捞出来，否则它既不算实体的格、也不在间隙里，
   *  方向键会整格跳过去（`H₂+` 里改不了那个 2 就是这么来的）。 */
  function unitInside(x) {
    if (!x || x.type !== 'subsup') return null;
    let found = null;
    (function scan(arr) {
      for (let i = 0; i < arr.length && !found; i++) {
        const a = arr[i];
        if (!a) continue;
        if (isUnitAtom(a)) { found = a; return; }
        childBranches(a).forEach(function (br) { if (br.key === 'body') scan(br.atoms); });
      }
    })(branchAtoms(x, 'body'));
    return found;
  }

  /** 整篇文档里所有的槽，按文档顺序（= 视觉从左到右、从上到下）。
   *  `external` 标记「挂在实体右边、但本身不在实体里」的上下标——H₂ 那个 2。
   *  它是独立原子，删空之后再退格该删它自己，而不是把整个元素吞掉。 */
  function docFields() {
    const model = modelOf();
    if (!model || !model.root) return [];
    const out = [];
    (function fieldsIn(arr, ctx, ext) {
      let lastUnit = null;                       // 紧挨在左边的兄弟是不是实体
      arr.forEach(function (x) {
        if (!x) return;
        const self = isUnitAtom(x) ? x : null;
        let u = self || ctx;
        let ex = self ? false : ext;
        // 实体右边紧跟的上下标：算前面那个实体的槽（H₂ 的 2 就是这一种）
        if (!self && x.type === 'subsup' && lastUnit) { u = lastUnit; ex = true; }
        // 另一种形态：上下标挂在「包着实体的外壳」上，实体是外壳的 body 分支。
        // 这一格同样归里面的实体，且属于「外挂」（不属于实体主体的四格）。
        const shell = self ? null : unitInside(x);
        if (shell) { u = shell; ex = true; }
        childBranches(x).forEach(function (br) {
          // 外壳的 body 分支就是实体本身：进去以后 ext 要归零，里面那四格才是内层格
          if (br.key === 'body') { fieldsIn(br.atoms, u, shell ? false : ex); return; }
          out.push(fieldFrom(model, x, br.key, u, shell ? true : ex));
          fieldsIn(br.atoms, u, shell ? true : ex);
        });
        lastUnit = self;
      });
    })(model.root.body || [], null, false);
    out.sort(function (p, q) { return p.start - q.start || p.end - q.end; });
    return out;
  }

  /** 某个整体里的所有槽（文档顺序）。化合物里挂在它后面的上下标也算它的。 */
  function slotsOf(model, unitAtom) {
    return docFields().filter(function (f) { return f.unit === unitAtom; });
  }

  /** 光标此刻落在哪一格（不在任何格里 → null）。
   *
   *  判定走**原子树**，不走 offset 区间：相邻两格在 offset 上是贴着的
   *  （个数 [20,22] 的右边界 = 电荷的起点 22），按区间猜会在边界上撞车。
   *  原子树自己写着答案：从光标左右两个原子往上爬，跨过的第一个非 body 分支就是那一格。
   *  `\mathrm{Cu}` 的个数格和电荷格挂在同一个原子上，靠 key 区分，也不会混。 */
  function fieldAt(pos) {
    const model = modelOf();
    if (!model) return null;
    const list = docFields();
    if (!list.length) return null;
    const probes = [atomAt(model, pos), atomAt(model, pos - 1)];
    for (let i = 0; i < probes.length; i++) {
      let cur = probes[i];
      for (let hops = 0; cur && cur.parent && hops < 24; hops++) {
        const p = cur.parent;
        const key = branchKeyOf(p, cur);
        if (key && key !== 'body') {
          for (let j = 0; j < list.length; j++) {
            if (list[j].owner === p && list[j].key === key) return list[j];
          }
          return null;              // 在结构里，但这格没被收录（矩阵单元格之类）
        }
        cur = p;
      }
    }
    return null;
  }

  /** 文档里 pos 前（dir<0）/ 后（dir>0）最近的一格，按「进这一格时光标该落的点」比较 */
  /** 光标左 / 右紧邻的那个「既不属于任何整体、也不在任何槽里」的原子。
   *
   *  两个实体之间夹着 `+`、`=`、数字时，方向键要能在它们身上停一下：
   *  以前只有 `fieldNext()`（只认槽位表），于是一步就从 `Cu` 的最后一格跨到 `O` 的第一格，
   *  中间那个 `+` 永远碰不到——用户看到的就是「光标在加号两边的元素之间来回跳」。
   *
   *  返回光标该停的位置（那个原子的右边界），没有可停的就返回 null，
   *  由调用方交给 `fieldNext()`。 */
  function gapAtomNear(model, pos, dir, list) {
    if (!model || !model.root) return null;
    const offs = [];
    (function walk(a) {
      if (!a) return;
      const kids = childBranches(a);
      if (!kids.length) {
        if (a.type !== 'first') {
          let off = null;
          try { off = model.offsetOf(a); } catch (e) { off = null; }
          if (typeof off === 'number') offs.push(off);
        }
        return;
      }
      kids.forEach(function (br) { br.atoms.forEach(walk); });
    })(model.root);

    let best = null;
    for (let i = 0; i < offs.length; i++) {
      const off = offs[i];
      // 只考虑「间隙」里的原子：属于某个实体的、槽里的，都不是独立落脚点。
      // 不能只看最近的那一个——光标在 O 里时，最近的叶子是 O 自己的原子，
      // 跳过它继续往外找，才找得到那个夹在中间的 `+`。
      if (unitOf(list, off)) continue;
      if (fieldAt(off)) continue;
      if (dir > 0 ? off > pos : off < pos) {
        if (best == null || (dir > 0 ? off < best : off > best)) best = off;
      }
    }
    return best;
  }

  function fieldNext(pos, dir) {
    const list = docFields();
    let best = null;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (dir > 0) {
        if (f.caret > pos && (!best || f.caret < best.caret)) best = f;
      } else if (f.caret < pos && (!best || f.caret > best.caret)) best = f;
    }
    return best;
  }

  /** 光标所在的槽。整篇文档一起看：化合物右边那个 `2` 也是一格。 */
  function slotAt(model, u, pos) {
    return fieldAt(pos);
  }

  /** 光标当前所在的那个槽，在 slotsOf 列表里的下标（不在槽里 → -1） */
  function slotIndexOf(model, u, slots) {
    const s = slotAt(model, u, mf.position);
    if (!s) return -1;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i].owner === s.owner && slots[i].key === s.key) return i;
    }
    return -1;
  }

  /** 把光标放进某个槽：collapsed 选区落在槽的 caret 上，得到一根真正的插入点细线 */
  function gotoSlot(slot) {
    if (!slot || typeof slot.caret !== 'number') return;
    focusField();
    mf.selection = { ranges: [[slot.caret, slot.caret]], direction: 'none' };
  }

  /** 槽在屏幕上的范围（相对 math-field 左上角）。取槽里各原子 DOM 的并集；
   *  渲染是异步的，还没画出来就返回 null，调用方跳过这一格。 */
  function slotRect(sr, slot) {
    if (!sr) return null;
    const host = mf.getBoundingClientRect();
    let box = null;
    slot.atoms.forEach(function (a) {
      if (!a || !a.id) return;
      const el = sr.querySelector('[data-atom-id="' + a.id + '"]');
      if (!el) return;
      let r = el.getBoundingClientRect();
      // 叶子节点用 range 量「字本身」的盒子：span 的 rect 带整行行高，
      // 直接拿来画框会比字大一圈，看着像选中了一个大块。
      if (!el.children.length && el.firstChild && el.firstChild.nodeType === 3 && document.createRange) {
        try {
          const rg = document.createRange();
          rg.selectNodeContents(el);
          const rb = rg.getBoundingClientRect();
          if (rb.width || rb.height) r = rb;
        } catch (e) { /* 量不到就用 span 的 */ }
      }
      if (!r.width && !r.height) return;
      const b = { left: r.left - host.left, top: r.top - host.top, right: r.right - host.left, bottom: r.bottom - host.top };
      if (!box) { box = b; return; }
      if (b.left < box.left) box.left = b.left;
      if (b.top < box.top) box.top = b.top;
      if (b.right > box.right) box.right = b.right;
      if (b.bottom > box.bottom) box.bottom = b.bottom;
    });
    if (!box) return null;
    return { left: box.left, top: box.top, w: box.right - box.left, h: box.bottom - box.top };
  }

  /** 按屏幕方位找相邻的槽。用几何而不是序号：元素的四格视觉上是「左侧上下、右侧上下」，
   *  document 顺序（左上→左下→右下→右上）和眼睛看到的方向并不一致。 */
  function stepSlot(sr, slots, cur, dir) {
    const rects = slots.map(function (s) { return slotRect(sr, s); });
    for (let i = 0; i < rects.length; i++) if (rects[i]) rects[i].cx = rects[i].left + rects[i].w / 2;

    // 光标不在任何槽里：左/右直接取最边上的那格
    if (cur < 0) {
      let best = -1;
      for (let i = 0; i < rects.length; i++) {
        if (!rects[i]) continue;
        if (best < 0) { best = i; continue; }
        const better = dir === 'left' ? rects[i].cx < rects[best].cx : rects[i].cx > rects[best].cx;
        if (better) best = i;
      }
      return best < 0 ? null : slots[best];
    }

    const from = rects[cur];
    if (!from) {
      // 这一格还没渲染出来：退回文档顺序
      const d = (dir === 'left' || dir === 'up') ? -1 : 1;
      const j = cur + d;
      return (j >= 0 && j < slots.length) ? slots[j] : null;
    }

    const fx = from.left + from.w / 2;
    const fy = from.top + from.h / 2;
    let best = null;
    let bestScore = Infinity;
    for (let i = 0; i < rects.length; i++) {
      if (i === cur || !rects[i]) continue;
      const r = rects[i];
      const dx = (r.left + r.w / 2) - fx;
      const dy = (r.top + r.h / 2) - fy;
      let ok = false;
      let score = 0;
      if (dir === 'left') { ok = dx < -2; score = -dx + Math.abs(dy) * 2.5; }
      else if (dir === 'right') { ok = dx > 2; score = dx + Math.abs(dy) * 2.5; }
      else if (dir === 'up') { ok = dy < -2; score = -dy + Math.abs(dx) * 2.5; }
      else { ok = dy > 2; score = dy + Math.abs(dx) * 2.5; }
      if (ok && score < bestScore) { bestScore = score; best = i; }
    }
    return best == null ? null : slots[best];
  }


  /** 槽刚被删空：补回占位符，槽继续可寻址。
   *  这一步放在按键处理之后做——MathLive 的删除是在我们之后才执行的。 */
  function refillSlot() {
    if (ime.on) return;
    const model = modelOf();
    if (!model) return;
    const list = units();
    const u = unitOf(list, mf.position);
    if (!u) return;
    const slot = slotAt(model, u, mf.position);
    if (!slot || slot.hasPh || slot.leaves.length) return;
    focusField();
    mf.executeCommand(['insert', '\\placeholder{}']);
    // insert 会把这个新占位符「选中」，不收一下的话下一键会当成「删选区」，
    // 而删一个占位符选区 MathLive 会把整个结构拆掉。
    // 回收方式：把光标放成占位符左边一格的插入点，而不是「选中整格」。
    const slots = slotsOf(model, u.atom);
    for (let i = 0; i < slots.length; i++) {
      if (slots[i].owner === slot.owner && slots[i].key === slot.key) {
        if (slots[i].phId != null) { gotoSlot(slots[i]); return; }
        break;
      }
    }
    const p = mf.position;
    mf.selection = { ranges: [[p, p]], direction: 'none' };
  }

  /** 刚在哪个槽里打了字（打完要把光标拉回槽内，见 settleSlotCaret） */
  let slotEdit = null;
  let slotEditDone = true;

  /** 在槽里打完一个字，MathLive 会把光标停在「分支外面」那一格：
   *  `{\vphantom{0}}^{1}` 打完 1，光标报 9（= 整个 subsup 的右边界），下一个 4 就落到了
   *  元素主体上，变成 `^{1}4`——看着像上标，其实是正文，而且退格会按「主体」把整个元素删掉。
   *  所以插完字检查一次：光标正好停在分支最后一个字的右边一格时，把它挪回槽内末尾。 */
  function settleSlotCaret() {
    if (slotEditDone || !slotEdit || ime.on) return;
    slotEditDone = true;
    const se = slotEdit;
    const model = modelOf();
    if (!model) return;
    const pos = mf.position;
    const leaves = contentOffsets(model, branchAtoms(se.owner, se.key), []);
    if (!leaves.length) return;
    let last = -Infinity;
    for (let i = 0; i < leaves.length; i++) if (leaves[i] > last) last = leaves[i];
    if (last !== pos - 1) return;
    const sel = mf.selection;
    const r = sel && sel.ranges;
    if (r && r.length === 1 && r[0][0] === r[0][1]) selectRange(last, last);
  }

  /** 光标所在的槽（不在槽里返回 null） */
  function slotHere() {
    const model = modelOf();
    if (!model) return null;
    const list = units();
    const u = list.length ? unitOf(list, mf.position) : null;
    return u ? slotAt(model, u, mf.position) : null;
  }

  /** 当前公式里所有整体，按位置排序。
   *  **从 model 找，不查 DOM**：MathLive 的渲染是异步的，刚插进去的整体可能还没进 DOM，
   *  这时按 DOM 找就会漏掉里层那个——「在元素的槽里插一个变量」时正是如此，
   *  漏掉里层就会把光标当成在外层整体的末尾，于是退格把整个元素删了。
   *  好在 `\htmlData` 生成的原子自己留着 `command = '\htmlData'` 与 `args = ['fe=var']`。 */
  function units() {
    const model = modelOf();
    if (!model || !model.root) return [];
    const out = [];
    const seen = new Set();
    (function walk(a) {
      if (!a) return;
      if (a.command === '\\htmlData' && Array.isArray(a.args)) {
        const id = a.id ? String(a.id) : null;
        const tag = a.args.map(String).filter(function (s) { return /^fe=/.test(s); })[0];
        const kind = tag ? tag.slice(3) : null;
        if (kind && (!id || !seen.has(id))) {
          if (id) seen.add(id);
          const sp = spanOf(model, a);
          if (sp) {
            let end = sp[1];
            const script = adjacentScript(model, a);
            if (script) end = script[1];
            out.push({ kind: kind, start: sp[0], end: end, atom: a, el: null });
          }
        }
      }
      childBranches(a).forEach(function (br) { br.atoms.forEach(walk); });
    })(model.root);
    out.sort(function (a, b) { return a.start - b.start; });
    return out;
  }

  /* ================= 空槽（placeholder）只在正在编辑的整体里露出来 =================
   * 一屏的「·」太吵，而 MathLive 只有全局的 placeholderSymbol，没有「按原子开关」的选项。
   * 它能给的是：占位符在 model 里是独立的 placeholder 原子，渲染出来带 data-atom-id。
   * 于是：找到所有 placeholder 原子的 DOM，把「不在当前整体里」的那些 display:none。
   *
   * 三个坑：
   *   ① 隐藏会让公式变窄——MathLive 的光标是按上一帧布局算的，所以要重设一次选区让它重算；
   *   ② MathLive 会重建这些 DOM，我们写上去的行内样式会没——用 MutationObserver 补；
   *   ③ 观察者自己改样式又会触发回调——样式写前先比一次，值没变就不写，循环自然收敛。
   */

  let litUnitId = null;
  let painting = false;

  /** 光标此刻落在哪个整体里（整体套整体时取最小那个）。
   *  用偏移区间判定，但右边界要用夹过的 unitEnd——offsetOf 是后序编号，
   *  最后一个整体（公式结尾的那个）的 end 会比文档末尾多一格，不夹的话
   *  「光标贴在整体右侧」会被误判成「在整体里」，一屏的点又回来了。 */
  function litUnitNow(list) {
    const pos = mf.position;
    let best = null;
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      if (pos < u.start || pos >= unitEnd(u)) continue;
      if (!best || (u.end - u.start) < (best.end - best.start)) best = u;
    }
    return best;
  }

  /** 收集 model 里所有 placeholder 原子的 id */
  function placeholderIds() {
    const model = modelOf();
    if (!model || !model.root) return [];
    const ids = [];
    (function walk(a) {
      if (!a) return;
      if (a.type === 'placeholder' && a.id) ids.push(a.id);
      ATOM_KIDS.forEach(function (k) {
        if (Array.isArray(a[k])) a[k].forEach(walk);
      });
      const brs = a._branches;
      if (brs) Object.keys(brs).forEach(function (k) {
        const br = brs[k];
        if (Array.isArray(br)) br.forEach(walk);
        else if (br && Array.isArray(br.atoms)) br.atoms.forEach(walk);
      });
    })(model.root);
    return ids;
  }

  /** 点亮当前整体里的空槽，藏掉别人家的；状态有变时顺手把光标位置重算一遍 */
  function paintSlots() {
    const sr = mf.shadowRoot;
    if (!sr || painting) return;
    painting = true;
    try {
      const list = units();
      const ids = placeholderIds();
      if (!list.length && !ids.length) { litUnitId = null; return; }

      // 焦点不在公式里时没有光标可言，一律收起来
      const focused = document.activeElement === mf;
      const lit = (focused && list.length) ? litUnitNow(list) : null;
      const litId = (lit && lit.atom.id) ? String(lit.atom.id) : null;
      const changed = litId !== litUnitId;
      litUnitId = litId;

      if (ids.length) {
        // 一次 querySelectorAll 建索引，别为每个槽查一遍选择器
        const byId = new Map();
        Array.prototype.forEach.call(sr.querySelectorAll('[data-atom-id]'), function (el) {
          byId.set(el.getAttribute('data-atom-id'), el);
        });
        ids.forEach(function (id) {
          const el = byId.get(id);
          if (!el) return;
          // 只用「最近的整体」判定：整体里套整体时，里层的槽归里层管
          const host = el.closest('[data-fe]');
          const show = !!litId && !!host && host.getAttribute('data-atom-id') === litId;
          if (show) {
            if (el.style.display) el.style.display = '';
          } else if (el.style.display !== 'none') {
            el.style.display = 'none';
          }
        });
      }

      // 槽位一显一隐，公式宽度就变了；MathLive 的插入点还按旧布局算，重设一次让它对齐
      if (changed && !ime.on && focused) {
        const sel = mf.selection;
        const ranges = (sel && sel.ranges) || [];
        if (ranges.length === 1 && ranges[0][0] === ranges[0][1]) {
          const p = ranges[0][0];
          mf.selection = { ranges: [[p, p]] };
        }
      }
    } finally {
      painting = false;
    }
  }

  function schedulePaint() {
    if (painting) return;
    paintSlots();
    updateSlotUI();
  }

  /* ================= 当前槽的框 + 状态栏 =================
   * 光离开「把整格选中」那套之后，还有一个问题：元素那四格很小，光标又是细线，
   * 一眼看不出它在左上还是左下。所以额外画一个框——画在公式上层、不吃鼠标，
   * 不参与排版，也就不会像改 DOM 那样把公式撑来撑去。
   */

  const slotBox = document.getElementById('slotBox');
  const ctxEl = document.getElementById('ctx');

  const SLOT_NAMES = {
    superscript: '上标', subscript: '下标',
    numerator: '分子', denominator: '分母',
    above: '上方', below: '下方', index: '指数'
  };
  // 元素四槽的语义顺序：文档顺序就是 质量数 → 质子数 → 个数 → 电荷
  const ELEM_SLOT_NAMES = ['质量数', '质子数', '个数', '电荷'];

  function rectOfAtom(sr, u) {
    const host = mf.getBoundingClientRect();
    const el = (sr && u.atom.id) ? sr.querySelector('[data-atom-id="' + u.atom.id + '"]') : null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return { left: r.left - host.left, top: r.top - host.top, w: r.width, h: r.height };
  }

  function slotName(u, slots, idx) {
    if (idx < 0) return '';
    const s = slots[idx];
    if (!s) return '';
    if (u.kind === 'elem') {
      // 元素自己那四格按语义顺序命名；挂在它右后的上下标（H₂ 的 2）就是同一个「个数」。
      // 槽的 owner 往往是实体内部的原子（`{\vphantom{0}}` 的组、`\mathrm{Cu}`），
      // 不是 htmlData 那个外壳，所以靠 docFields 记的 external 标记分内外。
      if (!s.external) {
        const inner = slots.filter(function (x) { return !x.external; });
        const i = inner.indexOf(s);
        if (i >= 0 && i < ELEM_SLOT_NAMES.length) return ELEM_SLOT_NAMES[i];
      }
      return s.key === 'subscript' ? '个数' : s.key === 'superscript' ? '电荷' : (SLOT_NAMES[s.key] || s.key);
    }
    return SLOT_NAMES[s.key] || s.key;
  }

  /** 整体当前显示成什么字（给状态栏用）。
   *  不能直接用 textContent：元素那个 `{\vphantom{0}}` 底座里藏着一个看不见的 0，
   *  直接取会变成「00Cu」。跳过 opacity:0 的子树，再滤掉槽位的点。 */
  function unitText(u) {
    const sr = mf.shadowRoot;
    const el = (sr && u.atom.id) ? sr.querySelector('[data-atom-id="' + u.atom.id + '"]') : null;
    if (!el) return '';
    let s = '';
    (function walk(node) {
      if (node.nodeType === 3) { s += node.nodeValue; return; }
      if (node.nodeType !== 1) return;
      if (node.style && node.style.opacity === '0') return;
      for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
    })(el);
    return s.replace(/[·\u200b\s]/g, '');
  }

  let uiSig = '';

  function updateSlotUI() {
    if (!slotBox || !ctxEl) return;
    const sr = mf.shadowRoot;
    const model = modelOf();
    const list = units();
    const focused = document.activeElement === mf;
    const cand = (focused && model && list.length)
      ? (unitOf(list, mf.position) || unitBefore(list, mf.position)) : null;
    // 用夹过的 unitEnd 判「在里面」：offsetOf 是后序编号，整体右边界的那个位置
    // 在数字上仍然「小于 end」，不夹的话「刚写完一个实体」会被当成「停在实体里」。
    const inside = (cand && mf.position > cand.start && mf.position < unitEnd(cand)) ? cand : null;
    const u = cand;

    if (!u) {
      // 光标不在任何实体里也照样给一行：不然状态栏整块消失，左下角就只剩几个按键提示，
      // 用户不知道「现在在哪、下一步能干什么」。
      const idleSig = 'idle|' + (focused ? 1 : 0) + '|' + list.length;
      if (uiSig === idleSig) return;
      uiSig = idleSig;
      slotBox.hidden = true;
      // 小窗里空着的时候什么都不写：下面已经有一行按键提示，再叠一句「空白 · 待输入」纯属噪音
      if (PLUGIN) { ctxEl.hidden = true; ctxEl.textContent = ''; return; }
      ctxEl.hidden = false;
      ctxEl.textContent = '';
      const w = document.createElement('span');
      w.className = 'who';
      w.textContent = list.length ? '正文' : '空白';
      ctxEl.appendChild(w);
      const t = document.createElement('span');
      t.className = 'tag idle';
      t.textContent = list.length ? '不在块里' : '待输入';
      ctxEl.appendChild(t);
      const h = document.createElement('span');
      h.className = 'kbd-tip';
      h.textContent = list.length
        ? 'Tab 进最近的块 · ← → 逐格走'
        : '# 符号 · @ 变量 · $ 元素';
      ctxEl.appendChild(h);
      return;
    }

    const slots = slotsOf(model, u.atom);
    const cur = slotIndexOf(model, u, slots);
    const inSlot = cur >= 0;
    // 光标在实体里、但没落在任何一格里 → 「整块模式」（退格删整个）。
    // 只是「贴在实体右侧」不算：那还没进实体，不该给用户一个「要删了」的框。
    const blockMode = !!inside && cur < 0;
    const box = inSlot ? slotRect(sr, slots[cur]) : (blockMode ? rectOfAtom(sr, u) : null);
    const name = inSlot ? slotName(u, slots, cur) : '';
    const text = unitText(u);
    const sig = [u.kind, u.start, cur, blockMode, text, name,
      box ? Math.round(box.left) + ',' + Math.round(box.top) + ',' + Math.round(box.w) + ',' + Math.round(box.h) : 'x'].join('|');
    if (sig === uiSig) return;
    uiSig = sig;

    // 框
    if (box && box.w >= 0 && box.h > 0) {
      const wrap = slotBox.parentElement.getBoundingClientRect();
      const ox = mf.getBoundingClientRect().left - wrap.left;
      const oy = mf.getBoundingClientRect().top - wrap.top;
      slotBox.hidden = false;
      slotBox.className = 'slot-box' + (blockMode ? ' block' : '');
      slotBox.style.left = Math.round(ox + box.left - (inSlot ? 4 : 3)) + 'px';
      slotBox.style.top = Math.round(oy + box.top - (inSlot ? 4 : 3)) + 'px';
      slotBox.style.width = Math.max(0, Math.round(box.w + (inSlot ? 8 : 6))) + 'px';
      slotBox.style.height = Math.max(0, Math.round(box.h + (inSlot ? 8 : 6))) + 'px';
    } else {
      slotBox.hidden = true;
    }

    // 状态栏
    ctxEl.textContent = '';
    ctxEl.hidden = false;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = (u.kind === 'elem' ? '元素 ' : u.kind === 'var' ? '变量 ' : '结构 ') + (text || '');
    ctxEl.appendChild(who);

    const tag = document.createElement('span');
    tag.className = 'tag' + (blockMode ? ' block' : '');
    tag.textContent = inSlot
      ? (name || '槽') + '　' + (cur + 1) + '/' + slots.length
      : blockMode ? '整块' : '实体外';
    ctxEl.appendChild(tag);

    const tip = document.createElement('span');
    tip.className = 'kbd-tip';
    tip.textContent = inSlot
      ? '退格只删这格 · Tab/方向键换格'
      : blockMode ? '退格删整块 · Tab 进第一格' : 'Tab 进第一格';
    ctxEl.appendChild(tip);
  }

  /** 光标是否落在某个整体内部（含左边界，不含右边界）。
   *  整体套整体（变量放在元素的槽里、函数的幂里再放一个变量）时取**最内层**：
   *  光标明明在里层那个变量里，却按外层删，用户看到的就是「一按退格整段没了」。 */
  function unitOf(list, pos) {
    let best = null;
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      if (pos >= u.start && pos < u.end) {
        if (!best || u.start > best.start) best = u;
      }
    }
    return best;
  }

  /** 光标「贴着」某个整体的右边界时（贴着不算在里面），取最内层那个。
   *  刚插完一个整体，MathLive 把光标放在它的末尾；整体套整体时那个位置同时也在外层的
   *  下半段里，所以要按「谁的右边界正好在这」来认，才不会把光标甩到外层外面去。 */
  function unitBefore(list, pos) {
    let best = null;
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      if (unitEnd(u) === pos && u.start < pos) {
        if (!best || u.start > best.start) best = u;
      }
    }
    return best;
  }

  /** 整体右侧的光标位置。offsetOf 是后序编号，末位的 end 可能超出文档长度，要夹一下 */
  function unitEnd(u) {
    const model = modelOf();
    const last = model && typeof model.lastOffset === 'number' ? model.lastOffset : null;
    return (last != null && u.end > last) ? last : u.end;
  }

  /** 光标是不是紧贴着这个实体的**最后一块**（实体本体、它的子孙原子，或者并进来的上下标）。
   *
   *  为什么不能用 unitEnd 算：`spanOf` 的 end 是「最后一个原子的 offset + 1」，而
   *  「在实体右边」的插入点是「最后一个原子的 offset」——两者差一格。实体后面还接着
   *  别的字（比如 O₂ 后面那个 =）时，unitEnd 会落到那个字后面去，于是「删 =」被误当成
   *  「贴着 O₂ 的右边」→ 一按退格把氧气也带走。直接问原子树最准。 */
  function atUnitTail(model, u, pos) {
    if (!model || !u) return false;
    // 左边界不算「尾巴」：整体内部第一个原子的 offset 正好等于整体自己的 `start`，
    // 所以 `at(start)` 会返回整体内部的原子，看起来像贴着最后一块——`2|Cu` 按退格
    // 想删那个 2，结果把 Cu 整块删了。左边界归 handleUnitKey 的 ⑤ 单独处理。
    if (pos <= u.start) return false;
    const last = atomAt(model, pos);
    if (!last) return false;
    if (last === u.atom || pathTo(u.atom, last)) return true;
    const sib = adjacentScriptAtom(model, u.atom);
    return !!(sib && (last === sib || pathTo(sib, last)));
  }

  function selectRange(a, b) {
    mf.selection = { ranges: [[a, b]], direction: 'forward' };
  }

  /** 某个位置左边还有没有「真字」（数字、符号、别的整体……）。
   *
   *  整体内部原子的 offset 都 ≥ 它自己的 `start`，所以「存在 offset < start 的叶子」
   *  就等于「左边还有内容」。用来区分「`2|Cu` 按退格该删那个 2」和
   *  「实体就在文档最开头、退格只能删它自己」。 */
  function hasLeftContent(model, pos) {
    if (!model) return false;
    const body = (model.root && model.root.body) || [];
    const offs = contentOffsets(model, body, []);
    return offs.some(function (o) { return o < pos; });
  }

  /** 把光标送进整体里的第一格（元素 / 变量刚创建完时用）。
   *  which = -1 时进最后一格（Shift+Tab 从实体左边倒着走回来）。 */
  function enterUnitSlot(which) {
    const model = modelOf();
    const list = units();
    if (!model || !list.length) return false;
    const u = unitOf(list, mf.position) || unitBefore(list, mf.position);
    if (!u) return false;
    const slots = slotsOf(model, u.atom);
    if (!slots.length) return false;
    gotoSlot(slots[which === -1 ? slots.length - 1 : 0]);
    return true;
  }

  /** 把光标从整体里提出来，落到它右侧。
   *  「哪个整体」按最内层算：刚插进去的那个整体才是刚刚建出来的那个，
   *  整体套整体时把光标甩到最外层右边，用户下一次输入就跑到外层的槽外面去了。 */
  function caretOutOfUnit() {
    const list = units();
    if (!list.length) return false;
    const pos = mf.position;
    const u = unitOf(list, pos) || unitBefore(list, pos);
    if (!u) return false;
    const at = unitEnd(u);
    selectRange(at, at);
    focusField();
    return true;
  }

  /** 整体删除：选中它再删，四个槽一起走。
   *  选区要在本轮按键处理结束后再交给 MathLive——keydown 里同步改选区，
   *  它自己的 keyboard delegate 随后还会按旧位置算一遍，删除会落空。 */
  function dropUnit(u) {
    selectRange(u.start, unitEnd(u));
    pendingSlot = false;
    setTimeout(function () {
      focusField();
      mf.executeCommand(['deleteBackward']);
    }, 0);
  }

  /** 光标是否正贴着某个整体的**左边界**（`pos === u.start`）。是就返回那个整体。
   *
   *  为什么需要它：MathLive 的插入点是「在 offset 为 pos 的那个原子**后面**插」，
   *  而整体内部第一个原子的 offset 就正好等于整体自己的 start。所以光标摆在整体左边时，
   *  打一个字会被塞进整体内部（`Cu` → 同一个块里变成 `xCu`），一个块就有了两个符号：
   *  删一次走两个、四个槽也跟着串位。 */
  function leftUnitAt(pos) {
    const list = units();
    for (let i = 0; i < list.length; i++) {
      if (list[i].start === pos) return list[i];
    }
    return null;
  }

  /** 光标是不是贴在某个整体的左边（含「左边界前一格」）。
   *  结构性整体（分式、根号）的最左一个原子前面有时还空着一格，光标会停在 `start - 1`：
   *  那里插进去同样会被 MathLive 解析成整体内部，所以一并算作左边界。 */
  function atUnitLeftEdge(pos) {
    return leftUnitAt(pos) || leftUnitAt(pos + 1);
  }

  /** 在整体左边界落笔：把整体原封不动挪到新内容右边，新内容才有地方站。
   *
   *  做法是「取出 → 删掉 → 插新内容 → 把整体插回去」而不是直接 insert：
   *  offset 上根本没有「紧贴整体左边」这个位置（它和「整体内部最左一格」是同一个数），
   *  只有先把整体拿走，光标才落在一个**外层**的可插入位置上。
   *
   *  `del` 是已经打进公式的待定码字数（`#al` 的 3 个字符）：它们也在整体左边，
   *  而这里 `deleteBackward` 是空的（插入点被解析成整体内部），所以必须**连待定码一起
   *  按区间换掉**——选区端点比原子右边界少一格，`[pos-del-1, pos)` 正好盖住那几个字。
   *
   *  整体原文用 `getValue([start,end],'latex')` 取，带 `\htmlData` 外壳与已填的槽，
   *  插回去还是同一个整体（不是重新拼一个）。成功返回 true，调用方不要再 insert。 */
  function insertBeforeUnit(tex, del) {
    const model = modelOf();
    if (!model) return false;
    const pos = mf.position;
    const u = atUnitLeftEdge(pos);
    if (!u) return false;
    const hi = unitEnd(u);
    let own = null;
    try { own = mf.getValue({ ranges: [[u.start, hi]] }, 'latex'); } catch (e) { own = null; }
    if (!own) return false;

    const n = del || 0;
    const lo = n > 0 ? Math.max(0, pos - n - 1) : pos;
    // 一次把「待定码 + 整个整体」选走再删：删完光标就落在一个外层位置上
    selectRange(lo, hi);
    mf.executeCommand(['deleteBackward']);
    if (tex) mf.insert(tex, { insertionMode: 'replaceSelection', selectionMode: 'after', format: 'latex', mode: 'math' });
    mf.insert(own, { insertionMode: 'replaceSelection', selectionMode: 'placeholder', format: 'latex', mode: 'math' });

    // 刚插回去的那个整体：从光标往上爬，遇到的第一个 \htmlData 就是它。
    // 光标这时被 selectionMode:'placeholder' 放进了它的第一格，所以要爬回去。
    let a = null;
    try { a = model.at(mf.position); } catch (e) { a = null; }
    let guard = 0;
    while (a && a.command !== '\\htmlData' && guard++ < 80) a = a.parent;
    const sp = a ? spanOf(model, a) : null;
    if (sp && sp[0] <= mf.position && mf.position < sp[1]) mf.position = sp[0];
    pendingSlot = false;
    slotEdit = null;
    return true;
  }

  /** 光标在整体里时，把 Backspace / Delete / ← / → 升级成「整块」语义。
   *  唯一的例外是**槽**：光标停在一格里（上标、下标、元素那些格、根号里、分子分母……）时，
   *  退格只删这一格的最后一个字，删空了也不许把整个实体带走。
   *
   *  第 17 批把「槽」从「当前实体」扩到**整篇文档**，顺手修了三处：
   *   ① 实体边界上退格删的是**左边**那个实体（以前 unitOf 从起点算，会删掉右边那个）；
   *   ② 只有「整个实体被选中」才整块删，选中实体里一段字就照常删这一段；
   *   ③ 化合物右边那个上下标（H₂ 的 2）删空之后，再退格删掉这个空上下标本身，
   *      而不是一口把元素吞掉。 */
  /** 光标在这一格**内部**逐字走：返回该去的那个原子边界，没有更近的就返回 null（该出格了）。
   *
   *  为什么不能交给渲染引擎：`_{2+}` 这样的格子里有不止一个字，原生 ← / → 会一步
   *  跳出整格（从 `+` 后面直接跳到左边的槽），用户看到的就是「光标完全掠过了那个 2」。
   *  自己按 `leaves`（格内真字符的 offset）一个个挪，格子里的每个字都能停到。 */
  function stepInsideField(f, dir, pos) {
    if (!f || !f.leaves || f.leaves.length < 2) return null;
    let best = null;
    for (let i = 0; i < f.leaves.length; i++) {
      const v = f.leaves[i];
      if (dir === 'left') {
        if (v < pos && (best == null || v > best)) best = v;
      } else if (dir === 'right') {
        if (v > pos && (best == null || v < best)) best = v;
      }
    }
    return best;
  }

  function handleUnitKey(ev) {
    const k = ev.key;
    if (k !== 'Backspace' && k !== 'Delete' && k !== 'ArrowLeft' && k !== 'ArrowRight' &&
        k !== 'ArrowUp' && k !== 'ArrowDown') return false;
    if (ev.shiftKey || ev.ctrlKey || ev.metaKey || ev.altKey) return false;

    const list = units();
    if (!list.length) return false;
    const model = modelOf();
    const pos = mf.position;

    const sel = mf.selection;
    const ranges = (sel && sel.ranges) || [];
    const r0 = ranges.length === 1 ? ranges[0] : null;
    const collapsed = !r0 || r0[0] === r0[1];

    if (!collapsed) {
      if (k === 'ArrowLeft' || k === 'ArrowRight') return false;
      const a = Math.min(r0[0], r0[1]);
      const b = Math.max(r0[0], r0[1]);
      // 只有选区把整个实体都盖住，才按「整块」删
      for (let i = 0; i < list.length; i++) {
        const u = list[i];
        if (a <= u.start && b >= unitEnd(u)) { stop(ev); dropUnit(u); return true; }
      }
      const uu = unitOf(list, a);
      if (uu) {
        // 选区里有没有「真字」？没有就只是圈到了空槽（MathLive 提交结构后常常这样留一个
        // 非折叠选区），当成「选中整个实体」删掉；有真字就只删这几个字，别连实体一起带走。
        const all = model ? contentOffsets(model, [uu.atom], []) : [];
        const hasText = all.some(function (off) { return off > a && off <= b; });
        if (!hasText) { stop(ev); dropUnit(uu); return true; }
        return false;
      }
      const f = fieldAt(a);
      if (f && !f.leaves.some(function (off) { return off > a && off <= b; })) {
        stop(ev);
        return true;                        // 选中的只是空占位符：删掉会把结构拆了
      }
      return false;
    }

    const here = fieldAt(pos);
    const u = unitOf(list, pos);            // 起始边界也算「在实体里」
    const before = unitBefore(list, pos);   // 光标正好贴着某个实体的右边界
    const dir = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[k];

    if (k === 'Backspace' || k === 'Delete') {
      // 退格的优先级（都是「光标左边那一样东西」）：
      //  ① 里层实体：光标停在某一格里，左边正好是里层那个实体的右边界 → 整块删它
      //     （元素的槽里放了个变量、变量的幂里放了个变量）
      //  ② 光标本来就在某一格里 → 只动这一格
      //  ③ 两个实体首尾相接（H₂O 中间那道缝）→ 删左边那个，别删右边的氧
      //  ④ 光标贴着某个实体的最后一块 → 整块删
      //  ⑤ 实体左边界：左边还有东西就删左边那一样，只有左边真空着才删实体自己
      //  ⑥ 其余交给 MathLive：删一个原子（O₂ 后面那个 = 就是这一种）
      if (k === 'Backspace') {
        // ① 里层实体（光标停在外层某一格里，左边正好是里层实体的右边界）→ 整块删它
        if (here && before && before.atom !== here.unit) { stop(ev); dropUnit(before); return true; }
        // ② 光标本来就在某一格里 → 只动这一格
        if (here) return editInField(ev, here, k, list);
        // ③ 两个实体首尾相接（H₂O 中间那道缝）→ 删左边那个，别删右边的氧
        if (u && before && pos === u.start) { stop(ev); dropUnit(before); return true; }
        // ④ 光标贴着某个实体的最后一块 → 整块删
        if (before && atUnitTail(model, before, pos)) { stop(ev); dropUnit(before); return true; }
        if (u && atUnitTail(model, u, pos)) { stop(ev); dropUnit(u); return true; }
        // ⑤ 实体左边界（← 刚把光标送到这儿）。
        //    结构性整体（分式、根号）最左一格前面还空着一格，光标会停在 `start - 1`，
        //    那也是「整体左边」，一并处理。
        const edgeU = (u && pos === u.start) ? u : leftUnitAt(pos + 1);
        if (edgeU) {
          // 左边那个字（`2Cu` 的 2）才是「眼前那一样」。
          // 注意 `pos === start` 时 MathLive 原生的 deleteBackward 是空操作
          // （插入点被解析成整体内部最左一格，前面没有原子可删），必须走区间删。
          if (hasLeftContent(model, edgeU.start)) {
            stop(ev);
            backspace(1);
            return true;
          }
          // 左边真的什么都没有（实体就在文档最前面）→ 删这个实体自己
          stop(ev); dropUnit(edgeU); return true;
        }
        return false;
      }
      if (here) return editInField(ev, here, k, list);
      if (u) { stop(ev); dropUnit(u); return true; }     // Delete：删右边那个
      return false;
    }

    // ---- 方向键 ----
    // ⓪ 先在**这一格内部**逐字走。`_{2+}` 这种格子里有多个字符，原生 ← / → 会一步
    //    跳出整格（用户看到的就是「光标完全掠过了那个 2」），所以自己按字挪。
    if (here && (dir === 'left' || dir === 'right')) {
      const step = stepInsideField(here, dir, pos);
      if (step != null) { stop(ev); selectRange(step, step); focusField(); return true; }
    }
    // ① 再在**当前实体内部**按屏幕方位走：元素四格是「左上、左下、右下、右上」，
    //    文档顺序和眼睛看到的方向并不一致。
    //    实体右边那串外挂上下标（H₂ 的 2）不参与这套方位计算——它不在四格那张图里，
    //    交给 ③ 的文档顺序走，才不会把「→」从个数拽到外挂的下标上去。
    const uFields = (u && model) ? slotsOf(model, u.atom).filter(function (f) { return !f.external; }) : [];
    if (u && here && here.unit === u.atom && !here.external && uFields.length) {
      const cur = uFields.findIndex(function (s) { return s.owner === here.owner && s.key === here.key; });
      // 槽里还有字、光标又没走到这一格的边上 → 让 MathLive 原生挪一格
      if (cur >= 0 && here.leaves.length) {
        let mn = Infinity;
        let mx = -Infinity;
        here.leaves.forEach(function (v) { if (v < mn) mn = v; if (v > mx) mx = v; });
        if (dir === 'left' && pos > mn - 1) return false;
        if (dir === 'right' && pos < mx) return false;
      }
      if (cur >= 0) {
        const s = stepSlot(mf.shadowRoot, uFields, cur, dir);
        if (s) { stop(ev); gotoSlot(s); return true; }
      }
    }
    // ② 本实体里没有邻居了 → 先看紧挨着的普通原子（`+`、`=`、数字……）。
    //    它们是「两个实体之间」的东西，不该被一步跨过去。
    //    只有两种时候才考虑：光标在间隙里（`u` 为空），或者光标正在某个格里
    //    （说明实体内已经走完）。光标落在实体**主体**上时（`here` 为空）不能跳，
    //    否则会越过还没访问的槽——`O` 的右端按 `←` 会直接飞到 `+`，O 的四格全没了。
    const stepDir = (dir === 'left' || dir === 'up') ? -1 : 1;
    if (model && (k === 'ArrowLeft' || k === 'ArrowRight') && (!u || here)) {
      const gap = gapAtomNear(model, pos, stepDir, list);
      if (gap != null) { stop(ev); selectRange(gap, gap); focusField(); return true; }
    }
    // ③ 再没有 → 看整篇文档的上一格 / 下一格。化合物就是这么走过去的：
    //    H 的电荷 → H 后面那个 2 → O 的质量数 ……
    const nf = fieldNext(pos, stepDir);
    if (nf) { stop(ev); gotoSlot(nf); return true; }

    if (k === 'ArrowUp' || k === 'ArrowDown') return false;   // 上下没有邻居：交回 MathLive
    const edge = u || before;
    if (!edge) return false;
    stop(ev);
    if (k === 'ArrowLeft') { selectRange(edge.start, edge.start); focusField(); return true; }
    selectRange(unitEnd(edge), unitEnd(edge));
    focusField();
    return true;
  }

  /** 光标在某一格里时按退格 / Delete：
   *  格里有字 → 只删这一格的字；格空了 → 保住实体，只把这一格清干净。 */
  function editInField(ev, f, k, list) {
    const pos = mf.position;
    const hit = f.leaves.some(function (off) { return k === 'Backspace' ? off <= pos : off > pos; });

    if (hit) {
      // 格末尾那格是「幽灵位」：MathLive 把上标末尾记成外层原子的 offset，
      // 在那里原生退格只会把光标挪进来一格，什么也不删——自己删掉前一个字
      const ghost = k === 'Backspace' && pos === f.end &&
        !f.leaves.some(function (off) { return off === pos; });
      if (ghost) {
        stop(ev);
        const last = f.leaves.reduce(function (m, off) { return off > m ? off : m; }, -Infinity);
        selectRange(last, last);
        setTimeout(function () {
          focusField();
          mf.executeCommand(['deleteBackward']);
          refillSlot();
        }, 0);
        return true;
      }
      setTimeout(refillSlot, 0);          // 交给 MathLive：按普通字符删
      return false;
    }

    stop(ev);
    const model = modelOf();
    // ① 挂在实体右边的上下标（H₂ 的 2）删空之后：把这个空上下标本身删掉。
    //    不这么做的话，光标会卡在一个空壳里，再退格就只能一口吞掉整个元素。
    //    用这一格自己的 [start, end] 选区间——`spanOf` 的 end 多算一格，会越界。
    if (f.unit && f.external && model) {
      const lastOff = typeof model.lastOffset === 'number' ? model.lastOffset : f.end;
      const hi = Math.min(f.end, lastOff);
      if (hi > f.start) {
        selectRange(f.start, hi);
        setTimeout(function () { focusField(); mf.executeCommand(['deleteBackward']); }, 0);
        return true;
      }
    }
    // ② 实体自己的槽：里面已经有内容（元素名 / 变量名 / 别的填好的槽）就到此为止，
    //    免得「改一个数字」变成「整个删掉」；空模板（刚插进来的根号、分式）照旧整删。
    const rec = f.unit ? list.filter(function (x) { return x.atom === f.unit; })[0] : null;
    if (rec) {
      if (hasTypedContent(rec.atom)) return true;
      dropUnit(rec);
      return true;
    }
    return true;
  }

  /* 结构提交后光标本该落进第一个空槽，但 MathLive 会在一两帧后刷新内部状态、
   * 把光标甩回末尾。所以提交时只记一个「待填槽」，等用户敲第一个字符时再定位——
   * 那时模型已经稳定，定位命令才真正生效。 */
  let pendingSlot = false;
  /** 提交结构那一刻光标在哪：找空槽时以它为起点，别跑到文档开头那一格去 */
  let pendingSlotFrom = null;

  /** 把光标送进刚插进去那个结构的第一个空槽（提交后即时定位失败时的兜底）。
   *
   *  起点是**提交那一刻的光标位置**，不是文档开头：老写法 `moveToMathfieldStart` +
   *  `moveToNextPlaceholder` 在只有一个结构的文档里没问题，但文档里已经有元素 / 变量时，
   *  它会跑到文档最开头那一格去，刚插的结构反而没人填。
   *
   *  `moveToNextPlaceholder` 会把整格「选中」（蓝方块、没有插入点），所以退一格改成折叠选区：
   *  占位符占 [hi-1, hi]，`hi - 1` 才是里面那个真插入点。 */
  function jumpToSlot() {
    const from = (typeof pendingSlotFrom === 'number') ? pendingSlotFrom : null;
    if (from == null) mf.executeCommand(['moveToMathfieldStart']);
    else selectRange(from, from);
    mf.executeCommand(['moveToNextPlaceholder']);
    const sel = mf.selection && mf.selection.ranges;
    const r = sel && sel.length === 1 ? sel[0] : null;
    if (r && r[1] > r[0]) selectRange(r[1] - 1, r[1] - 1);
  }

  function cancelIme() {
    const n = preeditLength();
    if (n) backspace(n);
    endIme();
  }

  function commitEntry(entry) {
    if (!entry) { cancelIme(); return; }
    const raw = E.expand(entry).text;
    const back = ime.ret;
    // 结构类符号（根号、积分、分式、矩阵…）整体包一层：光标一跳过、退格一删全。
    // 变量名里的符号不包——它只是名字的一个片段，包了会破坏 \mathrm 的推定。
    const tex = back ? raw : (isStructured(raw) ? wrapUnit('sym', raw) : raw);

    replacePreedit(tex, { del: ime.buf.length + 1, noSlot: !!back });

    if (back) {
      // 这段符号码已经变成真符号，回到变量 / 元素主体里继续敲
      ime.parts.push({ t: 'sym', v: raw, label: '#' + entry.t });
      ime.mode = back;
      ime.ret = null;
      ime.buf = '';
      ime.cands = [];
      ime.idx = 0;
      pendingSlot = false;
      refreshCand();
      return;
    }
    endIme();
  }

  /** 二次解析（##X）：把已敲的名字当码解析成字符，再把字符当码解析一次。
   *  只对旧写法 `##` 生效；`@Tom` 是变量，不做这件事。
   *  返回 { first, char, entry } 或 null。 */
  function secondOf(text) {
    if (ime.mode !== 'var' || ime.entry !== '##') return null;
    if (ime.parts.some(function (p) { return p.t !== 'text'; })) return null;  // 夹了符号码的名字不参与
    const s = (text == null) ? ime.parts.map(function (p) { return p.v; }).join('') : text;
    return s ? E.secondPass(s) : null;
  }

  /** 落定二次解析的结果：撤掉已敲的名字，插入第二遍的符号 */
  function commitSecond(dbl) {
    const raw = E.expand(dbl.entry).text;
    replacePreedit(isStructured(raw) ? wrapUnit('sym', raw) : raw, { del: preeditLength() });
    endIme();
    toast('二次解析：#' + dbl.first.t + ' → ' + dbl.char + ' → #' + dbl.char + ' → ' + dbl.entry.d);
  }

  /** 主体收尾：变量或元素已经敲完名字，把它落成结构 */
  function closeBody(thenSlot) {
    if (ime.mode === 'var') {
      const dbl = secondOf(null);
      if (dbl) { commitSecond(dbl); return; }
      createVar(thenSlot);
    } else if (ime.mode === 'elem') createElem(thenSlot);
    else cancelIme();
  }

  /** 变量收尾：把已经打出来的变量名换成一个整体变量。
   *  正上方留空槽（标注 / 估计量），右上与右下不预置——
   *  光标停在整体右侧，直接敲 ^ / _ 就落在整体自己的上标 / 下标分支里，
   *  删除整体时它们跟着一起走。 */
  function createVar(thenSlot) {
    const text = ime.parts.map(function (p) { return p.v; }).join('');
    if (!text) { cancelIme(); return; }

    // 纯字母数字 → 正体；已经含 α 之类的符号 → 不能再套 \mathrm（\mathrm{\alpha} 不生效）
    const inner = /^[A-Za-z0-9]+$/.test(text) ? '\\mathrm{' + text + '}' : text;
    const body = '\\overset{}{' + inner + '}';

    replacePreedit(wrapUnit('var', body), { del: preeditLength(), noSlot: true });

    const script = ime.script;
    ime.script = null;

    // 光标留在整体右侧，别让后面的输入掉进上标 / 下标槽
    setTimeout(function () {
      if (ime.on) return;
      focusField();
      if (!caretOutOfUnit()) mf.executeCommand(['moveAfterParent']);
      if (script) attachScript(script);
      if (thenSlot) setTimeout(enterUnitSlot, 0);
    }, 30);

    endIme();
    toast('变量已创建');
  }

  /** 元素收尾：$Cu → 元素主体。四个槽（左上质量数 / 左下质子数 / 右上电荷 / 右下个数）
   *  由引擎的 elementLatex 生成，这里只管落位与光标。 */
  function createElem(thenSlot) {
    const name = ime.parts.map(function (p) { return p.t === 'text' ? p.v : ''; }).join('');
    if (!name) { cancelIme(); return; }

    if (!E.isElement(name)) {
      toast('「' + name + '」不是元素符号（大小写敏感：Cu 是铜，CO 不是元素）');
      cancelIme();
      return;
    }

    replacePreedit(wrapUnit('elem', E.elementLatex(name)), { del: preeditLength(), noSlot: true });

    const script = ime.script;
    ime.script = null;

    // 光标停在整体右侧：接着敲 _2 会成为整体的下标（H₂O 的写法）；
    // 想填四个槽就按 Tab——第一下 Tab 收尾并直接进第一格（thenSlot）。
    setTimeout(function () {
      if (ime.on) return;
      focusField();
      if (!caretOutOfUnit()) mf.executeCommand(['moveToMathfieldEnd']);
      if (script) attachScript(script);
      if (thenSlot) setTimeout(enterUnitSlot, 0);
    }, 30);

    endIme();
    toast('元素 ' + name + ' 已创建');
  }

  /** 元素 / 变量名字后面紧跟的 `_` `^`：先把名字落成实体，再把下标 / 上标挂到它右侧，
   *  光标直接进那一格。这样 `$H` `_` `2` 才真的是 H₂（以前 `_` 被当成名字里的非法字符吞掉，
   *  接着敲的 2 并进名字里，`H2` 直接不是元素）。 */
  function attachScript(ch) {
    if (ime.on) return;
    focusField();
    mf.insert(ch === '_' ? '_{\\placeholder{}}' : '^{\\placeholder{}}');
    const list = docFields();
    let best = null;
    for (let i = 0; i < list.length; i++) {
      if (list[i].external && (!best || list[i].end >= best.end)) best = list[i];
    }
    if (best) gotoSlot(best);
  }

  function commitCurrent() {
    // 变量 / 元素只能用各自的起手符收尾，Tab / Enter 不算（handleImeKey 里还会再拦一次）。
    // 注意 ret 有值时 mode 已经是 'sym'，那是「主体里嵌的符号码」，照常提交。
    if (ime.mode !== 'sym') return;
    if (!ime.buf) { cancelIme(); return; }
    commitEntry(ime.cands[ime.idx] || E.query(ime.buf).exact);
  }

  /* ================= 候选列表（悬浮在光标下方） ================= */

  function glyphNode(entry) {
    const span = document.createElement('span');
    span.className = 'glyph';
    let x = entry.x.replace(/\$0/g, '');
    // 结构类条目（分式、根号、积分、矩阵…）本身是空壳，渲染出来什么都没有，
    // 往空组里塞个 a 当样例，候选条里就能看到它长什么样
    // 注意是 '{}' → '{a}'：'\frac{}{}' 里有两个相邻空组，直接替换会连大括号一起吃掉
    x = x.replace(/\{\}/g, '{a}');
    // 用 MathLive 真渲染：∪、α、分式……直接看到符号长什么样，
    // 只有渲染失败或渲染成空白才退回占位
    try {
      const out = MathLive.convertLatexToMarkup(x);
      Promise.resolve(out).then(function (html) {
        if (!html) { span.textContent = '▦'; return; }
        span.innerHTML = html;
        // 渲染完是空的就当没渲染出来
        if (!span.textContent.replace(/[\u200b\s]/g, '')) span.textContent = '▦';
      }).catch(function () { span.textContent = '▦'; });
    } catch (err) {
      span.textContent = '▦';
    }
    return span;
  }

  /** 一条候选：样张 + #码 + 说明；onPick 默认走正常提交 */
  function candItem(entry, selected, onPick) {
    const item = document.createElement('div');
    item.className = 'item' + (selected ? ' sel' : '');

    const code = document.createElement('span');
    code.className = 'code';
    code.textContent = '#' + entry.t;

    const desc = document.createElement('span');
    desc.className = 'desc';
    desc.textContent = entry.d;

    item.appendChild(glyphNode(entry));
    item.appendChild(code);
    item.appendChild(desc);
    item.addEventListener('mousedown', function (ev) {
      ev.preventDefault();
      (onPick || commitEntry)(entry);
    });
    return item;
  }

  function refreshCand() {
    cand.innerHTML = '';
    const items = document.createElement('div');
    items.className = 'items';

    if (ime.mode !== 'sym') {
      const typed = ime.parts.map(function (p) { return p.t === 'text' ? p.v : p.label; }).join('');
      const isVar = ime.mode === 'var';
      const dbl = secondOf(typed);
      if (dbl) {
        // ##Sigma：先把 #Sigma 解析成 Σ，再把 Σ 当码解析一次 → ∑
        const comp = document.createElement('div');
        comp.className = 'comp';
        comp.textContent = '二次解析　#' + dbl.first.t + ' → ' + dbl.char + ' → #' + dbl.char;
        items.appendChild(comp);
        items.appendChild(candItem(dbl.entry, true, function () { commitSecond(dbl); }));
      } else if (typed || ime.hashPending) {
        const comp = document.createElement('div');
        comp.className = 'comp';
        comp.textContent = (isVar ? '变量 ' : '元素 ') + (isVar ? '@' : '$') + typed + (ime.hashPending ? '#' : '');
        items.appendChild(comp);
      }
      const hint = document.createElement('div');
      hint.className = 'hint';
      if (dbl) {
        hint.textContent = 'Tab / Enter 选用二次解析结果；想建同名变量请改用 @';
      } else if (isVar) {
        hint.textContent = ime.hashPending
          ? '再按一次 # 结束变量'
          : '变量名：字母数字，或 #alpha 这样的符号码　@ / Tab 结束';
      } else if (!typed) {
        hint.textContent = '元素符号：H He C N O Cu Fe …（大小写敏感）　$ / Tab 结束';
      } else if (E.isElement(typed)) {
        hint.textContent = '✔ ' + typed + ' 是元素符号　$ / Tab 结束';
      } else {
        hint.textContent = '✘ 「' + typed + '」不是元素符号（大小写敏感：Cu 是铜，CO 不是）';
      }
      items.appendChild(hint);
    } else if (!ime.buf) {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = '输入符号代码：alpha、U、--、S …';
      items.appendChild(hint);
    } else if (!ime.cands.length) {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = '没有匹配的码 · 退格修改，Esc 取消';
      items.appendChild(hint);
    } else {
      // 变量 / 元素里起的符号码：顶部标出「我在谁里面」
      if (ime.ret) {
        const comp = document.createElement('div');
        comp.className = 'comp';
        const typed = ime.parts.map(function (p) { return p.t === 'text' ? p.v : p.label; }).join('');
        comp.textContent = (ime.ret === 'var' ? '变量 ' : '元素 ') + typed + '#' + ime.buf;
        items.appendChild(comp);
      }
      ime.cands.forEach(function (entry, idx) {
        items.appendChild(candItem(entry, idx === ime.idx));
      });

      // 明确给一个「选用」按钮：不点它、不按 Tab/Enter，就不会发生任何转换
      const foot = document.createElement('div');
      foot.className = 'cand-foot';

      const tip = document.createElement('span');
      tip.className = 'cand-tip';
      tip.textContent = 'Tab / Enter 选用　↑↓ 换　Esc 取消';
      foot.appendChild(tip);

      const ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'cand-ok';
      ok.textContent = '选用';
      ok.addEventListener('mousedown', function (ev) {
        ev.preventDefault();
        commitCurrent();
      });
      foot.appendChild(ok);

      items.appendChild(foot);
    }

    cand.appendChild(items);
    cand.hidden = false;
    placeCand();
    paintEcho();
  }

  /** 把候选列表放到光标正下方；光标太靠下就翻到上方，别掉出可视区 */
  function placeCand() {
    const host = cand.parentElement;
    if (!host) return;
    const hr = host.getBoundingClientRect();
    const sr = mf.shadowRoot;
    const caretEl = sr && sr.querySelector('.ML__caret');
    const cr = caretEl && caretEl.getBoundingClientRect();

    if (!cr || (!cr.width && !cr.height)) {
      cand.style.left = '18px';
      cand.style.right = '18px';
      cand.style.top = 'auto';
      cand.style.bottom = '14px';
      return;
    }

    const w = cand.offsetWidth || 320;
    const h = cand.offsetHeight || 120;
    let left = cr.left - hr.left;
    left = Math.max(8, Math.min(left, hr.width - w - 8));

    const below = cr.bottom - hr.top + 8;
    const above = cr.top - hr.top - h - 8;
    const top = (below + h > hr.height && above > 8) ? above : below;

    cand.style.right = 'auto';
    cand.style.left = left + 'px';
    cand.style.top = top + 'px';
    cand.style.bottom = 'auto';
  }

  function hideCand() {
    cand.hidden = true;
    cand.innerHTML = '';
    paintEcho();
  }

  /* ================= 焦点与全角归一化 ================= */

  let suppressBefore = false;

  function setFocused(on) { document.body.classList.toggle('focused', on); }

  mf.addEventListener('focusin', function () { setFocused(true); schedulePaint(); });
  mf.addEventListener('focusout', function () { setFocused(false); schedulePaint(); });

  stage.addEventListener('pointerdown', function (ev) {
    if (ev.target.closest && ev.target.closest('.cand')) return;
    if (document.activeElement !== mf) mf.focus();
  });

  const FULL2HALF = {
    '＃': '#', '／': '/', '＊': '*', '－': '-', '＋': '+', '＝': '=',
    '（': '(', '）': ')', '｜': '|', '～': '~', '！': '!', '＜': '<', '＞': '>',
    '：': ':', '，': ',', '。': '.', '＾': '^', '＿': '_', '＇': "'",
    '［': '[', '］': ']', '｛': '{', '｝': '}', '　': ' ', '—': '-',
    // 中文输入法下的弯引号：一律当撇号处理（#’ 与 #' 等价）
    '’': "'", '‘': "'"
  };

  function toHalf(ch) {
    if (!ch || ch.length !== 1) return null;
    if (Object.prototype.hasOwnProperty.call(FULL2HALF, ch)) {
      return FULL2HALF[ch] === ch ? null : FULL2HALF[ch];
    }
    const c = ch.codePointAt(0);
    if (c >= 0xFF01 && c <= 0xFF5E) return String.fromCodePoint(c - 0xFEE0);
    return null;
  }

  // 输入法上屏/粘贴进来的文本也归一化（这条路径不经过 keydown）
  mf.addEventListener('beforeinput', function (ev) {
    if (suppressBefore || !ev.data) return;
    let changed = false;
    const norm = Array.from(ev.data).map(function (ch) {
      const h = toHalf(ch);
      if (h === null) return ch;
      changed = true;
      return h;
    }).join('');
    if (!changed) return;
    ev.preventDefault();
    for (const ch of norm) handleChar(ch);
  }, true);

  /* ================= 键盘（文档级捕获，不依赖焦点落在哪） ================= */

  let pressCount = 0;
  let lastKeyLabel = '';
  const echoEl = document.getElementById('echo');

  function paintEcho() {
    if (!echoEl) return;
    let s = '按键 ' + pressCount;
    if (ime.on) {
      if (ime.mode !== 'sym' || ime.ret) {
        const typed = ime.parts.map(function (p) { return p.t === 'text' ? p.v : p.label; }).join('');
        const dbl = secondOf(typed);
        if (dbl) {
          s += ' · 二次解析 #' + dbl.first.t + ' → ' + dbl.char;
        } else {
          const tag = (ime.ret || ime.mode) === 'var' ? '变量 ' : '元素 ';
          s += ' · ' + tag + typed + (ime.hashPending ? '#' : '') + (ime.ret ? ' #' + ime.buf : '');
        }
      } else {
        s += ' · 待定 #' + ime.buf;
      }
    } else if (lastKeyLabel) {
      s += ' · ' + lastKeyLabel;
    }
    echoEl.textContent = s;
  }

  function stop(ev) { ev.preventDefault(); ev.stopPropagation(); }

  function focusField() {
    if (document.activeElement !== mf) mf.focus();
    setFocused(true);
  }

  /** 取字符：ev.key 不可靠时（部分 WebView / 输入法给 Unidentified、Process）用 keyCode 兜底 */
  function keyChar(ev) {
    if (ev.key && ev.key.length === 1 && ev.key !== 'Unidentified') return ev.key;
    const kc = ev.keyCode;
    if (!kc) return null;
    if (kc >= 65 && kc <= 90) return String.fromCharCode(ev.shiftKey ? kc : kc + 32);
    if (kc >= 48 && kc <= 57) return shiftDigit(kc, ev.shiftKey);
    const map = {
      106: '*', 107: '+', 109: '-', 110: '.', 111: '/',
      186: ';', 187: '=', 188: ',', 189: '-', 190: '.', 191: '/',
      192: '`', 219: '[', 220: '\\', 221: ']', 222: "'"
    };
    const base = map[kc];
    if (!base) return null;
    return ev.shiftKey ? shiftSymbol(base) : base;
  }

  function shiftDigit(kc, shift) {
    const d = String.fromCharCode(kc);
    if (!shift) return d;
    return { '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')' }[d] || d;
  }

  function shiftSymbol(base) {
    return { '=': '+', '-': '_', ';': ':', "'": '"', ',': '<', '.': '>', '/': '?', '`': '~', '[': '{', ']': '}', '\\': '|' }[base] || base;
  }

  document.addEventListener('keydown', function (ev) {
    pressCount++;
    lastKeyLabel = ev.key === ' ' ? '空格' : (ev.key || String.fromCharCode(ev.keyCode || 63));
    paintEcho();

    const tag = ev.target && ev.target.tagName;
    const inField = !!(ev.target && ev.target.closest && ev.target.closest('math-field'));

    // 命令面板开着：按键全归面板，别让待定态 / 槽位那套逻辑插手
    if (cmdkEl && !cmdkEl.hidden) {
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'k' || ev.key === 'K')) {
        stop(ev); closeCmdk(); return;
      }
      if (ev.key === 'Escape') { stop(ev); closeCmdk(); return; }
      if (ev.key === 'Enter') { stop(ev); commitCmdkSel(); return; }
      if (ev.key === 'ArrowDown') { stop(ev); moveCmdk(1); return; }
      if (ev.key === 'ArrowUp') { stop(ev); moveCmdk(-1); return; }
      if (ev.key === 'Tab') { stop(ev); moveCmdk(ev.shiftKey ? -1 : 1); return; }
      if (ev.key === 'PageDown') { stop(ev); moveCmdk(5); return; }
      if (ev.key === 'PageUp') { stop(ev); moveCmdk(-5); return; }
      return;                                   // 其余字符照常进输入框
    }

    // Ctrl/⌘ + K：唤出 / 收起命令面板
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey &&
        (ev.key === 'k' || ev.key === 'K')) {
      stop(ev);
      openCmdk();
      return;
    }

    // 只有真正的文本输入框才让路；按钮上的按键照样归编辑器处理（焦点被抢走时能自愈）
    if (!inField && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')) return;

    // 中文输入法组字中：不抢键，只提醒
    if (ev.isComposing || ev.keyCode === 229) {
      if (ime.on) toast('检测到中文输入法组字 · 按 Shift 切英文再敲触发码');
      return;
    }

    const raw = keyChar(ev);
    const ch = raw ? (toHalf(raw) || raw) : null;

    // 新的一次按键：上一键的槽内收尾作废
    slotEditDone = true;

    if (ime.on && handleImeKey(ev, ch)) return;

    // 整体语义：光标贴着变量 / 元素 / 结构符号的边界时，退格与左右箭头以整块为单位
    if (!ime.on && handleUnitKey(ev)) return;

    // 槽里打字：记下这个槽，等 MathLive 插完字再把光标拉回槽内
    if (ch && ch.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey &&
        ch !== '#' && ch !== '@' && ch !== '$') {
      slotEdit = slotHere();
      slotEditDone = false;
    } else {
      slotEdit = null;
    }

    // 刚提交过一个结构：这一键要落进空槽里，先定位再插入
    // （# / @ / $ 例外：它们要开新的待定态，不能被当成槽内内容）
    if (pendingSlot && ch && ch !== '#' && ch !== '@' && ch !== '$' && ch.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      pendingSlot = false;
      jumpToSlot();
      // 上标、下标、撇号交给 MathLive 自己处理
      if (ch === '^' || ch === '_' || ch === "'" || ch === '’') return;
      stop(ev);
      if (!slotEdit) { slotEdit = slotHere(); slotEditDone = false; }
      mf.insert(ch);
      settleSlotCaret();
      return;
    }

    if (ch === '#') { stop(ev); startIme(); return; }
    if (ch === '@') { stop(ev); startVar(); return; }
    if (ch === '$') { stop(ev); startElem(); return; }

    // 光标贴着某个整体的左边界时，MathLive 会把这个字塞进整体内部，
    // 一个块里就有了两个符号（删一次走两个、四个槽也串位）。先把整体挪到右边再插。
    // ^ / _ 不在此列：它们是「挂到左边那个整体上的上下标」，本身就该贴着块。
    if (ch && ch.length === 1 && ch !== '^' && ch !== '_' &&
        !ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.isComposing &&
        atUnitLeftEdge(mf.position)) {
      stop(ev);
      const lit = (ch === "'" || ch === '’') ? '\\prime'
        : (TEXT_LITERAL.test(ch) ? '\\text{' + ch + '}' : ch);
      insertBeforeUnit(lit);
      focusField();
      return;
    }

    if (ev.key === 'Escape') { endIme(); exitPanel(); return; }

    // Tab / Shift+Tab：在「当前实体」的槽之间循环，到两头的下一跳就走出实体
    if (ev.key === 'Tab') {
      stop(ev);
      if (handleTabKey(ev)) { focusField(); return; }
      mf.executeCommand([ev.shiftKey ? 'moveToPreviousPlaceholder' : 'moveToNextPlaceholder']);
      focusField();
      return;
    }

    if (ev.ctrlKey && ev.key === 'Enter') { stop(ev); return output(true); }
    // 插件模式 Enter 就是「插入」：复制完由主进程收起窗口并粘回原应用
    if (ev.key === 'Enter' && !ev.shiftKey) { stop(ev); return output(PLUGIN); }

    if (ev.ctrlKey && !ev.shiftKey && ev.key === 'ArrowUp') { stop(ev); return mf.executeCommand(['moveToPreviousPlaceholder']); }
    if (ev.ctrlKey && ev.key === 'ArrowDown') { stop(ev); return mf.executeCommand(['moveToNextPlaceholder']); }
    if (ev.ctrlKey && ev.key === 'ArrowLeft') { stop(ev); return mf.executeCommand(['moveBeforeParent']); }
    if (ev.ctrlKey && ev.key === 'ArrowRight') { stop(ev); return mf.executeCommand(['moveAfterParent']); }

    // 普通字符：焦点不在公式里就抢回来再插入
    if (ch && ch.length === 1 && document.activeElement !== mf && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      if (!/[A-Za-z0-9#@$+\-*/=^_{}()\[\]<>!~|.,' ]/.test(ch)) return;
      stop(ev);
      handleChar(ch);
    }
  }, true);

  /* 修饰键：绝不能动待定态。否则敲 # 之后按 Shift 想打大写字母，待定码就没了 */
  const MOD_KEYS = /^(Shift|Control|Alt|Meta|CapsLock|NumLock|ScrollLock|AltGraph|ContextMenu|OS|Fn|Super|Hyper|Symbol)$/;
  /* 光标/编辑类按键：放弃这次待定，让按键本身照常生效 */
  const NAV_KEYS = /^(ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Delete|Insert)$/;

  /** 待定态下的按键处理，返回 true 表示已消费 */
  function handleImeKey(ev, ch) {
    // 1. 修饰键与功能键：一律不动状态，也不拦按键
    if (MOD_KEYS.test(ev.key)) return true;
    if (/^F\d{1,2}$/.test(ev.key)) return true;

    // 2. 取消
    if (ev.key === 'Escape') { stop(ev); cancelIme(); return true; }

    // 3. 退格
    if (ev.key === 'Backspace') {
      stop(ev);
      if (ime.hashPending) { ime.hashPending = false; refreshCand(); return true; }
      if (ime.mode !== 'sym' || ime.ret) {
        if (ime.parts.length) {
          ime.parts.pop();
          backspace(1);
          if (ime.parts.length) refreshCand();
          else cancelIme();
        } else {
          cancelIme();
        }
        return true;
      }
      if (ime.buf) {
        ime.buf = ime.buf.slice(0, -1);
        backspace(1);
        if (ime.buf) refine(); else refreshCand();
      } else {
        cancelIme();
      }
      return true;
    }

    // 4. 候选切换
    if (ev.key === 'ArrowDown') { stop(ev); moveSel(1); return true; }
    if (ev.key === 'ArrowUp') { stop(ev); moveSel(-1); return true; }

    // 5. 确认：只有这里会把待定码变成符号
    if (ev.key === 'Tab' || ev.key === 'Enter' || ev.key === ' ') {
      stop(ev);
      if (ime.hashPending) { ime.hashPending = false; refreshCand(); return true; }
      if (ime.mode !== 'sym' && !ime.ret) {
        // ##Sigma 这种二次解析：Tab / Enter 直接落定（它是符号，不是变量名）
        const dbl = secondOf(null);
        if (dbl) { commitSecond(dbl); return true; }
        // 剩下的旧写法 ##Tom 保持原样：只认 ## 收尾。@变量 / $元素 允许 Tab / Enter 收尾
        if (ime.mode === 'var' && ime.entry === '##') {
          toast('变量要用 ## 结尾，Tab / Enter 不算');
          return true;
        }
        closeBody(ev.key === 'Tab' && !ev.shiftKey);
        return true;
      }
      if (!ime.buf && !ime.cands.length) { cancelIme(); return true; }
      commitCurrent();
      return true;
    }

    // 6. 可打印字符：进缓冲（Shift+字母 走的就是这条）
    if (ch && ch.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      stop(ev);
      handleChar(ch);
      return true;
    }

    // 7. Ctrl / Cmd / Alt 组合（撤销、复制…）：先干净退出待定，再让组合键照常执行
    if (ev.ctrlKey || ev.metaKey || ev.altKey) {
      cancelIme();
      return false;
    }

    // 8. 方向键左/右、Home/End 等：退出待定，按键照常执行
    if (NAV_KEYS.test(ev.key)) {
      cancelIme();
      return false;
    }

    // 9. 其它（系统键、输入法键）：不打断待定态，也不吞掉
    return true;
  }

  function moveSel(d) {
    if (!ime.cands.length) return;
    ime.idx = (ime.idx + d + ime.cands.length) % ime.cands.length;
    refreshCand();
  }

  /** 变量起手式：在 # 待定态里再按一个 #。
   *  起手式的 # 不留在公式里——先撤掉，变量名从当前位置开始写。 */
  function beginVar() {
    backspace(1);
    ime.mode = 'var';
    ime.entry = '##';
    ime.parts = [];
    ime.hashPending = false;
    ime.ret = null;
    ime.script = null;
    ime.buf = '';
    ime.cands = [];
    ime.idx = 0;
    refreshCand();
  }

  /** 字符进入待定缓冲，同时就地打进公式 */
  function handleChar(ch) {
    if (!ime.on) {
      if (ch === '#') { startIme(); return; }
      if (ch === '@') { startVar(); return; }
      if (ch === '$') { startElem(); return; }
      typeChar(ch);
      return;
    }

    /* ---------- 变量 / 元素主体里：字母数字照收，# @ $ 要先判定用途 ---------- */
    if (ime.mode !== 'sym') {
      const closeCh = ime.mode === 'var' ? '@' : '$';
      if (ime.hashPending) {
        ime.hashPending = false;
        if (ch === '#') { closeBody(); return; }   // ## 旧写法收尾
        // 不是收尾，那就是符号码的开头：切到 sym，从当前位置重新起算
        ime.ret = ime.mode;
        ime.mode = 'sym';
        ime.buf = '';
        ime.cands = [];
        ime.idx = 0;
        typeChar('#');                             // 让 # 也出现在公式里，和正常触发码一致
        // 往下走 sym 分支，把这个字符当成码的首字母
      } else if (ch === '#') {
        ime.hashPending = true;                    // 先不落地，等下一键
        refreshCand();
        return;
      } else if (ch === closeCh) {
        closeBody();                               // 同一个符号收尾：@Tom@ / $Cu$
        return;
      } else if (ch === '@' || ch === '$') {
        // 换一种主体：先把当前这个落定，再起下一个
        closeBody();
        if (ch === '@') startVar(); else startElem();
        return;
      } else if (ch === '_' || ch === '^') {
        // 名字写完了：先落成实体，这个下标 / 上标挂到实体右侧去（`$H` `_` `2` = H₂）
        ime.script = ch;
        closeBody();
        return;
      } else {
        if (!/[A-Za-z0-9]/.test(ch)) return;
        ime.parts.push({ t: 'text', v: ch });
        typeChar(ch);
        refreshCand();
        return;
      }
    }

    /* ---------- 符号触发码 ---------- */
    if (ch === '#') {
      if (!ime.buf) {
        if (ime.ret) {                             // 主体里刚起头就又按 #：撤掉这段
          const back = ime.ret;
          ime.ret = null;
          ime.mode = back;
          backspace(1);
          refreshCand();
          return;
        }
        beginVar();
        return;
      }
      commitCurrent();
      startIme();                                  // 上一段先上屏，这个 # 开新的一段
      return;
    }

    if (ch === '@' || ch === '$') {                 // 符号码里直接换主体
      commitCurrent();
      if (ch === '@') startVar(); else startElem();
      return;
    }

    if (!E.isTokenChar(ch)) { commitCurrent(); typeChar(ch); return; }
    ime.buf += ch;
    typeChar(ch);
    refine();
  }

  /** 缓冲变化后重新算候选。
   *  这里**不做任何自动上屏**：打完 #alpha 也停在候选态，等 Tab / Enter / 点「选用」才转换。
   *  没有匹配时同样停在原地，继续敲下一字符还能命中（#sigma 中途的 #si 就是这种情况）。
   */
  function refine() {
    if (!ime.buf) { ime.cands = []; ime.idx = 0; refreshCand(); return; }
    const q = E.query(ime.buf);
    ime.cands = q.candidates;
    ime.idx = 0;
    refreshCand();
  }

  /* ================= 输出 ================= */

  const toastTimer = { id: 0 };
  function toast(msg) {
    toastEl.textContent = msg;
    clearTimeout(toastTimer.id);
    toastTimer.id = setTimeout(function () { toastEl.textContent = ''; }, 2200);
  }

  /** 剥掉整体的元数据外壳：\htmlData{fe=var}{…} → …（花括号必须配对，正则顶不住嵌套） */
  function stripUnits(s) {
    const TAG = '\\htmlData{';
    let out = '';
    let i = 0;
    while (i < s.length) {
      if (s.startsWith(TAG, i)) {
        const argEnd = matchBrace(s, i + TAG.length - 1);
        const bodyStart = argEnd + 1;
        if (argEnd < 0 || s[bodyStart] !== '{') { out += s[i++]; continue; }
        const bodyEnd = matchBrace(s, bodyStart);
        if (bodyEnd < 0) { out += s[i++]; continue; }
        out += stripUnits(s.slice(bodyStart + 1, bodyEnd));
        i = bodyEnd + 1;
        continue;
      }
      out += s[i++];
    }
    return out;
  }

  /** 从 at 处的 '{' 找配对的 '}'，找不到返回 -1 */
  function matchBrace(s, at) {
    let depth = 0;
    for (let i = at; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') { i++; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (!depth) return i; }
    }
    return -1;
  }

  function cleanLatex(s) {
    return stripUnits(s)
      .replace(/\\placeholder\{\}/g, '')
      // 元素主体的零宽基底，只为了占住位置不被当成第五个槽
      .replace(/\{\\vphantom\{0\}\}/g, '')
      .replace(/\\overset\{\}\{\\mathrm\{([^{}]*)\}\}/g, '\\mathrm{$1}')
      // 预置的空上标 / 空下标（变量的幂与下标槽）导出时没有意义
      .replace(/\^\{\}/g, '')
      .replace(/_\{\}/g, '');
  }

  /* ================= 写剪贴板 =================
   * 只能在渲染进程做：这个 Electron 版本的主进程 clipboard 只能写纯文本
   *（write() 要 ClipboardItem 数组，而主进程里根本没有 ClipboardItem）。
   * 渲染进程的 navigator.clipboard.write 支持一次提交多种 MIME，正是我们要的。
   */
  async function writeClipboard(payload) {
    const text = payload.text || '';
    const wantRich = !!(payload.html || payload.png);

    if (wantRich && window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      const item = {};
      if (text) item['text/plain'] = new Blob([text], { type: 'text/plain' });
      if (payload.html) item['text/html'] = new Blob([payload.html], { type: 'text/html' });
      if (payload.png) {
        try {
          const res = await fetch(payload.png);
          item['image/png'] = await res.blob();
        } catch (err) { /* 出图拿不到就少一种格式 */ }
      }
      if (Object.keys(item).length) {
        try {
          await navigator.clipboard.write([new ClipboardItem(item)]);
          return true;
        } catch (err) { /* 落到下面的纯文本兜底 */ }
      }
    }

    // 没有文本就别兜底了：writeText('') 会把刚写好的图连同剪贴板一起清空，
    // 用户按 Ctrl+V 什么也拿不到，比直接报错更难查。
    if (!text) return false;

    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      return false;
    }
  }

  async function output(closeAfter) {
    if (ime.on) commitCurrent();
    const raw = latex().trim();
    if (!raw) { toast('还没有内容'); return; }

    if (PLUGIN) return outputPlugin(raw);

    try {
      if (format === 'latex') {
        if (!await writeClipboard({ text: cleanLatex(raw) })) { toast('复制失败'); return; }
      } else if (format === 'mathml' || format === 'word') {
        // MathLive 的 math-ml 不认 \htmlData，会把命令名当变量吐成 <mi>\htmlData</mi>，
        // 所以 MathML 一律从「剥干净的 LaTeX」用 KaTeX 转，不读它的序列化结果。
        let mml = '';
        try {
          mml = katex.renderToString(cleanLatex(raw), { output: 'mathml', throwOnError: false, displayMode: true });
        } catch (err) { mml = ''; }
        if (!mml) { toast('MathML 转换失败'); return; }

        let html = mml;
        if (format === 'word') {
          // Word 不认 MathML —— 它只认 OMML（Office 自己的公式标记）。
          // 早先这里塞的是 MathML，粘进 Word 只会留下一串字，是个假成功。
          html = window.FE_OMML ? window.FE_OMML.toWordHtml(mml) : '';
          if (!html) { toast('Word 公式转换失败'); return; }
        }
        if (!await writeClipboard({ text: cleanLatex(raw), html: html })) { toast('复制失败'); return; }
      } else if (format === 'png') {
        // 依赖主进程的离屏渲染（只有桌面版有），网页版直接说清楚
        if (!fe.png) { toast('PNG 出图需要桌面版'); return; }
        const pic = await fe.png(cleanLatex(raw));
        if (!pic || !pic.url) { toast('出图失败'); return; }
        // 独立编辑器的图片是用户自己按 Ctrl+V 粘的。这里同样不放纯文本：
        // Word / WPS 在图和文本都在时会挑文本，用户看到的就是一串字母。
        const html = pic.w && pic.h
          ? '<meta charset="utf-8"><img src="' + pic.url + '" width="' + Math.round(pic.w * 96 / 72) +
            '" height="' + Math.round(pic.h * 96 / 72) + '" style="width:' + pic.w +
            'pt;height:' + pic.h + 'pt" alt="">'
          : '';
        if (!await writeClipboard({ html: html, png: pic.url })) { toast('复制失败'); return; }
      }
      toast('已复制 ' + labelOf(format));
      if (closeAfter) setTimeout(function () { fe.close(); }, 140);
    } catch (err) {
      toast('复制失败：' + (err && err.message ? err.message : err));
    }
  }

  function labelOf(f) {
    return { auto: '自动', text: '纯文本', latex: 'LaTeX', mathml: 'MathML', word: 'Word 公式', png: '图片' }[f] || f;
  }

  /* ================= 插件模式：先认宿主，再定格式 =================
   * 规则表在 lib/hosts.js（UMD，node 单测和这里共用同一份）。
   *
   * 早先是「一次写三种格式让应用自己挑」，实测失败 —— 应用挑的是它第一个认识的，
   * 不是最合适的：记事本得到 LaTeX 源码、Word 得到空白、微信时图时文。
   * 现在改成一个宿主只给它那一两种格式。
   */
  let hostRaw = { proc: '', cls: '' };
  let rememberedMap = {};       // { 进程名: 'text' | 'png' | ... }，托盘可清
  let override = 'auto';        // auto | text | png | dollar | mathml | pngclear
  let hostPlan = window.FE_HOSTS
    ? window.FE_HOSTS.plan(hostRaw, 'auto')
    : { host: { id: 'unknown', label: '未知目标', proc: '', cls: '' }, text: 'bare', html: true, png: 'transparent', summary: 'LaTeX + MathML + 透明图片' };

  /** 认不出进程时也要能记住手动选择 —— 用同一个占位键，只存在本次会话 */
  function hostKey() {
    return (window.FE_HOSTS ? window.FE_HOSTS.normProc(hostRaw.proc) : '') || '__unknown__';
  }

  /** 面板弹出那一刻拿到的宿主 + 记忆，算出这次的配方 */
  function refreshHost(host) {
    if (host && typeof host === 'object') {
      hostRaw = { proc: host.proc || '', cls: host.cls || '' };
      if (host.remembered && typeof host.remembered === 'object') rememberedMap = host.remembered;
    }
    // 这个软件手动指定过就用指定的，否则按规则自动判断
    override = rememberedMap[hostKey()] || 'auto';
    hostPlan = window.FE_HOSTS ? window.FE_HOSTS.plan(hostRaw, override) : hostPlan;
    syncFmtButtons();
    paintTarget();
  }

  /** 把「当前生效的格式」反映到标题栏那三个按钮上 */
  function syncFmtButtons() {
    const box = document.getElementById('formats');
    if (!box) return;
    Array.prototype.forEach.call(box.children, function (b) {
      b.classList.toggle('on', b.dataset.fmt === override);
    });
  }

  /** 标题栏下方那句「这次往哪儿粘、粘什么」 */
  function paintTarget() {
    const el = document.getElementById('target');
    if (!el) return;
    const h = hostPlan.host || {};
    const unknown = h.id === 'unknown';
    el.textContent = (unknown ? '目标未知' : (h.label || '未知目标')) + ' · ' + (hostPlan.summary || '');
    el.hidden = false;
    el.classList.toggle('warn', unknown);
    el.title = unknown
      ? '认不出前台是什么软件，退回三种格式一起给。可以点上面的「文本 / 图片」手动指定，指定一次以后就按这个软件记住。'
      : '这次往 ' + (h.label || '') + ' 里粘 ' + (hostPlan.summary || '') + '（托盘菜单可清除记忆）';
  }

  /** 用户手动改格式：立刻重算配方，并按进程名记住 */
  function setOverride(fmt) {
    override = fmt || 'auto';
    // 先记在本地，界面立刻一致；能持久化再往主进程写
    if (override === 'auto') delete rememberedMap[hostKey()];
    else rememberedMap[hostKey()] = override;

    if (window.FE_HOSTS) hostPlan = window.FE_HOSTS.plan(hostRaw, override);
    paintTarget();
    syncFmtButtons();

    if (window.fe && window.fe.remember && hostRaw.proc) {
      window.fe.remember(hostRaw.proc, override).then(function (m) {
        if (m && typeof m === 'object') rememberedMap = m;
      }).catch(function () {});
    }
  }

  async function outputPlugin(raw) {
    // 兜底：万一 focus 事件没赶上（窗口刚建好就被唤出），出图前主动拉一次宿主。
    // 宁可靠拉，别靠事件时序 —— 这里错了就是「格式选错」，用户看不出来。
    if (!hostRaw.proc && window.fe && window.fe.host) {
      try { refreshHost(await window.fe.host()); } catch (e) { /* 拉不到就按未知处理 */ }
    }

    const bare = cleanLatex(raw);
    const p = hostPlan;
    // 先只准备文本：它是兜底，也是「文本类宿主」的唯一内容
    const payload = { text: window.FE_HOSTS ? window.FE_HOSTS.delimit(bare, p) : bare };

    // 富文本只在宿主真能解析 MathML 时才写。
    // Word/WPS 走 HTML 粘贴时只认 OMML，塞 MathML 进去它会挑中 HTML 然后吐空白 ——
    // 那种「看起来成功了」的失败最难发现，所以干脆不给它 HTML。
    if (p.html) {
      try {
        const mml = katex.renderToString(bare, { output: 'mathml', throwOnError: false, displayMode: false });
        if (mml) payload.html = '<meta charset="utf-8">' + mml;
      } catch (err) { /* 富文本失败不影响纯文本 */ }
    }

    // 出图。返回 { url, w, h }：w/h 是这张图「应该显示成多大」（pt）
    let shot = null;
    if (p.png && fe.png) {
      try {
        // 不指定像素高：主进程按托盘里的「公式字号」（默认五号 10.5pt）算显示尺寸，
        // 出图带 288dpi，写进文件里正好和正文一样大。
        shot = await fe.png(bare, { bg: p.png === 'white' ? 'white' : 'transparent' });
        if (shot && shot.url) payload.png = shot.url;
      } catch (err) { /* 出图失败就只给文字和富文本 */ }
      if (!payload.png && (p.imageOnly || override === 'png')) {
        toast('出图失败，已改为复制文字');
      }
    }

    // 出了图而且这个宿主只认图 → 把文本从剪贴板里摘掉。
    // Word / WPS / 微信在「图 + 文本」同时存在时挑的是文本，用户看到的就是
    // 「粘进去一串字母」。图已经成了，就不该再留这个诱饵。
    if (payload.png && p.imageOnly) {
      delete payload.text;
      delete payload.html;

      // 尺寸只能靠富文本来定：剪贴板里的位图不带 DPI —— PNG 的 pHYs 在转成 CF_DIB
      // 时就被丢了，WPS / Word 一律按 96dpi 解释像素，288dpi 的图于是大 3 倍
      // （实测过：图和文本同时给，粘出来是 3 倍大的图；只给 <img> 才是正文大小）。
      // 所以文档类宿主把位图整个撤掉，只留一段带尺寸的 <img>，位图仍然高清，
      // 打印时才不糊。
      if (shot && shot.w && shot.h) {
        const pxW = Math.round(shot.w * 96 / 72);
        const pxH = Math.round(shot.h * 96 / 72);
        payload.html = '<meta charset="utf-8"><img src="' + shot.url +
          '" width="' + pxW + '" height="' + pxH +
          '" style="width:' + shot.w + 'pt;height:' + shot.h + 'pt" alt="">';
        if (p.imgVia === 'html') delete payload.png;   // 给文档：只要这段 HTML
      }
    }

    // 排障用：e2e 会把它读出来，确认到底写了哪几种格式
    window.__lastPayloadKeys = Object.keys(payload);

    const written = await writeClipboard(payload);
    if (!written) { toast('写剪贴板失败'); return; }

    if (!window.fe || !window.fe.insert) return;
    try {
      const r = await window.fe.insert();
      // 主进程这时已经收起窗口了，toast 一般看不见，只是留个状态
      toast(r && r.pasted ? '已插入' : '已复制');
    } catch (err) {
      toast('已复制，按 Ctrl+V 粘贴');
    }
  }

  /** 收起面板：插件模式下只是隐藏（随时能再唤出来），独立应用里才是关窗口 */
  function exitPanel() {
    if (PLUGIN && window.fe && window.fe.hide) { window.fe.hide(); return; }
    fe.close();
  }

  /* ================= 格式切换 / 窗口按钮 ================= */

  document.getElementById('formats').addEventListener('click', function (ev) {
    const btn = ev.target.closest('button[data-fmt]');
    if (!btn) return;
    format = btn.dataset.fmt;
    Array.prototype.forEach.call(this.children, function (b) {
      b.classList.toggle('on', b === btn);
    });
    // 插件模式：按钮就是「这次给什么格式」，改了要重算并记住
    if (PLUGIN) setOverride(format);
    mf.focus();
  });

  document.getElementById('btnQuit').addEventListener('click', function () { exitPanel(); });
  document.getElementById('btnMin').addEventListener('click', function () {
    if (window.fe && window.fe.minimize) window.fe.minimize();
  });

  /* ================= 启动 ================= */

  mf.value = '';

  /* 插件模式界面：托盘小窗里跑，键盘优先，鼠标只留一个「插入」 */
  if (PLUGIN) {
    document.body.classList.add('plugin');

    // 格式按钮换一套。桌面端「自动」= 三种格式一起给，目标应用自己挑它认识的
    const fmtBox = document.getElementById('formats');
    if (fmtBox) {
      fmtBox.innerHTML =
        '<button data-fmt="auto" class="on">自动</button>' +
        '<button data-fmt="text">纯文本</button>' +
        '<button data-fmt="png">图片</button>';
      format = 'auto';
    }

    const quitBtn = document.getElementById('btnQuit');
    const minBtn = document.getElementById('btnMin');
    if (quitBtn) { quitBtn.textContent = '✕'; quitBtn.title = '收起（Esc）'; }
    if (minBtn) {
      // 最小化对浮窗没意义，换成一个看得见的「插入」（键盘党按 Enter 一样）
      const ins = document.createElement('button');
      ins.className = 'ins-btn';
      ins.textContent = '插入 ⏎';
      ins.title = '写入剪贴板并粘贴到原来的输入框（Enter）';
      ins.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
      ins.addEventListener('click', function () { output(true); });
      minBtn.replaceWith(ins);
    }

    const hints = document.getElementById('hints');
    if (hints) {
      // 小窗只留最必需的几个键：Ctrl+K 面板、[ ] 跳块、←↑↓→ 换槽这些属于长驻编辑器
      hints.innerHTML =
        '<kbd>#</kbd>符号<kbd>@</kbd>变量<kbd>$</kbd>元素' +
        '<span class="sep">·</span><kbd>Tab</kbd>换格' +
        '<span class="sep">·</span><kbd>Enter</kbd>插入';
    }

    // 首帧先按「自动」画一次目标提示，真正的宿主等 onFocus 到了再刷新
    if (window.fe && window.fe.host) {
      window.fe.host().then(refreshHost).catch(function () { refreshHost(); });
    } else {
      refreshHost();
    }
  }

  // 面板每次被唤出来：先认宿主算格式，再把光标放进去
  // （有内容就全选 —— 接着打会覆盖，想复用直接回车）
  if (window.fe && window.fe.onFocus) {
    window.fe.onFocus(function (host) {
      refreshHost(host);
      setTimeout(function () {
        try {
          mf.focus();
          if (mf.getValue('latex')) mf.executeCommand(['selectAll']);
          else mf.executeCommand(['moveToMathfieldEnd']);
          setFocused(true);
          schedulePaint();
        } catch (e) { /* 还没渲染好，下次再说 */ }
      }, 40);
    });
  }

  // 空槽默认画成「▢」，一屏方框太吵。所以：小点 + 平时收起来，光标进整体才露（见 paintSlots）
  try { mf.setOptions({ placeholderSymbol: '·' }); } catch (e) { /* 旧版本没有这个选项 */ }

  // 空槽只在正在编辑的整体里露出来：每次选区变化 / 内容重绘都重算一遍
  mf.addEventListener('selection-change', schedulePaint);
  mf.addEventListener('input', function () {
    // 槽里刚打完字：MathLive 把光标留在了分支外面，趁渲染还没吸收掉这一格拉回来
    settleSlotCaret();
    schedulePaint();
  });
  (function watchRender(tries) {
    const sr = mf.shadowRoot;
    // 组件升级可能比脚本晚一拍，shadow root 还没建出来就退避重试
    if (!sr) { if (tries > 0) setTimeout(function () { watchRender(tries - 1); }, 100); return; }
    if (!window.MutationObserver) return;
    new MutationObserver(function () { schedulePaint(); })
      .observe(sr, { childList: true, subtree: true, characterData: true });
    schedulePaint();
  })(10);

  // 关掉 MathLive 的“打字即转换”（259 条内置快捷词，会把 #alpha 里的 alpha 先吃掉）
  try { mf.inlineShortcuts = {}; } catch (e) { /* 旧版本可能不允许 */ }
  setTimeout(function () {
    try { if (Object.keys(mf.inlineShortcuts || {}).length) mf.inlineShortcuts = {}; } catch (e) {}
  }, 200);

  mf.focus();
  setFocused(document.activeElement === mf);

  // 自检：组件没升级成功时明确报出来，而不是让用户对着一个“死框”发呆
  setTimeout(function () {
    if (!window.customElements.get('math-field') || typeof mf.getValue !== 'function') {
      banner.hidden = false;
      banner.textContent = '数学输入组件未加载成功：请用 Edge / Chrome 直接打开 index.html，'
        + '或在项目目录执行 npm start 启动桌面版。';
      caretHint.hidden = true;
    } else if (document.activeElement !== mf) {
      caretHint.textContent = '敲任意键或点击这里开始输入';
    }
  }, 800);

  /* 截图/自动化演示钩子 */
  /* ================= 空白处的速查底纹 =================
   * 编辑区上下左右大片空着，索性把「常用符号怎么打」印成底纹。
   * 内容全部由 symbols.js 生成——新增触发码会自动出现在上面，不用再维护第二份清单。
   * 只收「一条命令对一个字符」的条目（`\alpha` 这种）：结构类（`\frac{}{}`）
   * 画不出单个符号，函数类（`\sin`）本来就是正文字母，都跳过。
   */

  const GLYPH = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η',
    theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ',
    pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', chi: 'χ',
    psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ',
    Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
    div: '÷', times: '×', pm: '±', mp: '∓', circ: '∘', cdot: '·',
    approx: '≈', sim: '∼', neq: '≠', equiv: '≡', leq: '≤', geq: '≥', ll: '≪', gg: '≫',
    propto: '∝', parallel: '∥', perp: '⊥', because: '∵', therefore: '∴',
    triangleq: '≜', mapsto: '↦', to: '→', Rightarrow: '⇒', Leftrightarrow: '⇔',
    square: '□', angle: '∠', triangle: '△', odot: '⊙',
    cup: '∪', cap: '∩', forall: '∀', exists: '∃', inn: '∈', in: '∈', notin: '∉',
    subseteq: '⊆', subset: '⊂', supseteq: '⊇', complement: '∁', varnothing: '∅',
    lnot: '¬', wedge: '∧', vee: '∨', vdash: '⊢',
    prime: '′', partial: '∂', nabla: '∇', infinity: '∞', infty: '∞', ominus: '⊖'
  };

  function glyphOf(tex) {
    const m = /^\\([A-Za-z]+)$/.exec(String(tex == null ? '' : tex));
    return m ? (GLYPH[m[1]] || null) : null;
  }

  function paintBgHints() {
    const host = document.getElementById('bgHints');
    const S = window.FE_SYMBOLS;
    if (!host || !S || !S.GROUPS) return;
    // 先希腊字母，再运算符、关系、集合——底纹也有个阅读顺序。
    // 「结构」不进来：`#frac` / `#v` 这类是复合模板，映射不出单个字形，
    // 硬排会剩下一两条孤零零的条目，比不放更乱（按键表里另有说明）。
    const ORDER = ['希腊字母（小写）', '希腊字母（大写）', '运算', '关系',
      '集合与逻辑', '微积分与大运算符'];
    const SHORT = {
      '希腊字母（小写）': '希腊 · 小写',
      '希腊字母（大写）': '希腊 · 大写',
      '运算': '运算',
      '关系': '关系',
      '集合与逻辑': '集合 · 逻辑',
      '微积分与大运算符': '微积分',
      '结构': '结构'
    };

    const cols = [];
    // 一列最多 26 行：只有真的装不下才拆（现在最长的两组是 24 条，正好各占一列），
    // 拆得太勤会变成一排只有十来行的短列，底下空出一大片。
    const MAX_ROWS = 26;
    ORDER.forEach(function (name) {
      const g = S.GROUPS.filter(function (x) { return x.name === name; })[0];
      if (!g) return;
      const items = [];
      const seen = {};
      g.items.forEach(function (it) {
        const glyph = glyphOf(it.x);
        if (!glyph || seen[it.t]) return;
        seen[it.t] = 1;
        items.push(['#' + it.t, glyph]);
      });
      if (!items.length) return;
      const parts = Math.ceil(items.length / MAX_ROWS);
      const per = Math.ceil(items.length / parts);
      for (let i = 0; i < items.length; i += per) {
        cols.push({
          title: i === 0 ? (SHORT[name] || name) : '',
          items: items.slice(i, i + per)
        });
      }
    });
    if (!cols.length) return;

    // 只铺一遍。以前是铺两遍把右边填满，代价是整组内容原样重复一遍，
    // 看着像「两张一样的表」；现在改成让每列自己撑开（CSS 里 flex-grow），
    // 一屏之内一条内容只出现一次。
    const frag = document.createDocumentFragment();
    cols.forEach(function (c) {
      const box = document.createElement('div');
      box.className = 'grp';
      const head = document.createElement('div');
      head.className = 'grp-t';
      head.textContent = c.title;
      box.appendChild(head);
      c.items.forEach(function (it) {
        const pair = document.createElement('span');
        pair.className = 'pair';
        const code = document.createElement('span');
        code.className = 'code';
        code.textContent = it[0];
        const b = document.createElement('b');
        b.textContent = it[1];
        pair.appendChild(code);
        pair.appendChild(b);
        box.appendChild(pair);
      });
      frag.appendChild(box);
    });
    host.appendChild(frag);
  }
  paintBgHints();

  /* ================= 输入法状态（中 / 英） =================
   * 浏览器读不到系统输入法的中英开关——那是操作系统 / IME 自己的状态，页面无权查询。
   * 能拿到的确定信号只有一个：正在用中文输入法组字时会有 composition 事件。
   * 所以这个徽标说的是「此刻是否在组字」：组拼音时亮「中文」，安静下来落回「英文」。
   */
  const imeBadge = document.getElementById('ime');
  const imeText = document.getElementById('imeText');
  let imeTimer = 0;

  function setImeUI(on) {
    if (imeBadge) imeBadge.classList.toggle('on', !!on);
    if (imeText) imeText.textContent = on ? '中文' : '英文';
  }
  function imeBusy() {
    if (imeTimer) { clearTimeout(imeTimer); imeTimer = 0; }
    setImeUI(true);
  }
  function imeRest() {
    if (imeTimer) clearTimeout(imeTimer);
    imeTimer = setTimeout(function () { imeTimer = 0; setImeUI(false); }, 800);
  }
  document.addEventListener('compositionstart', imeBusy, true);
  document.addEventListener('compositionupdate', imeBusy, true);
  document.addEventListener('compositionend', imeRest, true);
  document.addEventListener('keydown', function (ev) {
    if (ev.isComposing || ev.key === 'Process') imeBusy();
  }, true);
  window.addEventListener('blur', imeRest);

  /* ---------------- 命令面板（Ctrl/⌘ + K） ----------------
   * 不背触发码也能插：搜「根号」「分数」「alpha」「\int」，回车即插。
   * 插入走的是和 # 补全完全相同的通道（replacePreedit）——左边界挪块、
   * 结构提交后落进第一格、整块语义都自动生效，不用第二套插入逻辑。
   */
  const cmdkEl = document.getElementById('cmdk');
  const cmdkInput = document.getElementById('cmdkInput');
  const cmdkList = document.getElementById('cmdkList');
  const cmdkTip = document.getElementById('cmdkTip');
  const CMDK_RECENT = 'fe.cmdk.recent';
  let cmdkHits = [];
  let cmdkSel = 0;

  function cmdkAll() {
    return (window.FE_SYMBOLS && window.FE_SYMBOLS.FLAT) || [];
  }

  /** 打分的顺序就是「人找东西的顺序」：码完全对上 → 码开头 → 码里含 →
   *  LaTeX 命令名 → 中文说明 → 分组名 */
  function cmdkScore(it, q, qRaw) {
    const t = String(it.t || '').toLowerCase();
    const x = String(it.x || '').toLowerCase();
    const d = String(it.d || '').toLowerCase();
    const g = String(it.group || '').toLowerCase();
    // 别名（`all` 之于 `alpha`、`degree` 之于 `^o`）降权，否则敲 al 回车会落成 ∀。
    // 再按「敲下去的大小写」抬一档：全小写的 al 应该先给 alpha，不是 Alpha。
    const alias = it.p ? -260 : 0;
    const exactCase = (qRaw && String(it.t || '').indexOf(qRaw) === 0) ? 60 : 0;
    if (t === q) return 1200 + alias + exactCase;
    if (t.indexOf(q) === 0) return 1000 - Math.min(t.length, 60) + alias + exactCase;
    if (t.indexOf(q) > 0) return 820 - Math.min(t.length, 60) + alias;
    if (x.indexOf(q) >= 0) return 700 + alias;
    if (d.indexOf(q) >= 0) return 640 - Math.min(d.indexOf(q), 40) + alias;
    if (g.indexOf(q) >= 0) return 520;
    return 0;
  }

  function cmdkSearch(q, qRaw) {
    const out = [];
    cmdkAll().forEach(function (it) {
      const s = cmdkScore(it, q, qRaw);
      if (s > 0) out.push({ it: it, s: s });
    });
    out.sort(function (a, b) {
      if (b.s !== a.s) return b.s - a.s;
      const la = String(a.it.t).length;
      const lb = String(b.it.t).length;
      if (la !== lb) return la - lb;
      return String(a.it.t) < String(b.it.t) ? -1 : 1;
    });
    return out.slice(0, 40).map(function (r) { return r.it; });
  }

  function cmdkRecentCodes() {
    try {
      const raw = localStorage.getItem(CMDK_RECENT);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.slice(0, 12) : [];
    } catch (e) { return []; }
  }

  function cmdkRemember(t) {
    try {
      const arr = cmdkRecentCodes().filter(function (x) { return x !== t; });
      arr.unshift(t);
      localStorage.setItem(CMDK_RECENT, JSON.stringify(arr.slice(0, 12)));
    } catch (e) { /* 隐身模式之类，记不住就算了 */ }
  }

  /** 空查询时先给「最近用过」，第一次打开还没有记录就给每组头两条 */
  function cmdkIdle() {
    const all = cmdkAll();
    const byT = {};
    all.forEach(function (it) { if (!byT[it.t]) byT[it.t] = it; });
    const recent = cmdkRecentCodes().map(function (t) { return byT[t]; })
      .filter(function (x) { return !!x; });
    if (recent.length) return recent;
    const out = [];
    const seen = {};
    all.forEach(function (it) {
      // 默认列表只放看得见字形的条目：结构类（`\frac`、`\sqrt`）显示成 ⋯，
      // 一打开就是一排 ⋯ 反而不好找。要结构直接搜「分数」「根号」。
      if (!glyphOf(it.x)) return;
      const g = it.group || '';
      if ((seen[g] || 0) >= 2) return;
      seen[g] = (seen[g] || 0) + 1;
      out.push(it);
    });
    return out.slice(0, 12);
  }

  const CMDK_TAG = {
    '希腊字母（小写）': '希腊', '希腊字母（大写）': '希腊',
    '运算': '运算', '关系': '关系', '集合与逻辑': '集合',
    '微积分与大运算符': '微积分', '结构': '结构'
  };

  /** 列表左边的那个字形。符号类取真字形；结构类（\frac、\sqrt）没有单字符，
   *  按命令名给个能认出来的替身 —— 一列 ⋯ 谁也分不清哪个是哪个。 */
  const CMD_GLYPH = [
    [/^\\oiint/, '∯'], [/^\\oint/, '∮'], [/^\\int/, '∫'],
    [/^\\sum/, '∑'], [/^\\prod/, '∏'], [/^\\lim/, 'lim'],
    [/^\\frac/, '½'], [/^\\sqrt/, '√'],
    [/^\\begin\{cases\}/, '{'], [/^\\begin\{[pbvB]?matrix\}/, '▦'],
    [/^\\(vec|overrightarrow)/, 'v⃗'], [/^\\(hat|widehat)/, 'x̂'],
    [/^\\(bar|overline)/, 'x̄'], [/^\\(underline|uline)/, 'x̲'],
    [/^\\text/, 'T'], [/^\\binom/, '(ⁿₖ)']
  ];

  function cmdGlyph(x) {
    const g = glyphOf(x);
    if (g) return g;
    const s = String(x || '');
    for (let i = 0; i < CMD_GLYPH.length; i++) {
      if (CMD_GLYPH[i][0].test(s)) return CMD_GLYPH[i][1];
    }
    return '{}';
  }

  function paintCmdkSel() {
    const rows = cmdkList.querySelectorAll('.cmdk-item');
    for (let i = 0; i < rows.length; i++) {
      const on = i === cmdkSel;
      rows[i].classList.toggle('here', on);
      if (on) rows[i].scrollIntoView({ block: 'nearest' });
    }
    if (cmdkTip) {
      cmdkTip.textContent = cmdkHits.length ? (cmdkSel + 1) + ' / ' + cmdkHits.length : '';
    }
  }

  function renderCmdk() {
    const qRaw = cmdkInput.value.trim();
    const q = qRaw.toLowerCase();
    cmdkHits = q ? cmdkSearch(q, qRaw) : cmdkIdle();
    cmdkSel = 0;
    cmdkList.innerHTML = '';
    if (!cmdkHits.length) {
      const p = document.createElement('div');
      p.className = 'cmdk-empty';
      p.textContent = '没有匹配「' + cmdkInput.value.trim() + '」的符号';
      const hint = document.createElement('div');
      hint.textContent = '试试 根号 / 分数 / 约等于 / al / <=';
      p.appendChild(hint);
      cmdkList.appendChild(p);
      if (cmdkTip) cmdkTip.textContent = '';
      return;
    }
    const frag = document.createDocumentFragment();
    cmdkHits.forEach(function (it, i) {
      const row = document.createElement('div');
      row.className = 'cmdk-item';
      row.dataset.i = String(i);
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = '#' + it.t;
      const g = document.createElement('span');
      g.className = 'g';
      // 结构类（\frac、\sqrt）没有单字符字形，给个能认的替身，别留空
      g.textContent = cmdGlyph(it.x);
      const d = document.createElement('span');
      d.className = 'd';
      d.textContent = it.d || '';
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = CMDK_TAG[it.group] || '';
      row.appendChild(k);
      row.appendChild(g);
      row.appendChild(d);
      row.appendChild(tag);
      frag.appendChild(row);
    });
    cmdkList.appendChild(frag);
    paintCmdkSel();
  }

  function moveCmdk(d) {
    if (!cmdkHits.length) return;
    const n = cmdkHits.length;
    cmdkSel = ((cmdkSel + d) % n + n) % n;
    paintCmdkSel();
  }

  function insertCmdk(it) {
    if (!it) return;
    closeCmdk();
    const raw = E.expand(it).text;
    replacePreedit(isStructured(raw) ? wrapUnit('sym', raw) : raw, {});
    cmdkRemember(it.t);
    toast('插入 #' + it.t + ' · ' + (it.d || ''));
  }

  function commitCmdkSel() {
    insertCmdk(cmdkHits[cmdkSel]);
  }

  function openCmdk() {
    if (ime.on) cancelIme();          // 待定码先撤掉，不然插进去会跟半截码混在一起
    cmdkEl.hidden = false;
    cmdkInput.value = '';
    renderCmdk();
    cmdkInput.focus();
    cmdkInput.select();
  }

  function closeCmdk() {
    if (!cmdkEl || cmdkEl.hidden) return;
    cmdkEl.hidden = true;
    cmdkInput.blur();
    focusField();
  }

  cmdkInput.addEventListener('input', renderCmdk);
  cmdkList.addEventListener('click', function (ev) {
    const row = ev.target.closest && ev.target.closest('.cmdk-item');
    if (!row) return;
    const i = Number(row.dataset.i);
    if (cmdkHits[i]) insertCmdk(cmdkHits[i]);
  });
  // mousedown 拦下来：直接点遮罩关掉，别让焦点在 mf 和输入框之间来回抖一下
  cmdkEl.addEventListener('mousedown', function (ev) {
    if (ev.target === cmdkEl) { ev.preventDefault(); closeCmdk(); }
  });

  window.__FE = {
    ime: ime, mf: mf, handleChar: handleChar, latex: latex, endIme: endIme,
    clean: cleanLatex, units: units, stripUnits: stripUnits,
    paintSlots: paintSlots, litUnit: function () { return litUnitId; },
    slots: function () {
      const m = modelOf();
      const list = units();
      const u = list.length ? (unitOf(list, mf.position) || unitBefore(list, mf.position)) : null;
      if (!m || !u) return null;
      const sl = slotsOf(m, u.atom);
      return { count: sl.length, index: slotIndexOf(m, u, sl), keys: sl.map(function (x) { return x.key; }) };
    },
    fields: function () {
      return docFields().map(function (f) {
        return {
          key: f.key, owner: f.owner ? String(f.owner.id) : null,
          unit: f.unit ? String(f.unit.id) : null,
          start: f.start, end: f.end, caret: f.caret, leaves: f.leaves
        };
      });
    },
    probe: function () {
      const model = modelOf();
      if (!model) return null;
      const out = [];
      for (let p = 0; p <= model.lastOffset; p++) {
        const row = { p: p, at: null, at1: null, tree: null };
        const a = atomAt(model, p);
        const b = atomAt(model, p - 1);
        row.at = a ? (a.type + (a.command ? ':' + a.command : '')) : null;
        row.at1 = b ? (b.type + (b.command ? ':' + b.command : '')) : null;
        for (const probe of [a, b]) {
          let cur = probe;
          for (let hops = 0; cur && cur.parent && hops < 20; hops++) {
            const key = branchKeyOf(cur.parent, cur);
            if (key && key !== 'body') { row.tree = key + '@' + String(cur.parent.id); break; }
            cur = cur.parent;
          }
          if (row.tree) break;
        }
        out.push(row);
      }
      return out;
    },
    slotInfo: function () {
      const m = modelOf();
      const list = units();
      const u = list.length ? unitOf(list, mf.position) : null;
      const s = (m && u) ? slotAt(m, u, mf.position) : null;
      return {
        pos: mf.position, units: list.length, unit: u ? [u.start, u.end] : null,
        // 只回传能序列化的部分：owner / atoms 是活的原子对象，带 parent 环
        slot: s ? { key: s.key, start: s.start, end: s.end, leaves: s.leaves, hasPh: s.hasPh } : null,
        content: u ? hasTypedContent(u.atom) : null
      };
    }
  };
  const demo = new URLSearchParams(location.search).get('demo');
  if (demo === 'cand') {
    mf.value = 'x+';
    mf.focus();
    mf.executeCommand(['moveToMathfieldEnd']);
    startIme();
    handleChar('a');
    handleChar('l');
  } else if (demo === 'var') {
    mf.value = '\\overset{a}{\\mathrm{Tom}}_{1}^{2}+\\frac{\\alpha}{2}';
  }
})();

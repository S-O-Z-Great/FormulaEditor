/**
 * LaTeX → Word / WPS 的 EQ 域
 *
 * 为什么是 EQ 域：文档里要的是「能编辑的公式」，不是图片。实测下来 Office 系的
 * HTML 导入器不做任何数学转换（MathML、OMML 塞进 text/html 都会被剥成纯文字），
 * 剪贴板里唯一被 WPS 认下来、并且变成公式的通道是 **RTF 里的 EQ 域**。
 *
 * EQ 是 Word 2.0 时代的公式域，WPS 完整支持。它的好处正是我们要的：
 *   - 是「域」，不是图片 —— 选中按 Alt+F9 就能改代码，字体字号跟着段落走
 *   - 字号自动和正文一致，不用像图片那样去调「公式字号」
 *
 * 局限也要说清楚：EQ 只做位移不做缩放（上下标不会变小），复杂排版（矩阵、
 * 多行对齐）比 OMML 粗糙。所以它替代的是「图片」，不是 Word 的新公式编辑器。
 *
 * 生成的是 EQ 指令（不含 "EQ " 前缀），toRtf() 负责包成能进剪贴板的 RTF。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FE_EQ = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 命令 → 字符。EQ 直接用字符，不用再写开关。 */
  var CHARS = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
    zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
    lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', varpi: 'ϖ',
    rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ',
    phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
    Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
    infty: '∞', partial: '∂', nabla: '∇', hbar: 'ℏ', ell: 'ℓ',
    cdot: '·', times: '×', div: '÷', pm: '±', mp: '∓', ast: '∗', star: '⋆',
    circ: '∘', bullet: '•', oplus: '⊕', otimes: '⊗',
    le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', equiv: '≡',
    approx: '≈', sim: '∼', propto: '∝', ll: '≪', gg: '≫',
    to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔',
    Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔',
    mapsto: '↦', uparrow: '↑', downarrow: '↓',
    in: '∈', notin: '∉', ni: '∋', subset: '⊂', supset: '⊃',
    subseteq: '⊆', supseteq: '⊇', cup: '∪', cap: '∩', emptyset: '∅',
    varnothing: '∅', forall: '∀', exists: '∃', neg: '¬', land: '∧', lor: '∨',
    angle: '∠', perp: '⊥', parallel: '∥', therefore: '∴', because: '∵',
    sum: 'Σ', prod: 'Π', int: '∫', oint: '∮', iint: '∬', iiint: '∭',
    ldots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱', prime: '′', degree: '°',
    lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', langle: '⟨', rangle: '⟩',
    vert: '|', Vert: '‖', backslash: '\\', '%': '%', '&': '&', '#': '#', '_': '_',
    '{': '{', '}': '}', '$': '$'
  };

  /* 纯排版命令：没有可见内容，直接丢掉 */
  var DROP = {
    displaystyle: 1, textstyle: 1, limits: 1, nolimits: 1, left: 0, right: 0,
    big: 1, Big: 1, bigg: 1, Bigg: 1, mathstrut: 1, phantom: 0, hspace: 0, quad: 1, qquad: 1
  };

  /* 括号类：\left( ... \right) —— EQ 用 \b() 让它按内容高度自动伸缩。
   * 我们只保留最常见的三种，其余退化成普通字符。 */
  var BRACKETS = { '(': '(', ')': ')', '[': '[', ']': ']', '|': '|' };

  function Parser(src) {
    this.s = String(src || '');
    this.i = 0;
    this.plain = '';
  }

  Parser.prototype.eof = function () { return this.i >= this.s.length; };
  Parser.prototype.peek = function () { return this.s.charAt(this.i); };

  /* 读一个 {...} 组，返回里面的 EQ。不是 { 开头时只吃一个原子（LaTeX 的省略写法）。 */
  Parser.prototype.group = function () {
    this.skipSpace();
    if (this.peek() === '{') {
      var depth = 0;
      var start = this.i + 1;
      while (this.i < this.s.length) {
        var c = this.s.charAt(this.i);
        if (c === '\\') { this.i += 2; continue; }
        if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === 0) {
            var body = this.s.slice(start, this.i);
            this.i++;
            return this.body(body);
          }
        }
        this.i++;
      }
      return '';
    }
    return this.scriptArg();
  };

  /* 上下标的参数：一个字符 / 一个组 / 一条命令，且**不**再吞后面的上下标。
   * 少了这一步 `x_1^2` 会变成「下标里套上标」（`x\s\do6(1\s\up6(2))`），
   * 上标就掉进下标里去了。 */
  Parser.prototype.scriptArg = function () {
    this.skipSpace();
    if (this.eof()) return '';
    if (this.peek() === '{') return this.group();
    if (this.peek() === '\\') {
      var n = this.command();
      return n ? n.eq : '';
    }
    var c = this.peek();
    this.i++;
    return textOf(c);
  };

  /* 读一个原子：字符 / 命令 / 组，并处理它后面的上下标 */
  Parser.prototype.atom = function () {
    this.skipSpace();
    if (this.eof()) return null;
    var c = this.peek();
    var node = null;

    if (c === '{') {
      node = { eq: this.group(), plain: '' };
    } else if (c === '\\') {
      node = this.command();
      if (!node) return null;
    } else {
      this.i++;
      node = { eq: textOf(c), plain: c };
    }

    // 上下标：可以连着写 (x_1^2)，EQ 用位移开关
    while (true) {
      this.skipSpace();
      var n = this.peek();
      if (n !== '^' && n !== '_') break;
      this.i++;
      var arg = this.scriptArg();
      node.eq += (n === '^' ? '\\s\\up6(' + arg + ')' : '\\s\\do6(' + arg + ')');
    }
    return node;
  };

  /* 一整段内容（直到 stop 或结尾） */
  Parser.prototype.body = function (src) {
    var save = this.s;
    var saveI = this.i;
    this.s = src;
    this.i = 0;
    var out = '';
    while (!this.eof()) {
      var a = this.atom();
      if (!a) break;
      out += a.eq;
    }
    this.s = save;
    this.i = saveI;
    return out;
  };

  Parser.prototype.skipSpace = function () {
    while (!this.eof() && /\s/.test(this.peek())) this.i++;
  };

  /* \ 开头的命令 */
  Parser.prototype.command = function () {
    var start = this.i;
    this.i++; // 跳过 backslash
    if (this.eof()) return { eq: '\\', plain: '\\' };

    // \{ \} \% 这类单字符命令
    var c = this.peek();
    if (!/[a-zA-Z]/.test(c)) {
      this.i++;
      if (c === '\\') return { eq: ' ', plain: '\n' };
      return { eq: textOf(c), plain: c };
    }

    while (!this.eof() && /[a-zA-Z]/.test(this.peek())) this.i++;
    var name = this.s.slice(start + 1, this.i);

    // 少数带 * 的变体
    if (this.peek() === '*') this.i++;

    switch (name) {
      case 'frac': {
        var a = this.group();
        var b = this.group();
        return { eq: '\\f(' + arg(a) + ',' + arg(b || ' ') + ')', plain: '' };
      }
      case 'dfrac':
      case 'tfrac':
        return this.fracLike();
      case 'sqrt': {
        var deg = '';
        this.skipSpace();
        if (this.peek() === '[') {
          var close = this.s.indexOf(']', this.i);
          if (close > 0) {
            deg = this.body(this.s.slice(this.i + 1, close));
            this.i = close + 1;
          }
        }
        var x = this.group();
        return {
          eq: deg ? '\\r(' + arg(deg) + ',' + arg(x) + ')' : '\\r(' + arg(x) + ')',
          plain: ''
        };
      }
      case 'mathrm':
      case 'mathbf':
      case 'mathit':
      case 'mathsf':
      case 'mathtt':
      case 'mathcal':
      case 'mathbb':
      case 'text':
      case 'operatorname':
      case 'boldsymbol': {
        // EQ 域里没有「只换这一段的字体」的开关：域结果整体用公式字体。
        // 化学式、单位这类正体要求退化成同字体，视觉上接受。
        return { eq: this.group(), plain: '' };
      }
      case 'binom': {
        var n = this.group();
        var k = this.group();
        // EQ 的组合数：把它摆成 (n 在上 k 在下)，外面一对圆括号
        return { eq: '\\b(\\s\\up6(' + arg(n) + ')\\s\\do6(' + arg(k) + '))', plain: '' };
      }
      case 'overline':
      case 'bar':
      case 'vec':
      case 'hat':
      case 'tilde':
      case 'overbrace':
      case 'underbrace': {
        // EQ 的 \o\ac() 这一套在 WPS 里不被接受（会显示「错误!」），
        // 组合附加符在公式字体里也未必有位。宁可少一道装饰，也不能吐错误。
        return { eq: this.group(), plain: '' };
      }
      case 'begin':
        return this.environment();
      case 'left': {
        this.skipSpace();
        var ch = this.peek();
        this.i++;
        var open = ch === '.' ? '' : ch;
        var inner = this.untilRight();
        var closeCh = this._lastRight === '.' ? '' : (this._lastRight || '');
        if (!open) return { eq: inner, plain: '' };
        // 实测：\b(...) 圆括号会被自动拉高，\b\bc[ 那套 WPS 不认（原样吐出来）。
        // 所以圆括号交给 \b，其它括号老老实实写字面字符。
        if (open === '(' && (closeCh === ')' || !closeCh)) {
          return { eq: '\\b(' + inner + ')', plain: '' };
        }
        return { eq: lit(open) + inner + lit(closeCh), plain: '' };
      }
      case 'right': {
        // untilRight() 已经吃掉了 \right，这里不该走到
        this.skipSpace();
        if (!this.eof()) this.i++;
        return { eq: '', plain: '' };
      }
      case 'placeholder':
        this.group();
        return { eq: '', plain: '' };
      default:
        break;
    }

    if (DROP[name]) return { eq: '', plain: '' };
    if (CHARS[name]) return { eq: textOf(CHARS[name]), plain: CHARS[name] };
    // 不认识的命令：当成无内容，避免把 \foo 原样吐进文档
    return { eq: '', plain: '' };
  };

  Parser.prototype.fracLike = function () {
    var a = this.group();
    var b = this.group();
    return { eq: '\\f(' + arg(a) + ',' + arg(b || ' ') + ')', plain: '' };
  };

  /* \left( ... \right) 的内容：一直读到 \right，记下右括号 */
  Parser.prototype.untilRight = function () {
    var out = '';
    this._lastRight = '';
    while (!this.eof()) {
      if (this.s.slice(this.i, this.i + 6) === '\\right') {
        this.i += 6;
        this.skipSpace();
        this._lastRight = this.peek();
        this.i++;
        return out;
      }
      var a = this.atom();
      if (!a) break;
      out += a.eq;
    }
    return out;
  };

  /* \begin{cases} .. \\ .. \end{cases} / pmatrix / vmatrix */
  Parser.prototype.environment = function () {
    var name = this.group().replace(/\\/g, '').trim();
    var endTag = '\\end{' + name + '}';
    var close = this.s.indexOf(endTag, this.i);
    var raw = close >= 0 ? this.s.slice(this.i, close) : this.s.slice(this.i);
    if (close >= 0) this.i = close + endTag.length;

    var rows = raw.split(/\\\\/).map(function (r) { return r.trim(); }).filter(Boolean);
    var body = rows.map(function (r) {
      return r.split('&').map(function (cell) {
        return new Parser(cell).seq();
      }).join(' ');
    });

    if (name === 'cases') {
      // 分段函数：EQ 的分支阵列（\a）在 WPS 里不被接受，退化成一行的
      // 「{ 条件1; 条件2 }」，内容不丢，排版简单。
      return { eq: lit('{') + body.join('; ') + lit('}'), plain: '' };
    }
    if (name === 'matrix' || name === 'pmatrix' || name === 'bmatrix' ||
        name === 'vmatrix' || name === 'Vmatrix' || name === 'array') {
      // 同理：\a\coN\ac 会被原样吐出来，矩阵只能用括号 + 分号表达
      var flat = body.join('; ');
      if (name === 'vmatrix' || name === 'Vmatrix') return { eq: '|' + flat + '|', plain: '' };
      if (name === 'bmatrix') return { eq: lit('[') + flat + lit(']'), plain: '' };
      return { eq: lit('(') + flat + lit(')'), plain: '' };
    }
    return { eq: body.join(' '), plain: '' };
  };

  Parser.prototype.seq = function () {
    var out = '';
    while (!this.eof()) {
      var a = this.atom();
      if (!a) break;
      out += a.eq;
    }
    return out;
  };

  /* ---- 工具 ---- */

  /* 文字进 EQ：`\` `{` `}` 在 EQ 里是语法符号，前面加一个 backslash 转义。
   * 括号、逗号在 \f() 的参数里会被当分隔符，所以含这些字符的参数整段用引号包。 */
  function textOf(ch) {
    if (ch === '\\') return '\\\\';
    if (ch === '{') return '\\{';
    if (ch === '}') return '\\}';
    return ch;
  }

  function arg(s) {
    var t = String(s == null ? '' : s);
    // 空参数会报「错误!」，给个空格占位
    return t.trim() ? t : ' ';
  }

  /* 字面括号：EQ 里 { } 是语法符号，得加 backslash */
  function lit(ch) {
    if (!ch) return '';
    if (ch === '{') return '\\{';
    if (ch === '}') return '\\}';
    return ch;
  }

  /** LaTeX → EQ 指令（不含 "EQ " 前缀） */
  function toEq(latex) {
    var p = new Parser(latex);
    return p.seq().replace(/\s+/g, ' ').trim();
  }

  /* RTF 转义：ASCII 原样（`\ { }` 加反斜杠），非 ASCII 用 \uN? */
  function escapeRtf(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      var code = s.charCodeAt(i);
      if (c === '\\') out += '\\\\';
      else if (c === '{') out += '\\{';
      else if (c === '}') out += '\\}';
      else if (c === '\n') out += '\\par ';
      else if (code < 128) out += c;
      else out += '\\u' + (code > 32767 ? code - 65536 : code) + '?';
    }
    return out;
  }

  /**
   * 包成能放进剪贴板的 RTF。
   * fldrslt 留空：Office 会在粘贴时算一次域，得到的是排版好的结果。
   *
   * `\field` 必须整个包在花括号里（RTF 的组）。漏掉那对大括号时 WPS 不报错，
   * 但会在公式末尾吐出一个单独的 `\` —— 文件里一个字符都不该留。
   */
  function toRtf(latex, opts) {
    var o = opts || {};
    var eq = toEq(latex);
    if (!eq) return '';
    var field = '{\\field{\\*\\fldinst {EQ ' + escapeRtf(eq) + '}}{\\fldrslt {}}}';
    // fs21 = 五号 10.5pt；粘贴进文档时域会继承目标段落字号，这里只是兜底
    var head = '{\\rtf1\\ansi\\ansicpg1252\\deff0' +
      '{\\fonttbl{\\f0\\fnil\\fcharset0 ' + (o.font || 'Times New Roman') + ';}}' +
      '\\pard\\f0\\fs' + (o.fs || 21) + ' ';
    return head + field + '\\par}';
  }

  return {
    toEq: toEq,
    toRtf: toRtf,
    escapeRtf: escapeRtf,
    CHARS: CHARS
  };
});

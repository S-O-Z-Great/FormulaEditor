/**
 * MathML → OMML（Office Math Markup Language）
 *
 * 为什么需要它：Word / WPS 走 HTML 粘贴时**只认 OMML，不认 MathML**。
 * 早先给它们 MathML 的结果是「看起来成了」——粘进去一片空白，比报错更难发现。
 * 而只给白底图片虽然一定看得见，却不能再编辑。
 *
 * 所以路径是：LaTeX --KaTeX--> MathML --本文件--> OMML --包进 HTML--> 剪贴板。
 * Word / WPS 拆 HTML 时会把 m:oMath 变成**原生公式对象**，双击能接着改。
 *
 * 只覆盖 KaTeX 会吐出来的那个子集（它生成的 MathML 很规整，没有乱七八糟的东西）。
 * 认不出的元素一律「把子节点摊平」——宁可退化成一个字符，也不要整段变空白。
 *
 * 这个文件是 UMD：node 里跑单测、渲染进程里直接 <script> 引入，同一份逻辑。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FE_OMML = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ================= 极简 XML 解析 =================
   * 不引 DOMParser：node 里没有，而 UMD 要求两边跑同一份代码。
   * 输入是 KaTeX 生成的，一定良构，不用考虑畸形恢复。
   */

  function decodeEnt(s) {
    return String(s).replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, function (m, e) {
      if (e === 'amp') return '&';
      if (e === 'lt') return '<';
      if (e === 'gt') return '>';
      if (e === 'quot') return '"';
      if (e === 'apos') return "'";
      var code = e[1] === 'x' || e[1] === 'X'
        ? parseInt(e.slice(2), 16)
        : parseInt(e.slice(1), 10);
      return isFinite(code) ? String.fromCodePoint(code) : m;
    });
  }

  /** 找标签的结束 '>'，要跳过引号里的（属性值可能含 >） */
  function tagEnd(s, from) {
    var q = '';
    for (var i = from; i < s.length; i++) {
      var c = s[i];
      if (q) { if (c === q) q = ''; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === '>') return i;
    }
    return s.length;
  }

  var ATTR = /([^\s=\/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

  function parseXml(src) {
    var s = String(src || '');
    var rootNode = { type: 'root', children: [] };
    var stack = [rootNode];
    var i = 0;

    function push(node) {
      stack[stack.length - 1].children.push(node);
      return node;
    }
    function text(t) {
      if (t) push({ type: 'text', text: decodeEnt(t) });
    }

    while (i < s.length) {
      var lt = s.indexOf('<', i);
      if (lt < 0) { text(s.slice(i)); break; }
      if (lt > i) text(s.slice(i, lt));

      if (s.startsWith('<!--', lt)) {
        var ce = s.indexOf('-->', lt);
        i = ce < 0 ? s.length : ce + 3; continue;
      }
      if (s.startsWith('<![CDATA[', lt)) {
        var de = s.indexOf(']]>', lt);
        text(s.slice(lt + 9, de < 0 ? s.length : de));
        i = de < 0 ? s.length : de + 3; continue;
      }
      if (s.startsWith('<?', lt)) {
        var pe = s.indexOf('?>', lt);
        i = pe < 0 ? s.length : pe + 2; continue;
      }
      if (s.startsWith('<!', lt)) {
        var be = s.indexOf('>', lt);
        i = be < 0 ? s.length : be + 1; continue;
      }

      var gt = tagEnd(s, lt);
      var inner = s.slice(lt + 1, gt);
      var selfClose = /\/\s*$/.test(inner);
      if (selfClose) inner = inner.replace(/\/\s*$/, '');

      if (inner[0] === '/') {
        var cname = inner.slice(1).trim();
        // 弹到同名节点为止（容错：多余/缺失的闭合标签不让整棵树崩）
        for (var k = stack.length - 1; k > 0; k--) {
          if (stack[k].name === cname) { stack.length = k; break; }
        }
        i = gt + 1; continue;
      }

      var sp = inner.search(/\s/);
      var name = sp < 0 ? inner : inner.slice(0, sp);
      var attrs = {};
      if (sp >= 0) {
        var rest = inner.slice(sp);
        ATTR.lastIndex = 0;
        var m;
        while ((m = ATTR.exec(rest))) {
          attrs[m[1]] = decodeEnt(m[3] != null ? m[3] : m[4]);
        }
      }
      var el = push({ type: 'el', name: name, attrs: attrs, children: [] });
      if (!selfClose) stack.push(el);
      i = gt + 1;
    }
    return rootNode;
  }

  /* ================= 元素表 ================= */

  // 大运算符 → OMML 的 limLoc（上下限摆在哪）
  var NARY = {
    '\u2211': 'undOvr', // ∑
    '\u220F': 'undOvr', // ∏
    '\u2210': 'undOvr', // ∐
    '\u22C3': 'undOvr', // ⋃
    '\u22C2': 'undOvr', // ⋂
    '\u22C1': 'undOvr', // ⋁
    '\u22C0': 'undOvr', // ⋀
    '\u222B': 'subSup', // ∫
    '\u222C': 'subSup', // ∬
    '\u222D': 'subSup', // ∭
    '\u222E': 'subSup', // ∮
    '\u222F': 'subSup', // ∯
    '\u2230': 'subSup'  // ∰
  };

  // 括号类
  var PAIR = {
    '(': ')', '[': ']', '{': '}',
    '\u27E8': '\u27E9', // ⟨ ⟩
    '\u3008': '\u3009', // 〈 〉
    '\u27EE': '\u27EF', // ⟮ ⟯
    '\u2308': '\u2309', // ⌈ ⌉
    '\u230A': '\u230B', // ⌊ ⌋
    '|': '|', '\u2016': '\u2016'
  };

  // 上划线用 m:bar 而不是 m:acc（acc 会画成一个小帽子）
  var BAR = { '\u203E': 1, '\u00AF': 1, '_': 1, '\u2032': 0 };

  // 函数名：OMML 里用正体，且 \lim 这类带下标的要走 m:limLow
  var LIM_WORDS = {
    lim: 1, max: 1, min: 1, sup: 1, inf: 1, det: 1, gcd: 1,
    arg: 1, dim: 1, ker: 1, hom: 1, Pr: 1, mod: 1, lg: 1
  };

  // 累加型运算符：nary 的「被作用体」到这些符号为止，否则 \int f + \int g 会被吞成一坨
  var ADDITIVE = {
    '+': 1, '-': 1, '\u2212': 1, '=': 1, '<': 1, '>': 1,
    '\u2264': 1, '\u2265': 1, '\u2260': 1, '\u00B1': 1, '\u2213': 1,
    ',': 1, ';': 1
  };

  // 不可见字符：MathML 里用来标记「函数应用」「乘号」，落到 OMML 里没有意义
  var INVISIBLE = { '\u2061': 1, '\u2062': 1, '\u2063': 1, '\u200B': 1, '\u200C': 1, '\u200D': 1 };

  var ACCENTS = '\u0300\u0301\u0302\u0303\u0304\u0305\u0306\u0307\u0308\u030C' +
                '\u20D6\u20D7\u20DB\u20DC\u2032\u2033\u2034\u030A\u030B\u20E1';

  /* ================= 小工具 ================= */

  function local(name) {
    var i = String(name || '').indexOf(':');
    return (i >= 0 ? String(name).slice(i + 1) : String(name)).toLowerCase();
  }

  function kids(n) {
    return (n && n.children ? n.children : []).filter(function (c) { return c.type === 'el'; });
  }

  function textOf(n) {
    if (!n) return '';
    if (n.type === 'text') return n.text;
    if (!n.children) return '';
    return n.children.map(textOf).join('');
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function attrVal(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  }

  function run(text, opts) {
    var o = opts || {};
    if (!text) return '';
    var t = esc(text);
    var rPr = '';
    if (o.upright) rPr = '<m:rPr><m:sty m:val="p"/></m:rPr>';
    else if (o.normal) rPr = '<m:rPr><m:nor/></m:rPr>';
    var preserve = /^\s|\s$/.test(text) || /  /.test(text) ? ' xml:space="preserve"' : '';
    return '<m:r>' + rPr + '<m:t' + preserve + '>' + t + '</m:t></m:r>';
  }

  function isEl(n, name) {
    return n && n.type === 'el' && local(n.name) === name;
  }

  /* ================= 转换 ================= */

  /** 元素的「子内容」摊平成 OMML 片段（只有真结构才包容器） */
  function body(n) {
    return convList(kids(n));
  }

  /** 单个节点 → 片段 */
  function conv(n) {
    if (!n) return '';
    if (n.type === 'text') {
      return n.text.trim() ? run(n.text) : '';
    }
    var nm = local(n.name);
    var ch = kids(n);
    switch (nm) {
      case 'math':
      case 'semantics':
      case 'mrow':
      case 'mstyle':
      case 'mpadded':
      case 'mphantom':
      case 'menclose':
      case 'merror':
      case 'mtd':
      case 'mtr':
        return convList(ch);
      case 'mi': return mi(n);
      case 'mn': return run(textOf(n));
      case 'mo': return mo(n);
      case 'mtext': return run(textOf(n), { normal: true });
      case 'ms': return run(textOf(n), { normal: true });
      case 'mspace': return run('\u2009');
      case 'mfrac': return frac(n);
      case 'msqrt': return rad(n, null);
      case 'mroot': return rad(n, ch[1]);
      case 'msup': return script(n, 'sup');
      case 'msub': return script(n, 'sub');
      case 'msubsup': return script(n, 'subsup');
      case 'munder': return underOver(n, 'under');
      case 'mover': return over(n);
      case 'munderover': return underOver(n, 'both');
      case 'mtable': return table(n);
      case 'annotation':
      case 'annotation-xml':
        return '';
      default:
        // 认不出的元素：摊平，至少别把内容丢掉
        return convList(ch);
    }
  }

  function mi(n) {
    var t = textOf(n);
    if (!t) return '';
    // 单词函数名（\sin \cos \log…）在 OMML 里是正体；
    // 单字母保持默认（OMML 会自动斜体化），但数字类变体要显式正体
    if (t.length > 1 || LIM_WORDS[t]) return run(t, { upright: true });
    return run(t);
  }

  function mo(n) {
    var t = textOf(n);
    if (!t) return '';
    if (INVISIBLE[t]) return '';
    // 不认识的空格类
    if (/^[\u2000-\u200A\u205F\u3000]$/.test(t)) return '';
    return run(t);
  }

  function frac(n) {
    var ch = kids(n);
    var num = convList(ch.slice(0, 1) ? [ch[0]] : []);
    var den = convList(ch.slice(1, 2));
    var pr = '';
    var lt = n.attrs && n.attrs.linethickness;
    if (lt === '0' || lt === '0px' || lt === '0em') pr = '<m:fPr><m:type m:val="noBar"/></m:fPr>';
    return '<m:f>' + pr + '<m:num>' + num + '</m:num><m:den>' + den + '</m:den></m:f>';
  }

  function rad(n, deg) {
    var ch = kids(n);
    var e = convList(ch.slice(0, 1));
    if (deg == null) {
      return '<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/>' +
             '<m:e>' + e + '</m:e></m:rad>';
    }
    return '<m:rad><m:deg>' + conv(deg) + '</m:deg><m:e>' + e + '</m:e></m:rad>';
  }

  /** 上下标。base 是大运算符时其实是 nary，由 convList 提前拦截了，这里只管普通情形 */
  function script(n, kind) {
    var ch = kids(n);
    var base = ch[0];
    var e = conv(base);
    var baseText = textOf(base).replace(/[\u2061-\u2064]/g, '');

    // \lim_{x\to0} 这类：下面挂的是「极限条件」，OMML 用 limLow 才对
    if (kind !== 'sup' && LIM_WORDS[baseText] && baseText.length > 1) {
      var lim = convList(ch.slice(1, 2));
      var low = '<m:limLow><m:e>' + run(baseText, { upright: true }) + '</m:e>' +
                '<m:lim>' + lim + '</m:lim></m:limLow>';
      if (kind === 'sub') return low;
      // 带上下标的极限（少见）：上标挂在外面
      return '<m:sSup><m:e>' + low + '</m:e><m:sup>' + convList(ch.slice(2, 3)) + '</m:sup></m:sSup>';
    }

    if (kind === 'sup') {
      return '<m:sSup><m:e>' + e + '</m:e><m:sup>' + convList(ch.slice(1, 2)) + '</m:sup></m:sSup>';
    }
    if (kind === 'sub') {
      return '<m:sSub><m:e>' + e + '</m:e><m:sub>' + convList(ch.slice(1, 2)) + '</m:sub></m:sSub>';
    }
    return '<m:sSubSup><m:e>' + e + '</m:e>' +
           '<m:sub>' + convList(ch.slice(1, 2)) + '</m:sub>' +
           '<m:sup>' + convList(ch.slice(2, 3)) + '</m:sup></m:sSubSup>';
  }

  /** 顶上/底下挂东西：mover / munder / munderover */
  function over(n) {
    var ch = kids(n);
    var e = convList(ch.slice(0, 1));
    var mark = ch[1];
    var mt = textOf(mark);

    if (BAR[mt]) {
      return '<m:bar><m:barPr><m:pos m:val="top"/></m:barPr><m:e>' + e + '</m:e></m:bar>';
    }
    if (mt && (ACCENTS.indexOf(mt) >= 0 || (n.attrs && n.attrs.accent === 'true'))) {
      return '<m:acc><m:accPr><m:chr m:val="' + attrVal(mt) + '"/></m:accPr>' +
             '<m:e>' + e + '</m:e></m:acc>';
    }
    // 不是重音就是一个普通的上标结构
    return '<m:limUpp><m:e>' + e + '</m:e><m:lim>' + conv(mark) + '</m:lim></m:limUpp>';
  }

  function underOver(n, kind) {
    var ch = kids(n);
    var e = convList(ch.slice(0, 1));
    var under = kind === 'both' ? ch[1] : ch[1];
    var overNode = kind === 'both' ? ch[2] : null;
    var mt = textOf(under);

    // \underline
    if (kind === 'under' && BAR[mt]) {
      return '<m:bar><m:barPr><m:pos m:val="bot"/></m:barPr><m:e>' + e + '</m:e></m:bar>';
    }

    var low = '<m:limLow><m:e>' + e + '</m:e><m:lim>' + conv(under) + '</m:lim></m:limLow>';
    if (kind === 'under') return low;
    if (kind === 'over') {
      return '<m:limUpp><m:e>' + e + '</m:e><m:lim>' + conv(under) + '</m:lim></m:limUpp>';
    }
    return '<m:limUpp><m:e>' + low + '</m:e><m:lim>' + conv(overNode) + '</m:lim></m:limUpp>';
  }

  function table(n) {
    var rows = kids(n).filter(function (c) { return isEl(c, 'mtr'); });
    if (!rows.length) return '';
    var cols = 0;
    rows.forEach(function (r) { cols = Math.max(cols, kids(r).length); });
    var xml = rows.map(function (r) {
      var cells = kids(r).map(function (c) { return '<m:e>' + body(c) + '</m:e>'; }).join('');
      return '<m:mr>' + cells + '</m:mr>';
    }).join('');
    var pr = '<m:mPr><m:mcs><m:mc><m:mcPr><m:count m:val="' + Math.max(1, cols) + '"/>' +
             '<m:mcJc m:val="center"/></m:mcPr></m:mc></m:mcs></m:mPr>';
    return '<m:m>' + pr + xml + '</m:m>';
  }

  /* ---- 序列级：大运算符 + 括号对 ---- */

  /** 这个节点是不是「大运算符 + 上下限」 */
  function asNary(n) {
    if (!isEl(n, 'msub') && !isEl(n, 'msup') && !isEl(n, 'msubsup') && !isEl(n, 'mo')) return null;
    var ch = kids(n);
    var base = isEl(n, 'mo') ? n : ch[0];
    if (!isEl(base, 'mo')) return null;
    var chr = textOf(base);
    if (!NARY[chr]) return null;

    if (isEl(n, 'mo')) return { chr: chr, sub: null, sup: null };
    if (isEl(n, 'msub')) return { chr: chr, sub: ch[1] || null, sup: null };
    if (isEl(n, 'msup')) return { chr: chr, sub: null, sup: ch[1] || null };
    return { chr: chr, sub: ch[1] || null, sup: ch[2] || null };
  }

  function naryXml(x, operand) {
    var pr = '<m:chr m:val="' + attrVal(x.chr) + '"/>' +
             '<m:limLoc m:val="' + NARY[x.chr] + '"/>';
    if (!x.sub) pr += '<m:subHide m:val="1"/>';
    if (!x.sup) pr += '<m:supHide m:val="1"/>';
    return '<m:nary><m:naryPr>' + pr + '</m:naryPr>' +
      '<m:sub>' + (x.sub ? conv(x.sub) : '') + '</m:sub>' +
      '<m:sup>' + (x.sup ? conv(x.sup) : '') + '</m:sup>' +
      '<m:e>' + operand + '</m:e></m:nary>';
  }

  function delimXml(beg, end, inner) {
    var pr = '';
    if (beg !== '(' || end !== ')') {
      pr = '<m:dPr>' +
        (beg ? '<m:begChr m:val="' + attrVal(beg) + '"/>' : '') +
        (end ? '<m:endChr m:val="' + attrVal(end) + '"/>' : '<m:endChr m:val=""/>') +
        '</m:dPr>';
    }
    return '<m:d>' + pr + '<m:e>' + inner + '</m:e></m:d>';
  }

  function fenceChar(n) {
    if (!isEl(n, 'mo')) return '';
    if (n.attrs && n.attrs.fence === 'true') {
      var t = textOf(n);
      return PAIR[t] ? t : '';
    }
    return '';
  }

  /** 在 i 之后找配对的右括号；优先认 MathML 标记过 fence 的那些 */
  function findClose(nodes, i, open, closer) {
    var depth = 0, loose = -1;
    for (var j = i + 1; j < nodes.length; j++) {
      var c = nodes[j];
      if (!isEl(c, 'mo')) continue;
      var t = textOf(c);
      var marked = c.attrs && c.attrs.fence === 'true';
      if (marked && t === open && open !== closer) { depth++; continue; }
      if (t === closer) {
        if (marked) {
          if (depth === 0) return j;
          depth--;
        } else if (loose < 0 && depth === 0) {
          loose = j;
        }
      }
    }
    return loose;
  }

  /**
   * 一个序列。这里要处理两件只有「看兄弟节点」才能决定的事：
   *   ① 大运算符要把后面的东西收成自己的被作用体
   *   ② 配对的括号要变成一个定界符对象，而不是两个独立的字符
   */
  function convList(nodes) {
    var out = '';
    var i = 0;

    while (i < nodes.length) {
      var n = nodes[i];

      if (n.type === 'text') { out += conv(n); i++; continue; }

      var nm = local(n.name);
      if (nm === 'annotation' || nm === 'annotation-xml') { i++; continue; }

      // ① 大运算符
      var nary = asNary(n);
      if (nary && !(isEl(n, 'mo') && fenceChar(n))) {
        var j = i + 1;
        var operand = [];
        while (j < nodes.length) {
          var c = nodes[j];
          if (operand.length && isEl(c, 'mo') && ADDITIVE[textOf(c)]) break;
          if (operand.length && isEl(c, 'mo') && fenceChar(c) && textOf(c) === PAIR[textOf(c)]) break;
          operand.push(c);
          j++;
        }
        out += naryXml(nary, convList(operand));
        i = j;
        continue;
      }

      // ② 括号对
      var open = fenceChar(n);
      if (open) {
        var closer = PAIR[open];
        var close = findClose(nodes, i, open, closer);
        if (close > 0) {
          out += delimXml(open, closer, convList(nodes.slice(i + 1, close)));
          i = close + 1;
          continue;
        }
        // 没有右括号：\begin{cases} 的 { —— 剩下的全归它
        out += delimXml(open, '', convList(nodes.slice(i + 1)));
        i = nodes.length;
        continue;
      }

      out += conv(n);
      i++;
    }
    return out;
  }

  /* ================= 对外接口 ================= */

  /** MathML 字符串 → <m:oMath>…</m:oMath> */
  function toOMML(mathml) {
    var tree = parseXml(mathml);
    // 找到 <math>（KaTeX 外面还包着 <span>）
    var math = null;
    (function walk(nodes) {
      for (var k = 0; k < nodes.length; k++) {
        var x = nodes[k];
        if (x.type !== 'el') continue;
        if (local(x.name) === 'math' && !math) { math = x; return; }
        if (x.children && x.children.length) { walk(x.children); if (math) return; }
      }
    })(tree.children);

    if (!math) return '';
    var inner = convList(kids(math));
    if (!inner) return '';   // 空公式不给空壳：Word 会当成一个空公式对象插进去
    return '<m:oMath>' + inner + '</m:oMath>';
  }

  /**
   * MathML → 能被 Word / WPS 认成「原生公式」的 HTML。
   *
   * 关键是那四个 xmlns：Word 拆 HTML 时靠 m: 命名空间判定这是公式而不是未知标签。
   * 少了它，粘进去就是一片空白 —— 而且不报错，最难发现。
   */
  function toWordHtml(mathml) {
    var omml = toOMML(mathml);
    if (!omml) return '';
    return '<html xmlns:o="urn:schemas-microsoft-com:office:office" ' +
      'xmlns:w="urn:schemas-microsoft-com:office:word" ' +
      'xmlns:m="http://schemas.microsoft.com/office/2004/12/omml">' +
      '<head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head>' +
      '<body><p class=MsoNormal>' + omml + '</p></body></html>';
  }

  return {
    toOMML: toOMML,
    toWordHtml: toWordHtml,
    // 单测/排障用
    _parse: parseXml
  };
});

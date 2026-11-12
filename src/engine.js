/**
 * 编辑引擎 —— 不依赖 DOM，可直接用 node 跑测试
 *
 *   1. query()      # 转换引擎的候选查询
 *   2. expand()     符号条目 → 待插入文本 + 光标落点
 *   3. collect()    源码 → 结构列表（每个结构带合法槽位表）
 *   4. navigate()   Ctrl+方向键的三级回退
 *   5. activeSlot() 当前光标所在槽的范围（用于高亮）
 */
(function (global) {
  'use strict';

  const SYM = (typeof module !== 'undefined' && module.exports)
    ? require('./symbols.js')
    : global.FE_SYMBOLS;

  const FLAT = SYM.FLAT;

  /* ---------------- 1. # 查询 ---------------- */

  // 允许出现在 # 之后的字符：字母数字，以及符号型触发码用到的标点
  // 注意包含 ( ) [ ] { } | _ + : ^ —— 图形拼装类触发码（(S) (/） (- [[ ]] C_ |v）要用
  // 希腊字母也放行：二次解析的第二遍触发码就是字符本身（#Σ → ∑）
  const TOKEN_CHAR = /[A-Za-z0-9\u0370-\u03FF]|[-<>!=~*/.()\[\]{}|_+:^·’]|——/;
  const TOKEN_CHARS = /^[A-Za-z0-9\u0370-\u03FF\-<>!=~*/.()\[\]{}|_+:^·’——]+$/;

  function isTokenChar(ch) {
    return !!ch && TOKEN_CHAR.test(ch);
  }

  /** 元素符号校验（大小写严格：Cu 是铜，CO 不是元素） */
  function isElement(name) {
    return SYM.ELEMENTS.indexOf(name) >= 0;
  }

  /**
   * 元素主体 → LaTeX。左上质量数、左下质子数、右上电荷、右下个数，四个空槽。
   * 空基底用 \vphantom 占位（零宽），避免它被当成第五个空槽。
   *
   * 左上与左下**必须分成两个基底写**：写成 `{\vphantom{0}}^{\ph}_{\ph}` 时 MathLive 会合成
   * 一个 msubsup，Tab 先走下标（左下）再走上标（左上），填同位素会填反。
   * 拆成两个基底后 Tab 顺序就是 质量数 → 质子数 → 个数 → 电荷。
   */
  function elementLatex(name) {
    return '{\\vphantom{0}}^{\\placeholder{}}{\\vphantom{0}}_{\\placeholder{}}\\mathrm{' + name +
      '}_{\\placeholder{}}^{\\placeholder{}}';
  }

  /** 前缀查询：返回精确命中、候选列表、以及"是否存在更长的候选" */
  function query(prefix) {
    if (!prefix) return { exact: null, candidates: [], canExtend: false };
    const hits = FLAT.filter((e) => e.t.indexOf(prefix) === 0);
    hits.sort((a, b) => {
      const ae = a.t === prefix ? 0 : 1;
      const be = b.t === prefix ? 0 : 1;
      if (ae !== be) return ae - be;
      // p:1 是「次码 / 别名」（如 all、degree、.*、s）：同一个前缀下让主码排在前面，
      // 否则敲 #al 按回车会先落成 ∀ 而不是 α。见文档「命名风格」第 6 条（直观优先，避重靠别名）
      const ap = a.p || 0;
      const bp = b.p || 0;
      if (ap !== bp) return ap - bp;
      if (a.t.length !== b.t.length) return a.t.length - b.t.length;
      return a.t < b.t ? -1 : 1;
    });
    return {
      exact: hits.find((e) => e.t === prefix) || null,
      candidates: hits.slice(0, 8),
      canExtend: hits.some((e) => e.t.length > prefix.length)
    };
  }

  /* ---------------- 1.5 二次解析（##） ----------------
   * ##X 不是另一张表，而是把符号转换走两遍：
   *   ① #Sigma → 字符 Σ　② 把 Σ 本身当触发码再查一次 → ∑
   * 所以第二遍的触发码就是字符（symbols.js 末尾「二次解析」组）。
   * 这样 ##Theta → ⊖、##Alpha → A → ∀ 都是同一条规则的自然结果。
   */

  /** LaTeX 命令名 → 字符（只用于"第一遍的结果长什么样"，不参与渲染） */
  const GREEK_CHAR = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η',
    theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π',
    rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ',
    Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω'
  };

  /** 条目 → 它展开后的那个字符；拿不到（结构类、\frac 之类）返回 null */
  function surfaceOf(entry) {
    if (!entry) return null;
    const x = entry.x;
    if (x.length === 1 && x !== '\\') return x;            // 直接就是字符：A、B、∞…
    const m = /^\\([A-Za-z]+)$/.exec(x);                   // \Sigma、\alpha…
    return (m && GREEK_CHAR[m[1]]) || null;
  }

  /** 二次解析：先 #prefix，再把结果字符当码解析一次；没有第二遍就返回 null */
  function secondPass(prefix) {
    const first = query(prefix).exact;
    if (!first) return null;
    const ch = surfaceOf(first);
    if (!ch) return null;
    const entry = FLAT.find((e) => e.t === ch) || null;
    if (!entry) return null;
    return { first: first, char: ch, entry: entry };
  }

  /* ---------------- 2. 展开 ---------------- */
  /** 符号条目 → { text, caret }，$0 是光标标记，没有则落进第一个空槽 */
  function expand(entry) {
    const x = entry.x;
    const i = x.indexOf('$0');
    if (i >= 0) return { text: x.slice(0, i) + x.slice(i + 2), caret: i };
    const j = x.indexOf('{}');
    if (j >= 0) return { text: x, caret: j + 1 };
    return { text: x, caret: x.length };
  }

  /* ---------------- 3. 结构解析 ---------------- */

  /** 花括号配对表：open 下标 → close 下标 */
  function matchBraces(src) {
    const map = new Map();
    const stack = [];
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') { i++; continue; }
      if (c === '{') stack.push(i);
      else if (c === '}') {
        const o = stack.pop();
        if (o !== undefined) map.set(o, i);
      }
    }
    return map;
  }

  function skipSpace(src, i) {
    while (i < src.length && src[i] === ' ') i++;
    return i;
  }

  /** 从 idx 起取一个 {…} 组 */
  function groupAt(src, braces, idx) {
    const i = skipSpace(src, idx);
    if (src[i] !== '{') return null;
    const close = braces.get(i);
    if (close === undefined) return null;
    return { open: i, close: close, inner: [i + 1, close], end: close + 1 };
  }

  /** 从 idx 起取一个 _{} / ^{} 脚本 */
  function scriptAt(src, braces, idx) {
    let i = skipSpace(src, idx);
    if (src[i] !== '_' && src[i] !== '^') return null;
    const kind = src[i] === '_' ? 'sub' : 'sup';
    const g = groupAt(src, braces, i + 1);
    if (g) return { kind: kind, inner: g.inner, end: g.end };
    // 单字符脚本 x^2
    const ch = src[i + 1];
    if (ch) return { kind: kind, inner: [i + 1, i + 2], end: i + 2 };
    return null;
  }

  const BIGOPS = {
    '\\sum': { up: true, down: true },
    '\\prod': { up: true, down: true },
    '\\coprod': { up: true, down: true },
    '\\bigcup': { up: true, down: true },
    '\\bigcap': { up: true, down: true },
    '\\int': { sup: true, sub: true },
    '\\oint': { sup: true, sub: true },
    '\\iint': { sup: true, sub: true },
    '\\iiint': { sup: true, sub: true },
    '\\lim': { down: true }
  };

  /** 主解析：返回所有结构，按起点排序 */
  function collect(src) {
    const braces = matchBraces(src);
    const out = [];

    // 分式
    const fracRe = /\\(?:d|t)?frac/g;
    let m;
    while ((m = fracRe.exec(src))) {
      const g1 = groupAt(src, braces, m.index + m[0].length);
      if (!g1) continue;
      const g2 = groupAt(src, braces, g1.end);
      if (!g2) continue;
      out.push({ type: 'frac', start: m.index, end: g2.end, slots: { up: g1.inner, down: g2.inner } });
    }

    // 根式
    const sqrtRe = /\\sqrt/g;
    while ((m = sqrtRe.exec(src))) {
      let i = skipSpace(src, m.index + m[0].length);
      let indexSlot = null;
      if (src[i] === '[') {
        const close = src.indexOf(']', i);
        if (close > 0) { indexSlot = [i + 1, close]; i = close + 1; }
      }
      const g = groupAt(src, braces, i);
      if (!g) continue;
      const slots = { in: g.inner };
      if (indexSlot) slots.index = indexSlot;
      out.push({ type: 'sqrt', start: m.index, end: g.end, slots: slots });
    }

    // 大运算符（求和/积分/极限…）
    Object.keys(BIGOPS).forEach(function (cmd) {
      const re = new RegExp(cmd.replace('\\', '\\\\') + '(?![a-zA-Z])', 'g');
      let mm;
      while ((mm = re.exec(src))) {
        const spec = BIGOPS[cmd];
        const slots = {};
        let i = mm.index + mm[0].length;
        for (let k = 0; k < 2; k++) {
          const s = scriptAt(src, braces, i);
          if (!s) break;
          if (s.kind === 'sub' && (spec.sub || spec.down)) slots[spec.sub ? 'sub' : 'down'] = s.inner;
          if (s.kind === 'sup' && (spec.up || spec.sup)) slots[spec.up ? 'up' : 'sup'] = s.inner;
          i = s.end;
        }
        let end = i;
        const body = groupAt(src, braces, i);
        if (body) { slots.right = body.inner; end = body.end; }
        out.push({ type: 'bigop', cmd: cmd, start: mm.index, end: end, slots: slots });
      }
    });

    // 上下标（独立写法 ^{} _{}）
    const scriptRe = /[\^_]\s*(\{)/g;
    while ((m = scriptRe.exec(src))) {
      const open = m.index + m[0].length - 1;
      const close = braces.get(open);
      if (close === undefined) continue;
      const kind = src[m.index] === '^' ? 'sup' : 'sub';
      const slots = {};
      slots[kind] = [open + 1, close];
      out.push({ type: 'script', start: m.index, end: close + 1, slots: slots });
      scriptRe.lastIndex = m.index + 1;
    }

    // \left( … \right)
    const leftRe = /\\left/g;
    while ((m = leftRe.exec(src))) {
      let depth = 0;
      let j = m.index;
      let endIdx = -1;
      while (j < src.length) {
        if (src.startsWith('\\left', j)) { depth++; j += 5; continue; }
        if (src.startsWith('\\right', j)) {
          depth--;
          if (depth === 0) { endIdx = j; break; }
          j += 6;
          continue;
        }
        j++;
      }
      if (endIdx < 0) continue;
      const delimStart = m.index + 5;                       // \left 之后的定界符
      const innerStart = src[delimStart] === '\\' ? delimStart + 2 : delimStart + 1;
      const closeDelim = endIdx + 5;
      const innerEnd = endIdx;
      const structEnd = src[closeDelim] === '\\' ? closeDelim + 2 : closeDelim + 1;
      out.push({
        type: 'delim',
        start: m.index,
        end: structEnd,
        slots: { in: [innerStart, innerEnd] }
      });
    }

    // 矩阵 / 方程组
    const envRe = /\\begin\{([a-zA-Z*]+)\}([\s\S]*?)\\end\{\1\}/g;
    while ((m = envRe.exec(src))) {
      const name = m[1];
      if (!/(matrix|cases|aligned|array|gathered)/.test(name)) continue;
      const bodyStart = m.index + m[0].indexOf('}') + 1;
      const body = m[2];
      const rows = [];
      let rowStart = bodyStart;
      const rowTexts = body.split(/\\\\/);
      let offset = 0;
      for (let r = 0; r < rowTexts.length; r++) {
        const text = rowTexts[r];
        const cells = text.split('&');
        let cellOffset = 0;
        const rowCells = [];
        for (let c = 0; c < cells.length; c++) {
          const cellText = cells[c];
          rowCells.push([rowStart + offset + cellOffset, rowStart + offset + cellOffset + cellText.length]);
          cellOffset += cellText.length + 1;
        }
        rows.push(rowCells);
        offset += text.length + 2;
      }
      out.push({ type: 'matrix', env: name, start: m.index, end: m.index + m[0].length, rows: rows, slots: {} });
    }

    out.sort((a, b) => a.start - b.start || a.end - b.end);
    return out;
  }

  /* ---------------- 4. 槽位导航 ---------------- */

  function inRange(range, caret) {
    if (!range) return false;
    const [a, b] = range;
    return a === b ? caret === a : caret >= a && caret <= b;
  }

  function place(range) {
    return range ? range[0] : null;
  }

  /** 取包含 caret 的结构链，最内层在前 */
  function chainAt(structs, caret) {
    return structs
      .filter((s) => s.start <= caret && caret <= s.end)
      .sort((a, b) => (a.end - a.start) - (b.end - b.start));
  }

  function insideAnySlot(s, caret) {
    return Object.keys(s.slots).some((k) => inRange(s.slots[k], caret));
  }

  /** 矩阵单元格导航 */
  function matrixMove(s, caret, dir) {
    let pos = null;
    for (let r = 0; r < s.rows.length; r++) {
      for (let c = 0; c < s.rows[r].length; c++) {
        if (inRange(s.rows[r][c], caret)) pos = { r: r, c: c };
      }
    }
    if (!pos) return null;
    const target = { r: pos.r, c: pos.c };
    if (dir === 'left') target.c -= 1;
    else if (dir === 'right') target.c += 1;
    else if (dir === 'up') target.r -= 1;
    else if (dir === 'down') target.r += 1;
    else return null;
    const row = s.rows[target.r];
    if (!row || !row[target.c]) return null;
    return row[target.c][0];
  }

  /**
   * Ctrl + 方向键
   * dir: up | down | left | right | sup | sub
   * 返回新的光标位置，或 null 表示"本级无此方向"（调用方降级为普通跳转）
   */
  function navigate(src, caret, dir) {
    const structs = collect(src);
    const chain = chainAt(structs, caret);

    for (let k = 0; k < chain.length; k++) {
      const s = chain[k];

      if (s.type === 'matrix') {
        const p = matrixMove(s, caret, dir);
        if (p !== null) return p;
        continue;
      }

      let target = null;
      if (dir === 'up') {
        if (s.slots.up && !inRange(s.slots.up, caret)) target = s.slots.up;
        else if (s.slots.sup && !inRange(s.slots.sup, caret)) target = s.slots.sup;
      } else if (dir === 'down') {
        if (s.slots.down && !inRange(s.slots.down, caret)) target = s.slots.down;
        else if (s.slots.sub && !inRange(s.slots.sub, caret)) target = s.slots.sub;
        else if (s.slots.in && !inRange(s.slots.in, caret)) target = s.slots.in;
      } else if (dir === 'sup') {
        if (s.slots.sup && !inRange(s.slots.sup, caret)) target = s.slots.sup;
      } else if (dir === 'sub') {
        if (s.slots.sub && !inRange(s.slots.sub, caret)) target = s.slots.sub;
      } else if (dir === 'left' || dir === 'right') {
        // 从结构内部向外跳：左侧 = 结构起点，右侧 = 结构终点
        if (insideAnySlot(s, caret)) return dir === 'left' ? s.start : s.end;
      }

      if (target && !inRange(target, caret)) return place(target);
    }

    // 顶层：按 token 跳（命令 / 数字串 / 单字符）
    return tokenJump(src, caret, dir === 'left' || dir === 'up' ? -1 : 1);
  }

  const TOKEN_RE = /\\[a-zA-Z]+|\d+(?:\.\d+)?|[\s\S]/g;

  function tokenBounds(src) {
    const bounds = [];
    const re = new RegExp(TOKEN_RE.source, 'g');
    let m;
    while ((m = re.exec(src))) {
      if (m[0] === ' ' && bounds.length) { bounds[bounds.length - 1][1] = m.index + 1; continue; }
      bounds.push([m.index, m.index + m[0].length]);
    }
    return bounds;
  }

  function tokenJump(src, caret, dir) {
    const bounds = tokenBounds(src);
    if (dir < 0) {
      for (let i = bounds.length - 1; i >= 0; i--) {
        if (bounds[i][0] < caret) return bounds[i][0];
      }
      return 0;
    }
    for (let i = 0; i < bounds.length; i++) {
      if (bounds[i][1] > caret) return bounds[i][1];
    }
    return src.length;
  }

  /* ---------------- 5. 当前槽 / 高亮 ---------------- */

  /** 返回 { range, struct, key } 表示光标所在的槽 */
  function activeSlot(src, caret) {
    const structs = collect(src);
    const chain = chainAt(structs, caret);
    for (let k = 0; k < chain.length; k++) {
      const s = chain[k];
      if (s.type === 'matrix') {
        for (let r = 0; r < s.rows.length; r++) {
          for (let c = 0; c < s.rows[r].length; c++) {
            if (inRange(s.rows[r][c], caret)) return { range: s.rows[r][c], struct: s, key: 'cell' };
          }
        }
        continue;
      }
      const keys = Object.keys(s.slots);
      for (let i = 0; i < keys.length; i++) {
        if (inRange(s.slots[keys[i]], caret)) return { range: s.slots[keys[i]], struct: s, key: keys[i] };
      }
    }
    return { range: null, struct: null, key: null };
  }

  /** 在指定范围内注入高亮包裹 */
  function highlight(src, range) {
    if (!range) return src;
    const [a, b] = range;
    const content = src.slice(a, b);
    const wrapped = content.trim() === ''
      ? '\\htmlClass{fe-slot}{\\phantom{x}}'
      : '\\htmlClass{fe-slot}{' + content + '}';
    return src.slice(0, a) + wrapped + src.slice(b);
  }

  /** 所有空槽的位置（Tab 跳转用） */
  function emptySlots(src) {
    const structs = collect(src);
    const list = [];
    structs.forEach(function (s) {
      if (s.type === 'matrix') {
        s.rows.forEach((row) => row.forEach((cell) => {
          if (src.slice(cell[0], cell[1]).trim() === '') list.push(cell[0]);
        }));
        return;
      }
      Object.keys(s.slots).forEach(function (k) {
        const r = s.slots[k];
        if (src.slice(r[0], r[1]).trim() === '') list.push(r[0]);
      });
    });
    return Array.from(new Set(list)).sort((a, b) => a - b);
  }

  const api = {
    query: query,
    secondPass: secondPass,
    surfaceOf: surfaceOf,
    expand: expand,
    collect: collect,
    navigate: navigate,
    activeSlot: activeSlot,
    highlight: highlight,
    emptySlots: emptySlots,
    tokenJump: tokenJump,
    isTokenChar: isTokenChar,
    isElement: isElement,
    elementLatex: elementLatex,
    TOKEN_CHARS: TOKEN_CHARS,
    SYMBOLS: SYM
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.FE_ENGINE = api;
})(typeof window !== 'undefined' ? window : globalThis);

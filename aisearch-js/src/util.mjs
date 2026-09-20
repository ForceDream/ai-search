// 共用工具：模拟 Python int()/str.splitlines() 语义 + 异常命名对齐。
// Python 版与 JS 版的 JSON 输出要逐字段对齐，这里集中处理两语言语义差。

// ── Python int() 语义模拟 ───────────────────────────
// 返回 null 表示 Python 会抛 TypeError / ValueError / OverflowError 的情形，
// 调用方据此回退默认值或抛对齐的异常。

export function py_int(value) {
  if (typeof value === "boolean") return value ? 1 : 0;   // int(True)=1
  if (typeof value === "number") {
    if (Number.isNaN(value)) return null;                 // → ValueError
    if (!Number.isFinite(value)) return null;             // inf → OverflowError
    return Math.trunc(value);                             // int(50.7)=50
  }
  if (typeof value === "string") {
    const s = value.trim();                               // int(" 50 ") 允许
    // 仅接受十进制整数字面量（"0x1A"、"1_000" 等按非法处理）
    if (!/^[+-]?\d+$/.test(s)) return null;
    const n = parseInt(s, 10);
    if (!Number.isFinite(n)) return null;                 // 超长数字串 → 上层 clamp 处理
    return n;
  }
  return null;                                            // None/对象/数组 → TypeError
}


// ── 参数安全整数：对应 Python _safe_int ────────────

export function safe_int(value, default_, lo, hi) {
  const n = py_int(value);
  if (n === null) return default_;
  return Math.max(lo, Math.min(hi, n));
}


// ── Python str.splitlines() 语义 ────────────────────
// Python 识别 \n \r \r\n \v \f \x1c \x1d \x1e \x85 \u2028 \u2029；
// JS String.split 只认 \n，必须专门实现。

const _MULTI_NL = /[\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
const _NL_CHARS = new Set(["\n", "\v", "\f", "\x1c", "\x1d", "\x1e", "\x85", "\u2028", "\u2029"]);

export function splitLines(text) {
  if (text === "") return [];
  // 快路径：只有 \n 换行（99% 的源码文件）
  if (!_MULTI_NL.test(text)) {
    const lines = text.split("\n");
    if (text.endsWith("\n")) lines.pop();
    return lines;
  }
  const lines = [];
  let start = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (_NL_CHARS.has(c)) {
      lines.push(text.slice(start, i));
      i += 1;
      start = i;
    } else if (c === "\r") {
      lines.push(text.slice(start, i));
      i += 1;
      if (text[i] === "\n") i += 1;   // \r\n 算一个换行
      start = i;
    } else {
      i += 1;
    }
  }
  if (start < n) lines.push(text.slice(start));
  return lines;
}


// ── 字符串右侧/左侧去空白（对应 rstrip()/lstrip() 无参版本）──

export function rstrip(s) {
  return s.replace(/\s+$/, "");
}

export function lstrip(s) {
  return s.replace(/^\s+/, "");
}

export function rstrip_nl(s) {
  return s.replace(/\n+$/, "");
}


// ── Python round(x, 1)（毫秒统计用，banker's rounding 差异可忽略）──

export function round1(x) {
  return Math.round(x * 10) / 10;
}


// ── 正则元字符转义（对应 re.escape）────────────────

export function escape_regex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


// ── 单字符计数（对应 str.count）────────────────────

export function count_char(s, ch) {
  let n = 0;
  for (const c of s) if (c === ch) n += 1;
  return n;
}


// ── 对齐 Python 异常名的 Error 子类 ─────────────────
// rpc 把异常转为 {"ok": false, "error": "TypeName: message"}，
// 异常名与 Python 版一致，保证两版错误流 JSON 结构相同。

function named_error(name) {
  return class extends Error {
    constructor(message) {
      super(message);
      this.name = name;
    }
  };
}

export const PyValueError = named_error("ValueError");
export const PyTypeError = named_error("TypeError");
export const PyOSError = named_error("OSError");
export const PyPermissionError = named_error("PermissionError");

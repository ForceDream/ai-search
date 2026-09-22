


import path from "node:path";





export function abs_path(...parts) {

  const r = path.resolve(...parts);
  return /^[a-z]:/.test(r) ? r[0].toUpperCase() + r.slice(1) : r;
}





export function py_int(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return null;
    if (!Number.isFinite(value)) return null;
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const s = value.trim();

    if (!/^[+-]?\d+$/.test(s)) return null;
    const n = parseInt(s, 10);
    if (!Number.isFinite(n)) return null;
    return n;
  }
  return null;
}




export function safe_int(value, default_, lo, hi) {
  const n = py_int(value);
  if (n === null) return default_;
  return Math.max(lo, Math.min(hi, n));
}






const _MULTI_NL = /[\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
const _NL_CHARS = new Set(["\n", "\v", "\f", "\x1c", "\x1d", "\x1e", "\x85", "\u2028", "\u2029"]);

export function splitLines(text) {
  if (text === "") return [];

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
      if (text[i] === "\n") i += 1;
      start = i;
    } else {
      i += 1;
    }
  }
  if (start < n) lines.push(text.slice(start));
  return lines;
}




export function rstrip(s) {
  return s.replace(/\s+$/, "");
}

export function lstrip(s) {
  return s.replace(/^\s+/, "");
}

export function rstrip_nl(s) {
  return s.replace(/\n+$/, "");
}




export function round1(x) {
  return Math.round(x * 10) / 10;
}




export function escape_regex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}




export function count_char(s, ch) {
  let n = 0;
  for (const c of s) if (c === ch) n += 1;
  return n;
}






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

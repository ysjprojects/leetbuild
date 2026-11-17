/**
 * `cjson` as Redis 7 loads it into every script's Lua state: Mark Pulford's lua-cjson 2.1.0
 * (redis/deps/lua/src/lua_cjson.c) with its default configuration — 14 significant digits
 * (`%.14g`), NaN and Inf refused when encoding but accepted when decoding, sparse arrays refused
 * past index 10 when more than half empty, 1000 levels of nesting. A table whose keys are exactly
 * 1..n encodes as an array, any other table (the empty one included) as an object; JSON `null`
 * decodes to `cjson.null`, a NULL lightuserdata. Strings are bytes: `/` and DEL are escaped, bytes
 * above 0x7f pass through, `\uXXXX` decodes to UTF-8. The configuration functions
 * (`encode_sparse_array`, `encode_max_depth`, …, `new`) are not modelled.
 */
import {type LuaState, lauxlib, lua} from 'fengari';

const MAX_DEPTH = 1000;
const SPARSE_RATIO = 2;
const SPARSE_SAFE = 10;

const ascii = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

const fail = (L: LuaState, message: string): never => {
  lua.lua_pushstring(L, ascii(message));
  lua.lua_error(L);
  throw new Error(message); // lua_error does not return
};

/** C's `%.14g`: what lua-cjson's fpconv_g_fmt prints a number with, and Lua 5.1's `LUAI_NUMFFORMAT`. */
export const formatG14 = (n: number): string => {
  if (n === 0) return Object.is(n, -0) ? '-0' : '0';
  const [mantissa, e] = n.toExponential(13).split('e');
  const exp = Number(e);
  const sign = mantissa.startsWith('-') ? '-' : '';
  const digits = mantissa.replace('-', '').replace('.', '');
  if (exp < -4 || exp >= 14) {
    const m = `${digits[0]}.${digits.slice(1)}`.replace(/\.?0+$/, '');
    return `${sign}${m}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  const int = exp >= 0 ? digits.slice(0, exp + 1) : '0';
  const frac = (exp >= 0 ? digits.slice(exp + 1) : '0'.repeat(-exp - 1) + digits).replace(/0+$/, '');
  return sign + int + (frac ? `.${frac}` : '');
};

// ===== encoding =====

/** lua-cjson's char2escape for byte `c`: control characters, `"`, `\`, `/` and DEL; null for the rest. */
const escapeFor = (c: number): Uint8Array | null => {
  const named: Record<number, string> = {
    8: '\\b',
    9: '\\t',
    10: '\\n',
    12: '\\f',
    13: '\\r',
    34: '\\"',
    47: '\\/',
    92: '\\\\',
  };
  if (named[c] !== undefined) return ascii(named[c]);
  if (c < 0x20 || c === 0x7f) return ascii(`\\u${c.toString(16).padStart(4, '0')}`);
  return null;
};
const ESCAPES: readonly (Uint8Array | null)[] = [...Array(256).keys()].map(escapeFor);

class Buffer {
  bytes: number[] = [];
  push(s: string): void {
    for (let i = 0; i < s.length; i++) this.bytes.push(s.charCodeAt(i));
  }
  string(b: Uint8Array): void {
    this.bytes.push(34);
    for (const c of b) {
      const esc = ESCAPES[c];
      if (esc === null) this.bytes.push(c);
      else for (const e of esc) this.bytes.push(e);
    }
    this.bytes.push(34);
  }
}

const encodeError = (L: LuaState, idx: number, reason: string): never =>
  fail(L, `Cannot serialise ${String.fromCharCode(...lua.lua_typename(L, lua.lua_type(L, idx)))}: ${reason}`);

const appendNumber = (L: LuaState, idx: number, out: Buffer): void => {
  const num = lua.lua_tonumber(L, idx);
  if (!Number.isFinite(num)) encodeError(L, idx, 'must not be NaN or Inf');
  out.push(formatG14(num));
};

/** The array length of the table on top of the stack, or -1 when it is an object (lua_array_length). */
const arrayLength = (L: LuaState): number => {
  let max = 0;
  let items = 0;
  lua.lua_pushnil(L);
  while (lua.lua_next(L, -2) !== 0) {
    if (lua.lua_type(L, -2) === lua.LUA_TNUMBER) {
      const k = lua.lua_tonumber(L, -2);
      if (k && Math.floor(k) === k && k >= 1) {
        if (k > max) max = k;
        items++;
        lua.lua_pop(L, 1);
        continue;
      }
    }
    lua.lua_pop(L, 2);
    return -1;
  }
  if (max > items * SPARSE_RATIO && max > SPARSE_SAFE) encodeError(L, -1, 'excessively sparse array');
  return max;
};

const appendData = (L: LuaState, depth: number, out: Buffer): void => {
  switch (lua.lua_type(L, -1)) {
    case lua.LUA_TSTRING:
      out.string(lua.lua_tolstring(L, -1) as Uint8Array);
      return;
    case lua.LUA_TNUMBER:
      appendNumber(L, -1, out);
      return;
    case lua.LUA_TBOOLEAN:
      out.push(lua.lua_toboolean(L, -1) ? 'true' : 'false');
      return;
    case lua.LUA_TTABLE: {
      depth++;
      if (depth > MAX_DEPTH) fail(L, `Cannot serialise, excessive nesting (${depth})`);
      const length = arrayLength(L);
      if (length > 0) {
        out.push('[');
        for (let i = 1; i <= length; i++) {
          if (i > 1) out.push(',');
          lua.lua_rawgeti(L, -1, i);
          appendData(L, depth, out);
          lua.lua_pop(L, 1);
        }
        out.push(']');
        return;
      }
      out.push('{');
      let comma = false;
      lua.lua_pushnil(L);
      while (lua.lua_next(L, -2) !== 0) {
        if (comma) out.push(',');
        comma = true;
        const keyType = lua.lua_type(L, -2);
        if (keyType === lua.LUA_TNUMBER) {
          out.push('"');
          appendNumber(L, -2, out);
          out.push('":');
        } else if (keyType === lua.LUA_TSTRING) {
          out.string(lua.lua_tolstring(L, -2) as Uint8Array);
          out.push(':');
        } else {
          encodeError(L, -2, 'table key must be a number or string');
        }
        appendData(L, depth, out);
        lua.lua_pop(L, 1);
      }
      out.push('}');
      return;
    }
    case lua.LUA_TNIL:
      out.push('null');
      return;
    case lua.LUA_TLIGHTUSERDATA:
      if (lua.lua_touserdata(L, -1) === null) {
        out.push('null');
        return;
      }
    // falls through: any other lightuserdata cannot be serialised
    default:
      encodeError(L, -1, 'type not supported');
  }
};

const encode = (L: LuaState): number => {
  lauxlib.luaL_argcheck(L, lua.lua_gettop(L) === 1, 1, ascii('expected 1 argument'));
  const out = new Buffer();
  appendData(L, 0, out);
  lua.lua_pushstring(L, Uint8Array.from(out.bytes));
  return 1;
};

// ===== decoding =====

enum T {
  OBJ_BEGIN,
  OBJ_END,
  ARR_BEGIN,
  ARR_END,
  STRING,
  NUMBER,
  BOOLEAN,
  NULL,
  COLON,
  COMMA,
  END,
  WHITESPACE,
  ERROR,
  UNKNOWN,
}

interface Token {
  type: T;
  index: number;
  string?: Uint8Array;
  number?: number;
  boolean?: boolean;
  error?: string;
}

const ch2token = (c: number): T => {
  switch (c) {
    case 0x7b:
      return T.OBJ_BEGIN;
    case 0x7d:
      return T.OBJ_END;
    case 0x5b:
      return T.ARR_BEGIN;
    case 0x5d:
      return T.ARR_END;
    case 0x2c:
      return T.COMMA;
    case 0x3a:
      return T.COLON;
    case 0:
      return T.END;
    case 0x20:
    case 0x09:
    case 0x0a:
    case 0x0d:
      return T.WHITESPACE;
  }
  return /[fiInNt"+\-0-9]/.test(String.fromCharCode(c)) ? T.UNKNOWN : T.ERROR;
};

const ESCAPE2CHAR: Record<string, number> = {'"': 34, '\\': 92, '/': 47, b: 8, t: 9, n: 10, f: 12, r: 13};

/** What C's strtod accepts at the start of `s` (fpconv_strtod), or null. */
const STRTOD =
  /^[+-]?(?:0x(?:[0-9a-f]+(?:\.[0-9a-f]*)?|\.[0-9a-f]+)(?:p[+-]?\d+)?|inf(?:inity)?|nan(?:\([0-9a-z_]*\))?|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/i;

const strtod = (s: string): {value: number; length: number} | null => {
  const m = STRTOD.exec(s);
  if (m === null) return null;
  const text = m[0];
  const negative = text.startsWith('-');
  const body = text.replace(/^[+-]/, '').toLowerCase();
  let value: number;
  if (body.startsWith('inf')) value = Infinity;
  else if (body.startsWith('nan')) value = NaN;
  else if (body.startsWith('0x')) {
    const [, int, frac = '', exp = '0'] = /^0x([0-9a-f]*)(?:\.([0-9a-f]*))?(?:p([+-]?\d+))?$/.exec(
      body,
    ) as RegExpExecArray;
    value = 0;
    for (const d of int + frac) value = value * 16 + parseInt(d, 16);
    value = value * 2 ** (Number(exp) - 4 * frac.length);
  } else value = Number(body);
  return {value: negative ? -value : value, length: text.length};
};

class Parser {
  ptr = 0;
  depth = 0;
  constructor(private readonly L: LuaState, private readonly data: Uint8Array) {}

  /** The byte at `i`, 0 past the end — the C parser reads a NUL-terminated string. */
  at(i: number): number {
    return i < this.data.length ? this.data[i] : 0;
  }

  matches(word: string): boolean {
    for (let i = 0; i < word.length; i++) if (this.at(this.ptr + i) !== word.charCodeAt(i)) return false;
    return true;
  }

  error(token: Token, message: string): void {
    token.type = T.ERROR;
    token.index = this.ptr;
    token.error = message;
  }

  /** json_is_invalid_number: what strict JSON refuses but strtod would read (+, hex, leading zeros, inf, nan). */
  invalidNumber(): boolean {
    let p = this.ptr;
    if (this.at(p) === 0x2b) return true;
    if (this.at(p) === 0x2d) p++;
    if (this.at(p) === 0x30) {
      const c2 = this.at(p + 1);
      return (c2 | 0x20) === 0x78 || (c2 >= 0x30 && c2 <= 0x39);
    }
    if (this.at(p) <= 0x39) return false;
    const word = String.fromCharCode(this.at(p), this.at(p + 1), this.at(p + 2)).toLowerCase();
    return word === 'inf' || word === 'nan';
  }

  numberToken(token: Token): void {
    let end = this.ptr;
    while (/[0-9A-Za-z.+\-()_]/.test(String.fromCharCode(this.at(end))) && this.at(end) !== 0) end++;
    const parsed = strtod(String.fromCharCode(...this.data.subarray(this.ptr, end)));
    if (parsed === null) return this.error(token, 'invalid number');
    token.type = T.NUMBER;
    token.number = parsed.value;
    this.ptr += parsed.length;
  }

  hex4(p: number): number {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const d = parseInt(String.fromCharCode(this.at(p + i)), 16);
      if (Number.isNaN(d)) return -1;
      v = v * 16 + d;
    }
    return v;
  }

  /** json_append_unicode_escape: `\uXXXX` (a surrogate pair takes two) to UTF-8. */
  unicodeEscape(out: number[]): boolean {
    let codepoint = this.hex4(this.ptr + 2);
    if (codepoint < 0) return false;
    let escapeLength = 6;
    if ((codepoint & 0xf800) === 0xd800) {
      if (codepoint & 0x400) return false;
      if (this.at(this.ptr + 6) !== 0x5c || this.at(this.ptr + 7) !== 0x75) return false;
      const low = this.hex4(this.ptr + 8);
      if (low < 0 || (low & 0xfc00) !== 0xdc00) return false;
      codepoint = (((codepoint & 0x3ff) << 10) | (low & 0x3ff)) + 0x10000;
      escapeLength = 12;
    }
    if (codepoint <= 0x7f) out.push(codepoint);
    else if (codepoint <= 0x7ff) out.push((codepoint >> 6) | 0xc0, (codepoint & 0x3f) | 0x80);
    else if (codepoint <= 0xffff)
      out.push((codepoint >> 12) | 0xe0, ((codepoint >> 6) & 0x3f) | 0x80, (codepoint & 0x3f) | 0x80);
    else
      out.push(
        (codepoint >> 18) | 0xf0,
        ((codepoint >> 12) & 0x3f) | 0x80,
        ((codepoint >> 6) & 0x3f) | 0x80,
        (codepoint & 0x3f) | 0x80,
      );
    this.ptr += escapeLength;
    return true;
  }

  stringToken(token: Token): void {
    this.ptr++;
    const out: number[] = [];
    for (let c = this.at(this.ptr); c !== 0x22; c = this.at(this.ptr)) {
      if (c === 0) return this.error(token, 'unexpected end of string');
      if (c === 0x5c) {
        const escape = String.fromCharCode(this.at(this.ptr + 1));
        if (escape === 'u') {
          if (this.unicodeEscape(out)) continue;
          return this.error(token, 'invalid unicode escape code');
        }
        const translated = ESCAPE2CHAR[escape];
        if (translated === undefined) return this.error(token, 'invalid escape code');
        this.ptr++;
        c = translated;
      }
      out.push(c);
      this.ptr++;
    }
    this.ptr++;
    token.type = T.STRING;
    token.string = Uint8Array.from(out);
  }

  next(): Token {
    const token: Token = {type: T.END, index: 0};
    for (;;) {
      token.type = ch2token(this.at(this.ptr));
      if (token.type !== T.WHITESPACE) break;
      this.ptr++;
    }
    token.index = this.ptr;
    if (token.type === T.ERROR) {
      this.error(token, 'invalid token');
      return token;
    }
    if (token.type === T.END) return token;
    if (token.type !== T.UNKNOWN) {
      this.ptr++;
      return token;
    }
    const c = this.at(this.ptr);
    if (c === 0x22) this.stringToken(token);
    else if (c === 0x2d || (c >= 0x30 && c <= 0x39)) this.numberToken(token);
    else if (this.matches('true') || this.matches('false')) {
      token.type = T.BOOLEAN;
      token.boolean = this.matches('true');
      this.ptr += token.boolean ? 4 : 5;
    } else if (this.matches('null')) {
      token.type = T.NULL;
      this.ptr += 4;
    } else if (this.invalidNumber()) this.numberToken(token);
    else this.error(token, 'invalid token');
    return token;
  }

  throwParseError(expected: string, token: Token): never {
    const found = token.type === T.ERROR ? token.error : `T_${T[token.type]}`;
    return fail(this.L, `Expected ${expected} but found ${found} at character ${token.index + 1}`);
  }

  descend(): void {
    this.depth++;
    if (this.depth > MAX_DEPTH)
      fail(this.L, `Found too many nested data structures (${this.depth}) at character ${this.ptr}`);
  }

  object(): void {
    this.descend();
    lua.lua_createtable(this.L, 0, 0);
    let token = this.next();
    if (token.type === T.OBJ_END) {
      this.depth--;
      return;
    }
    for (;;) {
      if (token.type !== T.STRING) this.throwParseError('object key string', token);
      lua.lua_pushstring(this.L, token.string as Uint8Array);
      token = this.next();
      if (token.type !== T.COLON) this.throwParseError('colon', token);
      this.value(this.next());
      lua.lua_rawset(this.L, -3);
      token = this.next();
      if (token.type === T.OBJ_END) {
        this.depth--;
        return;
      }
      if (token.type !== T.COMMA) this.throwParseError('comma or object end', token);
      token = this.next();
    }
  }

  array(): void {
    this.descend();
    lua.lua_createtable(this.L, 0, 0);
    let token = this.next();
    if (token.type === T.ARR_END) {
      this.depth--;
      return;
    }
    for (let i = 1; ; i++) {
      this.value(token);
      lua.lua_rawseti(this.L, -2, i);
      token = this.next();
      if (token.type === T.ARR_END) {
        this.depth--;
        return;
      }
      if (token.type !== T.COMMA) this.throwParseError('comma or array end', token);
      token = this.next();
    }
  }

  value(token: Token): void {
    switch (token.type) {
      case T.STRING:
        lua.lua_pushstring(this.L, token.string as Uint8Array);
        return;
      case T.NUMBER: {
        // Lua 5.1 has one number type, the double: a JSON integer decodes to one too.
        lua.lua_pushnumber(this.L, token.number as number);
        return;
      }
      case T.BOOLEAN:
        lua.lua_pushboolean(this.L, token.boolean as boolean);
        return;
      case T.OBJ_BEGIN:
        return this.object();
      case T.ARR_BEGIN:
        return this.array();
      case T.NULL:
        lua.lua_pushlightuserdata(this.L, null);
        return;
      default:
        this.throwParseError('value', token);
    }
  }
}

const decode = (L: LuaState): number => {
  lauxlib.luaL_argcheck(L, lua.lua_gettop(L) === 1, 1, ascii('expected 1 argument'));
  const data = lauxlib.luaL_checklstring(L, 1);
  if (data.length >= 2 && (!data[0] || !data[1])) fail(L, 'JSON parser does not support UTF-16 or UTF-32');
  const parser = new Parser(L, data);
  parser.value(parser.next());
  const token = parser.next();
  if (token.type !== T.END) parser.throwParseError('the end', token);
  return 1;
};

/** Set the global `cjson`, as Redis' scriptingInit does with luaopen_cjson. */
export const openCjson = (L: LuaState): void => {
  lua.lua_createtable(L, 0, 5);
  lua.lua_pushcfunction(L, encode);
  lua.lua_setfield(L, -2, ascii('encode'));
  lua.lua_pushcfunction(L, decode);
  lua.lua_setfield(L, -2, ascii('decode'));
  lua.lua_pushlightuserdata(L, null);
  lua.lua_setfield(L, -2, ascii('null'));
  lua.lua_pushstring(L, ascii('cjson'));
  lua.lua_setfield(L, -2, ascii('_NAME'));
  lua.lua_pushstring(L, ascii('2.1.0'));
  lua.lua_setfield(L, -2, ascii('_VERSION'));
  lua.lua_setglobal(L, ascii('cjson'));
};

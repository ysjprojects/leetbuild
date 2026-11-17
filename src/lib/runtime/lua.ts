/**
 * Redis-flavoured Lua for the Python runtime: fakeredis (in Pyodide) hands EVAL scripts to this
 * fengari VM; `redis.call`/`redis.pcall` go back into the fake server through a callback. Values
 * cross as tagged JSON with Redis' own conversion rules (RESP2 ↔ Lua), so a script written against
 * real Redis behaves the same here. One fresh state per script: nothing leaks between calls.
 *
 * Numbers are Lua 5.1's, as Redis embeds it: every number is a double. fengari is Lua 5.3 with
 * 32-bit integers, whose arithmetic wraps (`1794890484 * 1000` would be negative), so the module
 * hooks below make every numeral and string → number conversion a float, print numbers with
 * `%.14g` ("5", not "5.0"), and the library functions a script multiplies answer floats too.
 */
import {type LuaCFunction, type LuaState, lauxlib, lua, lualib} from 'fengari';
import lobject, {type TValue} from 'fengari/src/lobject.js';
import lstring from 'fengari/src/lstring.js';

import {formatG14, openCjson} from './cjson';

/** RESP2 reply / Lua value as JSON: `{t:'int'|'str'|'nil'|'arr'|'ok'|'err', v}`; strings are latin-1 (byte-safe). */
export type Tagged =
  | {t: 'int'; v: number}
  | {t: 'str'; v: string}
  | {t: 'nil'}
  | {t: 'arr'; v: Tagged[]}
  | {t: 'ok'; v: string}
  | {t: 'err'; v: string};

const bytes = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

const str = (b: Uint8Array | null): string => {
  if (b === null) return '';
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
};

/** A number as Lua 5.1 prints it: `LUAI_NUMFFORMAT` ("%.14g"), glibc's spelling of the non-finite. */
const formatNumber = (n: number): string =>
  Number.isFinite(n) ? formatG14(n) : Number.isNaN(n) ? 'nan' : n > 0 ? 'inf' : '-inf';

/**
 * The double Lua 5.1 reads from numeral `s`, which fengari parsed as the integer `value`: the same
 * value, except a hexadecimal one (fengari's wraps at 32 bits) and `-0`.
 */
const numeralValue = (s: Uint8Array, value: number): number => {
  let i = 0;
  while (s[i] === 32 || (s[i] >= 9 && s[i] <= 13)) i++;
  const negative = s[i] === 45;
  if (negative || s[i] === 43) i++;
  if (s[i] !== 48 || (s[i + 1] | 32) !== 120) return negative && value === 0 ? -0 : value;
  let v = 0;
  for (i += 2; i < s.length; i++) {
    const c = s[i] | 32;
    if (c >= 48 && c <= 57) v = v * 16 + c - 48;
    else if (c >= 97 && c <= 102) v = v * 16 + c - 87;
    else break;
  }
  return negative ? -v : v;
};

// fengari's lexer (numerals), its VM (string arithmetic) and `lua_stringtonumber` (`tonumber`) all
// parse through `luaO_str2num`: a numeral that reads as an integer is stored as a float instead.
const str2num = lobject.luaO_str2num;
lobject.luaO_str2num = (s: Uint8Array, o: TValue): number => {
  const size = str2num(s, o);
  if (size !== 0 && o.ttisinteger()) o.setfltvalue(numeralValue(s, o.value));
  return size;
};
// Number → string coercion (`lua_tolstring`, `..`).
lobject.luaO_tostring = (L: LuaState, o: TValue): void => {
  o.setsvalue(lstring.luaS_bless(L, bytes(formatNumber(o.value))));
};
// `tostring` and `%s` print a float through `lua_pushfstring('%f')`, whose formatter calls fengari's
// own `luaO_tostring`: a `%f` item is handed to it as `%s` of the number's 5.1 text.
const pushvfstring = lobject.luaO_pushvfstring;
lobject.luaO_pushvfstring = (L: LuaState, fmt: Uint8Array, argp: unknown[]): Uint8Array => {
  if (!fmt.includes(102)) return pushvfstring(L, fmt, argp);
  const spec = Uint8Array.from(fmt);
  const args = [...argp];
  for (let i = 0, a = 0; i < spec.length - 1; i++) {
    if (spec[i] !== 37) continue;
    i++;
    if (spec[i] === 37) continue;
    if (spec[i] === 102) {
      spec[i] = 115;
      args[a] = bytes(formatNumber(args[a] as number));
    }
    a++;
  }
  return pushvfstring(L, spec, args);
};

/** C's `%d` of `n` cast to a long (truncated), with `string.format`'s flags, width and precision. */
const formatLong = (flags: string, width: string, precision: string | undefined, n: number): string => {
  const v = BigInt(Math.trunc(n));
  let digits = (v < 0n ? -v : v).toString();
  if (precision !== undefined)
    digits = v === 0n && Number(precision) === 0 ? '' : digits.padStart(Number(precision), '0');
  const sign = v < 0n ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '';
  const w = Number(width);
  if (flags.includes('-')) return (sign + digits).padEnd(w);
  if (flags.includes('0') && precision === undefined) return sign + digits.padStart(w - sign.length, '0');
  return (sign + digits).padStart(w);
};

/** A `string.format` item as its `scanformat` reads it: flags, two-digit width and precision, conversion. */
const FORMAT_ITEM = /%([-+ #0]*)(\d{0,2})(?:\.(\d{0,2}))?([\s\S])/g;

/**
 * `string.format`'s `%d`/`%i` as Lua 5.1 has them, for the numbers Lua 5.3 refuses (a fraction, or
 * beyond 32 bits): 5.1 casts to a C long. Each such item is formatted here and handed on as `%s`.
 */
const lua51Format =
  (format: LuaCFunction): LuaCFunction =>
  (S: LuaState): number => {
    const fmt = str(lauxlib.luaL_checklstring(S, 1));
    const top = lua.lua_gettop(S);
    let arg = 1;
    let changed = false;
    const rewritten = fmt.replace(
      FORMAT_ITEM,
      (item, flags: string, width: string, precision: string | undefined, conv: string) => {
        if (item === '%%') return item;
        arg++;
        if ((conv !== 'd' && conv !== 'i') || arg > top || !lua.lua_isnumber(S, arg)) return item;
        const n = lua.lua_tonumber(S, arg);
        if (!Number.isFinite(n) || (Number.isInteger(n) && n >= -0x80000000 && n < 0x80000000)) return item;
        lua.lua_pushstring(S, bytes(formatLong(flags, width, precision, n)));
        lua.lua_replace(S, arg);
        changed = true;
        return '%s';
      },
    );
    if (changed) {
      lua.lua_pushstring(S, bytes(rewritten));
      lua.lua_replace(S, 1);
    }
    return format(S);
  };

/** Replace the C function `name` of the table on top of the stack with `wrap(original)`. */
const rewrap = (L: LuaState, name: string, wrap: (original: LuaCFunction) => LuaCFunction): void => {
  lua.lua_getfield(L, -1, bytes(name));
  const original = lua.lua_tocfunction(L, -1);
  lua.lua_pop(L, 1);
  if (original === null) throw new Error(`${name} is not a C function`);
  lua.lua_pushcfunction(L, wrap(original));
  lua.lua_setfield(L, -2, bytes(name));
};

/** Lua 5.1's answers where Lua 5.3's library gives an integer: doubles, so arithmetic on them cannot wrap. */
const openLua51Numbers = (L: LuaState): void => {
  lua.lua_getglobal(L, bytes('math'));
  for (const [name, round] of [
    ['floor', Math.floor],
    ['ceil', Math.ceil],
  ] as const) {
    rewrap(L, name, () => S => {
      lua.lua_pushnumber(S, round(lauxlib.luaL_checknumber(S, 1)));
      return 1;
    });
  }
  lua.lua_pop(L, 1);
  lua.lua_getglobal(L, bytes('string'));
  rewrap(L, 'len', () => S => {
    lua.lua_pushnumber(S, lauxlib.luaL_checklstring(S, 1).length);
    return 1;
  });
  rewrap(L, 'format', lua51Format);
  lua.lua_pop(L, 1);
  lua.lua_getglobal(L, bytes('_G'));
  rewrap(L, 'select', select => S => {
    if (lua.lua_type(S, 1) !== lua.LUA_TSTRING || lua.lua_tolstring(S, 1)?.[0] !== 35) return select(S);
    lua.lua_pushnumber(S, lua.lua_gettop(S) - 1);
    return 1;
  });
  lua.lua_pop(L, 1);
};

/** Push a Redis reply onto the Lua stack (RESP2 → Lua). */
const pushReply = (L: LuaState, value: Tagged): void => {
  switch (value.t) {
    case 'int':
      lua.lua_pushnumber(L, value.v);
      return;
    case 'str':
      lua.lua_pushstring(L, bytes(value.v));
      return;
    case 'nil':
      lua.lua_pushboolean(L, false);
      return;
    case 'arr':
      lua.lua_createtable(L, value.v.length, 0);
      value.v.forEach((item, i) => {
        pushReply(L, item);
        lua.lua_rawseti(L, -2, i + 1);
      });
      return;
    case 'ok':
    case 'err':
      lua.lua_createtable(L, 0, 1);
      lua.lua_pushstring(L, bytes(value.v));
      lua.lua_setfield(L, -2, bytes(value.t));
      return;
  }
};

/** Read the value at `idx` as a Redis reply (Lua → RESP2). */
const readValue = (L: LuaState, idx: number): Tagged => {
  const abs = lua.lua_absindex(L, idx);
  switch (lua.lua_type(L, abs)) {
    case lua.LUA_TNUMBER:
      return {t: 'int', v: Math.trunc(lua.lua_tonumber(L, abs))};
    case lua.LUA_TSTRING:
      return {t: 'str', v: str(lua.lua_tolstring(L, abs))};
    case lua.LUA_TBOOLEAN:
      return lua.lua_toboolean(L, abs) ? {t: 'int', v: 1} : {t: 'nil'};
    case lua.LUA_TTABLE: {
      for (const field of ['err', 'ok'] as const) {
        lua.lua_getfield(L, abs, bytes(field));
        if (lua.lua_type(L, -1) === lua.LUA_TSTRING) {
          const v = str(lua.lua_tolstring(L, -1));
          lua.lua_pop(L, 1);
          return {t: field, v};
        }
        lua.lua_pop(L, 1);
      }
      const items: Tagged[] = [];
      for (let i = 1; ; i++) {
        lua.lua_rawgeti(L, abs, i);
        if (lua.lua_type(L, -1) === lua.LUA_TNIL) {
          lua.lua_pop(L, 1);
          break;
        }
        items.push(readValue(L, -1));
        lua.lua_pop(L, 1);
      }
      return {t: 'arr', v: items};
    }
    default:
      return {t: 'nil'};
  }
};

/** Arguments of a `redis.call`, as the Redis Lua binding sees them: strings, or numbers printed Lua 5.1-style. */
const readArgs = (L: LuaState): (string | number)[] => {
  const n = lua.lua_gettop(L);
  const args: (string | number)[] = [];
  for (let i = 1; i <= n; i++) {
    const type = lua.lua_type(L, i);
    if (type === lua.LUA_TSTRING) args.push(str(lua.lua_tolstring(L, i)));
    else if (type === lua.LUA_TNUMBER) args.push(lua.lua_tonumber(L, i));
    else if (type === lua.LUA_TBOOLEAN) args.push(lua.lua_toboolean(L, i) ? 1 : 0);
    else throw new Error('ERR Lua redis lib command arguments must be strings or integers');
  }
  return args;
};

const raise = (L: LuaState, message: string): number => {
  lua.lua_pushstring(L, bytes(message));
  return lua.lua_error(L);
};

/**
 * Run `script` with KEYS/ARGV; `redisCall` receives the JSON-encoded argument list of each
 * `redis.call` and answers with a tagged reply. Returns the script's tagged result; throws on a
 * Lua error or an error reply raised through `redis.call` (message = the Redis error line).
 */
export function luaEval(
  script: string,
  keysJson: string,
  argvJson: string,
  redisCall: (argsJson: string) => string,
): string {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  // Redis embeds Lua 5.1, where `unpack` is a global and `table.unpack` does not exist; fengari is
  // Lua 5.3, which has it the other way round.
  lua.lua_getglobal(L, bytes('table'));
  lua.lua_getfield(L, -1, bytes('unpack'));
  lua.lua_setglobal(L, bytes('unpack'));
  lua.lua_pushnil(L);
  lua.lua_setfield(L, -2, bytes('unpack'));
  lua.lua_pop(L, 1);
  openLua51Numbers(L);
  // Redis loads lua-cjson as the global `cjson` (cmsgpack, bit and struct are not modelled).
  openCjson(L);
  const call =
    (pcall: boolean) =>
    (S: LuaState): number => {
      let args: (string | number)[];
      try {
        args = readArgs(S);
      } catch (e) {
        return raise(S, (e as Error).message);
      }
      const reply = JSON.parse(redisCall(JSON.stringify(args))) as Tagged;
      if (reply.t === 'err' && !pcall) return raise(S, reply.v);
      pushReply(S, reply);
      return 1;
    };
  lua.lua_createtable(L, 0, 8);
  lua.lua_pushcfunction(L, call(false));
  lua.lua_setfield(L, -2, bytes('call'));
  lua.lua_pushcfunction(L, call(true));
  lua.lua_setfield(L, -2, bytes('pcall'));
  lua.lua_pushcfunction(L, S => {
    lua.lua_createtable(S, 0, 1);
    lua.lua_pushvalue(S, 1);
    lua.lua_setfield(S, -2, bytes('err'));
    return 1;
  });
  lua.lua_setfield(L, -2, bytes('error_reply'));
  lua.lua_pushcfunction(L, S => {
    lua.lua_createtable(S, 0, 1);
    lua.lua_pushvalue(S, 1);
    lua.lua_setfield(S, -2, bytes('ok'));
    return 1;
  });
  lua.lua_setfield(L, -2, bytes('status_reply'));
  lua.lua_pushcfunction(L, () => 0);
  lua.lua_setfield(L, -2, bytes('log'));
  lua.lua_pushcfunction(L, () => 0);
  lua.lua_setfield(L, -2, bytes('setresp'));
  (['LOG_DEBUG', 'LOG_VERBOSE', 'LOG_NOTICE', 'LOG_WARNING'] as const).forEach((name, i) => {
    lua.lua_pushnumber(L, i);
    lua.lua_setfield(L, -2, bytes(name));
  });
  lua.lua_setglobal(L, bytes('redis'));
  for (const [name, json] of [
    ['KEYS', keysJson],
    ['ARGV', argvJson],
  ] as const) {
    pushReply(L, {t: 'arr', v: (JSON.parse(json) as string[]).map(v => ({t: 'str', v}))});
    lua.lua_setglobal(L, bytes(name));
  }
  if (lauxlib.luaL_loadstring(L, bytes(script)) !== lua.LUA_OK) {
    throw new Error(`ERR Error compiling script (new function): ${str(lua.lua_tolstring(L, -1))}`);
  }
  if (lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) {
    throw new Error(str(lua.lua_tolstring(L, -1)));
  }
  return JSON.stringify(lua.lua_gettop(L) === 0 ? {t: 'nil'} : readValue(L, -1));
}

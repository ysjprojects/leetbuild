/**
 * Redis-flavoured Lua for the Python runtime: fakeredis (in Pyodide) hands EVAL scripts to this
 * fengari VM; `redis.call`/`redis.pcall` go back into the fake server through a callback. Values
 * cross as tagged JSON with Redis' own conversion rules (RESP2 ↔ Lua), so a script written against
 * real Redis behaves the same here. One fresh state per script: nothing leaks between calls.
 */
import {type LuaState, lauxlib, lua, lualib} from 'fengari';

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

/** Push a Redis reply onto the Lua stack (RESP2 → Lua). */
const pushReply = (L: LuaState, value: Tagged): void => {
  switch (value.t) {
    case 'int':
      lua.lua_pushinteger(L, value.v);
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
    lua.lua_pushinteger(L, i);
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

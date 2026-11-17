/** The part of fengari (Lua 5.3 in JavaScript) the runtime's Lua bridge uses; the package ships no types. */
declare module 'fengari' {
  /** An opaque Lua state created by `luaL_newstate`. */
  export interface LuaState {
    readonly __brand: 'lua_State';
  }

  export type LuaCFunction = (L: LuaState) => number;

  export const lua: {
    lua_absindex(L: LuaState, idx: number): number;
    lua_gettop(L: LuaState): number;
    lua_pop(L: LuaState, n: number): void;
    lua_type(L: LuaState, idx: number): number;
    lua_pushnumber(L: LuaState, n: number): void;
    lua_isnumber(L: LuaState, idx: number): boolean;
    lua_replace(L: LuaState, idx: number): void;
    lua_tocfunction(L: LuaState, idx: number): LuaCFunction | null;
    lua_pushstring(L: LuaState, s: Uint8Array): void;
    lua_pushboolean(L: LuaState, b: boolean): void;
    lua_pushnil(L: LuaState): void;
    lua_pushvalue(L: LuaState, idx: number): void;
    lua_pushcfunction(L: LuaState, fn: LuaCFunction): void;
    lua_createtable(L: LuaState, narr: number, nrec: number): void;
    lua_rawseti(L: LuaState, idx: number, n: number): void;
    lua_rawgeti(L: LuaState, idx: number, n: number): number;
    lua_setfield(L: LuaState, idx: number, k: Uint8Array): void;
    lua_getfield(L: LuaState, idx: number, k: Uint8Array): number;
    lua_setglobal(L: LuaState, name: Uint8Array): void;
    lua_getglobal(L: LuaState, name: Uint8Array): number;
    lua_tonumber(L: LuaState, idx: number): number;
    lua_toboolean(L: LuaState, idx: number): boolean;
    lua_tolstring(L: LuaState, idx: number): Uint8Array | null;
    lua_pcall(L: LuaState, nargs: number, nresults: number, errfunc: number): number;
    lua_error(L: LuaState): number;
    lua_next(L: LuaState, idx: number): number;
    lua_rawset(L: LuaState, idx: number): void;
    lua_pushlightuserdata(L: LuaState, p: unknown): void;
    lua_touserdata(L: LuaState, idx: number): unknown;
    lua_typename(L: LuaState, t: number): Uint8Array;
    LUA_OK: number;
    LUA_TNIL: number;
    LUA_TBOOLEAN: number;
    LUA_TLIGHTUSERDATA: number;
    LUA_TNUMBER: number;
    LUA_TSTRING: number;
    LUA_TTABLE: number;
  };

  export const lauxlib: {
    luaL_newstate(): LuaState;
    luaL_loadstring(L: LuaState, s: Uint8Array): number;
    luaL_argcheck(L: LuaState, cond: boolean, arg: number, extramsg: Uint8Array): void;
    luaL_checklstring(L: LuaState, arg: number): Uint8Array;
    luaL_checknumber(L: LuaState, arg: number): number;
  };

  export const lualib: {
    luaL_openlibs(L: LuaState): void;
  };

  export function to_luastring(s: string): Uint8Array;
  export function to_jsstring(b: Uint8Array): string;
}

/**
 * fengari's internals that Lua 5.1's numbers hook into: fengari calls these through the module
 * object, so replacing an export changes what the lexer, the VM and the API do.
 */
declare module 'fengari/src/lobject.js' {
  import type {LuaState} from 'fengari';

  /** A stack slot or constant; the hooks only see numbers through it. */
  export interface TValue {
    ttisinteger(): boolean;
    setfltvalue(n: number): void;
    setsvalue(ts: unknown): void;
    readonly value: number;
  }

  const lobject: {
    /** Parse a numeral into `o`: its length + 1, or 0 when `s` is not one. */
    luaO_str2num(s: Uint8Array, o: TValue): number;
    /** Replace the number in `o` with its string (number → string coercion). */
    luaO_tostring(L: LuaState, o: TValue): void;
    /** `lua_pushfstring`'s formatter (`%s %d %I %f %p %c %U %%`). */
    luaO_pushvfstring(L: LuaState, fmt: Uint8Array, argp: unknown[]): Uint8Array;
  };
  export default lobject;
}

declare module 'fengari/src/lstring.js' {
  import type {LuaState} from 'fengari';

  const lstring: {
    /** Intern `s` as a Lua string object. */
    luaS_bless(L: LuaState, s: Uint8Array): unknown;
  };
  export default lstring;
}

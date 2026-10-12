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
    lua_pushinteger(L: LuaState, n: number): void;
    lua_pushnumber(L: LuaState, n: number): void;
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
    lua_tonumber(L: LuaState, idx: number): number;
    lua_toboolean(L: LuaState, idx: number): boolean;
    lua_tolstring(L: LuaState, idx: number): Uint8Array | null;
    lua_pcall(L: LuaState, nargs: number, nresults: number, errfunc: number): number;
    lua_error(L: LuaState): number;
    LUA_OK: number;
    LUA_TNIL: number;
    LUA_TBOOLEAN: number;
    LUA_TNUMBER: number;
    LUA_TSTRING: number;
    LUA_TTABLE: number;
  };

  export const lauxlib: {
    luaL_newstate(): LuaState;
    luaL_loadstring(L: LuaState, s: Uint8Array): number;
  };

  export const lualib: {
    luaL_openlibs(L: LuaState): void;
  };

  export function to_luastring(s: string): Uint8Array;
  export function to_jsstring(b: Uint8Array): string;
}

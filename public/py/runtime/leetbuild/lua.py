"""
EVAL / EVALSHA / SCRIPT for fakeredis without `lupa`: the script runs in the host's Lua VM
(fengari, via `leetbuild_host.lua_eval`) and `redis.call` comes back into the fake server through
the same command runner every other command uses. Values cross the bridge as tagged JSON so no
proxy objects leak either way; the conversion rules are Redis' own (RESP2 → Lua, Lua → RESP2).
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

from fakeredis import _msgs as msgs
from fakeredis._command_args_parsing import Int
from fakeredis._commands import command
from fakeredis._helpers import SimpleError, SimpleString
from fakeredis._socket import FakeSocket


def _latin(b: bytes) -> str:
    return b.decode("latin-1")


def _encode_reply(result: Any) -> Any:
    """RESP2 reply (as fakeredis returns it) → tagged JSON for the Lua side."""
    if isinstance(result, SimpleError):
        return {"t": "err", "v": result.value}
    if isinstance(result, SimpleString):
        return {"t": "ok", "v": _latin(result.value)}
    if result is None:
        return {"t": "nil"}
    if isinstance(result, bool):
        return {"t": "int", "v": int(result)}
    if isinstance(result, int):
        return {"t": "int", "v": result}
    if isinstance(result, float):
        return {"t": "str", "v": repr(result)}
    if isinstance(result, (bytes, bytearray)):
        return {"t": "str", "v": _latin(bytes(result))}
    if isinstance(result, str):
        return {"t": "str", "v": result}
    if isinstance(result, (list, tuple)):
        return {"t": "arr", "v": [_encode_reply(x) for x in result]}
    if isinstance(result, dict):
        flat: list[Any] = []
        for k, v in result.items():
            flat.append(_encode_reply(k))
            flat.append(_encode_reply(v))
        return {"t": "arr", "v": flat}
    raise TypeError(f"unexpected reply type from the fake server: {type(result)}")


def _decode_result(value: Any) -> Any:
    """Tagged JSON from the Lua side → the reply EVAL returns to the client."""
    kind = value.get("t")
    if kind == "nil":
        return None
    if kind == "int":
        return int(value["v"])
    if kind == "str":
        return value["v"].encode("latin-1")
    if kind == "arr":
        return [_decode_result(x) for x in value["v"]]
    if kind == "ok":
        return SimpleString(value["v"].encode("latin-1"))
    if kind == "err":
        raise SimpleError(value["v"])
    raise TypeError(f"unexpected Lua result kind {kind!r}")


def _redis_call(socket: FakeSocket, args_json: str) -> str:
    """`redis.call(...)` from Lua: run the command on the socket's database, answer with tagged JSON."""
    args = json.loads(args_json)
    if not args:
        return json.dumps({"t": "err", "v": "ERR Please specify at least one argument for this redis lib call"})
    name = str(args[0])
    func, sig = socket._name_to_func(name.lower())
    if func is None:
        return json.dumps({"t": "err", "v": f"ERR Unknown Redis command called from script: {name}"})
    raw: list[bytes] = []
    for arg in args[1:]:
        if isinstance(arg, bool) or not isinstance(arg, (str, int, float)):
            return json.dumps({"t": "err", "v": msgs.LUA_COMMAND_ARG_MSG})
        # Lua numbers reach Redis as strings; integral floats print without a fraction, as Lua 5.1 did.
        if isinstance(arg, float):
            arg = int(arg) if arg.is_integer() else repr(arg)
        raw.append(str(arg).encode("latin-1"))
    result = socket._run_command(func, sig, raw, True)
    return json.dumps(_encode_reply(result))


def _eval_script(socket: FakeSocket, script: bytes, numkeys: int, keys_and_args: tuple[bytes, ...]) -> Any:
    import leetbuild_host

    if numkeys > len(keys_and_args):
        raise SimpleError(msgs.TOO_MANY_KEYS_MSG)
    if numkeys < 0:
        raise SimpleError(msgs.NEGATIVE_KEYS_MSG)
    sha1 = hashlib.sha1(script).hexdigest().encode()
    socket._server.script_cache[sha1] = script
    keys = json.dumps([_latin(k) for k in keys_and_args[:numkeys]])
    argv = json.dumps([_latin(a) for a in keys_and_args[numkeys:]])
    # Inside a script Redis answers redis.call in RESP2 (flat WITHSCORES pairs, scores as strings),
    # whatever protocol the client speaks; fakeredis keys that on `_script_resp` for the script's duration.
    socket._script_resp = 2
    try:
        out = leetbuild_host.lua_eval(_latin(script), keys, argv, lambda args_json: _redis_call(socket, args_json))
    except Exception as exc:  # a Lua error, or an error reply raised through redis.call
        message = str(exc)
        if message.startswith("Error: "):
            message = message[7:]
        if message.startswith("ERR ") or message.startswith("WRONGTYPE") or message.startswith("NOSCRIPT"):
            raise SimpleError(message) from None
        raise SimpleError(msgs.SCRIPT_ERROR_MSG.format(sha1.decode(), message)) from None
    finally:
        socket._script_resp = None
    return _decode_result(json.loads(out))


@command(name="EVAL", fixed=(bytes, Int), repeat=(bytes,), flags=msgs.FLAG_NO_SCRIPT)
def eval(self, script: bytes, numkeys: int, *keys_and_args: bytes) -> Any:  # noqa: A001 (the command's name)
    return _eval_script(self, script, numkeys, keys_and_args)


@command(name="EVALSHA", fixed=(bytes, Int), repeat=(bytes,), flags=msgs.FLAG_NO_SCRIPT)
def evalsha(self, sha1: bytes, numkeys: int, *keys_and_args: bytes) -> Any:
    try:
        script = self._server.script_cache[sha1]
    except KeyError:
        raise SimpleError(msgs.NO_MATCHING_SCRIPT_MSG) from None
    return _eval_script(self, script, numkeys, keys_and_args)


@command(name="SCRIPT LOAD", fixed=(bytes,), repeat=(bytes,), flags=msgs.FLAG_NO_SCRIPT)
def script_load(self, *args: bytes) -> bytes:
    if len(args) != 1:
        raise SimpleError(msgs.BAD_SUBCOMMAND_MSG.format("SCRIPT"))
    sha1 = hashlib.sha1(args[0]).hexdigest().encode()
    self._server.script_cache[sha1] = args[0]
    return sha1


@command(name="SCRIPT EXISTS", fixed=(), repeat=(bytes,), flags=msgs.FLAG_NO_SCRIPT)
def script_exists(self, *args: bytes) -> list[int]:
    return [int(sha1 in self._server.script_cache) for sha1 in args]


@command(name="SCRIPT FLUSH", fixed=(), repeat=(bytes,), flags=msgs.FLAG_NO_SCRIPT)
def script_flush(self, *args: bytes) -> SimpleString:
    self._server.script_cache.clear()
    return SimpleString(b"OK")


def install() -> None:
    """Attach the commands to the socket class the fake clients use; `@command` already registered their signatures."""
    for fn in (eval, evalsha, script_load, script_exists, script_flush):
        setattr(FakeSocket, fn.__name__, fn)

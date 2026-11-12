/**
 * A self-test of the runtimes' Redis model (src/lib/runtime/ts/redis.ts): command sequences with
 * the replies Redis 7.2 gives, each run on a fresh server with the virtual clock frozen at a known
 * instant, then the blocking commands, woken by other clients' writes or timed out on the clock.
 * `redisSelfTest()` returns the failures, none when the model holds. Random picks (SRANDMEMBER,
 * ZRANDMEMBER, HRANDFIELD) are checked on one-member values, where Redis's answer is fixed too.
 */
import {luaEval} from '../src/lib/runtime/lua';
import {CLOCK, nextMacrotask} from '../src/lib/runtime/ts/clock';
import {type Reply, RedisServer, ReplyError} from '../src/lib/runtime/ts/redis';

type Expected = Reply | {error: string};
/** A command (split on spaces) and its reply; `TICK <ms>` moves the clock instead. */
type Step = [command: string, expected?: Expected];

const err = (error: string): Expected => ({error});

/** The clock every case starts at: 2023-11-14T22:13:20Z. */
const T0 = 1_700_000_000_000;

const WRONGTYPE = err('WRONGTYPE Operation against a key holding the wrong kind of value');
const SYNTAX = err('ERR syntax error');
const NOT_INT = err('ERR value is not an integer or out of range');
const INVALID_ID = err('ERR Invalid stream ID specified as stream command argument');
const TOO_SMALL = err('ERR The ID specified in XADD is equal or smaller than the target stream top item');
const MAX_ID = '18446744073709551615-18446744073709551615';
const e = (id: string, ...fields: string[]): Reply => [id, fields];

export const CASES: Record<string, Step[]> = {
  'stream ids': [
    ['XADD s 0-0 f v', err('ERR The ID specified in XADD must be greater than 0-0')],
    ['EXISTS s', 0],
    ['XADD s 5-* f v', '5-0'],
    ['XADD s 5-* f v', '5-1'],
    ['XADD s 5 f v', TOO_SMALL],
    ['XADD s 4-* f v', TOO_SMALL],
    ['XADD s 6-3 f v', '6-3'],
    ['XADD s * f v', `${T0}-0`],
    ['XADD s * f v', `${T0}-1`],
    ['XADD s 1-x f v', INVALID_ID],
    ['XADD s + f v', INVALID_ID],
    ['XADD s * f', err("ERR wrong number of arguments for 'xadd' command")],
    ['XADD s * f v g', err("ERR wrong number of arguments for 'xadd' command")],
    ['XADD s NOMKSTREAM * f v', `${T0}-2`],
    ['XADD missing NOMKSTREAM * f v', null],
    ['EXISTS missing', 0],
    ['XLEN s', 6],
    ['XLEN missing', 0],
    ['TYPE s', 'stream'],
    ['OBJECT ENCODING s', 'stream'],
    ['SET str x', 'OK'],
    ['XADD str * f v', WRONGTYPE],
    ['XLEN str', WRONGTYPE],
    [`XADD s ${MAX_ID} f v`, MAX_ID],
    ['XADD s * f v', err('ERR The stream has exhausted the last possible ID, unable to add more items')],
  ],
  'stream ranges': [
    ['XADD s 1-0 a 1', '1-0'],
    ['XADD s 1-1 b 2', '1-1'],
    ['XADD s 2-0 c 3', '2-0'],
    ['XADD s 3-5 d 4', '3-5'],
    ['XRANGE s - +', [e('1-0', 'a', '1'), e('1-1', 'b', '2'), e('2-0', 'c', '3'), e('3-5', 'd', '4')]],
    ['XRANGE s 1 1', [e('1-0', 'a', '1'), e('1-1', 'b', '2')]],
    ['XRANGE s (1-0 2', [e('1-1', 'b', '2'), e('2-0', 'c', '3')]],
    ['XRANGE s - + COUNT 2', [e('1-0', 'a', '1'), e('1-1', 'b', '2')]],
    ['XRANGE s - + COUNT 0', null],
    ['XRANGE s - + COUNT -1', null],
    ['XRANGE s 3 2', []],
    ['XREVRANGE s + - COUNT 1', [e('3-5', 'd', '4')]],
    ['XREVRANGE s (3-5 (1-0', [e('2-0', 'c', '3'), e('1-1', 'b', '2')]],
    ['XRANGE s (- +', INVALID_ID],
    [`XRANGE s (${MAX_ID} +`, err('ERR invalid start ID for the interval')],
    ['XRANGE s - (0-0', err('ERR invalid end ID for the interval')],
    ['XRANGE s - + FOO', SYNTAX],
    ['XRANGE s - + COUNT', SYNTAX],
    ['XRANGE missing - + COUNT 0', []],
    ['XRANGE s', err("ERR wrong number of arguments for 'xrange' command")],
  ],
  'xdel and xtrim': [
    ['XADD s 1-0 f 1', '1-0'],
    ['XADD s 2-0 f 2', '2-0'],
    ['XADD s 3-0 f 3', '3-0'],
    ['XADD s 4-0 f 4', '4-0'],
    ['XADD s 5-0 f 5', '5-0'],
    ['XDEL s 2-0 9-0 2-0', 1],
    ['XDEL s 3-0 bad', INVALID_ID],
    ['XDEL missing 1-0', 0],
    ['XLEN s', 4],
    ['XTRIM s MAXLEN 2', 2],
    ['XRANGE s - +', [e('4-0', 'f', '4'), e('5-0', 'f', '5')]],
    ['XTRIM s MINID 5', 1],
    ['XTRIM s MAXLEN 1 LIMIT 10', err('ERR syntax error, LIMIT cannot be used without the special ~ option')],
    ['XTRIM s LIMIT 10 MAXLEN 1', err('ERR syntax error, LIMIT cannot be used without the special ~ option')],
    ['XTRIM s MAXLEN -1', err('ERR The MAXLEN argument must be >= 0.')],
    ['XTRIM s MAXLEN 1 MINID 1', err('ERR syntax error, MAXLEN and MINID options at the same time are not compatible')],
    ['XTRIM s MAXLEN abc', NOT_INT],
    ['XTRIM s FOO 1', SYNTAX],
    ['XTRIM s LIMIT 10 FOO', SYNTAX],
    ['XTRIM missing MAXLEN 0', 0],
    ['XADD s MAXLEN = 1 9-0 f 9', '9-0'],
    ['XRANGE s - +', [e('9-0', 'f', '9')]],
    ['XADD s LIMIT 5 * f v', err('ERR syntax error, LIMIT cannot be used without specifying a trimming strategy')],
    ['XADD s MINID 9-1 10-0 f 10', '10-0'],
    ['XLEN s', 1],
    // Approximate trimming drops whole nodes of 100 entries, never part of one.
    ...Array.from({length: 150}, (_, i): Step => [`XADD big ${i + 1}-0 f v`, `${i + 1}-0`]),
    ['XTRIM big MAXLEN ~ 60', 0],
    ['XTRIM big MAXLEN ~ 0 LIMIT 99', 0],
    ['XTRIM big MAXLEN ~ 50', 100],
    [
      'XINFO STREAM big',
      streamInfo(50, 1, '150-0', '0-0', 150, '101-0', 0, e('101-0', 'f', 'v'), e('150-0', 'f', 'v')),
    ],
    ['XTRIM big MINID = 141', 40],
    ['XADD big MAXLEN 0 151-0 f v', '151-0'],
    ['XLEN big', 0],
    ['EXISTS big', 1],
  ],
  xread: [
    ['XADD a 1-0 x 1', '1-0'],
    ['XADD a 2-0 x 2', '2-0'],
    ['XADD b 1-0 y 1', '1-0'],
    [
      'XREAD COUNT 1 STREAMS a b 0 0',
      [
        ['a', [e('1-0', 'x', '1')]],
        ['b', [e('1-0', 'y', '1')]],
      ],
    ],
    ['XREAD STREAMS a b 1-0 1', [['a', [e('2-0', 'x', '2')]]]],
    ['XREAD COUNT 0 STREAMS a 0', [['a', [e('1-0', 'x', '1'), e('2-0', 'x', '2')]]]],
    ['XREAD STREAMS a missing $ 0', null],
    ['XREAD BLOCK 10 STREAMS a $', null],
    ['XREAD STREAMS a', err("ERR wrong number of arguments for 'xread' command")],
    [
      'XREAD STREAMS a b 0',
      err("ERR Unbalanced 'xread' list of streams: for each stream key an ID or '$' must be specified."),
    ],
    ['XREAD COUNT 1 a 0', SYNTAX],
    ['XREAD COUNT 1 COUNT 2 a', SYNTAX],
    [
      'XREAD STREAMS a >',
      err('ERR The > ID can be specified only when calling XREADGROUP using the GROUP <group> <consumer> option.'),
    ],
    [
      'XREAD GROUP g c STREAMS a 0',
      err('ERR The GROUP option is only supported by XREADGROUP. You called XREAD instead.'),
    ],
    ['XREAD NOACK STREAMS a 0', err('ERR The NOACK option is only supported by XREADGROUP. You called XREAD instead.')],
    ['XREAD BLOCK -1 STREAMS a 0', err('ERR timeout is negative')],
    ['XREAD BLOCK x STREAMS a 0', err('ERR timeout is not an integer or out of range')],
    ['XREAD STREAMS a bad', INVALID_ID],
    ['SET str x', 'OK'],
    ['XREAD STREAMS str 0', WRONGTYPE],
  ],
  'consumer groups and the PEL': [
    [
      'XGROUP CREATE s g $',
      err(
        'ERR The XGROUP subcommand requires the key to exist. Note that for CREATE you may want to use the MKSTREAM option to create an empty stream automatically.',
      ),
    ],
    ['XGROUP CREATE s g $ MKSTREAM', 'OK'],
    ['XGROUP CREATE s g $', err('BUSYGROUP Consumer Group name already exists')],
    ['XADD s 1-0 a 1', '1-0'],
    ['XADD s 2-0 b 2', '2-0'],
    ['XADD s 3-0 c 3', '3-0'],
    ['XREADGROUP GROUP g alice COUNT 2 STREAMS s >', [['s', [e('1-0', 'a', '1'), e('2-0', 'b', '2')]]]],
    ['XREADGROUP GROUP g bob STREAMS s >', [['s', [e('3-0', 'c', '3')]]]],
    ['XREADGROUP GROUP g bob STREAMS s >', null],
    [
      'XPENDING s g',
      [
        3,
        '1-0',
        '3-0',
        [
          ['alice', '2'],
          ['bob', '1'],
        ],
      ],
    ],
    ['TICK 100'],
    [
      'XPENDING s g - + 10',
      [
        ['1-0', 'alice', 100, 1],
        ['2-0', 'alice', 100, 1],
        ['3-0', 'bob', 100, 1],
      ],
    ],
    ['XPENDING s g IDLE 50 - + 10 bob', [['3-0', 'bob', 100, 1]]],
    ['XPENDING s g (1-0 + 1', [['2-0', 'alice', 100, 1]]],
    ['XPENDING s g - + 0', []],
    ['XPENDING s g - + 10 nobody', []],
    ['XPENDING s g - +', SYNTAX],
    ['XPENDING s g IDLE 5 - +', SYNTAX],
    ['XPENDING s nog', err("NOGROUP No such key 's' or consumer group 'nog'")],
    // An explicit ID reads the consumer's own history: delivered again, the counts go up.
    ['XREADGROUP GROUP g alice STREAMS s 0', [['s', [e('1-0', 'a', '1'), e('2-0', 'b', '2')]]]],
    ['XPENDING s g - + 1', [['1-0', 'alice', 0, 2]]],
    ['XACK s g 1-0 9-0', 1],
    ['XACK s nog 1-0', 0],
    ['XACK missing g 1-0', 0],
    ['XACK s g bad', INVALID_ID],
    ['XCLAIM s g carol 50 2-0 3-0', [e('3-0', 'c', '3')]],
    [
      'XPENDING s g - + 10',
      [
        ['2-0', 'alice', 0, 2],
        ['3-0', 'carol', 0, 2],
      ],
    ],
    ['XCLAIM s g dave 0 2-0 JUSTID', ['2-0']],
    ['XCLAIM s g dave 0 2-0 IDLE 500 RETRYCOUNT 7', [e('2-0', 'b', '2')]],
    ['XPENDING s g - + 1', [['2-0', 'dave', 500, 7]]],
    ['XCLAIM s g dave 0 2-0 BOGUS', err("ERR Unrecognized XCLAIM option 'BOGUS'")],
    ['XCLAIM s g dave 0 2-0 IDLE', err("ERR Unrecognized XCLAIM option 'IDLE'")],
    ['XCLAIM s g dave 0 2-0 IDLE x', err('ERR Invalid IDLE option argument for XCLAIM')],
    ['XCLAIM s g dave abc 2-0', err('ERR Invalid min-idle-time argument for XCLAIM')],
    ['XCLAIM s nog dave 0 2-0', err("NOGROUP No such key 's' or consumer group 'nog'")],
    ['XCLAIM s g erin 0 1-0', []],
    ['XCLAIM s g erin 0 1-0 FORCE JUSTID', ['1-0']],
    ['XPENDING s g - + 10 erin', [['1-0', 'erin', 0, 1]]],
    [
      'XINFO GROUPS s',
      [['name', 'g', 'consumers', 5, 'pending', 3, 'last-delivered-id', '3-0', 'entries-read', 3, 'lag', 0]],
    ],
    // A pending entry deleted from the stream: XCLAIM drops it, history shows it as nil.
    ['XDEL s 1-0', 1],
    ['XREADGROUP GROUP g erin STREAMS s 0', [['s', [['1-0', null]]]]],
    ['XCLAIM s g erin 0 1-0', []],
    [
      'XPENDING s g',
      [
        2,
        '2-0',
        '3-0',
        [
          ['carol', '1'],
          ['dave', '1'],
        ],
      ],
    ],
  ],
  xreadgroup: [
    [
      'XREADGROUP GROUP g c STREAMS s >',
      err("NOGROUP No such key 's' or consumer group 'g' in XREADGROUP with GROUP option"),
    ],
    ['XGROUP CREATE s g $ MKSTREAM', 'OK'],
    [
      'XREADGROUP GROUP g c STREAMS s $',
      err(
        'ERR The $ ID is meaningless in the context of XREADGROUP: you want to read the history of this consumer by specifying a proper ID, or use the > ID to get new messages. The $ ID would just return an empty result set.',
      ),
    ],
    [
      'XREADGROUP GROUP g c STREAMS s t >',
      err("ERR Unbalanced 'xreadgroup' list of streams: for each stream key an ID or '>' must be specified."),
    ],
    ['XREADGROUP COUNT 1 COUNT 1 STREAMS s >', err('ERR Missing GROUP option for XREADGROUP')],
    ['XREADGROUP GROUP g c STREAMS s >', null],
    ['XREADGROUP GROUP g c STREAMS s 0', [['s', []]]],
    ['XADD s 1-0 f v', '1-0'],
    ['XREADGROUP GROUP g c NOACK STREAMS s >', [['s', [e('1-0', 'f', 'v')]]]],
    ['XPENDING s g', [0, null, null, null]],
    ['XINFO CONSUMERS s g', [['name', 'c', 'pending', 0, 'idle', 0, 'inactive', -1]]],
  ],
  xautoclaim: [
    ['XGROUP CREATE s g 0 MKSTREAM', 'OK'],
    ['XADD s 1-0 a 1', '1-0'],
    ['XADD s 2-0 b 2', '2-0'],
    ['XADD s 3-0 c 3', '3-0'],
    ['XADD s 4-0 d 4', '4-0'],
    [
      'XREADGROUP GROUP g alice STREAMS s >',
      [['s', [e('1-0', 'a', '1'), e('2-0', 'b', '2'), e('3-0', 'c', '3'), e('4-0', 'd', '4')]]],
    ],
    ['XDEL s 2-0', 1],
    ['TICK 1000'],
    // COUNT bounds claimed plus deleted entries; the cursor is the next pending entry.
    ['XAUTOCLAIM s g bob 500 0 COUNT 2', ['3-0', [e('1-0', 'a', '1')], ['2-0']]],
    ['XAUTOCLAIM s g bob 500 3-0 JUSTID', ['0-0', ['3-0', '4-0'], []]],
    ['XAUTOCLAIM s g carol 500 0', ['0-0', [], []]],
    ['XPENDING s g', [3, '1-0', '4-0', [['bob', '3']]]],
    [
      'XPENDING s g - + 10',
      [
        ['1-0', 'bob', 0, 2],
        ['3-0', 'bob', 0, 1],
        ['4-0', 'bob', 0, 1],
      ],
    ],
    ['XAUTOCLAIM s g carol 0 (1-0 COUNT 1', ['4-0', [e('3-0', 'c', '3')], []]],
    ['XAUTOCLAIM s g bob 0 0 COUNT 0', err('ERR COUNT must be > 0')],
    ['XAUTOCLAIM s g bob 0 0 FOO', SYNTAX],
    ['XAUTOCLAIM s g bob abc 0', err('ERR Invalid min-idle-time argument for XAUTOCLAIM')],
    ['XAUTOCLAIM s nog bob 0 0', err("NOGROUP No such key 's' or consumer group 'nog'")],
    [
      'XINFO CONSUMERS s g',
      [
        ['name', 'alice', 'pending', 0, 'idle', 1000, 'inactive', 1000],
        ['name', 'bob', 'pending', 2, 'idle', 0, 'inactive', 0],
        ['name', 'carol', 'pending', 1, 'idle', 0, 'inactive', 0],
      ],
    ],
  ],
  'group lag and xinfo': [
    ['XADD s 1-0 f 1', '1-0'],
    ['XADD s 2-0 f 2', '2-0'],
    ['XADD s 3-0 f 3', '3-0'],
    ['XADD s 4-0 f 4', '4-0'],
    ['XADD s 5-0 f 5', '5-0'],
    ['XGROUP CREATE s g 0', 'OK'],
    [
      'XINFO GROUPS s',
      [['name', 'g', 'consumers', 0, 'pending', 0, 'last-delivered-id', '0-0', 'entries-read', null, 'lag', 5]],
    ],
    ['XREADGROUP GROUP g c COUNT 2 STREAMS s >', [['s', [e('1-0', 'f', '1'), e('2-0', 'f', '2')]]]],
    [
      'XINFO GROUPS s',
      [['name', 'g', 'consumers', 1, 'pending', 2, 'last-delivered-id', '2-0', 'entries-read', 2, 'lag', 3]],
    ],
    // A deletion past the group's position hides its lag until it reads past it.
    ['XDEL s 4-0', 1],
    [
      'XINFO GROUPS s',
      [['name', 'g', 'consumers', 1, 'pending', 2, 'last-delivered-id', '2-0', 'entries-read', 2, 'lag', null]],
    ],
    ['XREADGROUP GROUP g c STREAMS s >', [['s', [e('3-0', 'f', '3'), e('5-0', 'f', '5')]]]],
    [
      'XINFO GROUPS s',
      [['name', 'g', 'consumers', 1, 'pending', 4, 'last-delivered-id', '5-0', 'entries-read', 5, 'lag', 0]],
    ],
    ['XINFO STREAM s', streamInfo(4, 1, '5-0', '4-0', 5, '1-0', 1, e('1-0', 'f', '1'), e('5-0', 'f', '5'))],
    ['XINFO STREAM missing', err('ERR no such key')],
    [
      'XINFO STREAM s FULL COUNT',
      err("ERR unknown subcommand or wrong number of arguments for 'STREAM'. Try XINFO HELP."),
    ],
    ['XINFO GROUPS', err("ERR wrong number of arguments for 'xinfo|groups' command")],
    ['XINFO CONSUMERS s nog', err("NOGROUP No such consumer group 'nog' for key name 's'")],
    ['XINFO FOO s', err("ERR unknown subcommand 'FOO'. Try XINFO HELP.")],
  ],
  xgroup: [
    ['XGROUP', err("ERR wrong number of arguments for 'xgroup' command")],
    ['XGROUP FOO s g', err("ERR unknown subcommand 'FOO'. Try XGROUP HELP.")],
    ['XGROUP CREATE s', err("ERR wrong number of arguments for 'xgroup|create' command")],
    ['XGROUP CREATE s g $ MKSTREAM ENTRIESREAD 3', 'OK'],
    [
      'XGROUP CREATE s h 0 BOGUS',
      err("ERR unknown subcommand or wrong number of arguments for 'CREATE'. Try XGROUP HELP."),
    ],
    ['XGROUP CREATE s h 1-x', INVALID_ID],
    ['XGROUP CREATE s h -', INVALID_ID],
    ['XGROUP CREATE s h 0 ENTRIESREAD -2', err('ERR value for ENTRIESREAD must be positive or -1')],
    ['XGROUP SETID s nog 0', err("NOGROUP No such consumer group 'nog' for key name 's'")],
    ['XGROUP CREATECONSUMER s g c1', 1],
    ['XGROUP CREATECONSUMER s g c1', 0],
    ['XADD s 1-0 f v', '1-0'],
    ['XREADGROUP GROUP g c2 STREAMS s >', [['s', [e('1-0', 'f', 'v')]]]],
    ['XGROUP DELCONSUMER s g c2', 1],
    ['XGROUP DELCONSUMER s g c2', 0],
    ['XPENDING s g', [0, null, null, null]],
    ['XGROUP SETID s g 0', 'OK'],
    ['XREADGROUP GROUP g c1 STREAMS s >', [['s', [e('1-0', 'f', 'v')]]]],
    ['XGROUP DESTROY s g', 1],
    ['XGROUP DESTROY s g', 0],
    ['XINFO GROUPS s', []],
    ['SET str x', 'OK'],
    ['XGROUP CREATE str g $', WRONGTYPE],
  ],
  lists: [
    ['LPUSHX l a', 0],
    ['EXISTS l', 0],
    ['RPUSH l a b c', 3],
    ['LPUSHX l z', 4],
    ['RPUSHX l d e', 6],
    ['LINSERT l BEFORE c x', 7],
    ['LINSERT l AFTER nope y', -1],
    ['LINSERT l MIDDLE c y', SYNTAX],
    ['LINSERT missing BEFORE a b', 0],
    ['LRANGE l 0 -1', ['z', 'a', 'b', 'x', 'c', 'd', 'e']],
    ['LSET l -1 E', 'OK'],
    ['LINDEX l 6', 'E'],
    ['LSET l 7 q', err('ERR index out of range')],
    ['LSET missing 0 q', err('ERR no such key')],
    ['LSET l x q', NOT_INT],
    ['RPUSH p a b a c a', 5],
    ['LPOS p a', 0],
    ['LPOS p a RANK 2', 2],
    ['LPOS p a RANK -1', 4],
    ['LPOS p a RANK 4', null],
    ['LPOS p a COUNT 0', [0, 2, 4]],
    ['LPOS p a COUNT 2 RANK -1', [4, 2]],
    ['LPOS p a MAXLEN 2 COUNT 0', [0]],
    ['LPOS p z', null],
    ['LPOS p z COUNT 1', []],
    ['LPOS missing a', null],
    ['LPOS missing a COUNT 1', []],
    [
      'LPOS p a RANK 0',
      err(
        "ERR RANK can't be zero: use 1 to start from the first match, 2 from the second ... or use negative to start from the end of the list",
      ),
    ],
    ['LPOS p a COUNT -1', err("ERR COUNT can't be negative")],
    ['LPOS p a MAXLEN -1', err("ERR MAXLEN can't be negative")],
    ['LPOS p a FOO 1', SYNTAX],
    ['LMOVE p q LEFT RIGHT', 'a'],
    ['LMOVE p p RIGHT LEFT', 'a'],
    ['LRANGE p 0 -1', ['a', 'b', 'a', 'c']],
    ['RPOPLPUSH p q', 'c'],
    ['LRANGE q 0 -1', ['c', 'a']],
    ['LMOVE p q UP LEFT', SYNTAX],
    ['LMOVE missing q LEFT LEFT', null],
    ['SET s x', 'OK'],
    ['LMOVE p s LEFT LEFT', WRONGTYPE],
    ['LRANGE p 0 -1', ['a', 'b', 'a']],
    ['LPUSHX s a', WRONGTYPE],
    ['RPUSH one x', 1],
    ['LMOVE one two LEFT LEFT', 'x'],
    ['EXISTS one', 0],
    ['LRANGE two 0 -1', ['x']],
    ['RPUSH bl a b', 2],
    ['BLPOP none bl 0', ['bl', 'a']],
    ['BRPOP bl 0', ['bl', 'b']],
    ['EXISTS bl', 0],
    // Not from a client that may block (here, a plain call): nothing to pop answers as a timeout.
    ['BLPOP bl 0', null],
    ['BLMOVE bl d LEFT LEFT 0', null],
    ['BRPOPLPUSH bl d 0', null],
    ['BLPOP bl -1', err('ERR timeout is negative')],
    ['BLPOP bl x', err('ERR timeout is not a float or out of range')],
    ['BLMOVE bl d LEFT UP 0', SYNTAX],
    ['BLPOP s 0', WRONGTYPE],
    ['BLPOP', err("ERR wrong number of arguments for 'blpop' command")],
  ],
  sets: [
    ['SADD a 1 2 3 4', 4],
    ['SADD b 3 4 5', 3],
    ['SADD c 4 6', 2],
    ['SINTER a b c', ['4']],
    ['SINTER a missing', []],
    ['SUNION a b', ['1', '2', '3', '4', '5']],
    ['SDIFF a b c', ['1', '2']],
    ['SDIFF missing a', []],
    ['SINTERSTORE d a b', 2],
    ['SMEMBERS d', ['3', '4']],
    ['SET str x', 'OK'],
    ['SINTER a str', WRONGTYPE],
    ['SINTER missing str', WRONGTYPE],
    ['EXPIRE d 100', 1],
    ['SUNIONSTORE d a c', 5],
    ['TTL d', -1],
    ['SDIFFSTORE d a a', 0],
    ['EXISTS d', 0],
    ['SDIFFSTORE str a b', 2],
    ['TYPE str', 'set'],
    ['SMISMEMBER a 1 9', [1, 0]],
    ['SMISMEMBER missing 1', [0]],
    ['SMOVE a b 1', 1],
    ['SMOVE a b 1', 0],
    ['SMOVE missing b 1', 0],
    ['SMOVE a a 2', 1],
    ['SMOVE a a 9', 0],
    ['SET x y', 'OK'],
    ['SMOVE a x 2', WRONGTYPE],
    ['SMOVE missing x 2', 0],
    ['SADD one m', 1],
    ['SMOVE one two m', 1],
    ['EXISTS one', 0],
    ['SMEMBERS two', ['m']],
    ['SRANDMEMBER two', 'm'],
    ['SRANDMEMBER two -3', ['m', 'm', 'm']],
    ['SRANDMEMBER two 5', ['m']],
    ['SRANDMEMBER two 0', []],
    ['SRANDMEMBER missing', null],
    ['SRANDMEMBER missing 3', []],
    ['SRANDMEMBER two 1 2', SYNTAX],
    ['SRANDMEMBER x', WRONGTYPE],
  ],
  'sorted sets': [
    ['ZADD z1 1 a 2 b', 2],
    ['ZADD z2 10 b 20 c', 2],
    ['SADD s1 a c', 2],
    ['ZUNIONSTORE out 2 z1 z2', 3],
    ['ZRANGE out 0 -1 WITHSCORES', ['a', '1', 'b', '12', 'c', '20']],
    ['ZUNIONSTORE out 2 z1 z2 WEIGHTS 2 0.5 AGGREGATE MAX', 3],
    ['ZRANGE out 0 -1 WITHSCORES', ['a', '2', 'b', '5', 'c', '10']],
    ['ZINTERSTORE out 2 z1 z2', 1],
    ['ZRANGE out 0 -1 WITHSCORES', ['b', '12']],
    ['ZINTERSTORE out 2 z1 s1 AGGREGATE MIN', 1],
    ['ZRANGE out 0 -1 WITHSCORES', ['a', '1']],
    ['ZUNIONSTORE out 3 z1 z2 s1', 3],
    ['ZRANGE out 0 -1 WITHSCORES', ['a', '2', 'b', '12', 'c', '21']],
    ['ZINTERSTORE out 2 z1 missing', 0],
    ['EXISTS out', 0],
    ['ZUNIONSTORE out 1 z1 WEIGHTS inf', 2],
    ['ZMSCORE out a b nope', ['inf', 'inf', null]],
    ['ZUNIONSTORE out 0 z1', err("ERR at least 1 input key is needed for 'zunionstore' command")],
    ['ZUNIONSTORE out 3 z1 z2', SYNTAX],
    ['ZUNIONSTORE out 2 z1 z2 WEIGHTS 1', SYNTAX],
    ['ZUNIONSTORE out 2 z1 z2 WEIGHTS 1 x', err('ERR weight value is not a float')],
    ['ZUNIONSTORE out 2 z1 z2 AGGREGATE AVG', SYNTAX],
    ['ZUNIONSTORE out x z1', NOT_INT],
    ['SET str x', 'OK'],
    ['ZUNIONSTORE out 2 z1 str', WRONGTYPE],
    ['ZMSCORE z1 a nope', ['1', null]],
    ['ZMSCORE missing a', [null]],
    ['ZMSCORE str a', WRONGTYPE],
    ['ZADD solo 3.5 m', 1],
    ['ZRANDMEMBER solo', 'm'],
    ['ZRANDMEMBER solo -2 WITHSCORES', ['m', '3.5', 'm', '3.5']],
    ['ZRANDMEMBER solo 5', ['m']],
    ['ZRANDMEMBER solo 0', []],
    ['ZRANDMEMBER missing 2', []],
    ['ZRANDMEMBER missing', null],
    ['ZRANDMEMBER solo 1 WITHVALUES', SYNTAX],
    ['ZRANDMEMBER solo x', NOT_INT],
    ['ZRANDMEMBER str', WRONGTYPE],
  ],
  'strings and bits': [
    ['SET k v', 'OK'],
    ['GETEX k EX 10', 'v'],
    ['TTL k', 10],
    ['GETEX k PERSIST', 'v'],
    ['TTL k', -1],
    ['GETEX k PX 1500', 'v'],
    ['GETEX k', 'v'],
    ['PTTL k', 1500],
    [`GETEX k EXAT ${T0 / 1000 + 100}`, 'v'],
    ['TTL k', 100],
    [`GETEX k PXAT ${T0 + 500}`, 'v'],
    ['PTTL k', 500],
    ['GETEX k EX 0', err("ERR invalid expire time in 'getex' command")],
    ['GETEX k EX x', NOT_INT],
    ['GETEX k EX 1 PX 1', SYNTAX],
    ['GETEX k EX', SYNTAX],
    ['GETEX k FOO', SYNTAX],
    ['GETEX missing EX 1', null],
    [`GETEX k EXAT ${T0 / 1000 - 1}`, 'v'],
    ['EXISTS k', 0],
    ['HSET h f v', 1],
    ['GETEX h', WRONGTYPE],
    ['MSETNX a 1 b 2', 1],
    ['MSETNX b 3 c 4', 0],
    ['EXISTS c', 0],
    ['MSETNX a 1 b', err("ERR wrong number of arguments for 'msetnx' command")],
    ['SETBIT bits 7 1', 0],
    ['SETBIT bits 7 1', 1],
    ['GET bits', '\u0001'],
    ['GETBIT bits 7', 1],
    ['GETBIT bits 6', 0],
    ['GETBIT bits 100', 0],
    ['GETBIT missing 0', 0],
    ['SETBIT bits 2 2', err('ERR bit is not an integer or out of range')],
    ['SETBIT bits -1 1', err('ERR bit offset is not an integer or out of range')],
    ['SETBIT bits 4294967296 1', err('ERR bit offset is not an integer or out of range')],
    ['SETBIT h 0 1', WRONGTYPE],
    ['SET foobar foobar', 'OK'],
    ['BITCOUNT foobar', 26],
    ['BITCOUNT foobar 0 0', 4],
    ['BITCOUNT foobar 1 1', 6],
    ['BITCOUNT foobar 1 1 BYTE', 6],
    ['BITCOUNT foobar 5 30 BIT', 17],
    ['BITCOUNT foobar -1 -2', 0],
    ['BITCOUNT foobar 3 1', 0],
    ['BITCOUNT foobar 1', SYNTAX],
    ['BITCOUNT foobar 0 1 WORD', SYNTAX],
    ['BITCOUNT missing 1', 0],
    ['OBJECT ENCODING bits', 'raw'],
    ['SET n 123', 'OK'],
    ['OBJECT ENCODING n', 'int'],
    ['OBJECT REFCOUNT n', 2147483647],
    ['SET n 12345', 'OK'],
    ['OBJECT REFCOUNT n', 1],
    ['OBJECT ENCODING foobar', 'embstr'],
    ['APPEND foobar x', 7],
    ['OBJECT ENCODING foobar', 'raw'],
  ],
  'hyperloglog and hashes': [
    ['PFADD h1 a b c', 1],
    ['PFADD h2 c d', 1],
    ['PFMERGE h3 h1 h2', 'OK'],
    ['PFCOUNT h3', 4],
    ['PFMERGE h1 h2', 'OK'],
    ['PFCOUNT h1', 4],
    ['PFMERGE empty', 'OK'],
    ['PFCOUNT empty', 0],
    ['SET str x', 'OK'],
    ['PFMERGE h3 str', err('WRONGTYPE Key is not a valid HyperLogLog string value.')],
    ['HSET h f hello g 1', 2],
    ['PFMERGE h3 h', WRONGTYPE],
    ['HSTRLEN h f', 5],
    ['HSTRLEN h nope', 0],
    ['HSTRLEN missing f', 0],
    ['HSTRLEN str f', WRONGTYPE],
    ['HSET solo k v', 1],
    ['HRANDFIELD solo', 'k'],
    ['HRANDFIELD solo -3', ['k', 'k', 'k']],
    ['HRANDFIELD solo 2 WITHVALUES', ['k', 'v']],
    ['HRANDFIELD solo -2 WITHVALUES', ['k', 'v', 'k', 'v']],
    ['HRANDFIELD solo 0', []],
    ['HRANDFIELD missing', null],
    ['HRANDFIELD missing 2', []],
    ['HRANDFIELD solo 1 WITHSCORES', SYNTAX],
    ['HRANDFIELD str', WRONGTYPE],
    ['OBJECT ENCODING h', 'listpack'],
  ],
  keyspace: [
    ['SET a 1', 'OK'],
    ['EXPIRE a 100', 1],
    ['TOUCH a b a', 2],
    ['COPY a b', 1],
    ['GET b', '1'],
    ['TTL b', 100],
    ['COPY a b', 0],
    ['SET a 2', 'OK'],
    ['COPY a b REPLACE', 1],
    ['GET b', '2'],
    ['TTL b', -1],
    ['COPY a a', err('ERR source and destination objects are the same')],
    ['COPY missing b', 0],
    ['COPY a c DB 0', 1],
    ['COPY a d DB 1', err('ERR DB index is out of range')],
    ['COPY a d FOO', SYNTAX],
    // A stream copies whole, groups and pending entries too, independent of the original.
    ['XADD s 1-0 f v', '1-0'],
    ['XGROUP CREATE s g 0', 'OK'],
    ['XREADGROUP GROUP g c STREAMS s >', [['s', [e('1-0', 'f', 'v')]]]],
    ['COPY s s2', 1],
    ['XACK s2 g 1-0', 1],
    ['XPENDING s g', [1, '1-0', '1-0', [['c', '1']]]],
    ['RENAME s2 s3', 'OK'],
    ['XLEN s3', 1],
    ['DEL s3', 1],
    ['SCAN 0 TYPE stream', ['0', ['s']]],
    ['OBJECT IDLETIME a', 0],
    ['TICK 5000'],
    ['OBJECT IDLETIME a', 5],
    ['OBJECT IDLETIME a', 5],
    ['GET a', '2'],
    ['OBJECT IDLETIME a', 0],
    ['TICK 3000'],
    ['TOUCH a', 1],
    ['OBJECT IDLETIME a', 0],
    [
      'OBJECT FREQ a',
      err(
        'ERR An LFU maxmemory policy is not selected, access frequency not tracked. Please note that when switching between policies at runtime LRU and LFU data will take some time to adjust.',
      ),
    ],
    ['OBJECT ENCODING missing', null],
    ['OBJECT FOO a', err("ERR unknown subcommand 'FOO'. Try OBJECT HELP.")],
    ['OBJECT ENCODING', err("ERR wrong number of arguments for 'object|encoding' command")],
    ['RPUSH l a', 1],
    ['OBJECT ENCODING l', 'listpack'],
    ['SADD si 1 2', 2],
    ['OBJECT ENCODING si', 'intset'],
    ['SADD ss a', 1],
    ['OBJECT ENCODING ss', 'listpack'],
    ['ZADD z 1 a', 1],
    ['OBJECT ENCODING z', 'listpack'],
  ],
};

/** XINFO STREAM's reply (radix-tree counts as the model approximates them). */
function streamInfo(
  length: number,
  nodes: number,
  last: string,
  maxDeleted: string,
  added: number,
  first: string,
  groups: number,
  firstEntry: Reply,
  lastEntry: Reply,
): Reply {
  return [
    'length',
    length,
    'radix-tree-keys',
    nodes,
    'radix-tree-nodes',
    nodes + 1,
    'last-generated-id',
    last,
    'max-deleted-entry-id',
    maxDeleted,
    'entries-added',
    added,
    'recorded-first-entry-id',
    first,
    'groups',
    groups,
    'first-entry',
    firstEntry,
    'last-entry',
    lastEntry,
  ];
}

/** A fresh server on a clock frozen at T0. */
function fresh(): RedisServer {
  CLOCK.reset();
  CLOCK.freeze();
  CLOCK.offset = T0 - CLOCK.now();
  const server = new RedisServer();
  server.lua = luaEval;
  return server;
}

const outcome = (run: () => Reply): Expected => {
  try {
    return run();
  } catch (error) {
    return {error: error instanceof Error ? error.message : String(error)};
  }
};

/** A pending reply, watched: settled once the promise is (after a turn of the event loop). */
interface Watched {
  settled: boolean;
  value?: Expected;
}

const watch = (promise: Promise<unknown>): Watched => {
  const w: Watched = {settled: false};
  promise.then(
    value => Object.assign(w, {settled: true, value}),
    error =>
      Object.assign(w, {settled: true, value: {error: error instanceof ReplyError ? error.message : String(error)}}),
  );
  return w;
};

const turn = (): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  nextMacrotask(resolve);
  return promise;
};

/** Blocking scenarios: `check(label, actual, expected)` records a mismatch. */
type Check = (label: string, actual: unknown, expected: unknown) => void;

const BLOCKING: Record<string, (s: RedisServer, check: Check) => Promise<void>> = {
  'BLPOP woken by another client': async (s, check) => {
    const pop = watch(s.executeBlocking(['blpop', 'q', '0']));
    await turn();
    check('blocked', pop.settled, false);
    check('rpush', s.execute(['rpush', 'q', 'a']), 1);
    await turn();
    check('popped', pop.value, ['q', 'a']);
    check('list emptied', s.execute(['exists', 'q']), 0);
    check('one trip each', s.trips, [['BLPOP'], ['RPUSH'], ['EXISTS']]);
  },
  'two blocked clients are served in order': async (s, check) => {
    const first = watch(s.executeBlocking(['blpop', 'q', '0']));
    const second = watch(s.executeBlocking(['brpop', 'other', 'q', '0']));
    s.execute(['rpush', 'q', 'a']);
    await turn();
    check('first served', first.value, ['q', 'a']);
    check('second waits', second.settled, false);
    s.execute(['rpush', 'q', 'b', 'c']);
    await turn();
    check('second served', second.value, ['q', 'c']);
    check('rest stays', s.execute(['lrange', 'q', '0', '-1']), ['b']);
  },
  'a timeout answers nil once the clock passes it': async (s, check) => {
    const pop = watch(s.executeBlocking(['blpop', 'q', '1.5']));
    CLOCK.advance(1499);
    await turn();
    check('still blocked', pop.settled, false);
    CLOCK.advance(1);
    await turn();
    check('timed out', pop.value, null);
    s.execute(['rpush', 'q', 'a']);
    check('push stays', s.execute(['llen', 'q']), 1);
  },
  'BLMOVE moves when woken': async (s, check) => {
    const move = watch(s.executeBlocking(['blmove', 'src', 'dst', 'LEFT', 'RIGHT', '0']));
    const chained = watch(s.executeBlocking(['blpop', 'dst', '0']));
    s.execute(['rpush', 'src', 'x']);
    await turn();
    check('moved', move.value, 'x');
    // The element BLMOVE pushed readies `dst` for the client blocked there.
    check('chained', chained.value, ['dst', 'x']);
    check('source gone', s.execute(['exists', 'src', 'dst']), 0);
  },
  'XREADGROUP BLOCK woken by XADD': async (s, check) => {
    s.execute(['xgroup', 'create', 's', 'g', '$', 'MKSTREAM']);
    const read = watch(s.executeBlocking(['xreadgroup', 'GROUP', 'g', 'c', 'BLOCK', '0', 'STREAMS', 's', '>']));
    await turn();
    check('blocked', read.settled, false);
    s.execute(['xadd', 's', '5-0', 'f', 'v']);
    await turn();
    check('read', read.value, [['s', [['5-0', ['f', 'v']]]]]);
    check('pending', s.execute(['xpending', 's', 'g']), [1, '5-0', '5-0', [['c', '1']]]);
  },
  'XREAD BLOCK $ reads only what comes after it blocked': async (s, check) => {
    s.execute(['xadd', 's', '1-0', 'a', '1']);
    const read = watch(s.executeBlocking(['xread', 'BLOCK', '0', 'STREAMS', 's', '$']));
    s.execute(['xadd', 's', '2-0', 'b', '2']);
    await turn();
    check('read', read.value, [['s', [['2-0', ['b', '2']]]]]);
    const late = watch(s.executeBlocking(['xread', 'BLOCK', '100', 'STREAMS', 's', '$']));
    CLOCK.advance(100);
    await turn();
    check('timed out', late.value, null);
  },
  'XREADGROUP blocked on a destroyed group gets NOGROUP': async (s, check) => {
    s.execute(['xgroup', 'create', 's', 'g', '$', 'MKSTREAM']);
    const read = watch(s.executeBlocking(['xreadgroup', 'GROUP', 'g', 'c', 'BLOCK', '0', 'STREAMS', 's', '>']));
    s.execute(['xgroup', 'destroy', 's', 'g']);
    await turn();
    check('error', read.value, {
      error: "NOGROUP No such key 's' or consumer group 'g' in XREADGROUP with GROUP option",
    });
  },
  'blocking commands do not block in MULTI or Lua': async (s, check) => {
    check(
      'multi',
      s.executeTransaction([
        ['blpop', 'q', '0'],
        ['xread', 'BLOCK', '0', 'STREAMS', 's', '$'],
        ['set', 'k', '1'],
      ]),
      [null, null, 'OK'],
    );
    check('lua blpop', s.execute(['eval', "return redis.call('blpop', 'q', 0)", '0']), null);
    check(
      'lua xread',
      outcome(() => s.execute(['eval', "return redis.call('xread', 'BLOCK', 0, 'STREAMS', 's', '$')", '0'])),
      {error: 'ERR xread command is not allowed with BLOCK option from scripts'},
    );
    // A script's push wakes a blocked client.
    const pop = watch(s.executeBlocking(['blpop', 'q', '0']));
    s.execute(['eval', "return redis.call('rpush', KEYS[1], 'a')", '1', 'q']);
    await turn();
    check('woken by lua', pop.value, ['q', 'a']);
  },
  'a pipelined BLPOP holds the commands after it': async (s, check) => {
    const replies = watch(
      s.executePipelineBlocking([
        ['set', 'before', '1'],
        ['blpop', 'q', '0'],
        ['set', 'after', '1'],
      ]),
    );
    await turn();
    check('before ran', s.execute(['get', 'before']), '1');
    check('after held', s.execute(['get', 'after']), null);
    s.execute(['rpush', 'q', 'a']);
    await turn();
    check('replies', replies.value, ['OK', ['q', 'a'], 'OK']);
    check('after ran', s.execute(['get', 'after']), '1');
    check('one trip', s.trips[0], ['SET', 'BLPOP', 'SET']);
  },
  'executeBlocking answers other commands and errors at once': async (s, check) => {
    s.execute(['set', 'k', 'v']);
    const get = watch(s.executeBlocking(['get', 'k']));
    const wrong = watch(s.executeBlocking(['blpop', 'k', '0']));
    await turn();
    check('get', get.value, 'v');
    check('wrongtype', wrong.value, {error: 'WRONGTYPE Operation against a key holding the wrong kind of value'});
  },
};

/** Run the table and the blocking scenarios; the failures, none when the model holds. */
export async function redisSelfTest(): Promise<string[]> {
  const failures: string[] = [];
  try {
    for (const [name, steps] of Object.entries(CASES)) {
      const server = fresh();
      for (const [command, expected] of steps) {
        const [cmd, ...args] = command.split(' ');
        if (cmd === 'TICK') {
          CLOCK.advance(Number(args[0]));
          continue;
        }
        const actual = outcome(() => server.execute([cmd.toLowerCase(), ...args], false));
        if (JSON.stringify(actual) !== JSON.stringify(expected))
          failures.push(`${name}: ${command} → ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
      }
    }
    for (const [name, scenario] of Object.entries(BLOCKING)) {
      const check: Check = (label, actual, expected) => {
        if (JSON.stringify(actual) !== JSON.stringify(expected))
          failures.push(`${name}: ${label} → ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
      };
      try {
        await scenario(fresh(), check);
      } catch (error) {
        failures.push(`${name}: threw ${error instanceof Error ? error.stack : String(error)}`);
      }
    }
  } finally {
    CLOCK.reset();
  }
  return failures;
}

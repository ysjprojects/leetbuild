/**
 * Redis for the C++ runtime: the server every language's checks share (../ts/redis.ts), as the
 * redis-plus-plus model (cppruntime/include/sw/redis++/redis++.h) and the harness's own client
 * reach it. A reply crosses as `{r: reply}`, or `{e: message}` for an error reply.
 */
import * as redis from '../ts/redis';
import type {Bridge, BridgeWorld} from './bridge';

type Tagged = {r: redis.Reply} | {e: string};

const tagged = (run: () => redis.Reply): Tagged => {
  try {
    return {r: run()};
  } catch (e) {
    return {e: e instanceof Error ? e.message : String(e)};
  }
};

const each = (replies: (redis.Reply | redis.ReplyError)[]): Tagged[] =>
  replies.map(r => (r instanceof redis.ReplyError ? {e: r.message} : {r}));

export function redisBridge(world: BridgeWorld): Bridge {
  // Each Subscriber subscription's way off the server, by its handle (UNSUBSCRIBE, or the connection closing).
  const subscriptions = new Map<number, () => void>();
  return {
    calls: {
      // `record`: the learner's command (a round trip the harness counts, probes fire); the harness's are not.
      'redis.execute': ({args, record}: {args: string[]; record: boolean}): Tagged =>
        tagged(() => redis.SERVER.execute(args, record)),
      'redis.pipeline': (commands: string[][]): Tagged[] => each(redis.SERVER.executePipeline(commands)),
      'redis.transaction': (commands: string[][]): Tagged[] => each(redis.SERVER.executeTransaction(commands)),
      'redis.fingerprint': (key: string): string => redis.SERVER.fingerprint(key),
      'redis.trips': (): string[][] => redis.SERVER.trips,
      'redis.probe': ({key, handle}: {key: string; handle: number}): void => {
        redis.SERVER.probes.push({
          key,
          fn: () => {
            if (world.live()) world.invoke(handle);
          },
          fired: false,
          result: undefined,
          error: undefined,
        });
      },
      'redis.subscribe': ({name, pattern, handle}: {name: string; pattern: boolean; handle: number}): void => {
        const deliver = (p: string | null, channel: string, message: string): void =>
          world.deliver(handle, JSON.stringify([p, channel, message]));
        subscriptions.set(
          handle,
          pattern
            ? redis.SERVER.psubscribe(name, (p, channel, message) => deliver(p, channel, message))
            : redis.SERVER.subscribe(name, (channel, message) => deliver(null, channel, message)),
        );
      },
      'redis.unsubscribe': ({handle}: {handle: number}): void => {
        subscriptions.get(handle)?.();
        subscriptions.delete(handle);
      },
    },
  };
}

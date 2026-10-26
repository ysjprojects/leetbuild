/**
 * Postgres for the C++ runtime: the shared PGlite (../ts/pg.ts), through its lock and its counts, as
 * the C++ database models reach it (cppruntime/src/pqxx.cpp: libpqxx, and the harness's ctx.DB).
 * The query log, the BEGIN/COMMIT/ROLLBACK events and the probes are kept on the C++ side, where
 * every statement of a check passes. A held connection (a transaction in progress) is released when
 * the program is over, its transaction rolled back, so the next program's statements neither wait
 * on it nor run inside it.
 */
import * as pg from '../ts/pg';
import type {Bridge, BridgeWorld} from './bridge';

export function dbBridge(world: BridgeWorld): Bridge {
  const held = new Map<number, () => void>();
  let next = 1;
  return {
    calls: {
      'db.release': (id: number): void => held.get(id)?.(),
    },
    asyncCalls: {
      // A statement: {fields: [{name, dataTypeID}], rows (text format, null for NULL), affected}, or
      // {error: {code, message, …}} (pg.DB.runText); `counted`: the learner's statement.
      'db.run': async ({
        sql,
        args,
        held: inHeld,
        counted,
      }: {
        sql: string;
        args: (string | null)[];
        held: boolean;
        counted: boolean;
      }): Promise<unknown> => {
        try {
          return JSON.parse(await world.tracked(pg.DB.runText(sql, args, inHeld, counted))) as unknown;
        } catch (e) {
          return {error: {message: e instanceof Error ? e.message : String(e)}};
        }
      },
      // A connection held for a transaction: its id, for db.run's `held` and db.release.
      'db.hold': async (): Promise<number> => {
        const release = await world.tracked(pg.DB.hold());
        const id = next++;
        held.set(id, () => {
          if (!held.delete(id)) return;
          release();
        });
        return id;
      },
      // Drop every table and apply the schema: null, or the error's message.
      'db.reset': async (schema: string): Promise<string | null> => {
        try {
          await world.tracked(pg.DB.resetSchema(schema));
          return null;
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      },
    },
    stop: async (): Promise<void> => {
      const open = [...held.values()];
      for (const release of open) release();
      if (open.length > 0) await pg.DB.runText('ROLLBACK', [], false, false).catch(() => undefined);
    },
  };
}

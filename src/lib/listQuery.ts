/**
 * The landing page's search/filter/sort state lives in the URL's query string: `useListQuery`
 * reads it through Next's router and writes it back with a shallow replace — no reload, no history
 * entry per keystroke — so a filtered view is a link that opens the same way for anyone.
 */
import Router, {useRouter} from 'next/router';
import {useCallback, useMemo} from 'react';

import {type ListQuery, DEFAULT_LIST_QUERY, parseListQuery, serializeListQuery} from './catalog';

const write = (query: ListQuery): void => {
  void Router.replace({pathname: '/', query: serializeListQuery(query)}, undefined, {shallow: true, scroll: false});
};

/** `[query, update, reset]`: `update` merges a patch into the URL's query, `reset` clears every filter. */
export function useListQuery(): [ListQuery, (patch: Partial<ListQuery>) => void, () => void] {
  const router = useRouter();
  const query = useMemo(
    () => (router.isReady ? parseListQuery(router.query) : DEFAULT_LIST_QUERY),
    [router.isReady, router.query],
  );
  // The singleton's query is read at call time, so two quick updates never overwrite each other.
  const update = useCallback((patch: Partial<ListQuery>) => write({...parseListQuery(Router.query), ...patch}), []);
  const reset = useCallback(() => {
    const current = parseListQuery(Router.query);
    write({...DEFAULT_LIST_QUERY, sort: current.sort, desc: current.desc});
  }, []);
  return [query, update, reset];
}

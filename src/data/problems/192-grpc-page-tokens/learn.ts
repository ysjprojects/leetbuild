/**
 * The learning guide for the page-token drill: AIP-158 pagination on a gRPC list method, offset
 * versus keyset, why the token is opaque and bound to its collection, the rules for page_size and the
 * last page, and what total_size costs. Rendered at `/grpc-page-tokens/learn`.
 */
export const learn = `# The mechanism at a glance

A list method that answers with the whole collection works until the collection is large. Then one
reply is megabytes, one query scans a table, and one slow client holds a server thread for all of it.
**Pagination** splits the answer: the client asks for a page, the server returns it with a token for
the next one, and the client sends that token back until the token comes back empty.

:::diagram
{
  "nodes": [
    {"id": "clients", "kind": "client", "label": "Clients", "sub": "send page_token back, never read it", "x": 18, "y": 50},
    {"id": "library", "kind": "grpc", "label": "Library", "sub": "ListBooks · keyset by id · :9000", "x": 52, "y": 50},
    {"id": "catalogue", "kind": "service", "label": "Catalogue", "sub": "adds and removes books between pages", "x": 84, "y": 50}
  ],
  "edges": [
    {"from": "clients", "to": "library", "kind": "grpc", "label": "ListBooks(shelf, page_size, page_token)"},
    {"from": "catalogue", "to": "library", "kind": "plain", "label": "SHELVES writes"}
  ]
}
:::

The contract the drill implements:

- \`library.v1.Library/ListBooks(ListBooksRequest{shelf, page_size, page_token})\` returns
  \`ListBooksResponse{books: [Book{id, title}], next_page_token}\`, read from the module-level
  \`SHELVES\` (shelf → {id → title}).
- \`DEFAULT_PAGE_SIZE = 50\`, \`MAX_PAGE_SIZE = 100\`. \`page_size\` 0 means 50, above 100 means 100, and
  a negative size is \`INVALID_ARGUMENT\`. An unknown shelf is \`NOT_FOUND\`.
- Books come in ascending \`id\` order. A page holds the books with \`id > after\`, where \`after\` is the
  last id of the previous page, carried inside the token.
- The token is base64url of a small JSON object with the shelf and that last id. A token for another
  shelf, or one that does not decode, is \`INVALID_ARGUMENT\`.
- \`next_page_token\` is \`""\` on the last page, and only there.

# Offset pagination and how it breaks

The first pagination anyone writes is an offset: page *n* is "skip \`n × size\`, take \`size\`". SQL
makes it one clause (\`LIMIT 5 OFFSET 5\`) and the token is just a number. It is correct for a list
that never changes during a walk, and wrong for every other list.

An offset is a position in the list *as it is at the moment of the call*. Between two calls the
catalogue removes two books the client has already seen. The list shifts left by two, the offset does
not, and two books the client has not seen slide under the cursor:

:::sequence
{
  "participants": ["Client", "Library (offset)", "Catalogue"],
  "messages": [
    {"from": "Client", "to": "Library (offset)", "label": "ListBooks(fiction, 5, token \\"0\\")", "kind": "sync"},
    {"from": "Library (offset)", "to": "Client", "label": "b-0010 … b-0050 · token \\"5\\"", "kind": "reply"},
    {"from": "Catalogue", "to": "Library (offset)", "label": "remove b-0020, b-0030", "kind": "async"},
    {"from": "Client", "to": "Library (offset)", "label": "ListBooks(fiction, 5, token \\"5\\")", "kind": "sync"},
    {"from": "Library (offset)", "to": "Library (offset)", "label": "skip 5 of [10, 40, 50, 60, 70, 80 …]", "kind": "sync"},
    {"from": "Library (offset)", "to": "Client", "label": "b-0080 … b-0120: b-0060, b-0070 never listed", "kind": "reply"},
    {"from": "Catalogue", "to": "Library (offset)", "label": "add b-0005, b-0025, b-0045", "kind": "async"},
    {"from": "Client", "to": "Library (offset)", "label": "ListBooks(fiction, 5, token \\"10\\")", "kind": "sync"},
    {"from": "Library (offset)", "to": "Client", "label": "b-0100 … b-0140: b-0100, b-0110, b-0120 again", "kind": "reply"}
  ]
}
:::

The same walk with a key in the token. Each call asks for "after the last id you gave me", which means
the same thing whatever moved in between:

:::sequence
{
  "participants": ["Client", "Library (keyset)", "Catalogue"],
  "messages": [
    {"from": "Client", "to": "Library (keyset)", "label": "ListBooks(fiction, 5, \\"\\")", "kind": "sync"},
    {"from": "Library (keyset)", "to": "Client", "label": "b-0010 … b-0050 · T1 = {fiction, after b-0050}", "kind": "reply"},
    {"from": "Catalogue", "to": "Library (keyset)", "label": "remove b-0020, b-0030", "kind": "async"},
    {"from": "Client", "to": "Library (keyset)", "label": "ListBooks(fiction, 5, T1)", "kind": "sync"},
    {"from": "Library (keyset)", "to": "Client", "label": "id > b-0050: b-0060 … b-0100 · T2", "kind": "reply"},
    {"from": "Catalogue", "to": "Library (keyset)", "label": "add b-0005, b-0025, b-0045", "kind": "async"},
    {"from": "Client", "to": "Library (keyset)", "label": "ListBooks(fiction, 5, T2)", "kind": "sync"},
    {"from": "Library (keyset)", "to": "Client", "label": "id > b-0100: b-0110 … b-0150 · nothing repeated", "kind": "reply"}
  ]
}
:::

| Change between two calls | Offset token | Key token |
| --- | --- | --- |
| a book before the cursor is removed | skips one unseen book | nothing |
| a book before the cursor is added | repeats one seen book | nothing (the new book is behind the walk) |
| the cursor's own book is removed | skips or repeats, depending on the rest | nothing: \`id > after\` needs no row for \`after\` |
| a book after the cursor is added or removed | listed or not, correctly | listed or not, correctly |
| cost of page 1,000 | the database reads and discards 50,000 rows | one index seek |

The last row is the other reason offsets die in production: \`OFFSET 50000\` still walks fifty thousand
index entries to throw them away, so deep pages get slower in a straight line. The
[no-offset argument](https://use-the-index-luke.com/no-offset) is the standard write-up of both
problems.

:::quiz
Q: A client walks a shelf with an offset token while the catalogue deletes books it has already listed. What does the client see?
- [ ] Duplicates: books it has seen come back on the next page
- [x] Gaps: books it has not seen yet slide under the offset and are never listed
- [ ] Nothing wrong: deleted books simply stop appearing
> Deleting behind the cursor shifts every later book one position left, and the offset does not move with them. Inserting behind the cursor does the opposite and causes duplicates. A key comparison is unaffected by either.
:::

# Keyset pagination: continue after a key

**Keyset** (or seek) pagination stores the sort key of the last row returned and asks for the rows
past it. Against a database it is one indexed query:

\`\`\`sql
SELECT id, title FROM books
WHERE shelf = $1 AND id > $2      -- $2 = the token's last id, '' on page 1
ORDER BY id
LIMIT $3 + 1                      -- one extra row says whether a next page exists
\`\`\`

The drill does the same over a dictionary: filter \`id > after\`, sort, take \`size\`. Four details make
it correct rather than nearly correct:

- **Strictly greater.** \`>=\` repeats the last book of every page. \`>\` needs no row for \`after\` to exist,
  so deleting the cursor's own book between calls changes nothing. An implementation that finds the
  cursor by position (\`ids.index(after) + 1\`) raises on exactly that deletion.
- **A total order.** Keyset needs a unique, stable sort key. Book ids are unique; a list sorted by
  \`created_at\` is not, and two books with the same timestamp on a page boundary would lose one. The fix is
  a composite key, \`(created_at, id)\`, compared as a tuple.
- **Look one past the page.** Whether a next page exists is "is there anything after the last book on
  this page", not "did the page come out full". With 100 books and \`page_size\` 50 the second page is
  full and also the last: a token on it leads to an empty third page.
- **Read the store as it is now.** Each page is computed from \`SHELVES\` at the moment of the call. A book
  added ahead of the cursor is listed when the walk reaches it; one added behind is not, and was not
  there when that part of the shelf was read. What keyset guarantees is the property clients can rely
  on: a book present for the whole walk is listed exactly once.

| Walk of 120 books | \`page_size\` | Pages | Last token |
| --- | --- | --- | --- |
| default size | 0 (→ 50) | 50, 50, 20 | \`""\` on the third |
| exact multiple | 50 of 100 books | 50, 50 | \`""\` on the second |
| clamped | 500 (→ 100) | 100, 20 | \`""\` on the second |
| empty shelf | any | one empty page | \`""\` on the first |

:::details What keyset gives up
Keyset cannot jump to page 40: the only way to reach it is to walk there, because page 40's key is
known only from page 39. Interfaces that need "page 40 of 312" either keep an offset for shallow pages
and accept the drift, or show "next" and "previous" only, as most infinite-scroll feeds do. Going
backwards is the same query with \`<\` and \`ORDER BY id DESC\`, then reversed. AIP-158's optional
\`skip\` field exists for clients that genuinely need to jump.
:::

:::quiz
Q: A shelf has exactly 100 books and the client asks for page_size 50. The server sets next_page_token whenever a page comes out full. What happens?
- [ ] Nothing wrong: the second page is full, so a token there is correct
- [x] The client makes a third call that returns an empty page, because the full second page carried a token
- [ ] The server rejects the second call with OUT_OF_RANGE
> A full page says nothing about what lies after it. Look past the page (fetch size + 1, or count what remains) and only then decide whether a token is owed.
:::

# Why the token is opaque

The client's whole relationship with a page token is: store it, send it back. It never parses one,
never builds one, and never compares two. That lets the server put anything inside and change it later:

| What goes in | Why |
| --- | --- |
| the last key returned | where to continue |
| the collection (the shelf) | a token cannot be replayed against another collection |
| every other request parameter (\`filter\`, \`order_by\`) | AIP-158: other fields must match the call that issued the token, or \`INVALID_ARGUMENT\` |
| a format version | a deploy can change the encoding and still read yesterday's tokens |
| an expiry | tokens that point into server-side state can be dropped after a while |

[AIP-158](https://google.aip.dev/158) makes opacity a **must**, with the reason in one line: if users
can deconstruct a token, they will, and then the token's layout is part of the API forever. It also
warns that **base64 of a readable structure is not enough**. The drill's token, base64url of JSON, is
opaque by contract only: anyone can decode it, and the server must treat it as untrusted input.

That is why decoding is total. A token can be:

- not base64 at all (\`%%%\`), base64 of text that is not JSON, or JSON that is not an object
  (\`[1, 2]\`, \`42\`, \`"b-0010"\`), or an object without the fields;
- a perfectly good token for another shelf.

Every one of those is the client's mistake: \`INVALID_ARGUMENT\`. An unhandled exception in the
handler surfaces as \`UNKNOWN\`, which tells the client the server broke, invites a retry, and pages
someone.

:::details Signed and encrypted tokens
A signed token (an HMAC over the payload, checked with a constant-time compare before anything else
is read) stops clients from forging positions: editing \`after\` to skip ahead or to probe for ids. An
encrypted token (AES-GCM, which also authenticates) hides the payload, so nobody can come to depend on
its fields. Google's own APIs serialize an internal proto message and encode that. Neither replaces
authorization: AIP-158 says a token only says where to continue, and every page is checked against the
caller as if there were no token.
:::

:::quiz
Q: The server encodes only the last id in the token. A client sends a token it got from shelf fiction with shelf history. What goes wrong?
- [ ] Nothing: the id is a valid position in any shelf
- [x] The server continues history from fiction's position, silently returning a page the client never asked for
- [ ] The server answers NOT_FOUND because the id belongs to another shelf
> A position is only meaningful in the collection it came from. Binding the shelf (and every other request parameter) into the token turns a silent wrong answer into an explicit INVALID_ARGUMENT.
:::

# AIP-158's rules, and what total_size costs

Google's API design rules turn pagination into a contract every list method shares, so client
libraries can wrap all of them in one iterator:

| Rule | In the drill |
| --- | --- |
| \`page_size\` is optional; 0 means a documented default, never an error | 0 → \`DEFAULT_PAGE_SIZE\` 50 |
| above the maximum, coerce down rather than fail | 500 → \`MAX_PAGE_SIZE\` 100 |
| a negative \`page_size\` **must** be \`INVALID_ARGUMENT\` | -1 → \`INVALID_ARGUMENT\` |
| the client may change \`page_size\` between pages and the server honours it | each call reads its own size |
| other fields must match the call that issued the token | the shelf is checked against the token |
| an empty \`next_page_token\` is the **only** end-of-collection signal | \`""\` on the last page |
| tokens are opaque, URL-safe strings | base64url, no padding |
| the server may return fewer results than asked, even zero, if it cannot tell in time | not needed: the drill always knows |

The rule about fewer results matters to clients more than to servers: a short page does not mean the
end. A client that stops when \`len(books) < page_size\` breaks on the first server that returns a
partial page under load. Stop on the empty token, nothing else.

Kubernetes list calls (\`limit\` and \`continue\`, see
[API chunking](https://kubernetes.io/docs/reference/using-api/api-concepts/#retrieving-large-results-sets-in-chunks))
and [Stripe's cursors](https://docs.stripe.com/api/pagination) (\`starting_after\` an object id) follow
the same shape with different field names.

## What total_size costs

AIP-158 allows an optional \`int32 total_size\` and lets it be an estimate. The reason it is optional is
the price:

- **An exact count is a full scan.** Keyset reads \`size + 1\` rows from an index; \`COUNT(*)\` with the same
  filter reads all of them, on every page, so the count costs more than the page.
- **It is wrong by the next call.** The count is a snapshot of a list that is changing, which is the
  very reason the drill uses keyset. "Page 3 of 7" against a moving list is a promise nobody keeps.
- **It leaks.** A count is information; for filtered or permission-scoped lists it can say how many rows
  exist that the caller cannot see.

The common answers: leave it out, return an estimate from table statistics and say so, or compute it
only on the first page and cache it with the walk.

:::quiz
Q: A client loops ListBooks until a page holds fewer than page_size books. Which server behaviour, allowed by AIP-158, breaks it?
- [ ] Clamping page_size 500 down to 100
- [x] Returning a short page that is not the last one, because the server could not fill it in time
- [ ] Returning next_page_token "" on the last page
> AIP-158 lets a server return fewer results than requested, even zero, without being at the end. The empty token is the only end-of-collection signal, so the loop must stop on that and nothing else.
:::

# What to take away

- An offset is a position in a list that no longer exists by the next call: deletes behind the cursor
  skip books, inserts repeat them. A key (\`id > after\`) means the same thing whatever moved.
- Compare strictly and never look the cursor up: the book the token points at may be gone.
- Decide on the next token by looking past the page, so the last page carries \`""\` even when the
  books divide evenly into pages.
- The token is untrusted input bound to the request that issued it: decode totally, reject a token for
  another shelf, and answer \`INVALID_ARGUMENT\`, never \`UNKNOWN\`.
- Opaque by contract is the floor; real tokens are versioned, signed or encrypted, and never grant
  access. \`total_size\` is optional because it costs a scan and is stale on arrival.

Primary reference: [AIP-158: Pagination](https://google.aip.dev/158).
`;

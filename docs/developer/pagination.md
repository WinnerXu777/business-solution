# Cursor pagination

The platform audit endpoint returns `{ items, nextCursor }`. Pass the cursor through verbatim and preserve the original filters between requests. A null cursor marks the last page.

```ts
for await (const entry of client.platform.auditEntries({ tool: 'order.read' })) {
  console.log(entry.id, entry.state);
}
```

`auditPages` yields the response pages so a worker can checkpoint the next cursor after committing a page. Resume with the same filter object and the saved `cursor`. Breaking the loop prevents another page from fetching.

```ts
for await (const page of client.platform.auditPages({ tool: 'order.read', cursor: savedCursor })) {
  await commitPage(page.items, page.nextCursor);
}
```

Use the exported `paginate` and `paginatePages` helpers for other endpoints with the same shape. Both stop at a null or missing cursor and raise `repeated_cursor` if a server repeats a cursor.

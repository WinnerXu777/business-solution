import { ApiError } from './errors.ts';

export type CursorPage<Item> = { items: readonly Item[]; nextCursor?: string | null };

export async function* paginatePages<Item>(
  load: (cursor?: string) => Promise<CursorPage<Item>>,
  startCursor?: string,
): AsyncGenerator<CursorPage<Item>> {
  let cursor = startCursor;
  const seen = new Set<string>();
  for (;;) {
    if (cursor !== undefined) {
      if (seen.has(cursor)) throw new ApiError('repeated_cursor');
      seen.add(cursor);
    }
    const page = await load(cursor);
    yield page;
    if (page.nextCursor == null) return;
    cursor = page.nextCursor;
  }
}

export async function* paginate<Item>(
  load: (cursor?: string) => Promise<CursorPage<Item>>,
  startCursor?: string,
): AsyncGenerator<Item> {
  for await (const page of paginatePages(load, startCursor)) yield* page.items;
}

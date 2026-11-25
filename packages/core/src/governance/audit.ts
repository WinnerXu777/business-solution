import { digest } from './results.ts';

/** Compare the terminal hash with a trusted copy to detect a rewritten or truncated export. */
export function verifyAuditExport(jsonl: string, expectedHead?: string | null) {
  const lines = jsonl === '' ? [] : jsonl.replace(/\n$/, '').split('\n');
  let head: string | null = null;
  try {
    for (const line of lines) {
      const { hash, ...entry } = JSON.parse(line);
      if (typeof hash !== 'string' || entry.previousHash !== head || digest(entry) !== hash)
        return { valid: false, head };
      head = hash;
    }
  } catch {
    return { valid: false, head };
  }
  return { valid: expectedHead === undefined || expectedHead === head, head };
}

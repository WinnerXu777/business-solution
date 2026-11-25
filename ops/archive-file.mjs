import { chmod, link, mkdtemp, rmdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Publish only a complete archive and refuse to replace an existing destination. */
export async function publishArchive(file, write) {
  const temporary = await mkdtemp(join(dirname(file), '.rivetquay-backup-'));
  const archive = join(temporary, 'archive');
  try {
    await write(archive);
    await chmod(archive, 0o600);
    await link(archive, file);
  } finally {
    await unlink(archive).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await rmdir(temporary);
  }
}

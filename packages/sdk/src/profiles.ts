import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isObject } from './errors.ts';

export type CredentialReference = { kind: 'api-key' | 'bearer'; env: string };
export type Profile = { tenant: string; baseUrl: string; credential: CredentialReference };
export type Profiles = { active?: string; profiles: Record<string, Profile> };
export type ProfileStore = {
  load: () => Promise<Profiles>;
  save: (config: Profiles) => Promise<void>;
};

export const validProfileName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
export const validEnvName = (name: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);

function isProfile(value: unknown): value is Profile {
  return (
    isObject(value) &&
    typeof value.tenant === 'string' &&
    typeof value.baseUrl === 'string' &&
    isObject(value.credential) &&
    ['api-key', 'bearer'].includes(String(value.credential.kind)) &&
    typeof value.credential.env === 'string' &&
    validEnvName(value.credential.env)
  );
}

export function fileProfiles(env: NodeJS.ProcessEnv): ProfileStore {
  const path = env.BS_CONFIG_FILE || join(homedir(), '.config', 'bs', 'profiles.json');
  return {
    async load() {
      const contents = await readFile(path, 'utf8').catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (contents === undefined) return { profiles: {} };
      const config: unknown = JSON.parse(contents);
      if (
        !isObject(config) ||
        !isObject(config.profiles) ||
        !Object.entries(config.profiles).every(
          ([name, profile]) => validProfileName(name) && isProfile(profile),
        ) ||
        (config.active !== undefined &&
          (typeof config.active !== 'string' || !Object.hasOwn(config.profiles, config.active)))
      ) {
        throw new Error('Invalid bs profile file');
      }
      return config as Profiles;
    },
    async save(config) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = path + '.' + randomUUID() + '.tmp';
      await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', {
        mode: 0o600,
        flag: 'wx',
      });
      try {
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}

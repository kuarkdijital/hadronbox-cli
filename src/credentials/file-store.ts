import { cliError } from '../errors/cli-error';
import type { Localized } from '../i18n';
import { isRecord } from '../json';
import path from 'node:path';
import { ensurePrivateDir, readPrivateFile, removeIfExists, writePrivateFile } from '../config/secure-file';

interface CredentialsFile {
  version: 1;
  profiles: Record<string, { apiKey: string }>;
}

/**
 * Fallback credential store: `<config dir>/credentials.json`, mode 0600 inside a 0700 directory, atomic writes,
 * ownership/symlink checks on every read (config/secure-file.ts).
 * Used when no OS keychain is reachable (headless Linux, containers, Windows) or when
 * `HADRONBOX_CREDENTIAL_STORE=file`.
 */
export class FileCredentialStore {
  constructor(
    private readonly file: string,
    private readonly onWarning: (message: Localized) => void = () => undefined,
  ) {}

  private async read(): Promise<CredentialsFile> {
    if (!(await ensurePrivateDir(path.dirname(this.file), this.onWarning))) return { version: 1, profiles: {} };
    const raw = await readPrivateFile(this.file, 'secret', this.onWarning);
    if (raw === null) return { version: 1, profiles: {} };
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      throw cliError('CONFIG_INVALID', { path: this.file }, { cause: error });
    }
    if (!isRecord(data) || data.version !== 1 || !isRecord(data.profiles)) {
      throw cliError('CONFIG_INVALID', { path: this.file });
    }
    const profiles: Record<string, { apiKey: string }> = {};
    for (const [name, entry] of Object.entries(data.profiles)) {
      if (!isRecord(entry) || typeof entry.apiKey !== 'string') {
        throw cliError('CONFIG_INVALID', { path: this.file });
      }
      profiles[name] = { apiKey: entry.apiKey };
    }
    return { version: 1, profiles };
  }

  async get(profile: string): Promise<string | null> {
    const data = await this.read();
    return data.profiles[profile]?.apiKey ?? null;
  }

  async set(profile: string, apiKey: string): Promise<void> {
    const data = await this.read();
    data.profiles[profile] = { apiKey };
    await writePrivateFile(this.file, `${JSON.stringify(data, null, 2)}\n`, this.onWarning);
  }

  async delete(profile: string): Promise<boolean> {
    const data = await this.read();
    if (data.profiles[profile] === undefined) return false;
    delete data.profiles[profile];
    if (Object.keys(data.profiles).length === 0) {
      await removeIfExists(this.file);
    } else {
      await writePrivateFile(this.file, `${JSON.stringify(data, null, 2)}\n`, this.onWarning);
    }
    return true;
  }
}

import { cliError } from '../errors/cli-error';
import type { Env } from '../config/paths';
import type { Localized } from '../i18n';
import { FileCredentialStore } from './file-store';
import { KeychainUnavailableError, platformKeychain, type Keychain } from './keychain';
import { spawnRunner, type CommandRunner } from './runner';
import { API_KEY_PATTERN, type CredentialBackend, type CredentialStore, type StoredCredential } from './types';

export const STORE_MODES = ['auto', 'keychain', 'file'] as const;
export type StoreMode = (typeof STORE_MODES)[number];

/** `HADRONBOX_CREDENTIAL_STORE` = auto (default) | keychain | file. */
export function resolveStoreMode(env: Env): StoreMode {
  const raw = env.HADRONBOX_CREDENTIAL_STORE;
  if (raw === undefined || raw === '') return 'auto';
  const mode = STORE_MODES.find((m) => m === raw);
  if (mode === undefined) {
    throw cliError('INVALID_ENV_VALUE', {
      name: 'HADRONBOX_CREDENTIAL_STORE',
      value: raw,
      allowed: STORE_MODES.join(', '),
    });
  }
  return mode;
}

function storeFailure(backend: CredentialBackend, cause: unknown) {
  return cliError('CREDENTIAL_STORE_ERROR', { store: backend }, { cause });
}

/**
 * Keychain first, 0600 file as fallback:
 * - `auto`: use the OS keychain when it works; if it is missing or fails, read/write the file instead
 *   (a key is kept in exactly one place: a successful keychain write removes the file entry and vice versa).
 * - `keychain`: keychain only; failures are CREDENTIAL_STORE_ERROR (exit 1).
 * - `file`: file only (CI runners, containers, users who prefer it).
 */
export class LayeredCredentialStore implements CredentialStore {
  readonly preferred: CredentialBackend;

  private fallbackWarned = false;

  constructor(
    private readonly mode: StoreMode,
    private readonly keychain: Keychain | null,
    private readonly file: FileCredentialStore,
    private readonly onWarning: (message: Localized) => void = () => undefined,
    private readonly fileLabel = 'credentials.json',
  ) {
    this.preferred = mode !== 'file' && keychain !== null ? keychain.backend : 'file';
    if (mode === 'keychain' && keychain === null) {
      throw cliError('CREDENTIAL_STORE_ERROR', { store: 'keychain' });
    }
  }

  private useKeychain(): Keychain | null {
    return this.mode === 'file' ? null : this.keychain;
  }

  async get(profile: string): Promise<StoredCredential | null> {
    const keychain = this.useKeychain();
    if (keychain !== null) {
      try {
        const value = await keychain.get(profile);
        if (value !== null) return { apiKey: value, backend: keychain.backend };
      } catch (error) {
        if (this.mode === 'keychain' || !(error instanceof KeychainUnavailableError)) {
          throw storeFailure(keychain.backend, error);
        }
      }
      if (this.mode === 'keychain') return null;
    }
    const value = await this.file.get(profile);
    return value === null ? null : { apiKey: value, backend: 'file' };
  }

  async set(profile: string, apiKey: string): Promise<CredentialBackend> {
    if (!API_KEY_PATTERN.test(apiKey)) throw cliError('INVALID_API_KEY');
    const keychain = this.useKeychain();
    if (keychain !== null) {
      let stored = false;
      try {
        await keychain.set(profile, apiKey);
        stored = true;
      } catch (error) {
        if (this.mode === 'keychain' || !(error instanceof KeychainUnavailableError)) {
          throw storeFailure(keychain.backend, error);
        }
      }
      if (stored) {
        await this.removeStaleFileEntry(profile);
        return keychain.backend;
      }
    }
    await this.file.set(profile, apiKey);
    if (this.mode === 'auto') this.warnFallback();
    return 'file';
  }

  /** The key is in the keychain now; a leftover file entry is only cleanup, so failing it is a warning. */
  private async removeStaleFileEntry(profile: string): Promise<void> {
    try {
      await this.file.delete(profile);
    } catch {
      this.onWarning({
        tr: `Anahtar anahtar zincirine kaydedildi ama ${this.fileLabel} içindeki eski kayıt silinemedi; dosyayı elle kontrol et.`,
        en: `The key was saved to the keychain but the old entry in ${this.fileLabel} could not be removed; check the file.`,
      });
    }
  }

  /** Falling back to the 0600 file is announced once. */
  private warnFallback(): void {
    if (this.fallbackWarned) return;
    this.fallbackWarned = true;
    this.onWarning({
      tr: `İşletim sistemi anahtar zinciri kullanılamadı; anahtar ${this.fileLabel} dosyasına (0600) yazıldı.`,
      en: `The OS keychain is not available; the key was written to ${this.fileLabel} (0600).`,
    });
  }

  async delete(profile: string): Promise<boolean> {
    let removed = false;
    const keychain = this.useKeychain();
    if (keychain !== null) {
      try {
        removed = (await keychain.delete(profile)) || removed;
      } catch (error) {
        if (this.mode === 'keychain' || !(error instanceof KeychainUnavailableError)) {
          throw storeFailure(keychain.backend, error);
        }
      }
    }
    if (this.mode !== 'keychain') {
      removed = (await this.file.delete(profile)) || removed;
    }
    return removed;
  }
}

export interface CredentialStoreOptions {
  readonly platform: NodeJS.Platform;
  readonly env: Env;
  readonly credentialsFile: string;
  readonly runner?: CommandRunner;
  readonly onWarning?: (message: Localized) => void;
  /** Executable check for the keychain tool lookup (tests). */
  readonly canExecute?: (file: string) => boolean;
}

export function createCredentialStore(options: CredentialStoreOptions): CredentialStore {
  const mode = resolveStoreMode(options.env);
  const keychain = platformKeychain(options.platform, options.runner ?? spawnRunner, options.canExecute);
  return new LayeredCredentialStore(
    mode,
    keychain,
    new FileCredentialStore(options.credentialsFile, options.onWarning),
    options.onWarning,
    options.credentialsFile,
  );
}

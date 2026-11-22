export type CredentialBackend = 'macos-keychain' | 'libsecret' | 'file';

export interface StoredCredential {
  readonly apiKey: string;
  readonly backend: CredentialBackend;
}

export interface CredentialStore {
  /** The backend `set` writes to first (for messages like "anahtar macOS Anahtar Zinciri'ne kaydedildi"). */
  readonly preferred: CredentialBackend;
  get(profile: string): Promise<StoredCredential | null>;
  /** Stores the key and returns where it went. */
  set(profile: string, apiKey: string): Promise<CredentialBackend>;
  /** Removes the key from every backend; true if anything was removed. */
  delete(profile: string): Promise<boolean>;
}

/** `hb_live_` + 48 lowercase hex (panel API key format). */
export const API_KEY_PATTERN = /^hb_live_[0-9a-f]{48}$/;

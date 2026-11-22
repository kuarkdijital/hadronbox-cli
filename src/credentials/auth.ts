import { cliError } from '../errors/cli-error';
import { apiOrigin, DEFAULT_API_URL } from '../config/config';
import type { Env } from '../config/paths';
import { API_KEY_PATTERN, type CredentialBackend, type CredentialStore } from './types';

export interface ResolvedAuth {
  readonly apiKey: string;
  readonly source: 'env' | CredentialBackend;
}

/**
 * Lookup order: `HADRONBOX_API_KEY` first (CI, agents), then the stored credential of the profile (keychain or
 * 0600 file, written by `hb login`). The format is checked locally so a typo fails fast with exit 3 and is never
 * sent anywhere. With a `binding`, a stored key whose verified origin differs from the target is refused
 * (CREDENTIAL_ORIGIN_MISMATCH, exit 3) before anything is sent.
 */
export interface CredentialBinding {
  /** Resolved API base URL the request is about to go to. */
  readonly apiUrl: string;
  /** Origin the stored key was verified against (config `credentialOrigin`); undefined = the default API. */
  readonly credentialOrigin?: string;
}

export async function resolveApiKey(
  env: Env,
  store: CredentialStore,
  profile: string,
  binding?: CredentialBinding,
): Promise<ResolvedAuth> {
  const fromEnv = env.HADRONBOX_API_KEY?.trim();
  if (fromEnv !== undefined && fromEnv !== '') {
    if (!API_KEY_PATTERN.test(fromEnv)) throw cliError('INVALID_API_KEY');
    return { apiKey: fromEnv, source: 'env' };
  }
  const stored = await store.get(profile);
  if (stored === null) throw cliError('AUTH_REQUIRED');
  if (!API_KEY_PATTERN.test(stored.apiKey)) throw cliError('INVALID_API_KEY');
  if (binding !== undefined) {
    // A stored key goes only to the origin it was verified against (an env key is the caller's choice).
    const saved = binding.credentialOrigin ?? apiOrigin(DEFAULT_API_URL);
    const current = apiOrigin(binding.apiUrl);
    if (saved !== current) throw cliError('CREDENTIAL_ORIGIN_MISMATCH', { saved, current });
  }
  return { apiKey: stored.apiKey, source: stored.backend };
}

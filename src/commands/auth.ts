import { booleanValue } from '../args/parse';
import { parseMe, type Me } from '../api/me';
import { parseQuota, parseMachine, type Quota } from '../api/machines';
import {
  apiOrigin,
  DEFAULT_API_URL,
  normalizeApiUrl,
  writeConfigFile,
  type ConfigFile,
  type ProfileSettings,
} from '../config/config';
import { API_KEY_PATTERN, type CredentialBackend } from '../credentials/types';
import { CliError, cliError } from '../errors/cli-error';
import { ExitCode } from '../errors/exit-codes';
import { renderFields } from '../format';
import type { ApiClient } from '../http/client';
import type { Lang, Localized } from '../i18n';
import type { JsonObject } from '../json';
import type { CommandContext, CommandSpec } from './types';

const API_KEYS_PAGE = 'https://hadronbox.tr/panel/api-anahtarlari';

const BACKEND_LABELS: Readonly<Record<CredentialBackend | 'env', { tr: string; en: string }>> = {
  'macos-keychain': { tr: 'macOS Anahtar Zinciri', en: 'macOS Keychain' },
  libsecret: { tr: 'Secret Service (libsecret)', en: 'Secret Service (libsecret)' },
  file: { tr: '0600 izinli dosya', en: 'file (0600)' },
  env: { tr: 'HADRONBOX_API_KEY ortam değişkeni', en: 'HADRONBOX_API_KEY environment variable' },
};

type KeySource = 'stdin' | 'prompt' | 'env';

/**
 * Where `hb login` takes the key from (never argv):
 * 1. `--with-api-key`: stdin (`hb login --with-api-key < key.txt`); on a TTY a hidden prompt,
 * 2. `HADRONBOX_API_KEY` if set: verified only, never stored (gh pattern),
 * 3. a hidden prompt when interactive,
 * 4. otherwise MISSING_API_KEY (exit 2). Without the flag stdin is never read, so an inherited open pipe cannot
 *    make login hang.
 */
async function readKey(ctx: CommandContext): Promise<{ key: string; source: KeySource }> {
  const prompt = async () => {
    ctx.out.info(
      ctx.lang === 'tr'
        ? `API anahtarını panelden oluşturabilirsin: ${API_KEYS_PAGE}`
        : `You can create an API key in the panel: ${API_KEYS_PAGE}`,
    );
    return {
      key: await ctx.prompt.secret(ctx.lang === 'tr' ? 'API anahtarı:' : 'API key:'),
      source: 'prompt' as const,
    };
  };

  if (booleanValue(ctx.args.values, 'with-api-key')) {
    if (!ctx.stdinIsTTY) return { key: await ctx.readStdin(), source: 'stdin' };
    if (ctx.interactive) return prompt();
    throw cliError('MISSING_API_KEY');
  }
  const env = ctx.env.HADRONBOX_API_KEY?.trim();
  if (env !== undefined && env !== '') return { key: env, source: 'env' };
  if (ctx.interactive) return prompt();
  throw cliError('MISSING_API_KEY');
}

/** GET /me with the given key; 401/403 keep their mapped codes (INVALID_API_KEY, EMAIL_NOT_VERIFIED, …, exit 3). */
async function fetchMe(api: ApiClient): Promise<Me> {
  return api.get('/me', parseMe);
}

/** Machine quota for whoami (`quota` of GET /sandboxes); null if the list cannot be read. */
async function fetchQuota(api: ApiClient): Promise<Quota | null> {
  try {
    const page = await api.requestPage('/sandboxes', parseMachine, { query: { limit: 1 } });
    return page.extra.quota === undefined ? null : parseQuota(page.extra.quota);
  } catch (error) {
    if (error instanceof CliError && error.exitCode === ExitCode.AUTH) throw error;
    return null;
  }
}

function orgText(me: Me, lang: Lang): string {
  const personal = me.organizationIsPersonal ? (lang === 'tr' ? ' (kişisel)' : ' (personal)') : '';
  return `${me.organizationName}${personal} · ${me.role}`;
}

function meJson(me: Me): JsonObject {
  return {
    email: me.email,
    name: me.userName,
    organization: { name: me.organizationName, isPersonal: me.organizationIsPersonal, role: me.role },
    plan: { name: me.planName, tier: me.planTier },
    auth: { type: me.authType, apiKeyName: me.apiKeyName },
  };
}

const loginCommand: CommandSpec = {
  name: 'login',
  summary: {
    tr: 'API anahtarıyla giriş yapar (anahtar gizli istemden veya --with-api-key ile stdin’den)',
    en: 'Log in with an API key (from a hidden prompt or stdin with --with-api-key)',
  },
  usage: 'login [--with-api-key]',
  examples: [
    'hb login',
    'hb login --with-api-key < anahtar.txt',
    'echo "$HB_KEY" | hb login --with-api-key --profile ci',
  ],
  maxPositionals: 0,
  options: {
    'with-api-key': {
      type: 'boolean',
      description: { tr: 'Anahtarı stdin’den oku', en: 'Read the key from stdin' },
    },
  },
  async run(ctx) {
    const { key: rawKey, source } = await readKey(ctx);
    const key = rawKey.trim();
    if (key === '') throw cliError('MISSING_API_KEY');
    if (!API_KEY_PATTERN.test(key)) throw cliError('INVALID_API_KEY');

    const config = await ctx.services.config();
    const api = await ctx.services.api({ apiKey: key });
    const me = await fetchMe(api);
    const tr = ctx.lang === 'tr';
    const warn = (message: Localized) => ctx.out.warn(message[ctx.lang]);
    const baseJson = { ...meJson(me), profile: config.profile, apiUrl: config.apiUrl };

    if (source === 'env') {
      // An environment key is verified, never written to disk or the keychain.
      warn({
        tr: 'HADRONBOX_API_KEY ile yetkilisin; anahtar kaydedilmedi. Kaydetmek için değişkeni kaldırıp "hb login --with-api-key" kullan.',
        en: 'You are authorized through HADRONBOX_API_KEY; the key was not stored. To store a key, unset the variable and use "hb login --with-api-key".',
      });
      const human = [
        tr ? `Yetkili (HADRONBOX_API_KEY): ${me.email}` : `Authorized (HADRONBOX_API_KEY): ${me.email}`,
        renderFields([
          [tr ? 'Organizasyon' : 'Organization', orgText(me, ctx.lang)],
          [tr ? 'Plan' : 'Plan', me.planName],
          [tr ? 'Adres' : 'Address', config.apiUrl],
        ]),
      ].join('\n');
      ctx.out.result(human, { ...baseJson, stored: false, credentialSource: 'env' });
      return;
    }

    // Login never changes where the profile points to on its own. An environment URL that differs from the
    // profile's address is announced; it becomes the profile address only after an explicit yes on a terminal.
    const profileSettings = config.file.profiles[config.profile] ?? {};
    const profileUrl = profileSettings.apiUrl === undefined ? DEFAULT_API_URL : normalizeApiUrl(profileSettings.apiUrl);
    let persistUrl = false;
    if (config.apiUrlSource === 'env' && config.apiUrl !== profileUrl) {
      warn({
        tr: `HADRONBOX_API_URL (${config.apiUrl}) bu profilin adresinden (${profileUrl}) farklı. Anahtar yalnız ${apiOrigin(config.apiUrl)} için kaydedilecek; değişken olmadan bu profil anahtarı göndermez.`,
        en: `HADRONBOX_API_URL (${config.apiUrl}) differs from this profile's address (${profileUrl}). The key is stored for ${apiOrigin(config.apiUrl)} only; without the variable this profile will not send it.`,
      });
      if (ctx.interactive) {
        persistUrl = await ctx.prompt.confirm(
          tr
            ? `"${config.profile}" profili bundan sonra ${config.apiUrl} adresini kullansın mı?`
            : `Should profile "${config.profile}" use ${config.apiUrl} from now on?`,
          ctx.lang,
        );
      }
    }

    const store = await ctx.services.credentials();
    const previous = await store.get(config.profile);
    const backend = await store.set(config.profile, key);

    const nextSettings: ProfileSettings = {
      ...profileSettings,
      ...(persistUrl ? { apiUrl: config.apiUrl } : {}),
      credentialOrigin: apiOrigin(config.apiUrl),
    };
    const next: ConfigFile = {
      version: 1,
      activeProfile: config.profile,
      profiles: { ...config.file.profiles, [config.profile]: nextSettings },
    };
    try {
      await writeConfigFile(config.paths.configFile, next, warn);
    } catch (error) {
      // Keep login all-or-nothing: without the profile entry the stored key would be unbound.
      try {
        if (previous === null) await store.delete(config.profile);
        else await store.set(config.profile, previous.apiKey);
      } catch {
        warn({
          tr: 'Profil güncellenemedi ve kaydedilen anahtar geri alınamadı; "hb logout" çalıştır.',
          en: 'The profile could not be updated and the stored key could not be rolled back; run "hb logout".',
        });
      }
      throw error;
    }

    const effectiveUrl = persistUrl ? config.apiUrl : config.apiUrlSource === 'env' ? profileUrl : config.apiUrl;
    const human = [
      tr ? `Giriş yapıldı: ${me.email}` : `Logged in: ${me.email}`,
      renderFields([
        [tr ? 'Organizasyon' : 'Organization', orgText(me, ctx.lang)],
        [tr ? 'Plan' : 'Plan', me.planName],
        [tr ? 'Profil' : 'Profile', `${config.profile} · ${effectiveUrl}`],
        [tr ? 'Anahtar adresi' : 'Key bound to', apiOrigin(config.apiUrl)],
        [tr ? 'Anahtar saklama' : 'Key stored in', BACKEND_LABELS[backend][ctx.lang]],
      ]),
    ].join('\n');
    ctx.out.result(human, {
      ...baseJson,
      stored: true,
      credentialStore: backend,
      credentialOrigin: apiOrigin(config.apiUrl),
      profileApiUrl: effectiveUrl,
    });
  },
};

const logoutCommand: CommandSpec = {
  name: 'logout',
  summary: { tr: 'Bu profilin kayıtlı anahtarını siler', en: 'Remove the stored key of this profile' },
  usage: 'logout',
  examples: ['hb logout', 'hb logout --profile ci'],
  maxPositionals: 0,
  async run(ctx) {
    const config = await ctx.services.config();
    const store = await ctx.services.credentials();
    const removed = await store.delete(config.profile);
    const tr = ctx.lang === 'tr';
    const envSet = (ctx.env.HADRONBOX_API_KEY ?? '').trim() !== '';
    if (envSet && !ctx.out.json) {
      ctx.out.warn(
        tr
          ? 'HADRONBOX_API_KEY hâlâ tanımlı; komutlar bu anahtarla çalışmaya devam eder.'
          : 'HADRONBOX_API_KEY is still set; commands keep using that key.',
      );
    }
    const human = removed
      ? tr
        ? `Çıkış yapıldı (profil: ${config.profile}).`
        : `Logged out (profile: ${config.profile}).`
      : tr
        ? `Bu profilde kayıtlı giriş yok (profil: ${config.profile}).`
        : `No stored login for this profile (profile: ${config.profile}).`;
    if (removed && !ctx.out.json) {
      ctx.out.info(
        tr
          ? `Anahtar sunucuda geçerli kalır; iptal etmek için: ${API_KEYS_PAGE}`
          : `The key stays valid on the server; to revoke it: ${API_KEYS_PAGE}`,
      );
    }
    ctx.out.result(human, { profile: config.profile, removed });
  },
};

const whoamiCommand: CommandSpec = {
  name: 'whoami',
  summary: { tr: 'Kimin adına çalıştığını, planı ve kotayı gösterir', en: 'Show who you are, your plan and quota' },
  usage: 'whoami',
  examples: ['hb whoami', 'hb whoami --json'],
  maxPositionals: 0,
  async run(ctx) {
    const config = await ctx.services.config();
    const auth = await ctx.services.auth();
    const api = await ctx.services.api();
    const me = await fetchMe(api);
    const quota = await fetchQuota(api);
    const tr = ctx.lang === 'tr';
    const keyText =
      me.apiKeyName === null
        ? BACKEND_LABELS[auth.source][ctx.lang]
        : `"${me.apiKeyName}" · ${BACKEND_LABELS[auth.source][ctx.lang]}`;
    const human = [
      me.email,
      renderFields([
        [tr ? 'Organizasyon' : 'Organization', orgText(me, ctx.lang)],
        [tr ? 'Plan' : 'Plan', me.planName],
        [tr ? 'Makineler' : 'Machines', quota === null ? '-' : `${quota.used}/${quota.limit}`],
        [tr ? 'API anahtarı' : 'API key', keyText],
        [tr ? 'Profil' : 'Profile', `${config.profile} · ${config.apiUrl}`],
      ]),
    ].join('\n');
    ctx.out.result(human, {
      ...meJson(me),
      machines: quota === null ? null : { used: quota.used, limit: quota.limit },
      profile: config.profile,
      apiUrl: config.apiUrl,
      credentialSource: auth.source,
    });
  },
};

export const AUTH_COMMANDS: readonly CommandSpec[] = [loginCommand, logoutCommand, whoamiCommand];

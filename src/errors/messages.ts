import type { Localized } from '../i18n';
import { ExitCode, type ExitCodeValue } from './exit-codes';

export interface CliErrorSpec extends Localized {
  readonly exit: ExitCodeValue;
}

/**
 * Errors raised by the CLI itself. The key is the stable machine-readable code printed as `kod: <CODE>` and in
 * `--json` as `error.code`; never rename one. Turkish copy uses the "sen" form (product voice).
 */
export const CLI_ERRORS = {
  UNKNOWN_COMMAND: {
    exit: ExitCode.USAGE,
    tr: 'Bilinmeyen komut: {command}.{suggestion} Komutlar için: hb --help',
    en: 'Unknown command: {command}.{suggestion} See: hb --help',
  },
  MISSING_COMMAND: {
    exit: ExitCode.USAGE,
    tr: '"{command}" bir alt komut bekliyor. Alt komutlar için: hb {command} --help',
    en: '"{command}" needs a subcommand. See: hb {command} --help',
  },
  UNKNOWN_OPTION: {
    exit: ExitCode.USAGE,
    tr: 'Bilinmeyen seçenek: {option}.',
    en: 'Unknown option: {option}.',
  },
  MISSING_OPTION_VALUE: {
    exit: ExitCode.USAGE,
    tr: '{option} seçeneği bir değer bekliyor.',
    en: 'Option {option} needs a value.',
  },
  INVALID_OPTION_VALUE: {
    exit: ExitCode.USAGE,
    tr: '{option} için geçersiz değer: "{value}". Geçerli değerler: {allowed}.',
    en: 'Invalid value for {option}: "{value}". Allowed values: {allowed}.',
  },
  OPTION_TAKES_NO_VALUE: {
    exit: ExitCode.USAGE,
    tr: '{option} bir değer almaz.',
    en: '{option} does not take a value.',
  },
  INVALID_PATH_SEGMENT: {
    exit: ExitCode.USAGE,
    tr: 'Geçersiz ad: "{value}".',
    en: 'Invalid name: "{value}".',
  },
  MISSING_ARGUMENT: {
    exit: ExitCode.USAGE,
    tr: 'Eksik argüman: {name}.',
    en: 'Missing argument: {name}.',
  },
  UNEXPECTED_ARGUMENT: {
    exit: ExitCode.USAGE,
    tr: 'Beklenmeyen argüman: "{argument}".',
    en: 'Unexpected argument: "{argument}".',
  },
  API_KEY_IN_ARGV: {
    exit: ExitCode.USAGE,
    tr: 'API anahtarını komut satırında verme: kabuk geçmişine ve süreç listesine sızar. HADRONBOX_API_KEY ortam değişkenini kullan.',
    en: 'Do not pass the API key on the command line: it leaks into shell history and the process list. Use the HADRONBOX_API_KEY environment variable.',
  },
  MISSING_API_KEY: {
    exit: ExitCode.USAGE,
    tr: 'API anahtarı verilmedi. Anahtarı stdin ile ver (hb login --with-api-key < anahtar.txt) veya HADRONBOX_API_KEY tanımla. Anahtar oluştur: https://hadronbox.tr/panel/api-anahtarlari',
    en: 'No API key given. Pipe it on stdin (hb login --with-api-key < key.txt) or set HADRONBOX_API_KEY. Create a key: https://hadronbox.tr/panel/api-anahtarlari',
  },
  CONFIRMATION_REQUIRED: {
    exit: ExitCode.USAGE,
    tr: 'Bu işlem onay gerektiriyor; etkileşimsiz çalışırken --yes ekle.',
    en: 'This action needs confirmation; add --yes when running non-interactively.',
  },
  CONFLICTING_OPTIONS: {
    exit: ExitCode.USAGE,
    tr: '{first} ve {second} birlikte kullanılamaz.',
    en: '{first} and {second} cannot be used together.',
  },
  INVALID_MACHINE_NAME: {
    exit: ExitCode.USAGE,
    tr: 'Makine adı geçersiz: "{name}". Küçük harf, rakam ve "-" kullan; harf veya rakamla başlasın (2–40 karakter).',
    en: 'Invalid machine name: "{name}". Use lowercase letters, digits and "-", starting with a letter or digit (2–40 characters).',
  },
  AMBIGUOUS_MACHINE: {
    exit: ExitCode.USAGE,
    tr: '"{name}" adında birden çok makine var; kimlikle belirt: {ids}',
    en: 'More than one machine is named "{name}"; use its id: {ids}',
  },
  MACHINE_NOT_FOUND: {
    exit: ExitCode.NOT_FOUND,
    tr: 'Makine bulunamadı: {name}',
    en: 'Machine not found: {name}',
  },
  INVALID_ENV_VALUE: {
    exit: ExitCode.USAGE,
    tr: '{name} ortam değişkeni geçersiz: "{value}". Geçerli değerler: {allowed}.',
    en: 'Invalid {name} environment variable: "{value}". Allowed values: {allowed}.',
  },
  INVALID_API_URL: {
    exit: ExitCode.USAGE,
    tr: 'API adresi geçersiz: "{url}". https:// ile başlamalı (http:// yalnız localhost için).',
    en: 'Invalid API URL: "{url}". It must start with https:// (http:// only for localhost).',
  },
  INVALID_PROFILE: {
    exit: ExitCode.USAGE,
    tr: 'Profil adı geçersiz: "{profile}". Küçük harf, rakam, "-" ve "_" kullan (en çok 32 karakter).',
    en: 'Invalid profile name: "{profile}". Use lowercase letters, digits, "-" and "_" (max 32 characters).',
  },
  AUTH_REQUIRED: {
    exit: ExitCode.AUTH,
    tr: 'Giriş yapılmamış. HADRONBOX_API_KEY ortam değişkenini tanımla veya "hb login" çalıştır.',
    en: 'Not logged in. Set the HADRONBOX_API_KEY environment variable or run "hb login".',
  },
  CREDENTIAL_ORIGIN_MISMATCH: {
    exit: ExitCode.AUTH,
    tr: 'Kayıtlı anahtar {saved} için doğrulandı; {current} adresine gönderilmedi. O adres için "hb login" çalıştır ya da HADRONBOX_API_URL / profil adresini düzelt.',
    en: 'The stored key was verified for {saved}; it was not sent to {current}. Run "hb login" for that address or fix HADRONBOX_API_URL / the profile address.',
  },
  INVALID_API_KEY: {
    exit: ExitCode.AUTH,
    tr: 'API anahtarı geçersiz veya süresi dolmuş.',
    en: 'The API key is invalid or has expired.',
  },
  CONFIG_INVALID: {
    exit: ExitCode.GENERAL,
    tr: 'Yapılandırma dosyası okunamadı: {path}. Dosyayı düzelt veya sil.',
    en: 'Could not read the config file: {path}. Fix or delete it.',
  },
  INSECURE_PATH: {
    exit: ExitCode.GENERAL,
    tr: '{path} güvenli değil (başka kullanıcıya ait, sembolik bağ veya başkalarınca yazılabilir); kullanılmadı. Sahipliğini ve izinlerini düzelt (dizin 0700, dosya 0600).',
    en: '{path} is not safe (owned by another user, a symlink or writable by others); not used. Fix its owner and permissions (directory 0700, file 0600).',
  },
  CREDENTIAL_STORE_ERROR: {
    exit: ExitCode.GENERAL,
    tr: 'Kimlik bilgisi deposuna erişilemedi ({store}).',
    en: 'Could not access the credential store ({store}).',
  },
  NETWORK_ERROR: {
    exit: ExitCode.NETWORK,
    tr: 'Sunucuya bağlanılamadı ({host}). Ağ bağlantını kontrol et.',
    en: 'Could not connect to the server ({host}). Check your network connection.',
  },
  TIMEOUT: {
    exit: ExitCode.NETWORK,
    tr: 'İstek zaman aşımına uğradı ({seconds} sn).',
    en: 'The request timed out ({seconds} s).',
  },
  RATE_LIMITED: {
    exit: ExitCode.NETWORK,
    tr: 'Çok fazla istek gönderildi. {retryAfter} sn sonra tekrar dene.',
    en: 'Too many requests. Try again in {retryAfter} s.',
  },
  SERVICE_UNAVAILABLE: {
    exit: ExitCode.NETWORK,
    tr: 'Hizmet şu an kullanılamıyor. Biraz sonra tekrar dene.',
    en: 'The service is temporarily unavailable. Try again shortly.',
  },
  SERVER_ERROR: {
    exit: ExitCode.GENERAL,
    tr: 'Sunucu hatası (HTTP {status}). Sorun sürerse destekle iletişime geç.',
    en: 'Server error (HTTP {status}). Contact support if it persists.',
  },
  UNEXPECTED_RESPONSE: {
    exit: ExitCode.GENERAL,
    tr: 'Sunucudan beklenmeyen yanıt (HTTP {status}).',
    en: 'Unexpected response from the server (HTTP {status}).',
  },
  RESPONSE_TOO_LARGE: {
    exit: ExitCode.GENERAL,
    tr: 'Sunucu yanıtı çok büyük (en çok {limit} MB).',
    en: 'The server response is too large (max {limit} MB).',
  },
  HTTP_ERROR: {
    exit: ExitCode.GENERAL,
    tr: 'İstek başarısız oldu (HTTP {status}).',
    en: 'The request failed (HTTP {status}).',
  },
  CLI_UPGRADE_REQUIRED: {
    exit: ExitCode.CLI_UPGRADE,
    tr: 'Bu CLI sürümü artık desteklenmiyor. Güncelle: npx hadronbox@latest',
    en: 'This CLI version is no longer supported. Update: npx hadronbox@latest',
  },
  UNSUPPORTED_NODE: {
    exit: ExitCode.GENERAL,
    tr: 'hadronbox Node.js {required} veya üstünü gerektirir (şu an {current}).',
    en: 'hadronbox requires Node.js {required} or newer (current {current}).',
  },
  INTERRUPTED: {
    exit: ExitCode.INTERRUPTED,
    tr: 'İptal edildi.',
    en: 'Interrupted.',
  },
  INTERNAL: {
    exit: ExitCode.GENERAL,
    tr: 'Beklenmeyen bir hata oluştu. Ayrıntı için --debug ile tekrar çalıştır.',
    en: 'An unexpected error occurred. Run again with --debug for details.',
  },
} as const satisfies Record<string, CliErrorSpec>;

export type CliErrorCode = keyof typeof CLI_ERRORS;

/**
 * CLI copy for panel API error codes. The exit code is derived from the code and the HTTP status
 * (api-error-map.ts), not stored here. Codes missing from this table fall back to the server message.
 */
export const API_ERROR_MESSAGES: Readonly<Record<string, Localized>> = {
  VALIDATION: { tr: 'İstek doğrulanamadı: {detail}', en: 'Request validation failed: {detail}' },
  INVALID_API_KEY: CLI_ERRORS.INVALID_API_KEY,
  SESSION_REQUIRED: {
    tr: 'Bu işlem API anahtarıyla yapılamaz; hadronbox.tr panelinden yap.',
    en: 'This action is not available with an API key; use the hadronbox.tr panel.',
  },
  SESSION_INVALID: CLI_ERRORS.INVALID_API_KEY,
  TOKEN_INVALID: CLI_ERRORS.INVALID_API_KEY,
  EMAIL_NOT_VERIFIED: {
    tr: 'E-posta adresin doğrulanmamış. hadronbox.tr üzerinden doğruladıktan sonra tekrar dene.',
    en: 'Your email address is not verified. Verify it on hadronbox.tr and try again.',
  },
  NOT_A_MEMBER: {
    tr: 'Bu organizasyonun üyesi değilsin.',
    en: 'You are not a member of this organization.',
  },
  FORBIDDEN_ROLE: {
    tr: 'Bu işlem için rolün yetmiyor.',
    en: 'Your role does not allow this action.',
  },
  PLAN_UPGRADE_REQUIRED: {
    tr: 'Bu özellik planında yok. Pro’ya yükselt: https://hadronbox.tr/panel/planlar',
    en: 'This feature is not in your plan. Upgrade to Pro: https://hadronbox.tr/panel/planlar',
  },
  PLAN_LIMIT_MACHINES: {
    tr: 'Makine kotan doldu. Daha fazlası için Pro’ya yükselt.',
    en: 'You have reached your machine limit. Upgrade to Pro for more.',
  },
  PLAN_LIMIT_SNAPSHOTS: {
    tr: 'Snapshot kotan doldu. Eskilerini sil veya Pro’ya yükselt.',
    en: 'You have reached your snapshot limit. Delete old ones or upgrade to Pro.',
  },
  PLAN_LIMIT_API_KEYS: {
    tr: 'API anahtarı sınırına ulaştın. Kullanmadıklarını panelden sil.',
    en: 'You have reached the API key limit. Delete unused keys in the panel.',
  },
  PLAN_LIMIT_SECRETS: {
    tr: 'Secret kotan doldu.',
    en: 'You have reached your secret limit.',
  },
  PLAN_LIMIT_WEBHOOKS: {
    tr: 'Webhook kotan doldu.',
    en: 'You have reached your webhook limit.',
  },
  SANDBOX_NOT_FOUND: { tr: 'Makine bulunamadı.', en: 'Machine not found.' },
  UNKNOWN_SANDBOX: { tr: 'Makine bulunamadı.', en: 'Machine not found.' },
  SNAPSHOT_NOT_FOUND: { tr: 'Snapshot bulunamadı.', en: 'Snapshot not found.' },
  SNAPSHOT_NOT_READY: { tr: 'Snapshot henüz hazır değil.', en: 'The snapshot is not ready yet.' },
  SANDBOX_NOT_SNAPSHOTTABLE: {
    tr: 'Bu makinenin şu an snapshot’ı alınamaz.',
    en: 'This machine cannot be snapshotted right now.',
  },
  TEMPLATE_NOT_FOUND: { tr: 'Şablon bulunamadı.', en: 'Template not found.' },
  INVALID_STATE: {
    tr: 'Makine bu işlem için uygun durumda değil.',
    en: 'The machine is not in a state that allows this action.',
  },
  NAME_TAKEN: { tr: 'Bu ad zaten kullanılıyor.', en: 'This name is already taken.' },
  RESERVED_NAME: { tr: 'Bu ad ayrılmış, başka bir ad seç.', en: 'This name is reserved; choose another.' },
};

/** Generic copy for unknown future `PLAN_LIMIT_*` codes (e.g. ports, terminals) so they still read well. */
export const GENERIC_PLAN_LIMIT: Localized = {
  tr: 'Planının sınırına ulaştın. Daha fazlası için Pro’ya yükselt.',
  en: 'You have reached a limit of your plan. Upgrade to Pro for more.',
};

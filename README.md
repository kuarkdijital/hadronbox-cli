# hadronbox

hadronbox.tr makineleri için komut satırı aracı. Paket adı `hadronbox`, komut adları `hadronbox` ve kısa hali `hb`.

```sh
npx hadronbox --help
hb help exit-codes
```

Node.js 20 veya üstü gerekir. Çalışma zamanında bağımlılığı yoktur. Telemetri yoktur. Daha eski bir Node.js ile
çalıştırırsan CLI açılmadan önce `kod: UNSUPPORTED_NODE` hatası (çıkış 1) verir; `--json` ile bu hata da JSON olarak
yazılır.

## Giriş

```sh
hb login                                  # terminalde gizli istemle anahtar sorar
hb login --with-api-key < anahtar.txt     # anahtarı stdin'den okur
echo "$HB_KEY" | hb login --with-api-key --profile ci
hb whoami
hb logout
```

`hb login` anahtarı şu sırayla arar:

1. `--with-api-key` verildiyse stdin'den okur (terminaldeyse gizli istemle sorar).
2. `HADRONBOX_API_KEY` tanımlıysa anahtarı `GET /me` ile doğrular ama **kaydetmez** (gh deseni). Ne diske ne
   anahtar zincirine yazılır, `config.json` da değişmez. Kaydetmek için değişkeni kaldırıp
   `hb login --with-api-key` kullan.
3. Terminaldeyse gizli istemle sorar.
4. Hiçbiri yoksa `kod: MISSING_API_KEY` (çıkış 2) döner. Bayrak verilmeden stdin okunmaz; açık kalmış bir pipe
   login'i bekletmez.

Anahtar hiçbir zaman argv'den alınmaz. Önce yerelde biçim olarak kontrol edilir, sonra `GET /me` ile doğrulanır.
Geçersizse çıkış 3 döner ve hiçbir şey kaydedilmez. Doğrulanınca anahtar kaydedilir, profil `activeProfile` olur ve
anahtar doğrulandığı adrese bağlanır (`credentialOrigin`). Bu profil kayıtlı anahtarı başka bir adrese hiç
göndermez: çözülen API adresinin origin'i farklıysa `kod: CREDENTIAL_ORIGIN_MISMATCH` (çıkış 3) döner ve istek
yapılmaz. `HADRONBOX_API_KEY` bu kontrolün dışındadır.

Login profilin API adresini kendiliğinden değiştirmez. `HADRONBOX_API_URL` profilin adresinden farklıysa bir uyarı
verir. Terminalde açık onay ("bundan sonra bu adresi kullansın mı? (e/H)") verirsen adres profile yazılır.
Etkileşimsiz modda adres hiçbir zaman yazılmaz; kalıcı ayar için ileride `hb config set api-url` gelecek. Config
yazılamazsa login geri alınır ve önceki anahtar yerine konur. API anahtarını panelden oluşturursun:
https://hadronbox.tr/panel/api-anahtarlari. Tarayıcıyla giriş (cihaz akışı) sonraki bir sürümde gelecek.

`hb logout` profilin kayıtlı anahtarını yerelden siler (anahtar zinciri ve dosya). Panelden oluşturulmuş anahtar
sunucuda geçerli kalır; iptal etmek için paneli kullan. `hb whoami` e-posta, organizasyon, plan, makine kotası,
anahtarın adını ve anahtarın nereden geldiğini gösterir.

Komutlar kimlik bilgisini şu sırayla arar:

1. `HADRONBOX_API_KEY` ortam değişkeni (`hb_live_…`). CI ve AI ajanları için önerilen yol budur.
2. Profilin kayıtlı anahtarı. `hb login` bunu önce işletim sisteminin anahtar zincirine yazar, olmazsa `0600` izinli
   dosyaya (bu durumda bir kez uyarı verir).

API anahtarı komut satırı argümanı olarak kabul edilmez. `--api-key` gibi bir bayrak ya da `hb_live_` içeren bir
argüman verirsen komut çıkış kodu 2 ile reddedilir, çünkü argümanlar kabuk geçmişine ve süreç listesine düşer.
CLI kendi yazdığı hiçbir çıktıda anahtarı göstermez, gerekirse `hb_live_••••<son4>` biçiminde maskeler. API adresindeki
kullanıcı adı ve parola da hata mesajlarında `***@` olarak gizlenir.

## Makineler

> **Beta notu:** Makine oluşturma beta açılışıyla çalışır. O zamana kadar `hb machines create` hesabında yalnız
> makine kaydını oluşturur; makine henüz açılmaz ve içinde komut çalıştırılamaz. Diğer komutlar (`ls`, `status`,
> `pause`, `resume`, `rm`) bu kayıtlar üzerinde çalışır.

```sh
hb machines ls [--status running]         # tablo + kota; kısa yol: hb ls
hb machines create [ad] [--size small|medium|large] [--template <kod>] [--snapshot <id>] [--no-auto-pause]
hb machines status <ad>                   # durum, kaynaklar, boşta kalma, otomatik duraklatma
hb machines pause <ad> [--hard [--yes]]   # takma ad: stop; --hard kalıcı durdurur (onay ister)
hb machines resume <ad>                   # takma ad: start; yalnız duraklatılmış (paused) makine
hb machines rm <ad> [--yes]               # takma ad: delete
```

- `machines` yerine `machine` veya `m` yazabilirsin. Alt komutlar üst düzeyde de çalışır: `hb ls`, `hb create`,
  `hb status`, `hb pause`, `hb resume`, `hb rm`.
- `<ad>` bir makine adı ya da `sbx_…` kimliğidir. Ad bulunamazsa `kod: MACHINE_NOT_FOUND` (çıkış 4) döner. Aynı adda
  birden çok makine varsa CLI tahmin yürütmez: kimlikleri listeler ve `kod: AMBIGUOUS_MACHINE` (çıkış 2) döner.
  Ad API yoluna her zaman kodlanmış tek bir parça olarak girer.
- `create` adı verilmezse `hb-<kelime>-NN` biçiminde bir ad üretir (çakışırsa yeniden dener). Başarıda stdout'a
  yalnız makinenin adı yazılır (`AD=$(hb create)`); `--json` ile tam nesne döner. Ad kuralı API ile aynıdır:
  `^[a-z0-9][a-z0-9-]{1,39}$`.
- `pause` veya `resume` uygun durumda olmayan bir makineye uygulanırsa durum adıyla birlikte açıklanır
  (`Makine zaten duraklatılmış: web`, `kod: INVALID_STATE`, çıkış 6).
- `rm` ve `pause --hard` / `stop --hard` geri alınamaz. İkisi de terminalde onay ister (`(e/H)`). Etkileşimsiz
  çalışırken `--yes` verilmezse `kod: CONFIRMATION_REQUIRED` (çıkış 2) döner ve hiçbir şey gönderilmez. Onaya
  "hayır" denirse çıkış 0 olur. Durdurulan (`stopped`) makine yeniden başlatılamaz, yalnız silinebilir; `resume`
  bunu açıkça söyler (`kod: INVALID_STATE`, çıkış 6). Düz `pause` / `stop` onay istemez, makine `resume` ile devam
  eder.
- `--json`: `ls` → `{ "machines": [...], "quota": { "used", "limit" } }`; `create`, `pause`, `resume`, `rm` → API'nin
  makine nesnesi; `status` → makine nesnesi + `envKeys`, `idleMinutes`, `autoPauseInMinutes`.

## Ortam değişkenleri

| Değişken                     | Anlamı                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `HADRONBOX_API_KEY`          | API anahtarı, kayıtlı girişten önce gelir                                           |
| `HADRONBOX_API_URL`          | API adresi (varsayılan `https://api.hadronbox.tr`). `http://` yalnız localhost için |
| `HADRONBOX_LANG`             | `tr` (varsayılan) veya `en`. `--lang` bayrağı bunu ezer                             |
| `HADRONBOX_PROFILE`          | Profil adı (varsayılan `default`). `--profile` bayrağı bunu ezer                    |
| `HADRONBOX_CONFIG_DIR`       | Yapılandırma dizini (mutlak yol)                                                    |
| `HADRONBOX_CREDENTIAL_STORE` | `auto` (varsayılan), `keychain` veya `file`                                         |
| `HADRONBOX_DEBUG=1`          | `--debug` ile aynı                                                                  |
| `NO_COLOR`, `CI`             | Renkleri kapatır                                                                    |

Kurumsal proxy: Node.js 20/22'deki yerleşik `fetch`, `HTTPS_PROXY` değişkenini kendiliğinden kullanmaz. Proxy
arkasındaysan Node.js 24+ ile `NODE_USE_ENV_PROXY=1` tanımla. Aksi halde bağlantı hatası (çıkış 7) alırsın.

## Dosyalar

| Platform     | Dizin                                                               |
| ------------ | ------------------------------------------------------------------- |
| Linux, macOS | `$XDG_CONFIG_HOME/hadronbox`, tanımlı değilse `~/.config/hadronbox` |
| Windows      | `%APPDATA%\hadronbox`                                               |

- `config.json`: gizli olmayan ayarlar: `{ "version": 1, "activeProfile": "…", "profiles": { "<ad>": { "apiUrl" } } }`.
  Kimlik bilgisi bu dosyada durmaz.
- `credentials.json`: yalnız anahtar zinciri kullanılamadığında yazılır. Dizin `0700`, dosya `0600` olur. Dosya
  atomik olarak yazılır (geçici dosya, fsync, rename, dizin fsync). İki CLI süreci aynı anda yazarsa son yazan
  kazanır.
- Güven kontrolleri (Linux, macOS; ssh `StrictModes` benzeri):
  - Dizin ve dosyalar çalışan kullanıcıya ait olmalıdır. Başka kullanıcıya aitse kullanılmaz (`kod: INSECURE_PATH`,
    çıkış 1).
  - Dosyalar sembolik bağla açılmaz (`O_NOFOLLOW`). Dizinin kendisi sembolik bağ olabilir (dotfiles kurulumları için).
  - Başkalarınca yazılabilen bir dizin `0700`'e çekilir. Başkalarınca okunabilen `credentials.json` ya da başkalarınca
    yazılabilen `config.json` `0600`'e çekilir. Her ikisinde de uyarı verilir.
  - Windows'ta bu kontroller yapılmaz; kullanıcı profilinin ACL'i geçerlidir.

Anahtar zinciri:

- **macOS:** Anahtar Zinciri'ne mutlak yol `/usr/bin/security` ile erişilir. Yazma işlemi `security -i` ile stdin
  üzerinden yapılır, anahtar argv'ye girmez. Not: `security` ile oluşturulan öğenin erişim listesi `security`
  aracını güvenilir sayar. Bu yüzden aynı kullanıcıyla çalışan bir süreç anahtarı sorusuz okuyabilir. Koruma düzeyi
  0600 dosyaya yakındır; farkı, anahtarın diskte düz metin olarak durmamasıdır.
- **Linux:** `secret-tool` (libsecret: GNOME Keyring, KWallet). Araç `$PATH` üzerinden aranmaz, yalnız sabit sistem
  dizinlerinde aranır: `/usr/bin`, `/bin`, `/usr/local/bin`, `/run/current-system/sw/bin`. Araç yoksa ya da D-Bus
  oturumu yoksa (sunucu, konteyner) dosyaya geçilir.
- **Windows:** dosya kullanılır.
- Her yazma işleminden sonra değer geri okunarak doğrulanır.

## Çıktı sözleşmesi

- Veri stdout'a yazılır. İlerleme, uyarı ve hata satırları stderr'e yazılır.
- `--json` verildiğinde stdout'ta her durumda yalnız tek bir JSON belgesi olur. Hatalar, Ctrl+C (`INTERRUPTED`),
  beklenmeyen iç hata (`INTERNAL`) ve eski Node.js (`UNSUPPORTED_NODE`) da buna dahildir:
  `{ "error": { "code": "PLAN_LIMIT_MACHINES", "message": "…", "details": { … } }, "exitCode": 5 }`.
  Sonuç yazıldıktan sonra bir hata oluşursa ikinci belge yazılmaz; hata stderr'e insan biçiminde gider.
  `--json` bayrağının değeri hatalı olsa bile (`--json=1`) hata JSON olarak yazılır.
- İnsan modunda bir hata stderr'de iki satır olarak görünür:

  ```
  hata: Makine kotan doldu. Daha fazlası için Pro’ya yükselt.
  kod: PLAN_LIMIT_MACHINES
  ```

  `kod` değeri dilden bağımsızdır ve değişmez. Panel API'nin kodları olduğu gibi aktarılır.
  CLI'ın kendi kodları `src/errors/messages.ts` dosyasındadır. İkisi aynı ad uzayındadır. API kaynaklı bir hatada
  `details.apiCode` ve `details.httpStatus` her zaman ayrıca bulunur, kaynağı ayırt etmek için bunlara bak.

- Sunucudan ya da komut satırından gelip mesaja yazılan metinlerdeki kontrol karakterleri (C0, C1, bidi) silinir.

## Çıkış kodları

| Kod | Ad                 | Ne zaman                                                                                                                                                       |
| --- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | OK                 | Başarılı                                                                                                                                                       |
| 1   | GENERAL            | Genel hata: sunucu hatası (500), beklenmeyen yanıt, yönlendirme, bozuk ya da güvensiz yerel dosya, eski Node.js, iç hata                                       |
| 2   | USAGE              | Kullanım hatası: bilinmeyen komut veya seçenek, eksik ya da geçersiz argüman, geçersiz ortam değişkeni, API 400 `VALIDATION`, TTY yokken onay gerektiren işlem |
| 3   | AUTH               | Giriş yok (`AUTH_REQUIRED`), API anahtarı geçersiz, 401 veya 403 (`SESSION_REQUIRED`, `EMAIL_NOT_VERIFIED`, `FORBIDDEN_ROLE` …)                                |
| 4   | NOT_FOUND          | 404 / 410, `*_NOT_FOUND`                                                                                                                                       |
| 5   | PLAN_LIMIT         | 402, `PLAN_LIMIT_*`, `PLAN_UPGRADE_REQUIRED`                                                                                                                   |
| 6   | INVALID_STATE      | 409, `INVALID_STATE`, `NAME_TAKEN`                                                                                                                             |
| 7   | NETWORK            | Bağlantı hatası, zaman aşımı, 408, 429 (`RATE_LIMITED`), 502/503/504 (`SERVICE_UNAVAILABLE`)                                                                   |
| 8   | CLI_UPGRADE        | 426 / `CLI_UPGRADE_REQUIRED`: bu CLI sürümü artık desteklenmiyor (`npx hadronbox@latest`)                                                                      |
| 125 | REMOTE_NOT_STARTED | Yalnız `exec` / `sh`: CLI tarafında hata (uzak komut başlamadan, bağlantı koptu, `--timeout`; aşağıya bak)                                                     |
| 130 | INTERRUPTED        | Ctrl+C / SIGINT (uzak komut çalışırken sinyal uzak sürece iletilir)                                                                                            |

Eşleme kuralı: önce API kodu belirleyicidir (`PLAN_LIMIT_*` her zaman 5 döner), API kodu yoksa HTTP durumu
kullanılır. Bu değerler herkese açık bir sözleşmedir. Mevcut kodların numarası hiçbir zaman değiştirilmez
ve yeniden kullanılmaz. Yeni kodlar 9 ile 124 arasından seçilir.

### Uzak komut çıkış kodları (`exec`, `sh`)

`exec` ve `sh` komutları bu sürümde yok, sonraki bir sürümde gelecek. Aşağıdaki kurallar o komutlar için şimdiden
sabittir; betiklerini bunlara göre yazabilirsin.

- Uzak komut bitince CLI onun çıkış kodunu (0–255) olduğu gibi döndürür. Süreç bir sinyalle ölürse
  `128 + sinyal numarası` döner (örneğin SIGKILL için 137).
- CLI tarafındaki her hata **125** ile çıkar, böylece hiçbir zaman uzak bir kodla karışmaz. Hata kodu ve mesajı
  değişmez. `--json` çıktısındaki `error.details` alanları:
  - `cliExitCode`: hatanın normal tablodaki sınıfı (ör. kota için 5);
  - `remoteStarted`: uzak komut başlamış mıydı;
  - `reason`: `not_started` (makine bulunamadı, kota, giriş yok, ağ…), `session_lost` (oturum başladıktan sonra
    bağlantı koptu; `sh`) ya da `timeout` (`exec --timeout` aşıldı; `code: TIMEOUT`).
- Ctrl+C uzak komut başlamadan önce 130 döner. Uzak komut çalışırken sinyal uzak sürece iletilir ve uzak sürecin kodu
  döner.
- Otomasyon için `--json` kullan. Bir CLI hatası her zaman `"error"` alanı olan tek bir belge üretir. `exec --json`
  olay akışında uzak komutun bitişi ayrı bir `exit` olayıdır.
- Uygulama: `remoteExitCode()` (`src/errors/exit-codes.ts`), `toRemoteSetupError()` (`src/errors/cli-error.ts`).
  Bir komut bu davranışı `CommandSpec.passthroughExit: true` ile alır ve uzak süreç çalışmaya başladığında
  `ctx.markRemoteStarted()` çağırır.

## Lisans

Apache License 2.0 (`LICENSE`), telif hakkı Kuark Dijital. Bu lisans yalnız bu CLI için geçerlidir; hadronbox sunucu
tarafı kapalı kaynaktır.

## Geliştirme

Node.js 20 veya üstü:

```sh
npm ci
npm run typecheck                # tsc --noEmit
npm test                         # vitest
npm run build                    # dist/cli.js (sürüm ön kontrolü) + dist/hadronbox.js (CLI), esbuild, ESM
node dist/cli.js --help
npm run check:pack               # npm pack --dry-run: pakette yalnız beklenen dosyalar var mı
```

Bu depo hadronbox ana deposundan her sürümde aktarılır. Bu yüzden pull request kabul edilmez; hata ve öneriler için
issue aç. Güvenlik açıklarını issue yerine `SECURITY.md`'deki yoldan bildir. Sürümler `v*` etiketiyle, GitHub
Actions'tan npm Trusted Publishing ve provenance ile yayımlanır (`.github/workflows/npm-publish.yml`).

`npm pack` ve `npm publish` öncesinde `prepack` derlemeyi kendiliğinden çalıştırır.

Yeni bir komut eklemek için `src/commands/` altında bir `CommandSpec` yaz ve `src/commands/index.ts` dosyasındaki
`COMMANDS` listesine ekle. Komut, `ctx.services.api()` (kimliği doğrulanmış istemci), `ctx.services.config()`,
`ctx.services.credentials()` ve `ctx.out` (stdout/stderr ile `--json` sözleşmesi) üzerinden çalışır. Bir hata
bildirmek için `cliError('KOD', params)` fırlatırsın. Kullanıcı girdisini API yoluna koyarken her zaman
`` apiPath`/sandboxes/${ad}` `` kullan: her parçayı kodlar, `.` ve `..` değerlerini reddeder.

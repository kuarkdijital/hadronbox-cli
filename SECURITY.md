# Güvenlik politikası

Bir güvenlik açığı bulduysan lütfen **herkese açık bir issue açma**. Bunun yerine şu yollardan biriyle bildir:

- GitHub'da bu depoda **Security → Report a vulnerability** (özel güvenlik bildirimi), ya da
- e-posta: **security@hadronbox.tr**

Bildirimine etkilenen sürümü (`hb --version`), işletim sistemini ve adım adım yeniden üretme yolunu ekle. API
anahtarı ya da başka bir gizli bilgi gönderme; gerekiyorsa son dört karakterini yazman yeterli.

Bildirimini aldığımızı kısa sürede yanıtlarız. Düzeltme yayımlanana kadar ayrıntıları gizli tutmanı rica ederiz.
Düzeltme yeni bir npm sürümüyle gelir ve sürüm notlarında belirtilir.

## Desteklenen sürümler

Güvenlik düzeltmeleri `hadronbox` paketinin en son sürümüne (`npm view hadronbox version`) yapılır. Eski sürümler
için `npx hadronbox@latest` kullan.

## Kapsam

Bu depo yalnız `hadronbox` komut satırı aracını içerir. hadronbox.tr web sitesi, paneli ve API'si ile ilgili
açıkları da aynı adrese bildirebilirsin.

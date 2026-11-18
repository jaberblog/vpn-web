# Vira VPN (Flutter + flutter_vless)

اپ VPN بر پایه VLESS. رابط کاربری کاملاً HTML/CSS/JS است و با یک پل (Bridge) به فلاتر وصل می‌شود.

## ساخت APK با گیت‌هاب
1. محتوای همین پوشه را در یک ریپوی جدید گیت‌هاب push کنید (شاخه‌ی `main`).
2. تب **Actions** ← workflow به نام **Build APK** (خودکار با push اجرا می‌شود؛ یا Run workflow).
3. بعد از پایان، از بخش Artifacts فایل `vira-vpn-apk` را دانلود کنید.
   - `app-release.apk` : نسخه‌ی universal
   - `app-arm64-v8a-release.apk` : مناسب اکثر گوشی‌های امروزی (کوچک‌تر)

پوشه‌ی `android/` در ریپو نیست؛ workflow آن را با `flutter create` می‌سازد و با `tool/patch_android.py`
(پرمیشن‌ها، `extractNativeLibs`، `minSdk 24`) آماده می‌کند.

## ساختار
```
lib/main.dart            WebView + پل JS/Flutter + دکمه‌ی بک
lib/vpn_manager.dart     اتصال، وضعیت، مصرف ذخیره‌شده، پینگ، دریافت لیست سرورها
assets/www/index.html    صفحات (خانه، انتخاب سرور)
assets/www/css/style.css
assets/www/js/bridge.js  پل (Bridge.call / Bridge._emit) + mock برای تست در مرورگر
assets/www/js/app.js     منطق UI و آدرس API (API_URL)
```

## پل JS ↔ Flutter
- JS → Flutter: `Bridge.call('connect', {name, icon, config})` یک Promise برمی‌گرداند.
  اکشن‌ها: `init`, `fetchServers {url}`, `select`, `connect`, `disconnect`, `ping {config}`, `resetTraffic`, `exit {disconnect}`
- Flutter → JS: رویدادهای `status` و `error` (`Bridge.on('status', fn)`)
- آدرس API در `app.js` (`API_URL`) است و با `fetchServers` به فلاتر داده می‌شود.

## تست رابط در مرورگر
`assets/www/index.html` را در کروم باز کنید؛ بدون فلاتر، یک mock فعال می‌شود (سرور و سرعت ساختگی).

## فونت وزیرمتن (اختیاری)
فایل `Vazirmatn.woff2` را در `assets/www/fonts/` بگذارید. اگر نباشد از Tahoma/فونت سیستم استفاده می‌شود.

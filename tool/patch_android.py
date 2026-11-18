#!/usr/bin/env python3
"""Patches the Android scaffold produced by `flutter create` for flutter_vless.

- AndroidManifest: permissions, android:extractNativeLibs="true", app label
- app/build.gradle(.kts): minSdk 24, legacy native-lib packaging
Works with both the Kotlin-DSL and the Groovy flavour of the Flutter template.
"""
import pathlib
import re
import sys

root = pathlib.Path('android')

# ------------------------------------------------------------- manifest
mf = root / 'app/src/main/AndroidManifest.xml'
t = mf.read_text(encoding='utf-8')

perms = [
    'android.permission.INTERNET',
    'android.permission.ACCESS_NETWORK_STATE',
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
    'android.permission.FOREGROUND_SERVICE_SYSTEM_EXEMPTED',
    'android.permission.POST_NOTIFICATIONS',
]
add = ''.join(
    '    <uses-permission android:name="%s"/>\n' % p
    for p in perms if p not in t
)
if add:
    t = t.replace('<application', add + '    <application', 1)

if 'extractNativeLibs' not in t:
    t = t.replace('<application', '<application\n        android:extractNativeLibs="true"', 1)

t = re.sub(r'(<application[^>]*?android:label=")[^"]*(")', r'\1Vira VPN\2', t, count=1)
mf.write_text(t, encoding='utf-8')
print('patched', mf)

# --------------------------------------------------------------- gradle
gradle = None
for name in ('app/build.gradle.kts', 'app/build.gradle'):
    if (root / name).exists():
        gradle = root / name
        break
if gradle is None:
    sys.exit('android/app/build.gradle(.kts) not found')

s = gradle.read_text(encoding='utf-8')
kts = gradle.suffix == '.kts'

s = re.sub(
    r'minSdk(?:Version)?\s*=?\s*flutter\.minSdkVersion(?:\.toInteger\(\))?',
    'minSdk = 24' if kts else 'minSdkVersion 24',
    s,
)

if 'useLegacyPackaging' not in s:
    s = re.sub(
        r'(\bandroid\s*\{)',
        r'\1\n    packaging {\n        jniLibs {\n            useLegacyPackaging = true\n        }\n    }',
        s,
        count=1,
    )

gradle.write_text(s, encoding='utf-8')
print('patched', gradle)

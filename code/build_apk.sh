#!/bin/bash
# 一键构建 Android APK 并发布到 public/apk（含版本文件，供 App 内自更新使用）
# 用法：bash code/build_apk.sh
set -euo pipefail
cd "$(dirname "$0")/../android"
AJAR=$PWD/platforms/android.jar
DX=/usr/lib/android-sdk/build-tools/debian/dx
OUT="${TALK_OUT:-$PWD/../public/apk}"

rm -rf build out && mkdir -p build/classes out
javac -source 8 -target 8 -bootclasspath "$AJAR" -d build/classes -nowarn src/com/talk/notify/*.java > /tmp/javac.log 2>&1 || { cat /tmp/javac.log; echo "编译失败"; exit 1; }
grep -v "^注" /tmp/javac.log || true
"$DX" --dex --output=build/classes.dex build/classes
aapt package -f -M AndroidManifest.xml -S res -A assets -I "$AJAR" -F out/base.apk
cp build/classes.dex out/classes.dex
(cd out && aapt add base.apk classes.dex >/dev/null)
zipalign -f 4 out/base.apk out/aligned.apk
KS="${TALK_KEYSTORE:-talk.keystore}"
KS_PASS="${TALK_KS_PASS:-changeit}"
apksigner sign --ks "$KS" --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --v1-signing-enabled true --v2-signing-enabled true --out out/talk-notify.apk out/aligned.apk
apksigner verify out/talk-notify.apk >/dev/null

VC=$(aapt dump badging out/talk-notify.apk | sed -n "s/.*versionCode='\([0-9]*\)'.*/\1/p" | head -1)
VN=$(aapt dump badging out/talk-notify.apk | sed -n "s/.*versionName='\([^']*\)'.*/\1/p" | head -1)

mkdir -p "$OUT"
cp out/talk-notify.apk "$OUT/talk-notify.apk"
printf '{"versionCode":%s,"versionName":"%s"}\n' "$VC" "$VN" > "$OUT/talk-notify.version.json"
echo "已发布: versionCode=$VC versionName=$VN  $(ls -lh "$OUT/talk-notify.apk" | awk '{print $5}')"

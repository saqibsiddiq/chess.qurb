#!/usr/bin/env bash
# Teaches the generated Android project to sign release builds.
#
#     bash scripts/setup-android-signing.sh
#
# Run once, and again after anything regenerates app/src-tauri/gen —
# that whole directory is ignored by git, so this patch has to be
# reapplicable rather than committed. It is idempotent.
#
# The credentials are NOT stored in the generated project. They are read
# from app/src-tauri/keystore.properties, which sits outside gen/ so it
# survives regeneration, and which .gitignore excludes so a signing key
# can never be committed by accident.
#
# Creating the keystore is deliberately left to you: it requires choosing
# passwords, and this script never handles them. See the instructions it
# prints when the properties file is missing.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
gradle="$root/app/src-tauri/gen/android/app/build.gradle.kts"
props="$root/app/src-tauri/keystore.properties"

[ -f "$gradle" ] || { echo "No generated Android project at $gradle" >&2; exit 1; }

if grep -q "CHESY-SIGNING" "$gradle"; then
  echo "signing config already present."
else
  python3 - "$gradle" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); t = p.read_text()

# Loaded next to Tauri's own properties, from outside the generated tree.
loader = '''
// CHESY-SIGNING — applied by scripts/setup-android-signing.sh
// Kept outside gen/ so it survives regeneration, and gitignored so a
// signing key is never committed.
val keystoreProperties = Properties().apply {
    val propFile = file("../../../keystore.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}
'''
anchor = '''val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}
'''
assert anchor in t, "could not find tauriProperties block"
t = t.replace(anchor, anchor + loader, 1)

# An unsigned release build stays possible: without the properties file
# the config carries no key and Gradle emits the -unsigned APK as before,
# rather than failing the build.
signing = '''    signingConfigs {
        create("release") {
            if (keystoreProperties.containsKey("storeFile")) {
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }
    buildTypes {
'''
assert "    buildTypes {\n" in t
t = t.replace("    buildTypes {\n", signing, 1)

release_anchor = '''        getByName("release") {
            isMinifyEnabled = true
'''
assert release_anchor in t
t = t.replace(
    release_anchor,
    '''        getByName("release") {
            if (keystoreProperties.containsKey("storeFile")) {
                signingConfig = signingConfigs.getByName("release")
            }
            isMinifyEnabled = true
''',
    1,
)
p.write_text(t)
PY
  echo "patched $(basename "$gradle")."
fi

if [ -f "$props" ]; then
  # Validate before building. Java property keys are case-sensitive, so a
  # file that says "storeFIle" or "storepassword" parses cleanly and
  # yields nothing: Gradle then finds no key, skips signing, and emits an
  # unsigned APK with a successful exit code. That failure is silent and
  # easy to mistake for success, so it is caught here instead.
  missing=""
  for key in storeFile storePassword keyAlias keyPassword; do
    grep -q "^${key}=" "$props" || missing="$missing $key"
  done
  if [ -n "$missing" ]; then
    echo "ERROR: keystore.properties is missing these keys (exact spelling matters):$missing" >&2
    echo "  found:" >&2
    sed "s/=.*/=<value>/" "$props" | sed "s/^/    /" >&2
    exit 1
  fi
  store=$(grep "^storeFile=" "$props" | cut -d= -f2- | tr -d "\r" | sed "s/[[:space:]]*$//")
  if [ ! -f "$store" ]; then
    echo "ERROR: storeFile does not exist: $store" >&2
    echo "Use an absolute path to the .jks file." >&2
    exit 1
  fi
  echo "keystore.properties valid; storeFile resolves. Release builds will be signed."
else
  cat <<'MSG'

No app/src-tauri/keystore.properties yet, so release builds stay unsigned.

To sign them, create a keystore and a properties file yourself — this
script will not do it, because both steps involve passwords:

  1. Generate the key. Choose a strong password when prompted, and keep
     the resulting file safe: every future update to this app must be
     signed with the same key, and losing it means the app can never be
     updated in place again.

       keytool -genkeypair -v \
         -keystore ~/chesy-release.jks \
         -keyalg RSA -keysize 4096 -validity 10000 \
         -alias chesy

  2. Write app/src-tauri/keystore.properties with an ABSOLUTE storeFile
     path, using the passwords you just chose:

       storeFile=/home/you/chesy-release.jks
       storePassword=...
       keyAlias=chesy
       keyPassword=...

  3. Re-run this script, then build:

       source scripts/android-env.sh
       cd app && npm run tauri android build -- --apk --target aarch64

MSG
fi

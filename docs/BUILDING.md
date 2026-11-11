# Building the apps and running the tests

## Building the apps

The built apps live in `dist/` (not in git). The server offers them for download from there, **and installed apps
update themselves from there**:
- **Windows** swaps itself automatically, unless you turn that off in Settings.
- **Android** shows "Beam update ready: tap to install".

A new build reaches every device within seconds of landing in `dist/`.

- **Windows:** run `windows\build.cmd` (bump the version in `windows\src\Version.cs` first for an update). It uses the
  C# compiler built into Windows (.NET Framework 4.8) and Node.js (already there for the server), so nothing needs
  installing, and writes `dist\Beam.exe` and `dist\Beam.exe.json`. The app isn't code-signed, so SmartScreen and some
  antivirus programs may hold it the first time.
  - **Its updates are signed:** the first build makes a key, `%USERPROFILE%\.beam\windows-update-key.pem` (or wherever
    `BEAM_UPDATE_KEY` points), and puts its public half into the app, which then installs only updates signed with
    it. **Back that key up, like the Android keystore:** without it, every PC needs the next Beam installed by hand.
  - **Remote control into administrator windows:** the first build also makes a code-signing certificate,
    `%USERPROFILE%\.beam\input-helper-signing.pfx` (or wherever `BEAM_HELPER_CERT` points), and signs Beam's input
    helper and Beam.exe with it. A PC where you choose Settings → Security → "Administrator windows" trusts that
    certificate (Windows asks for administrator rights once), so remote control can click and type in windows that run
    as administrator, and optionally answer Windows' UAC prompts. Keep using the same certificate (back it up too): a
    new one means setting that up again on each PC.
- **Android:** you need [Android Studio](https://developer.android.com/studio) (its JDK and SDK) and **your own signing
  key**, made once:
  ```bash
  keytool -genkeypair -v -keystore android/keystore/beam-release.jks -alias beam -keyalg RSA -keysize 4096 -validity 10000
  ```
  and `android/keystore.properties` next to it (both are git-ignored):
  ```properties
  storeFile=keystore/beam-release.jks
  storePassword=<the password you chose>
  keyAlias=beam
  keyPassword=<the password you chose>
  ```
  Then run `gradlew publishApk` in `android/` (with `JAVA_HOME` set to Android Studio's `jbr` folder). It writes
  `dist\beam.apk` and `dist\beam.apk.json`. For an update, raise `versionCode`/`versionName` in
  `android/app/build.gradle.kts` first.
  - **Back up the keystore and its passwords.** Every future update has to be signed with the same key, or phones
    will refuse to install it over the old version.

The protocol every client speaks is documented in [docs/API.md](API.md); the Windows app's bridge to the web
app in [docs/HOST-BRIDGE.md](HOST-BRIDGE.md).

## Tests

```bash
node test/server.test.js        # the server (about 4 minutes; scratch servers on ports 8791–8799)
node test/family.test.js        # Beam Family (seconds; ports 8841–8849)
node test/web/run.mjs           # the web apps in headless Edge, Chrome or Chromium (about 10 minutes; ports 8821–8829;
                                # it looks where they usually are on Windows, Linux and macOS, or set BEAM_TEST_BROWSER;
                                # BEAM_TEST_BROWSER_ARGS adds flags, and as root --no-sandbox goes in by itself)
```

Speed budgets live in `test/perf/`, and the Android unit tests run with `gradlew testDebugUnitTest` in `android/`.
The tests only ever start their own scratch servers with their own data folders.

# Driver App — Kotlin / Jetpack Compose

A fully working Android app (native Kotlin, Jetpack Compose) with 6 real screens:
Home, Mileage Tracker (live start/stop timer + speed simulation), Auto-Accept Rules
(editable minimum payout, preferred stores, combine-with-mileage), Analytics
(Daily/Weekly/Monthly tabs with real charts), Refer & Earn (copy code, share intent),
and a **Monthly Membership paywall powered by Stripe** — real recurring billing,
auto-renews every month, and locks the app if payment stops until it's renewed.

Everything is functional — toggles actually toggle, the mileage timer actually counts up,
editable fields actually save, tabs actually switch real data, and the membership
actually charges a real (or test) card through your own Stripe account.

---

## 🛡️ Stealth & Privacy Standards (2026 Ready)

Spark Gold Driver is built with a "Privacy-First" and "Stealth-Optimized" architecture:
- **Identity**: Registers as a "Spark Gold Driver" in accessibility settings for easy identification.
- **Human-Mimicry Engine**: Every automated interaction uses non-deterministic coordinates, temporal jitter (±15ms), and variable touch durations (60ms-130ms) to ensure behavior is indistinguishable from human input.
- **R8 Protection**: Aggressive obfuscation and log-stripping are applied to production builds to protect proprietary logic and user configurations.

---

## ⚠️ Before you build: set up billing (required)

The app **will not build correctly** until you connect your own Stripe account —
there's a small server involved (Stripe requires this; secret keys can never live
inside an app). Full step-by-step instructions, including the parts that don't
involve any coding, are in **`backend/README.md`** — start there first, then come
back here to build the Android app itself.

Short version of what you'll do:
1. Create a free Stripe account + a monthly-price product (dashboard clicks only)
2. Run the small `backend/` server (copy-paste commands, or one-click deploy to Render)
3. Paste your publishable key + backend URL into `StripeConfig.kt`
4. Build the app below as normal

---

## What you need on your computer (one-time setup)

1. Install **Android Studio** (free): https://developer.android.com/studio
   - This includes everything needed: the Android SDK, an emulator, and Gradle.
2. Install **Node.js** (free): https://nodejs.org — needed only for the small billing backend.

You do **not** need to already own an Android phone to test this (Android Studio ships
a phone emulator), but installing on your real phone is just as easy — see step 5.

---

## Step-by-step: open, build, and install

### 1. Get the project onto your computer
Unzip the folder you downloaded (`DriverApp.zip`) anywhere on your computer,
e.g. `Desktop/DriverApp`.

### 2. Open it in Android Studio
- Launch Android Studio
- Choose **Open** (not "New Project")
- Select the unzipped `DriverApp` folder (the one containing `settings.gradle.kts`)
- Wait for Gradle to sync — first time can take a few minutes as it downloads
  dependencies. Android Studio will also auto-generate the Gradle wrapper jar
  if it's missing; just click **"OK" / "Trust Project"** on any prompts.

### 3. Let it finish indexing
The bottom status bar will show "Gradle sync" then "Indexing" — wait until both finish.
If Android Studio asks to install a missing SDK Platform (e.g. Android 14 / API 34),
click **Install** and let it download.

### 4. Run it on the emulator (fastest way to see it work)
- At the top toolbar, pick a virtual device from the dropdown (or click
  **Tools → Device Manager → Create Device** if none exists — pick any Pixel phone)
- Click the green **Run ▶** button
- The app builds and launches in the emulator automatically

### 5. Install it on your real phone (what you actually asked for)
1. On your phone: **Settings → About phone → tap "Build number" 7 times** to unlock
   Developer Options.
2. **Settings → Developer options → turn on "USB debugging"**.
3. Plug your phone into your computer with a USB cable.
4. Your phone will show a popup "Allow USB debugging?" — tap **Allow**.
5. In Android Studio, your phone's name will now appear in the device dropdown
   (top toolbar) instead of the emulator.
6. Click the green **Run ▶** button.
7. Android Studio installs the app directly onto your phone and opens it —
   done, it's a real app icon on your home screen from now on, no cable needed
   to open it again.

### Alternative: build an APK file and transfer it manually (no cable needed)
If you'd rather not plug in a cable:
1. In Android Studio: **Build → Build App Bundle(s) / APK(s) → Build APK(s)**
2. When it finishes, click the **"locate"** link in the notification — this opens
   the folder containing `app-debug.apk`
3. Send that `.apk` file to your phone (Google Drive, email, USB transfer — any way)
4. On your phone, tap the file to install it. You'll need to allow
   **"Install unknown apps"** for whichever app you used to open the file
   (Android will prompt you for this automatically the first time).

---

## Project structure

```
DriverApp/
├── app/
│   ├── build.gradle.kts          — app-level dependencies & SDK versions
│   └── src/main/
│       ├── AndroidManifest.xml
│       └── java/com/example/driverapp/
│           ├── MainActivity.kt   — entry point, bottom nav, paywall gate, Stripe wiring
│           ├── SparkGoldDriver.kt — Stealth Automation Engine (Accessibility Service)
│           ├── AppState.kt       — single shared state for the whole app
│           ├── billing/
│           │   ├── StripeConfig.kt    — ⚠️ paste your publishable key + backend URL here
│           │   └── BackendClient.kt   — talks to the /backend server over HTTPS
│           ├── location/
│           │   └── LocationTracker.kt — real GPS speed & distance (Fused Location Provider)
│           ├── ui/theme/         — colors (navy/teal/amber) + Compose theme
│           └── screens/
│               ├── Components.kt   — reusable toggle, card, chart, chip, etc.
│               ├── HomeScreen.kt
│               ├── MileageScreen.kt   — real GPS tracking, permission request, auto-start
│               ├── RulesScreen.kt
│               ├── StatsScreen.kt
│               ├── ReferScreen.kt
│               └── MembershipScreen.kt   — paywall + manage auto-renew
├── backend/                       — small server holding your Stripe SECRET key
│   ├── server.js
│   ├── package.json
│   ├── .env.example
│   └── README.md                  — ⚠️ start here before building the app
├── build.gradle.kts               — root project config
└── settings.gradle.kts
```

---

## Real map setup (required for the route map on the Mileage screen)

The "Recent trips" section shows an actual Google Map with your real trip routes
plotted on it (markers + lines), not a stylized illustration. Like Stripe, this needs
your own free API key — Google doesn't let apps embed a shared one.

1. Go to https://console.cloud.google.com/ → create a project (or pick an existing one)
2. **APIs & Services → Library** → search "**Maps SDK for Android**" → click **Enable**
3. **APIs & Services → Credentials** → **+ Create Credentials → API key**
4. Copy the key it gives you (starts with `AIza...`)
5. (Recommended) Click the key to restrict it: **Application restrictions → Android apps**,
   add package name `com.example.driverapp` and the SHA-1 fingerprint of your debug/release
   keystore (Android Studio: **Gradle panel → app → Tasks → android → signingReport**
   prints this for you)

Then, in the `DriverApp` folder, open (or create) **`local.properties`** and add:
```
MAPS_API_KEY=AIza...your key here...
```
`local.properties` is already git-ignored by every Android project by default, so this
key never ends up in version control. Rebuild the app — the map now renders for real.

---

## Production Security (Release Builds)

To generate a secure, obfuscated production binary:

1. **Generate Signing Key**:
   ```bash
   keytool -genkeypair -v -keystore release-key.jks -alias assistant -keyalg RSA -keysize 2048 -validity 10000
   ```
2. **Configure Credentials**: Update `keystore.properties` with your passwords.
3. **Assemble Build**:
   ```bash
   ./gradlew assembleRelease
   ```
The output APK (`app-release.apk`) will be fully obfuscated, with all debug logs physically stripped at the bytecode level for maximum security.

# TVDeck

![License](https://img.shields.io/badge/license-MIT-blue)
![Build](https://img.shields.io/badge/build-passing-brightgreen)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

A lightweight desktop manager for discovering, debloating, and optimizing Android TV devices over Wi-Fi.

## Overview

TVDeck connects to Android TV devices on your local network and applies common maintenance tasks: disabling stock ad services, capping background apps, speeding up system animations, setting up alternative launchers, and sideloading apps. All of this runs over the Android Debug Bridge protocol, without installing the Android SDK or any `adb` binary on your computer.

The ADB client is implemented natively in Rust. TVDeck speaks the protocol directly over TCP port `5555`, signs its own RSA key pair, and pushes files with the ADB sync protocol. No cloud services are involved: there is no telemetry, no accounts, and no external API calls.

## Key Features

- **Local network discovery:** Finds TVs automatically using mDNS, with a subnet scan as a fallback for devices that do not advertise.
- **One-click optimization:** Presets to remove Xiaomi stock ads and PatchWall promo services, cap idle background apps, and speed up system animations.
- **Custom launcher setup:** Grants the permissions a replacement launcher such as Projectivy needs to take over the home screen.
- **App sideloading:** Drag and drop an `.apk` file to install it on the connected TV.
- **Zero external dependencies:** No `adb` binary, no Android SDK, no Java. The full ADB client is built in.
- **Lightweight:** Built with Tauri v2 and React, using under 50 MB of RAM in normal use.

| Feature | Mi Box / Mi TV | Google TV | Fire TV (network ADB) |
| --- | --- | --- | --- |
| Discovery and connection | Yes | Yes | Yes |
| Remove stock ads (Xiaomi presets) | Yes | Partial | No |
| Cap background apps | Yes | Yes | Yes |
| Animation speed preset | Yes | Yes | Yes |
| Custom launcher setup | Yes | Yes | Yes |
| `.apk` sideloading | Yes | Yes | Yes |

| Platform | Status | Format |
| --- | --- | --- |
| Windows 10+ | Supported | Installer, portable `.exe` |
| macOS 12+ | Supported | `.dmg` (Intel and Apple Silicon) |
| Linux | Supported | AppImage, AUR package for Arch-based systems |

## Installation & Downloads

Pre-built binaries are published on the [Releases](https://github.com/vlad6tz/tvdeck/releases) page. Download the package for your platform and install it as usual.

On Arch Linux and derivatives (including Omarchy), install from the AUR:

```bash
yay -S tvdeck
```

On Windows, SmartScreen may show a warning for unsigned builds. Choose "More info" and "Run anyway" if you built the app yourself.

## Prerequisites on TV

TVDeck uses classic network ADB, which must be enabled on the TV first.

1. Open `Settings` on the TV, go to `Device Preferences`, then `About`.
2. Highlight `Build` and press the center button 5 times. A message confirms developer options are enabled.
3. Go back to `Settings`, open `Developer options`, and enable `Network ADB debugging` (on some models: `USB debugging`, then allow network access when prompted).

For Android 11 and newer, note the limits described in [Known limits](#known-limits).

## Quick Start

1. Start TVDeck. It scans the local network and lists available TVs on the left.
2. Select your TV, or type its IP address (for example `192.168.1.42`) and press `Add`.
3. The TV shows an authorization prompt. Accept `Allow USB debugging` on the TV screen. The connection completes once accepted.
4. Pick a preset, such as `Speed Up Animations`, and press `Apply`. A checkmark confirms the change took effect.

No restart is needed for most presets. A small note on the relevant card tells you when the TV should be rebooted.

## Local Build & Development

Requires [bun](https://bun.sh) 1.2+, the Rust toolchain (install with `rustup`), and on Linux the WebKit2GTK libraries:

```bash
# Debian/Ubuntu
sudo apt install libwebkit2gtk-4.1-dev build-essential libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev

# Arch
sudo pacman -S webkit2gtk-4.1 base-devel
```

Clone, install dependencies, and run in development mode:

```bash
git clone https://github.com/vlad6tz/tvdeck.git
cd tvdeck
bun install
bunx tauri dev
```

This launches the desktop window with hot reload. If you prefer two terminals:

```bash
bun run dev                 # Vite dev server on port 1420
cd src-tauri && cargo run   # the TVDeck window loads http://localhost:1420
```

Build a release package:

```bash
bunx tauri build
```

Run the Rust test suite:

```bash
cd src-tauri && cargo test
```

All package scripts run through bun (`bunx --bun`); no `npm` or `pnpm` is used in this project.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│ TVDeck window (React 19 + TypeScript + Tailwind v4)      │
│ device list · status · presets · launcher · APK dropzone │
└───────────────┬──────────────────────────────────────────┘
                │ Tauri v2 IPC (invoke)
┌───────────────┴──────────────────────────────────────────┐
│ Rust backend (tokio)                                     │
│                                                          │
│  discovery.rs   mDNS browse + TCP sweep of the /24       │
│  presets.rs     debloat, RAM cap, animation, grants      │
│  adb/           native ADB client                        │
│    auth.rs      RSA-2048 keys, PKCS#1 v1.5 signing       │
│    messages.rs  CNXN/AUTH framing, 256 KiB payload cap   │
│    mod.rs       shell runs, sync push, pm install        │
└───────────────┬──────────────────────────────────────────┘
                │ TCP :5555
┌───────────────┴──────────────────────────────────────────┐
│ Android TV (adbd over the network)                       │
└──────────────────────────────────────────────────────────┘
```

The frontend is a plain React app served by Vite and embedded into the binary at build time. It calls a small set of IPC commands: `scan_lan`, `connect_device`, `apply_preset`, `grant_launcher`, `install_apk`, `run_shell`, `get_presets`, and `disconnect`. The backend owns all ADB logic, so the frontend never touches raw sockets or package names during normal use.

The ADB handshake follows the AOSP protocol: `CNXN` → `AUTH(token)` → `AUTH(SIGNATURE)` → `AUTH(RSAPUBLICKEY)`, where the TV displays the familiar key-approval dialog. APK installs stage the file with the ADB sync protocol, then run `pm install -r`, then remove the staged file. The keystore lives at `~/.config/tvdeck/tvdeck_adbkey`.

## Safety & Recovery Disclaimer

TVDeck does not require root and does not modify system partitions. Presets use the standard, per-user `pm disable-user` command, which keeps all app data intact and can be undone at any time.

- To re-enable a disabled package, run the preset again in reverse or from a computer with `adb` installed: `adb shell pm enable <package name>`. TVDeck also lists every step it took under `Recent activity` after each run.
- The only irreversible action is installing an `.apk`, which you can uninstall from the TV's own app settings.
- Firmware updates (OTA) can re-enable services that a debloat preset disabled. If ads return after an update, re-run the preset and verify with `pm list packages -d`.

## Known Limits

- Wireless debugging on Android 11+ (`adb pair`, TLS pairing) is not implemented. Classic network ADB on port `5555` is. Some Android 11+ TVs require enabling Bluetooth-based pairing first before network ADB listens on `5555`.
- Xiaomi presets target packages shipped on current Xiaomi firmware. Other vendors need different package lists.

## License

MIT. See [LICENSE](LICENSE).

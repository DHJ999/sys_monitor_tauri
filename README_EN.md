# System Monitor Overlay (sys_monitor_tauri)

A lightweight, always-on-top **desktop system monitor** for Windows. It floats on your desktop as a transparent overlay and shows real-time CPU, memory, GPU, disk, network, and process usage at a glance. Built with [Tauri 2](https://v2.tauri.app/) (Rust backend) and a TypeScript + Vite frontend.

> Windows 10 / 11 only. Single-file executable, no installation required.

## Features

- **CPU** — usage ring chart + live sparkline
- **Memory** — usage progress bar with used / total (GB)
- **GPU** — one row per graphics card showing model, utilization, and VRAM usage (DXGI + PDH)
- **Disk** — usage + live read / write throughput (MB/s)
- **Network** — live download / upload speed (KB/s)
- **Processes** — top 8 by memory consumption
- **Display styles** — 4 presets plus per-module customization
- **System tray** — show / hide, pin / unpin, open settings, quit
- **Global hotkey** — `Ctrl + Alt + M` toggles visibility
- **Transparent window** — overall opacity 20%–100% (CSS `opacity`)

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | HTML + CSS + TypeScript + Vite |
| Desktop framework | Tauri 2 |
| Backend | Rust (`sysinfo` + DXGI / PDH sampling) |
| Tray / global hotkey | Tauri tray API / `tauri-plugin-global-shortcut` |

## Installation

### Option A — Download the prebuilt binary (recommended)

Grab `sys_monitor_tauri.exe` from the [**Releases**](../../releases) page, drop it into any folder, and double-click to run. No installation, no dependencies beyond what Windows already provides (WebView2 ships with Windows 10/11).

### Option B — Build from source

**Prerequisites**

- Rust (stable, with the MSVC toolchain)
- Node.js 18 or newer
- WebView2 (preinstalled on Windows 10/11)

**Steps**

```bash
# 1. Install frontend dependencies
npm install

# 2. (Optional) Run in development mode — compiles Rust and opens the
#    window with hot-reload enabled
npx tauri dev

# 3. Build a standalone executable (recommended, skips the installer)
npx tauri build --no-bundle

# 4. (Optional) Build the full installer (release exe + MSI/NSIS)
npx tauri build
```

**Build artifacts**

| Output | Path |
|---|---|
| Executable | `src-tauri/target/release/sys_monitor_tauri.exe` |
| Installer | `src-tauri/target/release/bundle/` |

> The full installer needs the WiX toolset, which Tauri downloads automatically on first build.

## Usage

### Window

- The main window defaults to 320×480 and can be resized between 280×360 and 600×900.
- It is borderless and transparent. Drag by the title bar; resize from the bottom-right handle.
- **Desktop position** can be set to *free floating*, *top-right*, or *top-left*.

### Keyboard & tray

- `Ctrl + Alt + M` — show / hide the main window.
- Right-click the tray icon for: show / hide, pin / unpin, open settings, quit.

### Settings

Open **Settings** from the tray menu. Changes apply instantly and persist — no restart needed.

## Configuration

All options are available from the in-app Settings window. They are stored in:

```
%APPDATA%\com.duan.sys-monitor\settings.json
```

| Option | Description |
|---|---|
| Always on top | Keep the window above other windows |
| Auto start | Launch on system login |
| Close behavior | Minimize to tray / Quit |
| Desktop position | Free floating / Top-right / Top-left |
| Text color | 7 presets |
| Opacity | 20% – 100% |
| Font size | 10 – 18 |
| Display style | 4 presets + per-module dropdowns (5 modules) |

Fields carry `serde` defaults, so an older `settings.json` remains forward-compatible.

### Display styles

**Settings → Display style** offers four one-click presets:

| Preset | Layout | Notes |
|---|---|---|
| Default | Single column | CPU ring + line, memory/GPU/disk bars, dual network cards |
| Sparkline | Single column | Mini line charts for every module |
| Minimal | Single column | One line per module ("name + value"), smallest footprint |
| Double | Two columns | Shorter window, ideal for the screen edge |

**Per-module customization:** each module has its own dropdown (CPU: ring / sparkline / bar / text; memory, GPU, disk: bar / sparkline / text; network: card / text / sparkline). Changing any dropdown switches to *custom* mode; clicking a preset reapplies the whole set.

### Example `settings.json`

```json
{
  "always_on_top": true,
  "auto_start": false,
  "close_action": "minimize",
  "desktop_mode": "free",
  "text_color": "green",
  "font_size": 13,
  "opacity": 0.9,
  "style_preset": "default",
  "layout": "single",
  "cpu_display": "ring",
  "mem_display": "progress",
  "gpu_display": "progress",
  "disk_display": "progress",
  "net_display": "card"
}
```

## Project Structure

```
sys_monitor_tauri/
├── index.html            # Shared by main and settings windows (split by window.label)
├── src/
│   ├── main.ts           # Frontend logic: renderers, history cache, settings sync, drag/resize
│   ├── styles.css        # Styles (font size via --font-size-base; single/double layouts)
│   └── assets/
├── src-tauri/
│   ├── tauri.conf.json   # App config (windows, bundle, identifier)
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs       # Entry point
│       ├── lib.rs        # Command registration, tray, settings window, settings broadcast
│       ├── monitor.rs    # Sampling loop + dedicated GPU cache thread
│       ├── gpu.rs        # GPU sampling (DXGI enumeration + PDH counters)
│       └── settings.rs   # Settings struct + JSON persistence
└── dist/                 # Frontend build output
```

## Contributing

Contributions are welcome!

1. Fork the repository and create a feature branch.
2. Install the prerequisites listed under **Build from source**.
3. Run `npx tauri dev` to iterate with hot-reload.
4. Keep the Rust side formatted (`cargo fmt`) and free of `cargo clippy` warnings where reasonable.
5. Submit a pull request describing the change and the motivation.

Please open an issue first for larger changes so we can align on the approach.

## License

Licensed under the [MIT License](LICENSE).

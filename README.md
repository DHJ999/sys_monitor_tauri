# 系统监控悬浮窗 (sys_monitor_tauri)

Windows 桌面系统监控悬浮窗 —— 透明置顶、托盘常驻、实时刷新 CPU / 内存 / GPU / 磁盘 / 网络 / 进程占用，支持多套显示风格预设与分模块自定义。

## 功能

- **CPU**：占用率环形图 + 实时折线曲线
- **内存**：占用率进度条 + 已用/总量 GB
- **GPU**：每块显卡一行，显示型号、占用率、显存占用（DXGI + PDH 采集）
- **磁盘**：占用率 + 实时读写速度（MB/s）
- **网络**：实时下载 / 上传速度（KB/s）
- **进程**：内存占用 Top 8
- **显示风格**：4 套预设 + 分模块自定义（见下）
- **系统托盘**：显示/隐藏、置顶/取消置顶、打开设置、退出
- **全局快捷键**：`Ctrl + Alt + M` 切换显示/隐藏
- **透明窗口**：主窗口整体透明度 20%~100%（前端 CSS opacity 实现）

## 显示风格

设置 →「显示风格」，四个预设按钮一键整套切换：

| 预设 | 布局 | 说明 |
|---|---|---|
| 默认 | 单列 | CPU 圆环+曲线，内存/GPU/磁盘 进度条，网络 双指标卡片 |
| 曲线 | 单列 | 所有模块迷你折线图（sparkline），趋势一目了然 |
| 极简 | 单列 | 每个模块压缩成一行"名称 + 数值"，最省桌面空间 |
| 双列 | 双列网格 | 模块两列排布，窗口变矮，适合贴屏幕侧边 |

分模块自定义：每个模块有独立下拉框（CPU：圆环/迷你曲线/进度条/纯文字；内存/GPU/磁盘：进度条/迷你曲线/纯文字；网络：默认卡片/纯文字/迷你曲线）。改动任意下拉自动进入「自定义」模式，改回预设按钮即整套套用。

风格数据流：设置窗口保存 → Rust 端 `update_settings` 持久化并广播 `settings-changed` 事件 → 主窗口收到后重新应用（字号/颜色/透明度/风格/桌面位置全部实时生效）。

## 设置项（独立设置窗口）

- 始终置顶（实时生效）
- 开机自启动
- 关闭行为：最小化到托盘 / 直接退出
- 桌面位置：悬浮自由拖动 / 固定右上角 / 固定左上角
- 文字颜色（7 种预设）
- 窗口透明度（20% ~ 100%）
- 字号（10 ~ 18）
- 显示风格（4 预设 + 5 个模块下拉）

设置持久化在 `%APPDATA%\com.duan.sys-monitor\settings.json`（字段带 serde 默认值，旧配置文件向前兼容）。

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | HTML + CSS + TypeScript + Vite |
| 桌面框架 | Tauri 2 |
| 后端 | Rust（sysinfo + DXGI/PDH 采集） |
| 托盘 / 全局快捷键 | Tauri tray API / tauri-plugin-global-shortcut |

## 目录结构

```
sys_monitor_tauri/
├── index.html            # 主窗口与设置窗口共用（按 window.label 区分）
├── src/
│   ├── main.ts           # 前端逻辑：多渲染器动态渲染、曲线历史缓存、设置同步、拖动/缩放
│   ├── styles.css        # 全部样式（字号走 --font-size-base 变量；单列/双列布局）
│   └── assets/
├── src-tauri/
│   ├── tauri.conf.json   # 应用配置（窗口、bundle、identifier）
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs       # 入口
│       ├── lib.rs        # 命令注册、托盘、设置窗口、settings-changed 广播
│       ├── monitor.rs    # 2Hz 主循环采集 + GPU 独立线程缓存
│       ├── gpu.rs        # GPU 采集（DXGI 枚举 + PDH 计数器）
│       └── settings.rs   # Settings 结构（含风格字段）+ JSON 持久化
└── dist/                 # 前端构建产物
```

## 开发

```bash
# 前端依赖
npm install

# 调试运行（自动编译 Rust + 打开窗口，热更新）
npx tauri dev
```

环境要求：

- Rust（stable，含 MSVC 工具链）
- Node.js 18+
- WebView2（Win10/11 自带）

## 构建

```bash
# 只出 exe（推荐，跳过安装包打包）
npx tauri build --no-bundle

# 完整打包（release exe + MSI/NSIS 安装包）
npx tauri build
```

产物位置：

- exe：`src-tauri\target\release\sys_monitor_tauri.exe`（单文件，可直接运行）
- MSI：`src-tauri\target\release\bundle\msi\`

> 注意：MSI 打包需要 WiX 工具（首次自动从 GitHub 下载 `WixTools314`）。若国内网络下载不完整导致 `light.exe` 失败，用 `--no-bundle` 出 exe 即可，功能不受影响。

## 部署位置

- 运行副本：`D:\系统监控\系统监控.exe`
- 桌面快捷方式：`系统监控.lnk`
- 更新方式：重新编译后，把 `target\release\sys_monitor_tauri.exe` 覆盖到 `D:\系统监控\系统监控.exe`（注意先退出运行中的实例，单实例锁会拦截新进程启动）

## 窗口特性

- 主窗口默认 320×480，可调范围 280×360 ~ 600×900；无边框（decorations=false）、透明（transparent=true）
- 标题栏整条可拖动（`startDragging`）；右下角斜纹手柄拖动调整大小（`startResizeDragging("SouthEast")`，需在 capabilities 里授权 `core:window:allow-start-resize-dragging`）
- 设置窗口是独立窗口（label=`settings`，默认 380×680，系统标题栏），打开后主窗口仍可自由拖动
- 双列网格用 `repeat(2, minmax(0, 1fr))`：防止长 GPU 名的 min-content 撑爆列宽把第二列挤出窗口

## 踩坑记录（重要）

- **透明度**：Win32 `SetLayeredWindowAttributes` 对 Tauri 透明窗口无效（tao 使用 `WS_EX_NOREDIRECTIONBITMAP`），改用前端 CSS `opacity` 控制主窗口 body。
- **设置不生效**：Rust `Settings` 结构体字段必须与前端发送的 JSON 对齐；多出的字段（如历史遗留 `trayStyle`）要加 `#[serde(default)]`，否则 `update_settings` 反序列化静默失败，且前端 `catch {}` 会吞掉错误。
- **两个 webview 不互通**：设置窗口和主窗口是独立 DOM，任何设置变更必须由后端 `app.emit("settings-changed", ...)` 广播，主窗口监听后重新应用。
- **窄列文字挤压**：卡片标题保底 `min-width: 3em`、数值 `flex-shrink: 0`、长文本用内层 span 做省略号，避免"网络"标签被挤没。
- **Tauri JS API 枚举**：`startResizeDragging` 的方向值是 PascalCase（`"SouthEast"`），不是小写驼峰。

## 说明

- 温度功能（CPU/硬盘温度）已移除：本机 CPU 无 ACPI 热区、硬盘温度走 SMART 需大量原始 FFI，获取不到，按需求删除。

- 原 Flutter 版本（`E:\Code\sys_monitor`）已由本 Tauri 版本替代。

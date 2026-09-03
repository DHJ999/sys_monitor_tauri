use std::fs;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub auto_start: bool,
    pub close_action: String,
    // 前端不传此字段（历史遗留），允许缺失，否则 update_settings 反序列化永远失败
    #[serde(default)]
    pub tray_style: String,
    pub desktop_mode: String,
    pub text_color: String,
    pub font_size: f64,
    pub opacity: f64,
    pub always_on_top: bool,

    // ── 显示样式（新增字段均带默认值，兼容旧 settings.json）──
    // 风格预设：default | curve | minimal | cards | custom
    #[serde(default = "def_style")]
    pub style_preset: String,
    // 布局：list（单列）| grid（双列卡片）
    #[serde(default = "def_layout")]
    pub layout: String,
    // 各模块显示方式：cpu = ring|spark|bar|text；mem/gpu/disk = bar|spark|text；net = text|spark
    #[serde(default = "def_cpu")]
    pub cpu_display: String,
    #[serde(default = "def_mem")]
    pub mem_display: String,
    #[serde(default = "def_gpu")]
    pub gpu_display: String,
    #[serde(default = "def_disk")]
    pub disk_display: String,
    #[serde(default = "def_net")]
    pub net_display: String,
}

fn def_style() -> String { "default".into() }
fn def_layout() -> String { "list".into() }
fn def_cpu() -> String { "ring".into() }
fn def_mem() -> String { "bar".into() }
fn def_gpu() -> String { "bar".into() }
fn def_disk() -> String { "bar".into() }
fn def_net() -> String { "text".into() }

impl Default for Settings {
    fn default() -> Self {
        Self {
            auto_start: false,
            close_action: "toTray".into(),
            tray_style: "simple".into(),
            desktop_mode: "floating".into(),
            text_color: "#FFFFFF".into(),
            font_size: 12.0,
            opacity: 1.0,
            always_on_top: true,
            style_preset: def_style(),
            layout: def_layout(),
            cpu_display: def_cpu(),
            mem_display: def_mem(),
            gpu_display: def_gpu(),
            disk_display: def_disk(),
            net_display: def_net(),
        }
    }
}

pub struct AppState {
    pub settings: Mutex<Settings>,
}

impl AppState {
    pub fn load(app: &AppHandle) -> Self {
        let path = settings_path(app);
        let settings = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            settings: Mutex::new(settings),
        }
    }

    pub fn save(&self, app: &AppHandle) {
        let s = self.settings.lock().unwrap().clone();
        let path = settings_path(app);
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(path, serde_json::to_string_pretty(&s).unwrap());
    }
}

fn settings_path(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("settings.json")
}

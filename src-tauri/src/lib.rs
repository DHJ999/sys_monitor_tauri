use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindowBuilder};

mod gpu;
mod monitor;
mod settings;

use settings::{AppState, Settings};

// ─── 前端可调用的命令 ──────────────────────────────────────

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn update_settings(app: AppHandle, state: State<AppState>, settings: Settings) {
    {
        let mut cur = state.settings.lock().unwrap();
        // 自启动开关变化 → 同步注册表（HKCU，无需管理员）
        if cur.auto_start != settings.auto_start {
            use tauri_plugin_autostart::ManagerExt;
            let autostart = app.autolaunch();
            if settings.auto_start {
                let _ = autostart.enable();
            } else {
                let _ = autostart.disable();
            }
        }
        // 透明度由前端 CSS opacity 处理（Win32 LWA_ALPHA 对 NOREDIRECTIONBITMAP 窗口无效）
        if cur.always_on_top != settings.always_on_top {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_always_on_top(settings.always_on_top);
            }
        }
        *cur = settings;
    }
    state.save(&app);
    // 广播给所有窗口（设置窗口与主窗口是两个独立 webview，主窗口需收到后重新应用字号/颜色/位置）
    let latest = state.settings.lock().unwrap().clone();
    let _ = app.emit("settings-changed", latest);
}

/// 关闭：按设置决定「退出」还是「缩到托盘」
#[tauri::command]
fn request_close(app: AppHandle, state: State<AppState>) {
    let action = state.settings.lock().unwrap().close_action.clone();
    if action == "exit" {
        app.exit(0);
    } else if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

#[tauri::command]
fn toggle_window(app: AppHandle) {
    toggle_main_window(&app);
}

#[tauri::command]
fn set_always_on_top(app: AppHandle, on: bool) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_always_on_top(on);
    }
}

/// 打开设置窗口（独立窗口）
#[tauri::command]
async fn open_settings_window(app: AppHandle) -> Result<(), String> {
    // 如果设置窗口已存在，聚焦它
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }

    let settings_window = WebviewWindowBuilder::new(
        &app,
        "settings",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("设置")
    .inner_size(380.0, 680.0)
    .min_inner_size(320.0, 420.0)
    .resizable(true)
    .decorations(true)
    .transparent(false)
    .always_on_top(true)
    .skip_taskbar(false)
    .build()
    .map_err(|e| e.to_string())?;

    // 发送当前设置到设置窗口
    let _ = settings_window.emit("open-settings", ());

    Ok(())
}

// ─── 窗口显隐 ──────────────────────────────────────

/// 从托盘切换「置顶/取消置顶」：与 update_settings 保持一致的持久化 + 广播，
/// 否则设置面板的「始终置顶」勾选框会显示过期值，且后续其他设置变更可能把它改回来。
fn set_always_on_top_synced(app: &AppHandle, on: bool) {
    {
        let state = app.state::<AppState>();
        let mut s = state.settings.lock().unwrap();
        if s.always_on_top == on {
            // 值未变化，仅保证窗口状态一致后直接返回
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_always_on_top(on);
            }
            return;
        }
        s.always_on_top = on;
        let latest = s.clone();
        state.save(app);
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.set_always_on_top(on);
        }
        let _ = app.emit("settings-changed", latest);
    }
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

// ─── 系统托盘 ──────────────────────────────────────

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_hide = MenuItem::with_id(app, "toggle", "显示/隐藏", true, None::<&str>)?;
    let always_top = MenuItem::with_id(app, "always_top", "置顶", true, None::<&str>)?;
    let cancel_top = MenuItem::with_id(app, "cancel_top", "取消置顶", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let settings_item = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &show_hide,
            &sep,
            &always_top,
            &cancel_top,
            &sep,
            &settings_item,
            &quit,
        ],
    )?;

    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("系统监控")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => toggle_main_window(app),
            "always_top" => set_always_on_top_synced(app, true),
            "cancel_top" => set_always_on_top_synced(app, false),
            "settings" => {
                let _ = app.emit("open-settings", ());
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

// ─── 启动 ──────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts(["ctrl+alt+m"])
                .expect("fail to register ctrl+alt+m")
                .with_handler(|app, _shortcut, event| {
                    use tauri_plugin_global_shortcut::ShortcutState;
                    if event.state == ShortcutState::Pressed {
                        toggle_main_window(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let handle = app.handle();
            handle.manage(AppState::load(handle));
            // 应用已保存的自启动设置
            {
                let state = handle.state::<AppState>();
                let s = state.settings.lock().unwrap();
                use tauri_plugin_autostart::ManagerExt;
                let autostart = handle.autolaunch();
                if s.auto_start {
                    let _ = autostart.enable();
                } else {
                    let _ = autostart.disable();
                }
                // 应用已保存的置顶设置
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.set_always_on_top(s.always_on_top);
                }
            }
            setup_tray(handle)?;
            monitor::start_monitor(handle.clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let state = window.app_handle().state::<AppState>();
                    let action = state.settings.lock().unwrap().close_action.clone();
                    if action != "exit" {
                        // 缩到托盘
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            update_settings,
            request_close,
            toggle_window,
            set_always_on_top,
            open_settings_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#![allow(unexpected_cfgs)]

mod commands;
mod tray;

use tauri::Manager;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::get_app_version,
            commands::set_badge_count,
            commands::start_window_drag,
        ])
        .setup(|app| {
            tray::create_tray(app.handle())?;

            // Build native macOS menu (enables Cmd+C/V/X/A/Z and Cmd+R)
            let handle = app.handle();

            let app_menu = Submenu::with_items(
                handle,
                "Codecast",
                true,
                &[
                    &PredefinedMenuItem::about(handle, Some("About Codecast"), None)?,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::hide(handle, None)?,
                    &PredefinedMenuItem::hide_others(handle, None)?,
                    &PredefinedMenuItem::show_all(handle, None)?,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::quit(handle, None)?,
                ],
            )?;

            let edit_menu = Submenu::with_items(
                handle,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(handle, None)?,
                    &PredefinedMenuItem::redo(handle, None)?,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::cut(handle, None)?,
                    &PredefinedMenuItem::copy(handle, None)?,
                    &PredefinedMenuItem::paste(handle, None)?,
                    &PredefinedMenuItem::select_all(handle, None)?,
                ],
            )?;

            let reload_item = MenuItem::with_id(handle, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;
            let hard_reload_item = MenuItem::with_id(handle, "hard_reload", "Hard Reload", true, Some("CmdOrCtrl+Shift+R"))?;
            let view_menu = Submenu::with_items(
                handle,
                "View",
                true,
                &[
                    &reload_item,
                    &hard_reload_item,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::fullscreen(handle, None)?,
                ],
            )?;

            let window_menu = Submenu::with_items(
                handle,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(handle, None)?,
                    &PredefinedMenuItem::maximize(handle, None)?,
                    &PredefinedMenuItem::close_window(handle, None)?,
                ],
            )?;

            let menu = Menu::with_items(handle, &[&app_menu, &edit_menu, &view_menu, &window_menu])?;
            app.set_menu(menu)?;

            // Inject desktop flag for remote URL detection
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.eval("document.documentElement.classList.add('tauri-desktop')");
            }

            app.on_menu_event(move |app, event| {
                match event.id().as_ref() {
                    "reload" | "hard_reload" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.eval("location.reload()");
                        }
                    }
                    _ => {}
                }
            });

            let shortcut_handle = app.handle().clone();
            let shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::ALT), Code::Space);
            app.handle().global_shortcut().on_shortcut(
                shortcut,
                move |_app, _shortcut, _event| {
                    if let Some(w) = shortcut_handle.get_webview_window("main") {
                        if w.is_visible().unwrap_or(false) {
                            let _ = w.hide();
                        } else {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                },
            )?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

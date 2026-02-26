#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub fn start_window_drag(window: tauri::Window) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

#[allow(deprecated)]
#[tauri::command]
pub fn set_badge_count(count: u32) {
    #[cfg(target_os = "macos")]
    unsafe {
        use objc::{class, msg_send, sel, sel_impl};

        let app: cocoa::base::id = msg_send![class!(NSApplication), sharedApplication];
        let dock_tile: cocoa::base::id = msg_send![app, dockTile];
        let label_str = if count == 0 {
            String::new()
        } else {
            count.to_string()
        };
        let ns_string: cocoa::base::id = msg_send![class!(NSString), alloc];
        let bytes = label_str.as_ptr();
        let len = label_str.len();
        let ns_string: cocoa::base::id = msg_send![ns_string,
            initWithBytes: bytes
            length: len
            encoding: 4u64 // NSUTF8StringEncoding
        ];
        let _: () = msg_send![dock_tile, setBadgeLabel: ns_string];
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = count;
    }
}

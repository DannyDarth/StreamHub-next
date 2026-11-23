mod adblock;
mod auth;
mod badge;
mod chat;
mod kick;
mod streamlink;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(streamlink::Streams::default())
        .manage(kick::KickFetcher::default())
        .invoke_handler(tauri::generate_handler![
            auth::twitch_login,
            streamlink::watch,
            streamlink::stop,
            streamlink::streamlink_info,
            badge::badge_hide,
            kick::kick_channels,
            kick::kick_browse,
            kick::kick_account,
            kick::kick_followed,
            kick::kick_login,
            kick::kick_logout,
            chat::open_chat,
            chat::close_chat,
        ])
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "Show StreamHub", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit StreamHub", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("StreamHub")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "quit" => {
                        app.state::<streamlink::Streams>().stop_all();
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            badge::create(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // closing the main window keeps StreamHub running in the tray
            if window.label() == "main" {
                match event {
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                        chat::layout_panel(window.app_handle());
                    }
                    _ => {}
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running StreamHub");
}

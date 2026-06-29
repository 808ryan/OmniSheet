use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::window::{Color, Effect, EffectState, EffectsBuilder};
use tauri::{
    App, AppHandle, LogicalPosition, Manager, Rect, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

const QUICK_ADD_LABEL: &str = "quick-add";
const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_MENU_SHOW_MAIN_ID: &str = "show-main";
const TRAY_MENU_SHOW_QUICK_ADD_ID: &str = "show-quick-add";
const TRAY_MENU_EXIT_ID: &str = "exit-app";
const QUICK_ADD_WIDTH: f64 = 420.0;
const QUICK_ADD_HEIGHT: f64 = 560.0;
const QUICK_ADD_TRAY_GAP: f64 = 8.0;
const QUICK_ADD_SCREEN_MARGIN: f64 = 8.0;

pub struct QuickAddTrayState {
    #[allow(dead_code)]
    tray_icon: TrayIcon,
}

pub fn setup(app: &mut App) -> tauri::Result<()> {
    let app_handle = app.handle().clone();
    ensure_macos_regular_activation_policy(&app_handle)?;
    create_quick_add_window(&app_handle)?;
    install_main_window_close_to_tray(&app_handle);

    let tray_menu = build_tray_menu(&app_handle)?;

    let tray_icon = TrayIconBuilder::with_id("quick-add-tray")
        .icon(build_circle_plus_icon())
        .icon_as_template(true)
        .tooltip("Add timesheet entry")
        .menu(&tray_menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_MENU_SHOW_MAIN_ID => {
                if let Err(error) = show_main_window(app) {
                    log::error!("failed to show main window from tray menu: {error}");
                }
            }
            TRAY_MENU_SHOW_QUICK_ADD_ID => {
                if let Err(error) = show_quick_add_window(app) {
                    log::error!("failed to show quick entry window from tray menu: {error}");
                }
            }
            TRAY_MENU_EXIT_ID => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                if let Err(error) = toggle_quick_add_window(tray.app_handle(), rect) {
                    log::error!("failed to toggle quick entry window: {error}");
                }
            }
        })
        .build(app.handle())?;

    app.manage(QuickAddTrayState { tray_icon });

    Ok(())
}

#[cfg(target_os = "macos")]
fn ensure_macos_regular_activation_policy(app: &AppHandle) -> tauri::Result<()> {
    app.set_activation_policy(tauri::ActivationPolicy::Regular)
}

#[cfg(not(target_os = "macos"))]
fn ensure_macos_regular_activation_policy(_app: &AppHandle) -> tauri::Result<()> {
    Ok(())
}

#[tauri::command]
pub fn quick_add_hide_window(app: AppHandle) -> Result<(), String> {
    hide_quick_add_window(&app).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn quick_add_show_main_window(app: AppHandle) -> Result<(), String> {
    show_main_window(&app).map_err(|error| error.to_string())
}

fn build_tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let show_main = MenuItem::with_id(
        app,
        TRAY_MENU_SHOW_MAIN_ID,
        "Show OmniSheet",
        true,
        None::<&str>,
    )?;
    let show_quick_add = MenuItem::with_id(
        app,
        TRAY_MENU_SHOW_QUICK_ADD_ID,
        "Add timesheet entry",
        true,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let exit = MenuItem::with_id(app, TRAY_MENU_EXIT_ID, "Exit", true, None::<&str>)?;

    Menu::with_items(app, &[&show_main, &show_quick_add, &separator, &exit])
}

fn install_main_window_close_to_tray(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        log::warn!("main window not found while installing close-to-tray behavior");
        return;
    };
    let main_window = window.clone();

    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Err(error) = main_window.hide() {
                log::error!("failed to hide main window on close request: {error}");
            }
        }
    });
}

fn hide_quick_add_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(QUICK_ADD_LABEL) {
        window.hide()?;
    }

    Ok(())
}

fn show_main_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        window.show()?;
        window.unminimize()?;
        window.set_focus()?;
    }

    hide_quick_add_window(app)?;

    Ok(())
}

fn create_quick_add_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let builder = WebviewWindowBuilder::new(
        app,
        QUICK_ADD_LABEL,
        WebviewUrl::App("index.html?window=quick-add".into()),
    )
    .title("Quick Entry")
    .inner_size(QUICK_ADD_WIDTH, QUICK_ADD_HEIGHT)
    .min_inner_size(QUICK_ADD_WIDTH, QUICK_ADD_HEIGHT)
    .max_inner_size(QUICK_ADD_WIDTH, QUICK_ADD_HEIGHT)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .background_color(Color(0, 0, 0, 0))
    .shadow(true)
    .effects(
        EffectsBuilder::new()
            .effects([
                Effect::Popover,
                Effect::Acrylic,
                Effect::Mica,
                Effect::Blur,
            ])
            .state(EffectState::Active)
            .radius(18.0)
            .color(Color(245, 248, 252, 128))
            .build(),
    )
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .focused(false);

    builder.build()
}

fn toggle_quick_add_window(app: &AppHandle, tray_rect: Rect) -> tauri::Result<()> {
    let window = match app.get_webview_window(QUICK_ADD_LABEL) {
        Some(window) => window,
        None => create_quick_add_window(app)?,
    };

    if window.is_visible()? {
        window.hide()?;
        return Ok(());
    }

    position_quick_add_window(&window, tray_rect)?;
    window.show()?;
    window.set_focus()?;

    Ok(())
}

fn show_quick_add_window(app: &AppHandle) -> tauri::Result<()> {
    let window = match app.get_webview_window(QUICK_ADD_LABEL) {
        Some(window) => window,
        None => create_quick_add_window(app)?,
    };

    if !window.is_visible()? {
        position_quick_add_window_without_tray_rect(&window)?;
        window.show()?;
    }

    window.set_focus()?;

    Ok(())
}

fn position_quick_add_window(window: &WebviewWindow, tray_rect: Rect) -> tauri::Result<()> {
    let fallback_scale_factor = window.scale_factor().unwrap_or(1.0);
    let tray_physical_position = tray_rect.position.to_physical::<f64>(fallback_scale_factor);
    let tray_physical_size = tray_rect.size.to_physical::<f64>(fallback_scale_factor);
    let tray_center_x = tray_physical_position.x + tray_physical_size.width / 2.0;
    let tray_center_y = tray_physical_position.y + tray_physical_size.height / 2.0;
    let monitor = window.available_monitors().ok().and_then(|monitors| {
        monitors.into_iter().find(|monitor| {
            let work_area = monitor.work_area();
            let left = work_area.position.x as f64;
            let top = work_area.position.y as f64;
            let right = left + work_area.size.width as f64;
            let bottom = top + work_area.size.height as f64;

            tray_center_x >= left
                && tray_center_x <= right
                && tray_center_y >= top
                && tray_center_y <= bottom
        })
    });
    let scale_factor = monitor
        .as_ref()
        .map(|monitor| monitor.scale_factor())
        .unwrap_or(fallback_scale_factor);
    let rect_position = tray_rect.position.to_logical::<f64>(scale_factor);
    let rect_size = tray_rect.size.to_logical::<f64>(scale_factor);
    let tray_center_x = rect_position.x + rect_size.width / 2.0;
    let tray_center_y = rect_position.y + rect_size.height / 2.0;
    let preferred_x = tray_center_x - QUICK_ADD_WIDTH / 2.0;
    let (min_x, max_x, min_y, max_y, work_area_center_y) = monitor
        .as_ref()
        .map(|monitor| {
            let work_area = monitor.work_area();
            let work_area_position = work_area.position.to_logical::<f64>(scale_factor);
            let work_area_size = work_area.size.to_logical::<f64>(scale_factor);
            let work_area_center_y = work_area_position.y + work_area_size.height / 2.0;

            (
                work_area_position.x + QUICK_ADD_SCREEN_MARGIN,
                work_area_position.x + work_area_size.width
                    - QUICK_ADD_WIDTH
                    - QUICK_ADD_SCREEN_MARGIN,
                work_area_position.y + QUICK_ADD_SCREEN_MARGIN,
                work_area_position.y + work_area_size.height
                    - QUICK_ADD_HEIGHT
                    - QUICK_ADD_SCREEN_MARGIN,
                work_area_center_y,
            )
        })
        .unwrap_or((
            QUICK_ADD_SCREEN_MARGIN,
            f64::INFINITY,
            QUICK_ADD_SCREEN_MARGIN,
            f64::INFINITY,
            f64::INFINITY,
        ));
    let preferred_y = if tray_center_y <= work_area_center_y {
        rect_position.y + rect_size.height + QUICK_ADD_TRAY_GAP
    } else {
        rect_position.y - QUICK_ADD_HEIGHT - QUICK_ADD_TRAY_GAP
    };
    let position = LogicalPosition::new(
        clamp_to_window_bounds(preferred_x, min_x, max_x),
        clamp_to_window_bounds(preferred_y, min_y, max_y),
    );

    window.set_position(position)
}

fn position_quick_add_window_without_tray_rect(window: &WebviewWindow) -> tauri::Result<()> {
    let monitor = match window.current_monitor()? {
        Some(monitor) => Some(monitor),
        None => window.primary_monitor()?,
    };

    let Some(monitor) = monitor else {
        return window.center();
    };

    let scale_factor = monitor.scale_factor();
    let work_area = monitor.work_area();
    let work_area_position = work_area.position.to_logical::<f64>(scale_factor);
    let work_area_size = work_area.size.to_logical::<f64>(scale_factor);
    let min_x = work_area_position.x + QUICK_ADD_SCREEN_MARGIN;
    let max_x =
        work_area_position.x + work_area_size.width - QUICK_ADD_WIDTH - QUICK_ADD_SCREEN_MARGIN;
    let min_y = work_area_position.y + QUICK_ADD_SCREEN_MARGIN;
    let max_y =
        work_area_position.y + work_area_size.height - QUICK_ADD_HEIGHT - QUICK_ADD_SCREEN_MARGIN;
    let position = LogicalPosition::new(
        clamp_to_window_bounds(max_x, min_x, max_x),
        clamp_to_window_bounds(max_y, min_y, max_y),
    );

    window.set_position(position)
}

fn clamp_to_window_bounds(value: f64, min: f64, max: f64) -> f64 {
    value.clamp(min, max.max(min))
}

fn build_circle_plus_icon() -> Image<'static> {
    const SIZE: u32 = 64;
    const CENTER: f32 = 31.5;
    const RADIUS: f32 = 24.0;
    const CIRCLE_STROKE: f32 = 6.5;
    const PLUS_HALF_LENGTH: f32 = 14.0;
    const PLUS_STROKE: f32 = 7.0;

    let mut rgba = Vec::with_capacity((SIZE * SIZE * 4) as usize);

    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 - CENTER;
            let dy = y as f32 - CENTER;
            let distance = (dx * dx + dy * dy).sqrt();
            let circle_alpha = antialias(CIRCLE_STROKE / 2.0 - (distance - RADIUS).abs());
            let horizontal_alpha = antialias(rect_signed_distance(
                dx,
                dy,
                PLUS_HALF_LENGTH,
                PLUS_STROKE / 2.0,
            ));
            let vertical_alpha = antialias(rect_signed_distance(
                dx,
                dy,
                PLUS_STROKE / 2.0,
                PLUS_HALF_LENGTH,
            ));
            let alpha = circle_alpha.max(horizontal_alpha).max(vertical_alpha);

            rgba.extend_from_slice(&[0, 0, 0, (alpha * 255.0).round() as u8]);
        }
    }

    Image::new_owned(rgba, SIZE, SIZE)
}

fn antialias(signed_distance: f32) -> f32 {
    const EDGE_WIDTH: f32 = 1.25;

    ((signed_distance + EDGE_WIDTH) / (EDGE_WIDTH * 2.0)).clamp(0.0, 1.0)
}

fn rect_signed_distance(dx: f32, dy: f32, half_width: f32, half_height: f32) -> f32 {
    (half_width - dx.abs()).min(half_height - dy.abs())
}

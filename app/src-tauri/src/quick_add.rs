use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::window::{Color, Effect, EffectState, EffectsBuilder};
use tauri::{
    App, AppHandle, LogicalPosition, LogicalSize, Manager, Monitor, Rect, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const QUICK_ADD_LABEL: &str = "quick-add";
const MAIN_WINDOW_LABEL: &str = "main";
const QUICK_ADD_TRAY_ID: &str = "quick-add-tray";
const TRAY_MENU_SHOW_MAIN_ID: &str = "show-main";
const TRAY_MENU_SHOW_QUICK_ADD_ID: &str = "show-quick-add";
const TRAY_MENU_EXIT_ID: &str = "exit-app";
const QUICK_ADD_WIDTH: f64 = 420.0;
const QUICK_ADD_MIN_HEIGHT: f64 = 260.0;
const QUICK_ADD_MAX_HEIGHT: f64 = 680.0;
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

    let tray_icon_builder =
        TrayIconBuilder::with_id(QUICK_ADD_TRAY_ID).icon(build_quick_add_tray_icon()?);
    #[cfg(target_os = "macos")]
    let tray_icon_builder = tray_icon_builder.icon_as_template(true);
    #[cfg(not(target_os = "macos"))]
    let tray_icon_builder = tray_icon_builder.icon_as_template(false);

    let tray_icon = tray_icon_builder
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
                if let Err(error) = handle_tray_icon_left_click(tray.app_handle(), rect) {
                    log::error!("failed to handle quick add tray icon click: {error}");
                }
            }
        })
        .build(app.handle())?;

    app.manage(QuickAddTrayState { tray_icon });
    register_quick_add_global_shortcut(&app_handle);

    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn register_quick_add_global_shortcut(app: &AppHandle) {
    let shortcut = quick_add_global_shortcut();
    let shortcut_for_handler = shortcut.clone();
    let plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(move |app, pressed_shortcut, event| {
            if pressed_shortcut != &shortcut_for_handler || event.state() != ShortcutState::Pressed
            {
                return;
            }

            log::info!("quick add global shortcut triggered");
            if let Err(error) = toggle_quick_add_window_from_shortcut(app) {
                log::error!("failed to toggle quick entry window from shortcut: {error}");
            }
        })
        .build();

    if let Err(error) = app.plugin(plugin) {
        log::warn!("failed to initialize quick add global shortcut plugin: {error}");
        return;
    }

    if let Err(error) = app.global_shortcut().register(shortcut) {
        log::warn!("failed to register quick add global shortcut: {error}");
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn register_quick_add_global_shortcut(_app: &AppHandle) {}

#[cfg(target_os = "macos")]
fn quick_add_global_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::SUPER | Modifiers::ALT), Code::KeyO)
}

#[cfg(not(target_os = "macos"))]
#[cfg(any(target_os = "windows", target_os = "linux"))]
fn quick_add_global_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyO)
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

#[tauri::command]
pub fn quick_add_resize_window(app: AppHandle, height: f64) -> Result<(), String> {
    resize_quick_add_window(&app, height).map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
pub fn handle_app_reopen(app: &AppHandle, has_visible_windows: bool) {
    if has_visible_windows {
        return;
    }

    if let Err(error) = show_main_window(app) {
        log::error!("failed to show main window from macOS app reopen: {error}");
    }
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

fn handle_tray_icon_left_click(app: &AppHandle, tray_rect: Rect) -> tauri::Result<()> {
    toggle_quick_add_window(app, tray_rect)
}

fn hide_quick_add_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(QUICK_ADD_LABEL) {
        window.hide()?;
    }

    Ok(())
}

fn show_main_window(app: &AppHandle) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    app.show()?;

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
    .inner_size(QUICK_ADD_WIDTH, QUICK_ADD_MAX_HEIGHT)
    .min_inner_size(QUICK_ADD_WIDTH, QUICK_ADD_MIN_HEIGHT)
    .max_inner_size(QUICK_ADD_WIDTH, QUICK_ADD_MAX_HEIGHT)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .background_color(Color(0, 0, 0, 0))
    .shadow(true)
    .effects(
        EffectsBuilder::new()
            .effects([Effect::Popover, Effect::Acrylic, Effect::Mica, Effect::Blur])
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

fn resize_quick_add_window(app: &AppHandle, requested_height: f64) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window(QUICK_ADD_LABEL) else {
        return Ok(());
    };

    if !requested_height.is_finite() {
        return Ok(());
    }

    let height = requested_height.clamp(QUICK_ADD_MIN_HEIGHT, QUICK_ADD_MAX_HEIGHT);
    let current_height = quick_add_window_height(&window, window.scale_factor().unwrap_or(1.0));

    if (current_height - height).abs() < 1.0 {
        return Ok(());
    }

    window.set_size(LogicalSize::new(QUICK_ADD_WIDTH, height))?;

    if window.is_visible()? {
        position_quick_add_window_for_current_anchor(app, &window)?;
    }

    Ok(())
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

    if !position_quick_add_window(&window, tray_rect)? {
        position_quick_add_window_at_platform_fallback(app, &window)?;
    }

    show_and_focus_quick_add_window(&window)?;

    Ok(())
}

fn toggle_quick_add_window_from_shortcut(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(QUICK_ADD_LABEL) {
        if window.is_visible()? {
            window.hide()?;
            return Ok(());
        }
    }

    show_quick_add_window(app)
}

fn show_quick_add_window(app: &AppHandle) -> tauri::Result<()> {
    let window = match app.get_webview_window(QUICK_ADD_LABEL) {
        Some(window) => window,
        None => create_quick_add_window(app)?,
    };

    if !window.is_visible()? {
        position_quick_add_window_for_current_anchor(app, &window)?;
    }

    show_and_focus_quick_add_window(&window)?;

    Ok(())
}

fn show_and_focus_quick_add_window(window: &WebviewWindow) -> tauri::Result<()> {
    window.show()?;
    window.unminimize()?;

    #[cfg(target_os = "windows")]
    {
        window.set_always_on_top(false)?;
        window.set_always_on_top(true)?;
    }

    window.set_focus()
}

fn position_quick_add_window_for_current_anchor(
    app: &AppHandle,
    window: &WebviewWindow,
) -> tauri::Result<()> {
    let anchored_to_tray = if let Some(rect) = quick_add_tray_rect(app) {
        position_quick_add_window(window, rect)?
    } else {
        false
    };

    if !anchored_to_tray {
        position_quick_add_window_at_platform_fallback(app, window)?;
    }

    Ok(())
}

fn quick_add_tray_rect(app: &AppHandle) -> Option<Rect> {
    let tray_icon = app.tray_by_id(QUICK_ADD_TRAY_ID)?;

    match tray_icon.rect() {
        Ok(Some(rect)) if is_usable_tray_rect(&rect) => Some(rect),
        Ok(Some(rect)) => {
            let rect_position = rect.position.to_physical::<f64>(1.0);
            let rect_size = rect.size.to_physical::<f64>(1.0);
            log::info!(
                "quick add tray icon rect was not usable; using platform fallback: position=({}, {}), size=({}, {})",
                rect_position.x,
                rect_position.y,
                rect_size.width,
                rect_size.height
            );
            None
        }
        Ok(None) => {
            log::info!("quick add tray icon rect unavailable; using platform fallback");
            None
        }
        Err(error) => {
            log::warn!("failed to read quick add tray icon rect: {error}");
            None
        }
    }
}

fn is_usable_tray_rect(rect: &Rect) -> bool {
    let rect_position = rect.position.to_physical::<f64>(1.0);
    let rect_size = rect.size.to_physical::<f64>(1.0);

    rect_position.x.is_finite()
        && rect_position.y.is_finite()
        && rect_size.width.is_finite()
        && rect_size.height.is_finite()
        && rect_size.width > 1.0
        && rect_size.height > 1.0
}

fn position_quick_add_window(window: &WebviewWindow, tray_rect: Rect) -> tauri::Result<bool> {
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

    let Some(monitor) = monitor else {
        log::info!(
            "quick add tray icon rect did not resolve to a monitor; using platform fallback"
        );
        return Ok(false);
    };

    let scale_factor = monitor.scale_factor();
    let rect_position = tray_rect.position.to_logical::<f64>(scale_factor);
    let rect_size = tray_rect.size.to_logical::<f64>(scale_factor);
    let tray_center_x = rect_position.x + rect_size.width / 2.0;
    let tray_center_y = rect_position.y + rect_size.height / 2.0;
    let preferred_x = tray_center_x - QUICK_ADD_WIDTH / 2.0;
    let work_area = monitor.work_area();
    let work_area_position = work_area.position.to_logical::<f64>(scale_factor);
    let work_area_size = work_area.size.to_logical::<f64>(scale_factor);
    let work_area_center_y = work_area_position.y + work_area_size.height / 2.0;
    let min_x = work_area_position.x + QUICK_ADD_SCREEN_MARGIN;
    let max_x =
        work_area_position.x + work_area_size.width - QUICK_ADD_WIDTH - QUICK_ADD_SCREEN_MARGIN;
    let min_y = work_area_position.y + QUICK_ADD_SCREEN_MARGIN;
    let height = quick_add_window_height(window, scale_factor);
    let max_y = work_area_position.y + work_area_size.height - height - QUICK_ADD_SCREEN_MARGIN;
    let preferred_y = if tray_center_y <= work_area_center_y {
        rect_position.y + rect_size.height + QUICK_ADD_TRAY_GAP
    } else {
        rect_position.y - height - QUICK_ADD_TRAY_GAP
    };
    let position = LogicalPosition::new(
        clamp_to_window_bounds(preferred_x, min_x, max_x),
        clamp_to_window_bounds(preferred_y, min_y, max_y),
    );

    window.set_position(position)?;

    Ok(true)
}

fn position_quick_add_window_at_platform_fallback(
    app: &AppHandle,
    window: &WebviewWindow,
) -> tauri::Result<()> {
    let monitor = quick_add_fallback_monitor(app, window)?;

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
    let height = quick_add_window_height(window, scale_factor);
    let max_y = work_area_position.y + work_area_size.height - height - QUICK_ADD_SCREEN_MARGIN;
    #[cfg(target_os = "macos")]
    let (preferred_x, preferred_y) = {
        log::info!("positioning quick add at macOS menu-bar center fallback");
        (
            work_area_position.x + (work_area_size.width - QUICK_ADD_WIDTH) / 2.0,
            min_y,
        )
    };
    #[cfg(not(target_os = "macos"))]
    let (preferred_x, preferred_y) = {
        log::info!("positioning quick add at taskbar-corner fallback");
        (max_x, max_y)
    };
    let position = LogicalPosition::new(
        clamp_to_window_bounds(preferred_x, min_x, max_x),
        clamp_to_window_bounds(preferred_y, min_y, max_y),
    );

    window.set_position(position)
}

fn quick_add_fallback_monitor(
    app: &AppHandle,
    window: &WebviewWindow,
) -> tauri::Result<Option<Monitor>> {
    if let Ok(cursor_position) = app.cursor_position() {
        if let Some(monitor) = app.monitor_from_point(cursor_position.x, cursor_position.y)? {
            return Ok(Some(monitor));
        }
    }

    if let Some(monitor) = window.current_monitor()? {
        return Ok(Some(monitor));
    }

    app.primary_monitor()
}

fn quick_add_window_height(window: &WebviewWindow, scale_factor: f64) -> f64 {
    window
        .inner_size()
        .map(|size| size.to_logical::<f64>(scale_factor).height)
        .unwrap_or(QUICK_ADD_MAX_HEIGHT)
        .clamp(QUICK_ADD_MIN_HEIGHT, QUICK_ADD_MAX_HEIGHT)
}

fn clamp_to_window_bounds(value: f64, min: f64, max: f64) -> f64 {
    value.clamp(min, max.max(min))
}

fn build_quick_add_tray_icon() -> tauri::Result<Image<'static>> {
    #[cfg(target_os = "macos")]
    {
        let source = Image::from_bytes(include_bytes!("../icons/icon.png"))?.to_owned();

        Ok(build_macos_template_tray_icon(source))
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(Image::from_bytes(include_bytes!("../icons/32x32.png"))?.to_owned())
    }
}

#[cfg(target_os = "macos")]
fn build_macos_template_tray_icon(source: Image<'static>) -> Image<'static> {
    let width = source.width();
    let height = source.height();
    let center_x = (width as f32 - 1.0) / 2.0;
    let center_y = (height as f32 - 1.0) / 2.0;
    let center_cutout_radius = width.min(height) as f32 * 0.245;
    let mut rgba = Vec::with_capacity(source.rgba().len());

    for (index, pixel) in source.rgba().chunks_exact(4).enumerate() {
        let x = (index as u32 % width) as f32;
        let y = (index as u32 / width) as f32;
        let dx = x - center_x;
        let dy = y - center_y;
        let distance = (dx * dx + dy * dy).sqrt();
        let red = pixel[0];
        let green = pixel[1];
        let blue = pixel[2];
        let alpha = pixel[3];
        let keep_outer_logo = distance > center_cutout_radius;
        let keep_clock_hand = is_dark_teal_pixel(red, green, blue, alpha);
        let template_alpha = if keep_outer_logo || keep_clock_hand {
            normalize_template_alpha(alpha)
        } else {
            0
        };

        rgba.extend_from_slice(&[0, 0, 0, template_alpha]);
    }

    Image::new_owned(rgba, width, height)
}

#[cfg(target_os = "macos")]
fn is_dark_teal_pixel(red: u8, green: u8, blue: u8, alpha: u8) -> bool {
    alpha > 40
        && red < 120
        && green > 45
        && blue > 55
        && green.saturating_sub(red) > 20
        && blue.saturating_sub(red) > 20
        && green < 185
        && blue < 200
}

#[cfg(target_os = "macos")]
fn normalize_template_alpha(alpha: u8) -> u8 {
    if alpha < 64 {
        alpha
    } else {
        255
    }
}

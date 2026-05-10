use tauri::image::Image;
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{
    App, AppHandle, LogicalPosition, Manager, Rect, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

const QUICK_ADD_LABEL: &str = "quick-add";
const MAIN_WINDOW_LABEL: &str = "main";
const QUICK_ADD_WIDTH: f64 = 360.0;
const QUICK_ADD_HEIGHT: f64 = 250.0;

pub struct QuickAddTrayState {
    #[allow(dead_code)]
    tray_icon: TrayIcon,
}

pub fn setup(app: &mut App) -> tauri::Result<()> {
    let app_handle = app.handle().clone();
    create_quick_add_window(&app_handle)?;

    let tray_icon = TrayIconBuilder::with_id("quick-add-tray")
        .icon(build_circle_plus_icon())
        .icon_as_template(true)
        .title("+")
        .tooltip("Add timesheet entry")
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                if let Err(error) = toggle_quick_add_window(tray.app_handle(), rect) {
                    log::error!("failed to toggle quick add window: {error}");
                }
            }
        })
        .build(app.handle())?;

    app.manage(QuickAddTrayState { tray_icon });

    Ok(())
}

#[tauri::command]
pub fn quick_add_hide_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(QUICK_ADD_LABEL) {
        window.hide().map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub fn quick_add_show_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        window.show().map_err(|error| error.to_string())?;
        window.unminimize().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
    }

    if let Some(window) = app.get_webview_window(QUICK_ADD_LABEL) {
        window.hide().map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn create_quick_add_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let builder = WebviewWindowBuilder::new(
        app,
        QUICK_ADD_LABEL,
        WebviewUrl::App("index.html?window=quick-add".into()),
    )
    .title("Quick Add")
    .inner_size(QUICK_ADD_WIDTH, QUICK_ADD_HEIGHT)
    .min_inner_size(QUICK_ADD_WIDTH, QUICK_ADD_HEIGHT)
    .max_inner_size(QUICK_ADD_WIDTH, QUICK_ADD_HEIGHT)
    .resizable(false)
    .decorations(false)
    .shadow(true)
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

fn position_quick_add_window(window: &WebviewWindow, tray_rect: Rect) -> tauri::Result<()> {
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let rect_position = tray_rect.position.to_logical::<f64>(scale_factor);
    let rect_size = tray_rect.size.to_logical::<f64>(scale_factor);
    let x = rect_position.x + rect_size.width - QUICK_ADD_WIDTH - 8.0;
    let y = rect_position.y + rect_size.height + 8.0;
    let position = LogicalPosition::new(x.max(8.0), y.max(8.0));

    window.set_position(position)
}

fn build_circle_plus_icon() -> Image<'static> {
    const SIZE: u32 = 32;
    const CENTER: f32 = 15.5;
    const RADIUS: f32 = 11.8;
    const CIRCLE_STROKE: f32 = 2.1;
    const PLUS_HALF_LENGTH: f32 = 6.6;
    const PLUS_STROKE: f32 = 2.3;

    let mut rgba = Vec::with_capacity((SIZE * SIZE * 4) as usize);

    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 - CENTER;
            let dy = y as f32 - CENTER;
            let distance = (dx * dx + dy * dy).sqrt();
            let on_circle = (distance - RADIUS).abs() <= CIRCLE_STROKE / 2.0;
            let on_horizontal = dy.abs() <= PLUS_STROKE / 2.0 && dx.abs() <= PLUS_HALF_LENGTH;
            let on_vertical = dx.abs() <= PLUS_STROKE / 2.0 && dy.abs() <= PLUS_HALF_LENGTH;
            let alpha = if on_circle || on_horizontal || on_vertical {
                255
            } else {
                0
            };

            rgba.extend_from_slice(&[0, 0, 0, alpha]);
        }
    }

    Image::new_owned(rgba, SIZE, SIZE)
}

use std::sync::Mutex;

use rusqlite::Connection;

pub struct AppState {
    pub connection: Mutex<Connection>,
    pub http_client: reqwest::Client,
    pub session_id: String,
    pub app_version: String,
    pub api_key_cache: Mutex<Option<String>>,
}

use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("configuration error: {0}")]
    Config(String),
    #[error("service unavailable: {0}")]
    Service(String),
}

pub type AppResult<T> = Result<T, AppError>;

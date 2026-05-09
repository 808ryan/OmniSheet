use crate::models::{MicrophonePermissionResult, MicrophonePermissionStatus};

pub struct MicrophonePermissionRequestOutcome {
    pub initial_status: MicrophonePermissionStatus,
    pub result: MicrophonePermissionResult,
}

#[cfg(target_os = "macos")]
mod imp {
    use std::sync::mpsc::sync_channel;

    use av_foundation::{
        capture_device::{
            AVAuthorizationStatusAuthorized, AVAuthorizationStatusDenied,
            AVAuthorizationStatusNotDetermined, AVAuthorizationStatusRestricted, AVCaptureDevice,
        },
        media_format::AVMediaTypeAudio,
    };
    use tauri::AppHandle;

    use super::{
        MicrophonePermissionRequestOutcome, MicrophonePermissionResult, MicrophonePermissionStatus,
    };

    fn map_status(status: isize) -> MicrophonePermissionStatus {
        match status {
            AVAuthorizationStatusAuthorized => MicrophonePermissionStatus::Granted,
            AVAuthorizationStatusDenied => MicrophonePermissionStatus::Denied,
            AVAuthorizationStatusRestricted => MicrophonePermissionStatus::Restricted,
            AVAuthorizationStatusNotDetermined => MicrophonePermissionStatus::NotDetermined,
            _ => MicrophonePermissionStatus::NotDetermined,
        }
    }

    fn audio_media_type() -> &'static av_foundation::media_format::AVMediaType {
        // AVFoundation exposes this as an extern static constant. Reading it is safe here
        // because we only borrow the framework-defined immutable media type identifier.
        unsafe { AVMediaTypeAudio }
    }

    pub async fn request_microphone_permission(
        app: &AppHandle,
    ) -> Result<MicrophonePermissionRequestOutcome, String> {
        let initial_status = map_status(AVCaptureDevice::authorization_status_for_media_type(
            audio_media_type(),
        ));

        match initial_status {
            MicrophonePermissionStatus::Granted
            | MicrophonePermissionStatus::Denied
            | MicrophonePermissionStatus::Restricted => Ok(MicrophonePermissionRequestOutcome {
                initial_status,
                result: MicrophonePermissionResult {
                    status: initial_status,
                    requested: false,
                },
            }),
            MicrophonePermissionStatus::NotDetermined => {
                let (tx, rx) = sync_channel::<MicrophonePermissionStatus>(1);

                app.run_on_main_thread(move || {
                    AVCaptureDevice::request_access_for_media_type(
                        audio_media_type(),
                        move |granted| {
                            let status = if granted.as_bool() {
                                MicrophonePermissionStatus::Granted
                            } else {
                                MicrophonePermissionStatus::Denied
                            };
                            let _ = tx.send(status);
                        },
                    );
                })
                .map_err(|error| {
                    format!("failed to request microphone permission on the main thread: {error}")
                })?;

                let final_status = tauri::async_runtime::spawn_blocking(move || {
                    rx.recv().map_err(|error| {
                        format!("failed to receive microphone permission result: {error}")
                    })
                })
                .await
                .map_err(|error| {
                    format!("failed waiting for microphone permission result: {error}")
                })??;

                Ok(MicrophonePermissionRequestOutcome {
                    initial_status,
                    result: MicrophonePermissionResult {
                        status: final_status,
                        requested: true,
                    },
                })
            }
            MicrophonePermissionStatus::Unsupported => Ok(MicrophonePermissionRequestOutcome {
                initial_status,
                result: MicrophonePermissionResult {
                    status: MicrophonePermissionStatus::Unsupported,
                    requested: false,
                },
            }),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use tauri::AppHandle;

    use super::{
        MicrophonePermissionRequestOutcome, MicrophonePermissionResult, MicrophonePermissionStatus,
    };

    pub async fn request_microphone_permission(
        _app: &AppHandle,
    ) -> Result<MicrophonePermissionRequestOutcome, String> {
        Ok(MicrophonePermissionRequestOutcome {
            initial_status: MicrophonePermissionStatus::Unsupported,
            result: MicrophonePermissionResult {
                status: MicrophonePermissionStatus::Unsupported,
                requested: false,
            },
        })
    }
}

pub use imp::request_microphone_permission;

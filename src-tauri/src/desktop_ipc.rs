use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const DESKTOP_IPC_VERSION: u16 = 1;
pub const DESKTOP_IPC_ENDPOINT_FILE: &str = "browser-ipc.json";
pub const MAX_DESKTOP_IPC_MESSAGE_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopIpcEndpoint {
    pub protocol_version: u16,
    pub pipe_name: String,
    pub token: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DesktopIpcRequest {
    protocol_version: u16,
    token: String,
    action: DesktopIpcAction,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum DesktopIpcAction {
    Probe,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum DesktopIpcResponse {
    Ok {
        protocol_version: u16,
        desktop_version: String,
    },
    Error {
        code: DesktopIpcErrorCode,
        retryable: bool,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum DesktopIpcErrorCode {
    InvalidMessage,
    Unauthorized,
    UnsupportedVersion,
}

pub struct DesktopIpcState {
    endpoint_path: PathBuf,
    token: String,
}

impl Drop for DesktopIpcState {
    fn drop(&mut self) {
        let owns_endpoint = read_endpoint(&self.endpoint_path).is_ok_and(|endpoint| {
            constant_time_eq(endpoint.token.as_bytes(), self.token.as_bytes())
        });
        if owns_endpoint {
            let _ = fs::remove_file(&self.endpoint_path);
        }
    }
}

pub fn endpoint_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(DESKTOP_IPC_ENDPOINT_FILE)
}

pub fn read_endpoint(path: &Path) -> io::Result<DesktopIpcEndpoint> {
    let bytes = fs::read(path)?;
    if bytes.len() > MAX_DESKTOP_IPC_MESSAGE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Desktop IPC endpoint metadata exceeds its size limit",
        ));
    }
    let endpoint: DesktopIpcEndpoint = serde_json::from_slice(&bytes).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "Desktop IPC endpoint metadata is invalid",
        )
    })?;
    validate_endpoint(&endpoint)?;
    Ok(endpoint)
}

fn validate_endpoint(endpoint: &DesktopIpcEndpoint) -> io::Result<()> {
    if endpoint.protocol_version != DESKTOP_IPC_VERSION
        || !endpoint
            .pipe_name
            .starts_with(r"\\.\pipe\com.long.translate.browser.")
        || endpoint.pipe_name.len() > 160
        || Uuid::parse_str(&endpoint.token).is_err()
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Desktop IPC endpoint metadata failed validation",
        ));
    }
    Ok(())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

#[cfg(windows)]
mod windows {
    use super::*;
    use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions};

    pub fn start_server(app_data_dir: PathBuf) -> io::Result<DesktopIpcState> {
        fs::create_dir_all(&app_data_dir)?;
        let instance_id = Uuid::new_v4();
        let endpoint = DesktopIpcEndpoint {
            protocol_version: DESKTOP_IPC_VERSION,
            pipe_name: format!(r"\\.\pipe\com.long.translate.browser.{instance_id}"),
            token: Uuid::new_v4().to_string(),
        };
        validate_endpoint(&endpoint)?;

        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .reject_remote_clients(true)
            .create(&endpoint.pipe_name)?;
        let endpoint_path = endpoint_path(&app_data_dir);
        write_endpoint(&endpoint_path, &endpoint)?;

        let state = DesktopIpcState {
            endpoint_path,
            token: endpoint.token.clone(),
        };
        tauri::async_runtime::spawn(run_server(server, endpoint));
        Ok(state)
    }

    async fn run_server(mut server: NamedPipeServer, endpoint: DesktopIpcEndpoint) {
        loop {
            if let Err(error) = server.connect().await {
                log::error!("Desktop IPC listener failed: {error}");
                return;
            }
            let next = match ServerOptions::new()
                .reject_remote_clients(true)
                .create(&endpoint.pipe_name)
            {
                Ok(next) => next,
                Err(error) => {
                    log::error!("Desktop IPC listener could not accept another client: {error}");
                    return;
                }
            };
            let connected = server;
            let client_endpoint = endpoint.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = handle_client(connected, &client_endpoint).await {
                    log::warn!("Desktop IPC client was rejected: {error}");
                }
            });
            server = next;
        }
    }

    async fn handle_client(
        mut stream: NamedPipeServer,
        endpoint: &DesktopIpcEndpoint,
    ) -> io::Result<()> {
        let request = match read_json_frame::<_, DesktopIpcRequest>(&mut stream).await {
            Ok(request) => request,
            Err(error) => {
                let _ = write_json_frame(
                    &mut stream,
                    &DesktopIpcResponse::Error {
                        code: DesktopIpcErrorCode::InvalidMessage,
                        retryable: false,
                    },
                )
                .await;
                return Err(error);
            }
        };

        let response = if request.protocol_version != DESKTOP_IPC_VERSION {
            DesktopIpcResponse::Error {
                code: DesktopIpcErrorCode::UnsupportedVersion,
                retryable: false,
            }
        } else if !constant_time_eq(request.token.as_bytes(), endpoint.token.as_bytes()) {
            DesktopIpcResponse::Error {
                code: DesktopIpcErrorCode::Unauthorized,
                retryable: false,
            }
        } else {
            match request.action {
                DesktopIpcAction::Probe => DesktopIpcResponse::Ok {
                    protocol_version: DESKTOP_IPC_VERSION,
                    desktop_version: env!("CARGO_PKG_VERSION").to_string(),
                },
            }
        };
        write_json_frame(&mut stream, &response).await
    }

    pub async fn probe(endpoint_path: &Path) -> io::Result<String> {
        let endpoint = read_endpoint(endpoint_path)?;
        probe_endpoint(&endpoint).await
    }

    async fn probe_endpoint(endpoint: &DesktopIpcEndpoint) -> io::Result<String> {
        let mut stream = ClientOptions::new().open(&endpoint.pipe_name)?;
        write_json_frame(
            &mut stream,
            &DesktopIpcRequest {
                protocol_version: DESKTOP_IPC_VERSION,
                token: endpoint.token.clone(),
                action: DesktopIpcAction::Probe,
            },
        )
        .await?;
        match read_json_frame::<_, DesktopIpcResponse>(&mut stream).await? {
            DesktopIpcResponse::Ok {
                protocol_version: DESKTOP_IPC_VERSION,
                desktop_version,
            } => Ok(desktop_version),
            DesktopIpcResponse::Ok { .. } => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Desktop IPC response uses an unsupported version",
            )),
            DesktopIpcResponse::Error { code, .. } => Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("Desktop IPC request failed: {code:?}"),
            )),
        }
    }

    async fn read_json_frame<R, T>(reader: &mut R) -> io::Result<T>
    where
        R: AsyncRead + Unpin,
        T: for<'de> Deserialize<'de>,
    {
        let mut prefix = [0_u8; 4];
        reader.read_exact(&mut prefix).await?;
        let message_size = u32::from_le_bytes(prefix) as usize;
        if message_size == 0 || message_size > MAX_DESKTOP_IPC_MESSAGE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Desktop IPC message exceeds its size limit",
            ));
        }
        let mut message = vec![0_u8; message_size];
        reader.read_exact(&mut message).await?;
        serde_json::from_slice(&message).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidData, "Desktop IPC message is invalid")
        })
    }

    async fn write_json_frame<W, T>(writer: &mut W, value: &T) -> io::Result<()>
    where
        W: AsyncWrite + Unpin,
        T: Serialize,
    {
        let payload = serde_json::to_vec(value).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "Desktop IPC response is invalid",
            )
        })?;
        if payload.is_empty() || payload.len() > MAX_DESKTOP_IPC_MESSAGE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Desktop IPC message exceeds its size limit",
            ));
        }
        writer
            .write_all(&(payload.len() as u32).to_le_bytes())
            .await?;
        writer.write_all(&payload).await?;
        writer.flush().await
    }

    fn write_endpoint(path: &Path, endpoint: &DesktopIpcEndpoint) -> io::Result<()> {
        let payload = serde_json::to_vec(endpoint).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "Desktop IPC endpoint metadata could not be serialized",
            )
        })?;
        let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
        fs::write(&temporary, payload)?;
        if path.exists() {
            fs::remove_file(path)?;
        }
        if let Err(error) = fs::rename(&temporary, path) {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn temporary_app_dir() -> PathBuf {
            std::env::temp_dir().join(format!("long-translate-ipc-{}", Uuid::new_v4()))
        }

        #[tokio::test]
        async fn authenticated_probe_reaches_the_running_desktop_server() {
            let app_dir = temporary_app_dir();
            let state = start_server(app_dir.clone()).unwrap();
            let version = probe(&endpoint_path(&app_dir)).await.unwrap();
            assert_eq!(version, env!("CARGO_PKG_VERSION"));
            let second_version = probe(&endpoint_path(&app_dir)).await.unwrap();
            assert_eq!(second_version, env!("CARGO_PKG_VERSION"));

            drop(state);
            assert!(!endpoint_path(&app_dir).exists());
            let _ = fs::remove_dir_all(app_dir);
        }

        #[tokio::test]
        async fn invalid_tokens_are_rejected_without_returning_desktop_data() {
            let app_dir = temporary_app_dir();
            let state = start_server(app_dir.clone()).unwrap();
            let mut endpoint = read_endpoint(&endpoint_path(&app_dir)).unwrap();
            endpoint.token = Uuid::new_v4().to_string();
            let error = probe_endpoint(&endpoint).await.unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);

            drop(state);
            let _ = fs::remove_dir_all(app_dir);
        }

        #[tokio::test]
        async fn stale_state_cannot_remove_a_newer_endpoint() {
            let app_dir = temporary_app_dir();
            let stale_state = start_server(app_dir.clone()).unwrap();
            let endpoint_file = endpoint_path(&app_dir);
            let mut replacement = read_endpoint(&endpoint_file).unwrap();
            replacement.token = Uuid::new_v4().to_string();
            write_endpoint(&endpoint_file, &replacement).unwrap();

            drop(stale_state);
            assert_eq!(read_endpoint(&endpoint_file).unwrap(), replacement);

            let _ = fs::remove_file(endpoint_file);
            let _ = fs::remove_dir_all(app_dir);
        }
    }
}

#[cfg(windows)]
pub use windows::{probe, start_server};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_metadata_is_strict_and_bounded() {
        let endpoint = DesktopIpcEndpoint {
            protocol_version: DESKTOP_IPC_VERSION,
            pipe_name: format!(r"\\.\pipe\com.long.translate.browser.{}", Uuid::new_v4()),
            token: Uuid::new_v4().to_string(),
        };
        validate_endpoint(&endpoint).unwrap();
        assert!(constant_time_eq(
            endpoint.token.as_bytes(),
            endpoint.token.as_bytes()
        ));
        assert!(!constant_time_eq(endpoint.token.as_bytes(), b"invalid"));

        let mut invalid = endpoint;
        invalid.pipe_name = r"\\.\pipe\other-product".to_string();
        assert_eq!(
            validate_endpoint(&invalid).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }
}

use tauri::{Manager, State};

#[cfg(not(debug_assertions))]
use std::{
    fs::{self, OpenOptions},
    net::TcpListener,
    os::windows::process::CommandExt,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
};
#[derive(Clone)]
struct ServerConnection {
    port: u16,
    token: String,
}

struct ServerRuntime {
    connection: ServerConnection,
    #[cfg(not(debug_assertions))]
    child: Mutex<Option<Child>>,
    #[cfg(not(debug_assertions))]
    server_path: PathBuf,
    #[cfg(not(debug_assertions))]
    node_path: PathBuf,
    #[cfg(not(debug_assertions))]
    data_dir: PathBuf,
}

#[tauri::command]
fn server_connection(runtime: State<'_, ServerRuntime>) -> serde_json::Value {
    serde_json::json!({ "port": runtime.connection.port, "token": runtime.connection.token })
}

#[tauri::command]
fn restart_server(_runtime: State<'_, ServerRuntime>) -> Result<(), String> {
    #[cfg(not(debug_assertions))]
    {
        let mut child = _runtime
            .child
            .lock()
            .map_err(|_| "Server lock is unavailable")?;
        if let Some(process) = child.as_mut() {
            let _ = process.kill();
            let _ = process.wait();
        }
        *child = Some(spawn_server(_runtime.inner()).map_err(|error| error.to_string())?);
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![server_connection, restart_server])
        .setup(|app| {
            #[cfg(debug_assertions)]
            app.manage(ServerRuntime {
                connection: ServerConnection {
                    port: 4317,
                    token: String::new(),
                },
            });

            #[cfg(not(debug_assertions))]
            {
                let data_dir = app.path().app_data_dir()?;
                fs::create_dir_all(&data_dir)?;
                let server_path = data_dir.join("orchestration-server.mjs");
                fs::write(
                    &server_path,
                    include_bytes!("../../../server/dist/server.mjs"),
                )?;
                fs::write(
                    data_dir.join("preview-mcp.mjs"),
                    include_bytes!("../../../server/dist/preview-mcp.mjs"),
                )?;
                let bundled_node = app.path().resource_dir()?.join("node.exe");
                let node_path = if bundled_node.is_file() {
                    bundled_node
                } else {
                    PathBuf::from("node")
                };
                let listener = TcpListener::bind(("127.0.0.1", 0))?;
                let port = listener.local_addr()?.port();
                drop(listener);
                let runtime = ServerRuntime {
                    connection: ServerConnection {
                        port,
                        token: secure_token()?,
                    },
                    child: Mutex::new(None),
                    server_path,
                    node_path,
                    data_dir,
                };
                *runtime
                    .child
                    .lock()
                    .map_err(|_| "Server lock is unavailable")? = Some(spawn_server(&runtime)?);
                app.manage(runtime);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Kimi Code Desktop");

    app.run(|_handle, _event| {
        #[cfg(not(debug_assertions))]
        if matches!(_event, tauri::RunEvent::Exit) {
            if let Some(state) = _handle.try_state::<ServerRuntime>() {
                if let Ok(mut process) = state.child.lock() {
                    if let Some(child) = process.as_mut() {
                        let _ = child.kill();
                    }
                }
            }
        }
    });
}

#[cfg(not(debug_assertions))]
fn spawn_server(runtime: &ServerRuntime) -> std::io::Result<Child> {
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(runtime.data_dir.join("orchestration-server.log"))?;
    Command::new(&runtime.node_path)
        .arg(&runtime.server_path)
        .env("KIMI_DESKTOP_HOME", &runtime.data_dir)
        .env("KIMI_CODE_NO_AUTO_UPDATE", "1")
        .env("KIMI_SERVER_PORT", runtime.connection.port.to_string())
        .env("KIMI_SERVER_TOKEN", &runtime.connection.token)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log))
        .creation_flags(0x08000000)
        .spawn()
}

#[cfg(not(debug_assertions))]
fn secure_token() -> std::io::Result<String> {
    #[link(name = "bcrypt")]
    extern "system" {
        fn BCryptGenRandom(
            algorithm: *mut std::ffi::c_void,
            buffer: *mut u8,
            length: u32,
            flags: u32,
        ) -> i32;
    }
    let mut bytes = [0_u8; 32];
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            0x00000002,
        )
    };
    if status != 0 {
        return Err(std::io::Error::other(format!(
            "BCryptGenRandom failed with status {status}"
        )));
    }
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

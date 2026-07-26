use tauri::{Manager, State};

use std::{
    ffi::{c_void, OsStr},
    io,
    iter::once,
    os::windows::ffi::OsStrExt,
};

#[cfg(not(debug_assertions))]
use std::{
    fs::{self, OpenOptions},
    net::TcpListener,
    path::PathBuf,
    sync::Mutex,
};

#[cfg(any(not(debug_assertions), test))]
use std::{
    os::windows::process::CommandExt,
    process::{Child, Command, Stdio},
};

// Keep the legacy mutex so 0.9 and Tasty cannot both own the same data directory during an update.
const SINGLE_INSTANCE_MUTEX: &str = r"Local\KimiCodeDesktop.com.kimicode.desktop";
const ERROR_ALREADY_EXISTS: u32 = 183;

struct SingleInstanceGuard {
    handle: *mut c_void,
}

impl SingleInstanceGuard {
    fn acquire(name: &str) -> io::Result<Option<Self>> {
        let wide_name = OsStr::new(name)
            .encode_wide()
            .chain(once(0))
            .collect::<Vec<_>>();
        let handle = unsafe { CreateMutexW(std::ptr::null_mut(), 0, wide_name.as_ptr()) };
        let last_error = unsafe { GetLastError() };
        if handle.is_null() {
            return Err(io::Error::from_raw_os_error(last_error as i32));
        }
        if last_error == ERROR_ALREADY_EXISTS {
            unsafe {
                CloseHandle(handle);
            }
            return Ok(None);
        }
        Ok(Some(Self { handle }))
    }
}

impl Drop for SingleInstanceGuard {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe {
                CloseHandle(self.handle);
            }
            self.handle = std::ptr::null_mut();
        }
    }
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateMutexW(
        mutex_attributes: *mut c_void,
        initial_owner: i32,
        name: *const u16,
    ) -> *mut c_void;
    fn GetLastError() -> u32;
    fn CloseHandle(object: *mut c_void) -> i32;
}

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
fn recover_server(_runtime: State<'_, ServerRuntime>, force: Option<bool>) -> Result<bool, String> {
    #[cfg(not(debug_assertions))]
    {
        let mut child = _runtime
            .child
            .lock()
            .map_err(|_| "Server lock is unavailable")?;
        if let Some(process) = child.as_mut() {
            let running = process
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_none();
            if running && !force.unwrap_or(false) {
                return Ok(false);
            }
            if running {
                terminate_server_tree(process).map_err(|error| error.to_string())?;
            }
        }
        *child = Some(spawn_server(_runtime.inner()).map_err(|error| error.to_string())?);
        return Ok(true);
    }
    #[cfg(debug_assertions)]
    {
        let _ = force;
        Ok(false)
    }
}

#[tauri::command]
fn stop_server_for_update(_runtime: State<'_, ServerRuntime>) -> Result<bool, String> {
    #[cfg(not(debug_assertions))]
    {
        let mut child = _runtime
            .child
            .lock()
            .map_err(|_| "Server lock is unavailable")?;
        let Some(process) = child.as_mut() else {
            return Ok(false);
        };
        terminate_server_tree(process).map_err(|error| error.to_string())?;
        child.take();
        return Ok(true);
    }
    #[cfg(debug_assertions)]
    Ok(false)
}

#[tauri::command]
fn app_log_path(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .app_data_dir()
        .map(|path| {
            path.join("orchestration-server.log")
                .to_string_lossy()
                .into_owned()
        })
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let instance_guard = match SingleInstanceGuard::acquire(SINGLE_INSTANCE_MUTEX) {
        Ok(Some(guard)) => guard,
        Ok(None) => return,
        Err(error) => {
            eprintln!("Could not acquire the Tasty instance lock: {error}");
            return;
        }
    };

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            server_connection,
            recover_server,
            stop_server_for_update,
            app_log_path
        ])
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
        .expect("error while building Tasty");

    let mut instance_guard = Some(instance_guard);
    app.run(move |_handle, _event| {
        if !matches!(_event, tauri::RunEvent::Exit) {
            return;
        }

        #[cfg(not(debug_assertions))]
        if let Some(state) = _handle.try_state::<ServerRuntime>() {
            if let Ok(mut process) = state.child.lock() {
                if let Some(mut child) = process.take() {
                    let _ = terminate_server_tree(&mut child);
                }
            }
        }
        instance_guard.take();
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
        .env("TASTY_HOME", &runtime.data_dir)
        .env("KIMI_DESKTOP_HOME", &runtime.data_dir)
        .env("KIMI_DEFAULT_CWD", "")
        .env("KIMI_CODE_NO_AUTO_UPDATE", "1")
        .env("KIMI_SERVER_PORT", runtime.connection.port.to_string())
        .env("KIMI_SERVER_TOKEN", &runtime.connection.token)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log))
        .creation_flags(0x08000000)
        .spawn()
}

#[cfg(any(not(debug_assertions), test))]
fn terminate_server_tree(child: &mut Child) -> std::io::Result<()> {
    // Every caller holds ServerRuntime.child's lock. Keep the Child handle alive
    // and verify it still represents a live process before acting on its PID.
    if child.try_wait()?.is_some() {
        return Ok(());
    }
    let pid = child.id().to_string();
    let status = Command::new("taskkill")
        .args(["/PID", &pid, "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000)
        .status()?;
    if status.success() {
        child.wait()?;
        return Ok(());
    }
    if child.try_wait()?.is_some() {
        return Ok(());
    }
    Err(std::io::Error::other(format!(
        "Could not terminate the local server process tree (taskkill exited with {status})"
    )))
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

#[cfg(test)]
mod tests {
    use super::{terminate_server_tree, SingleInstanceGuard};
    use std::process::Command;

    #[test]
    fn named_mutex_rejects_a_second_owner_and_releases_on_drop() {
        let name = format!(r"Local\KimiCodeDesktop.test.{}", std::process::id());
        let first = SingleInstanceGuard::acquire(&name)
            .expect("first mutex acquisition should succeed")
            .expect("first mutex owner should receive a guard");

        assert!(
            SingleInstanceGuard::acquire(&name)
                .expect("second mutex acquisition should be handled")
                .is_none(),
            "a live mutex owner must reject a second instance"
        );

        drop(first);

        assert!(
            SingleInstanceGuard::acquire(&name)
                .expect("mutex should remain usable after release")
                .is_some(),
            "dropping the guard must release the named mutex"
        );
    }

    #[test]
    fn terminating_an_already_exited_child_is_idempotent() {
        let mut child = Command::new("cmd")
            .args(["/C", "exit", "0"])
            .spawn()
            .expect("test child should start");
        child.wait().expect("test child should exit");

        terminate_server_tree(&mut child).expect("an exited child must not be killed by stale PID");
    }
}

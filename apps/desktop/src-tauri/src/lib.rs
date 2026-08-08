use tauri::{Manager, State};

use std::io;

#[cfg(target_os = "windows")]
use std::{
    ffi::{c_void, OsStr},
    iter::once,
    os::windows::ffi::OsStrExt,
};

#[cfg(not(debug_assertions))]
use std::{fs, io::Write, path::PathBuf, sync::Mutex};

#[cfg(any(not(debug_assertions), test))]
use std::{
    io::Read,
    net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener, TcpStream},
    process::Child,
    thread,
    time::{Duration, Instant},
};

#[cfg(test)]
use std::io::Write as _;

#[cfg(not(debug_assertions))]
use std::process::{Command, Stdio};

#[cfg(all(target_os = "windows", any(not(debug_assertions), test)))]
use std::os::windows::io::AsRawHandle;

#[cfg(all(target_os = "windows", not(debug_assertions)))]
use std::os::windows::process::CommandExt;

// Keep the legacy mutex so every Kimi Code Desktop release owns one data directory.
const SINGLE_INSTANCE_MUTEX: &str = r"Local\KimiCodeDesktop.com.kimicode.desktop";
#[cfg(target_os = "windows")]
const ERROR_ALREADY_EXISTS: u32 = 183;

#[cfg(not(debug_assertions))]
const SERVER_READY_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(any(not(debug_assertions), test))]
const SERVER_PROBE_TIMEOUT: Duration = Duration::from_millis(250);
#[cfg(any(not(debug_assertions), test))]
const SERVER_EXIT_TIMEOUT: Duration = Duration::from_secs(3);
#[cfg(not(debug_assertions))]
const SERVER_START_ATTEMPTS: usize = 3;
#[cfg(any(not(debug_assertions), test))]
const SERVER_LOG_FILE: &str = "orchestration-server.log";
#[cfg(any(not(debug_assertions), test))]
const SERVER_LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;

#[cfg(target_os = "windows")]
struct SingleInstanceGuard {
    handle: *mut c_void,
}

#[cfg(target_os = "windows")]
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

#[cfg(target_os = "windows")]
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

#[cfg(not(target_os = "windows"))]
struct SingleInstanceGuard;

#[cfg(not(target_os = "windows"))]
impl SingleInstanceGuard {
    fn acquire(_name: &str) -> io::Result<Option<Self>> {
        Ok(Some(Self))
    }
}

#[cfg(target_os = "windows")]
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

#[cfg(all(target_os = "windows", any(not(debug_assertions), test)))]
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
#[cfg(all(target_os = "windows", any(not(debug_assertions), test)))]
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;
#[cfg(all(target_os = "windows", not(debug_assertions)))]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(all(target_os = "windows", any(not(debug_assertions), test)))]
#[repr(C)]
#[derive(Default)]
struct JobObjectBasicLimitInformation {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: u32,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

#[cfg(all(target_os = "windows", any(not(debug_assertions), test)))]
#[repr(C)]
#[derive(Default)]
struct IoCounters {
    read_operation_count: u64,
    write_operation_count: u64,
    other_operation_count: u64,
    read_transfer_count: u64,
    write_transfer_count: u64,
    other_transfer_count: u64,
}

#[cfg(all(target_os = "windows", any(not(debug_assertions), test)))]
#[repr(C)]
#[derive(Default)]
struct JobObjectExtendedLimitInformation {
    basic_limit_information: JobObjectBasicLimitInformation,
    io_info: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[cfg(all(target_os = "windows", any(not(debug_assertions), test)))]
#[link(name = "kernel32")]
extern "system" {
    fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> *mut c_void;
    fn SetInformationJobObject(
        job: *mut c_void,
        information_class: i32,
        information: *mut c_void,
        information_length: u32,
    ) -> i32;
    fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
    fn TerminateJobObject(job: *mut c_void, exit_code: u32) -> i32;
}

#[cfg(all(target_os = "windows", any(not(debug_assertions), test)))]
const TCP_TABLE_OWNER_PID_LISTENER: u32 = 3;
#[cfg(all(target_os = "windows", any(not(debug_assertions), test)))]
const MIB_TCP_STATE_LISTEN: u32 = 2;
#[cfg(all(target_os = "windows", any(not(debug_assertions), test)))]
const ERROR_INSUFFICIENT_BUFFER: u32 = 122;

#[cfg(all(target_os = "windows", any(not(debug_assertions), test)))]
#[repr(C)]
struct MibTcpRowOwnerPid {
    state: u32,
    local_address: u32,
    local_port: u32,
    remote_address: u32,
    remote_port: u32,
    owning_pid: u32,
}

#[cfg(all(target_os = "windows", any(not(debug_assertions), test)))]
#[link(name = "iphlpapi")]
extern "system" {
    fn GetExtendedTcpTable(
        table: *mut c_void,
        size: *mut u32,
        order: i32,
        address_family: u32,
        table_class: u32,
        reserved: u32,
    ) -> u32;
}

#[cfg(all(target_os = "windows", any(not(debug_assertions), test)))]
struct JobHandle(isize);

#[cfg(all(target_os = "windows", any(not(debug_assertions), test)))]
impl JobHandle {
    fn create() -> io::Result<Self> {
        let handle = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Self(handle as isize);
        let mut limits = JobObjectExtendedLimitInformation::default();
        limits.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job.raw(),
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                (&mut limits as *mut JobObjectExtendedLimitInformation).cast(),
                std::mem::size_of::<JobObjectExtendedLimitInformation>() as u32,
            )
        };
        if configured == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    fn assign(&self, child: &Child) -> io::Result<()> {
        let assigned =
            unsafe { AssignProcessToJobObject(self.raw(), child.as_raw_handle() as *mut c_void) };
        if assigned == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn terminate(&self) -> io::Result<()> {
        if unsafe { TerminateJobObject(self.raw(), 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn raw(&self) -> *mut c_void {
        self.0 as *mut c_void
    }
}

#[cfg(all(target_os = "windows", any(not(debug_assertions), test)))]
impl Drop for JobHandle {
    fn drop(&mut self) {
        if self.0 != 0 {
            unsafe {
                CloseHandle(self.raw());
            }
            self.0 = 0;
        }
    }
}

#[cfg(any(not(debug_assertions), test))]
struct ServerProcess {
    child: Child,
    #[cfg(target_os = "windows")]
    job: JobHandle,
}

#[cfg(any(not(debug_assertions), test))]
impl ServerProcess {
    fn attach(mut child: Child) -> io::Result<Self> {
        #[cfg(target_os = "windows")]
        {
            let job = JobHandle::create();
            let job = match job.and_then(|job| {
                job.assign(&child)?;
                Ok(job)
            }) {
                Ok(job) => job,
                Err(error) => {
                    return Err(match terminate_unmanaged_child(&mut child) {
                        Ok(()) => error,
                        Err(cleanup_error) => io::Error::new(
                            io::ErrorKind::ResourceBusy,
                            format!(
                                "Could not contain the local runtime ({error}); cleanup also failed: {cleanup_error}"
                            ),
                        ),
                    });
                }
            };
            Ok(Self { child, job })
        }
        #[cfg(not(target_os = "windows"))]
        {
            Ok(Self { child })
        }
    }
}

#[cfg(any(not(debug_assertions), test))]
fn terminate_unmanaged_child(child: &mut Child) -> io::Result<()> {
    if child.try_wait()?.is_some() {
        return Ok(());
    }
    if let Err(error) = child.kill() {
        if child.try_wait()?.is_none() {
            return Err(error);
        }
        return Ok(());
    }
    let deadline = Instant::now() + SERVER_EXIT_TIMEOUT;
    while child.try_wait()?.is_none() {
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Uncontained local runtime did not exit after termination",
            ));
        }
        thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

#[derive(Clone)]
struct ServerConnection {
    port: u16,
    token: String,
}

struct ServerRuntime {
    connection: ServerConnection,
    #[cfg(not(debug_assertions))]
    child: Mutex<Option<ServerProcess>>,
    #[cfg(not(debug_assertions))]
    startup_error: Mutex<Option<String>>,
    #[cfg(not(debug_assertions))]
    server_path: PathBuf,
    #[cfg(not(debug_assertions))]
    node_path: PathBuf,
    #[cfg(not(debug_assertions))]
    data_dir: PathBuf,
}

#[tauri::command]
fn server_connection(runtime: State<'_, ServerRuntime>) -> Result<serde_json::Value, String> {
    #[cfg(not(debug_assertions))]
    if let Some(error) = runtime
        .startup_error
        .lock()
        .map_err(|_| "Server startup status is unavailable")?
        .as_ref()
    {
        return Err(error.clone());
    }
    Ok(serde_json::json!({ "port": runtime.connection.port, "token": runtime.connection.token }))
}

#[tauri::command]
fn recover_server(_runtime: State<'_, ServerRuntime>, force: Option<bool>) -> Result<bool, String> {
    #[cfg(not(debug_assertions))]
    {
        let mut child = _runtime
            .child
            .lock()
            .map_err(|_| "Server lock is unavailable")?;
        let running = if let Some(process) = child.as_mut() {
            process
                .child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_none()
        } else {
            false
        };
        if running && !force.unwrap_or(false) {
            return Ok(false);
        }
        *_runtime
            .startup_error
            .lock()
            .map_err(|_| "Server startup status is unavailable")? =
            Some("The local Kimi Code runtime is restarting".into());
        if running {
            terminate_server_tree(child.as_mut().expect("running child should exist"))
                .map_err(|error| error.to_string())?;
        }
        child.take();
        let (next_child, startup_error) = recoverable_server_start(spawn_server(_runtime.inner()));
        *child = next_child;
        *_runtime
            .startup_error
            .lock()
            .map_err(|_| "Server startup status is unavailable")? = startup_error.clone();
        drop(child);
        if let Some(error) = startup_error {
            report_server_start_failure(_runtime.inner(), &error);
            return Err(error);
        }
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
        *_runtime
            .startup_error
            .lock()
            .map_err(|_| "Server startup status is unavailable")? =
            Some("The local Kimi Code runtime is stopped for an update".into());
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
            eprintln!("Could not acquire the Kimi Code instance lock: {error}");
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
                app.manage(initial_server_runtime(server_path, node_path, data_dir)?);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Kimi Code");

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
fn initial_server_runtime(
    server_path: PathBuf,
    node_path: PathBuf,
    data_dir: PathBuf,
) -> io::Result<ServerRuntime> {
    let mut last_failure = None;
    for attempt in 1..=SERVER_START_ATTEMPTS {
        let (reservation, port) = reserve_local_port()?;
        let mut runtime = ServerRuntime {
            connection: ServerConnection {
                port,
                token: secure_token()?,
            },
            child: Mutex::new(None),
            startup_error: Mutex::new(None),
            server_path: server_path.clone(),
            node_path: node_path.clone(),
            data_dir: data_dir.clone(),
        };
        match spawn_server_reserved(&runtime, reservation) {
            Ok(child) => {
                runtime.child = Mutex::new(Some(child));
                return Ok(runtime);
            }
            Err(error) => {
                if error.kind() == io::ErrorKind::ResourceBusy {
                    return Err(error);
                }
                let retryable = error.kind() == io::ErrorKind::BrokenPipe;
                last_failure = Some(format!(
                    "Could not start the local Kimi Code runtime after attempt {attempt}/{SERVER_START_ATTEMPTS}: {error}"
                ));
                if !retryable {
                    break;
                }
            }
        }
    }

    let error = last_failure.expect("at least one server start was attempted");
    let (reservation, port) = reserve_local_port()?;
    let runtime = ServerRuntime {
        connection: ServerConnection {
            port,
            token: secure_token()?,
        },
        child: Mutex::new(None),
        startup_error: Mutex::new(Some(error.clone())),
        server_path,
        node_path,
        data_dir,
    };
    drop(reservation);
    report_server_start_failure(&runtime, &error);
    Ok(runtime)
}

#[cfg(any(not(debug_assertions), test))]
fn reserve_local_port() -> io::Result<(TcpListener, u16)> {
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    Ok((listener, port))
}

#[cfg(not(debug_assertions))]
fn spawn_server(runtime: &ServerRuntime) -> io::Result<ServerProcess> {
    let reservation = TcpListener::bind(SocketAddrV4::new(
        Ipv4Addr::LOCALHOST,
        runtime.connection.port,
    ))?;
    spawn_server_reserved(runtime, reservation)
}

#[cfg(not(debug_assertions))]
fn spawn_server_reserved(
    runtime: &ServerRuntime,
    reservation: TcpListener,
) -> io::Result<ServerProcess> {
    if reservation.local_addr()?.port() != runtime.connection.port {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Server port reservation does not match the runtime connection",
        ));
    }
    let log = open_runtime_log(&runtime.data_dir)?;
    let mut command = Command::new(&runtime.node_path);
    command
        .arg(&runtime.server_path)
        .env("KIMI_DESKTOP_HOME", &runtime.data_dir)
        .env("KIMI_DEFAULT_CWD", "")
        .env("KIMI_CODE_NO_AUTO_UPDATE", "1")
        .env("KIMI_SERVER_PORT", runtime.connection.port.to_string())
        .env("KIMI_SERVER_TOKEN", &runtime.connection.token)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log));
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    // Node cannot inherit the Rust listener, so release it at the last possible
    // point and verify the authenticated server before exposing this connection.
    drop(reservation);
    let mut process = ServerProcess::attach(command.spawn()?)?;
    if let Err(error) =
        wait_for_server_ready(&mut process, &runtime.connection, SERVER_READY_TIMEOUT)
    {
        let shutdown = terminate_server_tree(&mut process);
        return Err(match shutdown {
            Ok(()) => error,
            Err(shutdown_error) => io::Error::new(
                io::ErrorKind::ResourceBusy,
                format!("{error}; cleanup also failed: {shutdown_error}"),
            ),
        });
    }
    Ok(process)
}

#[cfg(any(not(debug_assertions), test))]
fn open_runtime_log(data_dir: &std::path::Path) -> io::Result<std::fs::File> {
    let path = data_dir.join(SERVER_LOG_FILE);
    let should_rotate = match std::fs::metadata(&path) {
        Ok(metadata) => metadata.len() >= SERVER_LOG_MAX_BYTES,
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => {
            eprintln!(
                "Could not inspect the local runtime log; continuing without rotation: {error}"
            );
            false
        }
    };
    if should_rotate {
        let backup = path.with_extension("log.1");
        let rotation = std::fs::remove_file(&backup)
            .or_else(|error| {
                (error.kind() == io::ErrorKind::NotFound)
                    .then_some(())
                    .ok_or(error)
            })
            .and_then(|()| std::fs::rename(&path, &backup));
        if let Err(error) = rotation {
            eprintln!(
                "Could not rotate the local runtime log; continuing the current log: {error}"
            );
        }
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
}

#[cfg(any(not(debug_assertions), test))]
fn recoverable_server_start(
    result: io::Result<ServerProcess>,
) -> (Option<ServerProcess>, Option<String>) {
    match result {
        Ok(child) => (Some(child), None),
        Err(error) => (
            None,
            Some(format!(
                "Could not start the local Kimi Code runtime: {error}"
            )),
        ),
    }
}

#[cfg(any(not(debug_assertions), test))]
fn wait_for_server_ready(
    process: &mut ServerProcess,
    connection: &ServerConnection,
    timeout: Duration,
) -> io::Result<()> {
    let deadline = Instant::now() + timeout;
    let mut last_probe = None;
    loop {
        if let Some(status) = process.child.try_wait()? {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                format!("Local runtime exited before becoming ready ({status})"),
            ));
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!(
                    "Local runtime did not complete its authenticated readiness handshake in {} ms{}",
                    timeout.as_millis(),
                    last_probe
                        .map(|error: io::Error| format!(": {error}"))
                        .unwrap_or_default()
                ),
            ));
        }
        let probe_timeout = SERVER_PROBE_TIMEOUT.min(deadline.saturating_duration_since(now));
        match authenticated_server_probe(connection, process.child.id(), probe_timeout) {
            Ok(()) => {
                if let Some(status) = process.child.try_wait()? {
                    return Err(io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        format!("Local runtime exited during its readiness handshake ({status})"),
                    ));
                }
                return Ok(());
            }
            Err(error) => last_probe = Some(error),
        }
        thread::sleep(
            Duration::from_millis(25).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
}

#[cfg(any(not(debug_assertions), test))]
fn authenticated_server_probe(
    connection: &ServerConnection,
    expected_pid: u32,
    timeout: Duration,
) -> io::Result<()> {
    if connection.token.len() != 64
        || !connection
            .token
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Local runtime token has an invalid format",
        ));
    }
    verify_listener_owner(connection.port, expected_pid)?;
    let address = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, connection.port));
    let deadline = Instant::now() + timeout;
    let mut stream = TcpStream::connect_timeout(&address, timeout)?;
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "Local runtime probe timed out while connecting",
        ));
    }
    stream.set_read_timeout(Some(remaining))?;
    stream.set_write_timeout(Some(remaining))?;
    write!(
        stream,
        "GET /?token={} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: http://tauri.localhost\r\n\r\n",
        connection.token, connection.port
    )?;
    stream.flush()?;

    let mut response = Vec::with_capacity(2_048);
    let mut chunk = [0_u8; 2_048];
    while response.len() < 16 * 1_024 {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        stream.set_read_timeout(Some(remaining))?;
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                response.extend_from_slice(&chunk[..read]);
                if response_has_authenticated_welcome(&response) {
                    verify_listener_owner(connection.port, expected_pid)?;
                    return Ok(());
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                break
            }
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        "Local runtime did not return its authenticated welcome frame",
    ))
}

#[cfg(any(not(debug_assertions), test))]
fn verify_listener_owner(port: u16, expected_pid: u32) -> io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        let actual = listener_owner_pid(port)?;
        if actual != expected_pid {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "Local runtime port {port} belongs to process {actual}, expected {expected_pid}"
                ),
            ));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (port, expected_pid);
    }
    Ok(())
}

#[cfg(all(target_os = "windows", any(not(debug_assertions), test)))]
fn listener_owner_pid(port: u16) -> io::Result<u32> {
    let mut size = 0_u32;
    let status = unsafe {
        GetExtendedTcpTable(
            std::ptr::null_mut(),
            &mut size,
            0,
            2,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        )
    };
    if status != ERROR_INSUFFICIENT_BUFFER {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    let mut table = vec![0_u32; (size as usize).div_ceil(std::mem::size_of::<u32>())];
    let status = unsafe {
        GetExtendedTcpTable(
            table.as_mut_ptr().cast(),
            &mut size,
            0,
            2,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    if size < std::mem::size_of::<u32>() as u32 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Windows returned an invalid TCP listener table",
        ));
    }
    let count = table[0] as usize;
    let rows_size = count
        .checked_mul(std::mem::size_of::<MibTcpRowOwnerPid>())
        .and_then(|bytes| bytes.checked_add(std::mem::size_of::<u32>()))
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "TCP table is too large"))?;
    if rows_size > size as usize || rows_size > table.len() * std::mem::size_of::<u32>() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Windows returned a truncated TCP listener table",
        ));
    }
    let rows = unsafe {
        std::slice::from_raw_parts(table.as_ptr().add(1).cast::<MibTcpRowOwnerPid>(), count)
    };
    rows.iter()
        .find(|row| {
            row.state == MIB_TCP_STATE_LISTEN
                && row.local_address == u32::from_ne_bytes(Ipv4Addr::LOCALHOST.octets())
                && u16::from_be(row.local_port as u16) == port
        })
        .map(|row| row.owning_pid)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!("No Windows TCP listener owns local runtime port {port}"),
            )
        })
}

#[cfg(any(not(debug_assertions), test))]
fn response_has_authenticated_welcome(response: &[u8]) -> bool {
    let Some(header_end) = response.windows(4).position(|window| window == b"\r\n\r\n") else {
        return false;
    };
    let Ok(header) = std::str::from_utf8(&response[..header_end]) else {
        return false;
    };
    let mut lines = header.split("\r\n");
    if !lines
        .next()
        .is_some_and(|status| status.starts_with("HTTP/1.1 101 "))
    {
        return false;
    }
    let mut upgrade = false;
    let mut connection_upgrade = false;
    let mut accept = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return false;
        };
        let value = value.trim();
        if name.eq_ignore_ascii_case("upgrade") {
            upgrade = value.eq_ignore_ascii_case("websocket");
        } else if name.eq_ignore_ascii_case("connection") {
            connection_upgrade = value
                .split(',')
                .any(|token| token.trim().eq_ignore_ascii_case("upgrade"));
        } else if name.eq_ignore_ascii_case("sec-websocket-accept") {
            accept = value == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";
        }
    }
    if !(upgrade && connection_upgrade && accept) {
        return false;
    }
    let frame = &response[header_end + 4..];
    let Some(payload) = websocket_text_payload(frame) else {
        return false;
    };
    let Ok(message) = serde_json::from_slice::<serde_json::Value>(payload) else {
        return false;
    };
    message.get("channel").and_then(serde_json::Value::as_str) == Some("server.welcome")
        && message
            .pointer("/payload/protocolVersion")
            .and_then(serde_json::Value::as_u64)
            == Some(1)
}

#[cfg(any(not(debug_assertions), test))]
fn websocket_text_payload(frame: &[u8]) -> Option<&[u8]> {
    if frame.len() < 2 || frame[0] != 0x81 || frame[1] & 0x80 != 0 {
        return None;
    }
    let marker = frame[1] & 0x7f;
    let (header_len, payload_len): (usize, usize) = match marker {
        0..=125 => (2, marker as usize),
        126 if frame.len() >= 4 => (4, u16::from_be_bytes([frame[2], frame[3]]) as usize),
        127 if frame.len() >= 10 => {
            let length = u64::from_be_bytes(frame[2..10].try_into().ok()?);
            (10, usize::try_from(length).ok()?)
        }
        _ => return None,
    };
    let end = header_len.checked_add(payload_len)?;
    (end <= frame.len()).then(|| &frame[header_len..end])
}

#[cfg(not(debug_assertions))]
fn report_server_start_failure(runtime: &ServerRuntime, message: &str) {
    eprintln!("{message}");
    if let Ok(mut log) = open_runtime_log(&runtime.data_dir) {
        let _ = writeln!(log, "{message}");
    }
}

#[cfg(any(not(debug_assertions), test))]
fn terminate_server_tree(process: &mut ServerProcess) -> io::Result<()> {
    #[cfg(target_os = "windows")]
    process.job.terminate()?;
    #[cfg(not(target_os = "windows"))]
    if process.child.try_wait()?.is_none() {
        process.child.kill()?;
    }

    let deadline = Instant::now() + SERVER_EXIT_TIMEOUT;
    loop {
        if process.child.try_wait()?.is_some() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Local server process tree did not exit after termination",
            ));
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(not(debug_assertions))]
fn secure_token() -> io::Result<String> {
    let mut bytes = [0_u8; 32];
    #[cfg(target_os = "windows")]
    {
        #[link(name = "bcrypt")]
        extern "system" {
            fn BCryptGenRandom(
                algorithm: *mut std::ffi::c_void,
                buffer: *mut u8,
                length: u32,
                flags: u32,
            ) -> i32;
        }
        let status = unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                0x00000002,
            )
        };
        if status != 0 {
            return Err(io::Error::other(format!(
                "BCryptGenRandom failed with status {status}"
            )));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    }
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::{
        authenticated_server_probe, open_runtime_log, recoverable_server_start, reserve_local_port,
        response_has_authenticated_welcome, terminate_server_tree, wait_for_server_ready,
        ServerConnection, ServerProcess, SingleInstanceGuard, SERVER_LOG_FILE,
        SERVER_LOG_MAX_BYTES,
    };
    use std::{
        fs,
        io::{Read, Write},
        net::{Ipv4Addr, SocketAddrV4, TcpListener},
        path::PathBuf,
        process::{Command, Stdio},
        thread,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };

    #[cfg(target_os = "windows")]
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
    fn a_reserved_port_is_held_until_the_listener_is_dropped() {
        let (listener, port) = reserve_local_port().expect("an ephemeral port should be reserved");
        assert!(
            TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).is_err(),
            "the reservation must exclude a competing listener"
        );
        drop(listener);
        TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port))
            .expect("the reservation should release the port on drop");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn kill_on_job_close_ends_the_attached_process() {
        let ServerProcess { mut child, job } = long_running_process();
        drop(job);

        let deadline = Instant::now() + Duration::from_secs(3);
        while child
            .try_wait()
            .expect("child status should be readable")
            .is_none()
        {
            assert!(
                Instant::now() < deadline,
                "closing the job must kill its process"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn terminating_a_managed_process_is_idempotent() {
        let mut process = long_running_process();

        terminate_server_tree(&mut process).expect("the managed process tree should terminate");
        terminate_server_tree(&mut process)
            .expect("an exited managed process must remain safe to terminate");
    }

    #[test]
    fn readiness_reports_a_child_that_has_already_exited() {
        let mut process = long_running_process();
        terminate_server_tree(&mut process).expect("test process should terminate");
        let error = wait_for_server_ready(
            &mut process,
            &ServerConnection {
                port: 1,
                token: "a".repeat(64),
            },
            Duration::from_millis(100),
        )
        .expect_err("an exited child cannot become ready");

        assert_eq!(error.kind(), std::io::ErrorKind::BrokenPipe);
    }

    #[test]
    fn server_spawn_failure_is_kept_for_recovery_instead_of_exiting() {
        let (child, error) = recoverable_server_start(Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "spawn denied",
        )));

        assert!(child.is_none());
        assert_eq!(
            error.as_deref(),
            Some("Could not start the local Kimi Code runtime: spawn denied")
        );
    }

    #[test]
    fn runtime_log_appends_below_the_limit_without_a_backup() {
        let dir = temporary_log_dir("append");
        let path = dir.join(SERVER_LOG_FILE);
        fs::write(&path, b"before").expect("test log should be seeded");

        let mut log = open_runtime_log(&dir).expect("runtime log should open");
        log.write_all(b" after").expect("runtime log should append");
        drop(log);

        assert_eq!(
            fs::read(&path).expect("runtime log should remain readable"),
            b"before after"
        );
        assert!(!path.with_extension("log.1").exists());
        fs::remove_dir_all(dir).expect("test log directory should be removed");
    }

    #[test]
    fn runtime_log_rotates_once_before_appending() {
        let dir = temporary_log_dir("rotate");
        let path = dir.join(SERVER_LOG_FILE);
        let backup = path.with_extension("log.1");
        fs::write(&backup, b"obsolete backup").expect("old backup should be seeded");
        let seed = fs::File::create(&path).expect("test log should be seeded");
        seed.set_len(SERVER_LOG_MAX_BYTES)
            .expect("test log should reach the rotation limit");
        drop(seed);

        let mut log = open_runtime_log(&dir).expect("rotated runtime log should open");
        log.write_all(b"fresh diagnostics")
            .expect("new diagnostics should be appended");
        drop(log);

        assert_eq!(
            fs::metadata(&backup)
                .expect("one backup should exist")
                .len(),
            SERVER_LOG_MAX_BYTES
        );
        assert_eq!(
            fs::read(&path).expect("fresh runtime log should remain readable"),
            b"fresh diagnostics"
        );
        assert!(!path.with_extension("log.2").exists());
        fs::remove_dir_all(dir).expect("test log directory should be removed");
    }

    #[test]
    fn runtime_log_keeps_diagnostics_when_rotation_fails() {
        let dir = temporary_log_dir("rotation-failure");
        let path = dir.join(SERVER_LOG_FILE);
        let backup = path.with_extension("log.1");
        fs::create_dir(&backup).expect("an unreplaceable backup should be seeded");
        let seed = fs::File::create(&path).expect("test log should be seeded");
        seed.set_len(SERVER_LOG_MAX_BYTES)
            .expect("test log should reach the rotation limit");
        drop(seed);

        let mut log = open_runtime_log(&dir).expect("existing runtime log should remain usable");
        log.write_all(b" after")
            .expect("diagnostics should still append");
        drop(log);

        assert_eq!(
            fs::metadata(&path)
                .expect("runtime log should remain readable")
                .len(),
            SERVER_LOG_MAX_BYTES + 6
        );
        assert!(backup.is_dir());
        fs::remove_dir_all(dir).expect("test log directory should be removed");
    }

    #[test]
    fn readiness_requires_the_authenticated_welcome_frame() {
        let payload = br#"{"channel":"server.welcome","seq":1,"payload":{"defaultCwd":"","protocolVersion":1}}"#;
        let valid = websocket_response(payload);
        assert!(response_has_authenticated_welcome(&valid));

        let wrong_version = websocket_response(
            br#"{"channel":"server.welcome","seq":1,"payload":{"protocolVersion":2}}"#,
        );
        assert!(!response_has_authenticated_welcome(&wrong_version));
        let mut masked = valid.clone();
        let header_end = masked
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("test response should contain headers");
        masked[header_end + 5] |= 0x80;
        assert!(!response_has_authenticated_welcome(&masked));

        let mut wrong_accept = valid.clone();
        let accept = b"s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";
        let accept_start = wrong_accept
            .windows(accept.len())
            .position(|window| window == accept)
            .expect("test response should contain the accept value");
        wrong_accept[accept_start] = b'x';
        assert!(!response_has_authenticated_welcome(&wrong_accept));

        let unauthorized = b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n";
        assert!(!response_has_authenticated_welcome(unauthorized));
    }

    #[test]
    fn readiness_probe_authenticates_before_accepting_the_server() {
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
            .expect("test server should bind");
        let port = listener
            .local_addr()
            .expect("test address should exist")
            .port();
        let token = "b".repeat(64);
        let expected_token = token.clone();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("probe should connect");
            socket
                .set_read_timeout(Some(Duration::from_secs(1)))
                .expect("test timeout should apply");
            let mut request = Vec::new();
            let mut chunk = [0_u8; 512];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = socket
                    .read(&mut chunk)
                    .expect("probe request should arrive");
                assert!(
                    read > 0 && request.len() < 2_048,
                    "probe request must be bounded"
                );
                request.extend_from_slice(&chunk[..read]);
            }
            let request = String::from_utf8_lossy(&request);
            assert!(request.starts_with(&format!("GET /?token={expected_token} HTTP/1.1\r\n")));
            assert!(request.contains("\r\nOrigin: http://tauri.localhost\r\n"));
            let response = websocket_response(
                br#"{"channel":"server.welcome","seq":1,"payload":{"protocolVersion":1}}"#,
            );
            socket
                .write_all(&response[..17])
                .expect("the first response fragment should be sent");
            socket.flush().expect("the first fragment should flush");
            thread::sleep(Duration::from_millis(10));
            socket
                .write_all(&response[17..])
                .expect("the remaining welcome should be sent");
            thread::sleep(Duration::from_millis(100));
        });

        authenticated_server_probe(
            &ServerConnection { port, token },
            std::process::id(),
            Duration::from_secs(1),
        )
        .expect("the authenticated welcome should mark the server ready");
        server.join().expect("test server should finish");
    }

    fn websocket_response(payload: &[u8]) -> Vec<u8> {
        let mut response = b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n".to_vec();
        response.push(0x81);
        if payload.len() <= 125 {
            response.push(payload.len() as u8);
        } else {
            response.push(126);
            response.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        }
        response.extend_from_slice(payload);
        response
    }

    fn temporary_log_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should follow the Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "kimi-code-desktop-{name}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("test log directory should be created");
        path
    }

    fn long_running_process() -> ServerProcess {
        #[cfg(target_os = "windows")]
        let mut command = {
            let mut command = Command::new("cmd");
            command.args(["/C", "ping -n 30 127.0.0.1 >nul"]);
            command
        };
        #[cfg(not(target_os = "windows"))]
        let mut command = {
            let mut command = Command::new("sh");
            command.args(["-c", "sleep 30"]);
            command
        };
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        ServerProcess::attach(command.spawn().expect("test child should start"))
            .expect("test child should join its lifecycle container")
    }
}

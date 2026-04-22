use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, Position, Size, State, WebviewWindow,
};

const MAIN_WINDOW_LABEL: &str = "main";
const DEFAULT_EXPANDED_WIDTH: f64 = 340.0;
const DEFAULT_EXPANDED_HEIGHT: f64 = 680.0;
const COLLAPSED_WIDTH: f64 = 74.0;
const COLLAPSED_HEIGHT: f64 = 164.0;
const COLLAPSED_FLOATING_SIZE: f64 = 84.0;
const WINDOW_MARGIN: i32 = 14;
const MIN_EXPANDED_WIDTH: f64 = 320.0;
const MAX_EXPANDED_WIDTH: f64 = 520.0;
const MIN_EXPANDED_HEIGHT: f64 = 460.0;
const MAX_EXPANDED_HEIGHT: f64 = 920.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TodoItem {
    id: String,
    title: String,
    completed: bool,
    pinned: bool,
    created_at: i64,
    updated_at: i64,
    completed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TodoPatch {
    title: Option<String>,
    completed: Option<bool>,
    pinned: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct AppSettings {
    opacity: f64,
    auto_collapse_seconds: u64,
    launch_at_login: bool,
    always_on_top: bool,
    anchor_side: String,
    window_x: Option<f64>,
    window_y: f64,
    expanded_width: f64,
    expanded_height: f64,
    collapse_to_edge: bool,
    git_sync_enabled: bool,
    git_repo_path: String,
    git_branch: String,
    git_todos_file: String,
    collapsed: bool,
    theme: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            opacity: 0.88,
            auto_collapse_seconds: 30,
            launch_at_login: true,
            always_on_top: true,
            anchor_side: "right".to_string(),
            window_x: None,
            window_y: 72.0,
            expanded_width: DEFAULT_EXPANDED_WIDTH,
            expanded_height: DEFAULT_EXPANDED_HEIGHT,
            collapse_to_edge: true,
            git_sync_enabled: false,
            git_repo_path: String::new(),
            git_branch: "main".to_string(),
            git_todos_file: "focus-float-todo/todos.json".to_string(),
            collapsed: false,
            theme: "graphite".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadedAppState {
    todos: Vec<TodoItem>,
    settings: AppSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitSyncPayload {
    todos: Vec<TodoItem>,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitSyncResult {
    todos: Vec<TodoItem>,
    settings: AppSettings,
    commit_message: String,
}

struct AppStore {
    data_dir: PathBuf,
    todos: Vec<TodoItem>,
    settings: AppSettings,
}

struct SharedStore(Mutex<AppStore>);

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn clamp_opacity(opacity: f64) -> f64 {
    opacity.clamp(0.65, 1.0)
}

fn clamp_expanded_width(width: f64) -> f64 {
    width.clamp(MIN_EXPANDED_WIDTH, MAX_EXPANDED_WIDTH)
}

fn clamp_expanded_height(height: f64) -> f64 {
    height.clamp(MIN_EXPANDED_HEIGHT, MAX_EXPANDED_HEIGHT)
}

fn sanitize_theme(theme: &str) -> String {
    match theme {
        "graphite" | "sand" | "mint" | "sunset" => theme.to_string(),
        _ => "graphite".to_string(),
    }
}

fn sanitize_settings(mut settings: AppSettings) -> AppSettings {
    settings.opacity = clamp_opacity(settings.opacity);

    if !matches!(settings.auto_collapse_seconds, 10 | 30 | 60 | 300) {
        settings.auto_collapse_seconds = 30;
    }

    settings.anchor_side = "right".to_string();
    settings.window_x = settings.window_x.filter(|value| value.is_finite());

    if !settings.window_y.is_finite() {
        settings.window_y = 72.0;
    }

    settings.expanded_width = clamp_expanded_width(settings.expanded_width);
    settings.expanded_height = clamp_expanded_height(settings.expanded_height);
    settings.git_repo_path = settings.git_repo_path.trim().to_string();
    settings.git_branch = if settings.git_branch.trim().is_empty() {
        "main".to_string()
    } else {
        settings.git_branch.trim().to_string()
    };
    settings.git_todos_file = if settings.git_todos_file.trim().is_empty() {
        "focus-float-todo/todos.json".to_string()
    } else {
        settings.git_todos_file
            .trim()
            .replace('\\', "/")
            .trim_start_matches('/')
            .to_string()
    };

    settings.theme = sanitize_theme(settings.theme.trim());

    settings
}

fn read_json_or_default<T>(path: &Path) -> T
where
    T: DeserializeOwned + Default,
{
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<T>(&bytes).ok())
        .unwrap_or_default()
}

fn persist_store(store: &AppStore) -> Result<(), String> {
    fs::create_dir_all(&store.data_dir).map_err(|error| error.to_string())?;

    let todos_path = store.data_dir.join("todos.json");
    let settings_path = store.data_dir.join("settings.json");

    let todos_bytes = serde_json::to_vec_pretty(&store.todos).map_err(|error| error.to_string())?;
    let settings_bytes =
        serde_json::to_vec_pretty(&store.settings).map_err(|error| error.to_string())?;

    fs::write(todos_path, todos_bytes).map_err(|error| error.to_string())?;
    fs::write(settings_path, settings_bytes).map_err(|error| error.to_string())?;
    Ok(())
}

fn run_git(repo_path: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .current_dir(repo_path)
        .args(args)
        .output()
        .map_err(|error| format!("Failed to run git {:?}: {}", args, error))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn write_git_sync_file(repo_path: &str, relative_file: &str, todos: &[TodoItem]) -> Result<(), String> {
    let full_path = Path::new(repo_path).join(relative_file);
    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let payload = GitSyncPayload {
        todos: todos.to_vec(),
        updated_at: now_millis(),
    };
    let bytes = serde_json::to_vec_pretty(&payload).map_err(|error| error.to_string())?;
    fs::write(full_path, bytes).map_err(|error| error.to_string())
}

fn read_git_sync_file(repo_path: &str, relative_file: &str) -> Result<Option<GitSyncPayload>, String> {
    let full_path = Path::new(repo_path).join(relative_file);
    if !full_path.exists() {
        return Ok(None);
    }

    let bytes = fs::read(full_path).map_err(|error| error.to_string())?;
    let payload = serde_json::from_slice::<GitSyncPayload>(&bytes).map_err(|error| error.to_string())?;
    Ok(Some(payload))
}

fn sync_todos_with_git(store: &mut AppStore) -> Result<GitSyncResult, String> {
    let settings = sanitize_settings(store.settings.clone());
    if !settings.git_sync_enabled {
        return Err("Git sync is not enabled.".to_string());
    }

    if settings.git_repo_path.is_empty() {
        return Err("Git repository path is required.".to_string());
    }

    let repo_path = Path::new(&settings.git_repo_path);
    if !repo_path.exists() {
        return Err("Configured Git repository path does not exist.".to_string());
    }

    run_git(
        &settings.git_repo_path,
        &["pull", "--rebase", "origin", settings.git_branch.as_str()],
    )?;

    if let Some(remote_payload) = read_git_sync_file(&settings.git_repo_path, &settings.git_todos_file)? {
        if remote_payload.updated_at > store.todos.iter().map(|todo| todo.updated_at).max().unwrap_or_default() {
            store.todos = remote_payload.todos;
        }
    }

    write_git_sync_file(&settings.git_repo_path, &settings.git_todos_file, &store.todos)?;

    run_git(&settings.git_repo_path, &["add", settings.git_todos_file.as_str()])?;

    let commit_message = format!("sync todos {}", now_millis());
    match run_git(
        &settings.git_repo_path,
        &["commit", "-m", commit_message.as_str()],
    ) {
        Ok(_) => {}
        Err(error) if error.contains("nothing to commit") => {}
        Err(error) => return Err(error),
    }

    run_git(
        &settings.git_repo_path,
        &["push", "origin", settings.git_branch.as_str()],
    )?;

    store.settings = settings.clone();
    persist_store(store)?;

    Ok(GitSyncResult {
        todos: store.todos.clone(),
        settings,
        commit_message,
    })
}

fn data_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .or_else(|_| std::env::current_dir())
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("focus-float-todo")
}

fn load_store(app: &AppHandle) -> AppStore {
    let directory = data_dir(app);
    let _ = fs::create_dir_all(&directory);

    let settings = sanitize_settings(read_json_or_default(&directory.join("settings.json")));
    let todos = read_json_or_default(&directory.join("todos.json"));

    AppStore {
        data_dir: directory,
        todos,
        settings,
    }
}

fn get_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "Main window not found".to_string())
}

fn clamp_window_position(
    window: &WebviewWindow,
    desired_x: Option<f64>,
    desired_y: f64,
    width: f64,
    height: f64,
) -> Option<PhysicalPosition<i32>> {
    let monitor = desired_x
        .and_then(|x| window.monitor_from_point(x, desired_y).ok().flatten())
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten())?;
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let min_x = monitor_position.x as f64 + WINDOW_MARGIN as f64;
    let max_x =
        monitor_position.x as f64 + monitor_size.width as f64 - width - WINDOW_MARGIN as f64;
    let min_y = monitor_position.y as f64 + WINDOW_MARGIN as f64;
    let max_y =
        monitor_position.y as f64 + monitor_size.height as f64 - height - WINDOW_MARGIN as f64;
    let fallback_x =
        monitor_position.x as f64 + monitor_size.width as f64 - width - WINDOW_MARGIN as f64;
    let x = desired_x.unwrap_or(fallback_x).clamp(min_x, max_x.max(min_x)).round() as i32;
    let y = desired_y.clamp(min_y, max_y.max(min_y)).round() as i32;

    Some(PhysicalPosition::new(x, y))
}

fn apply_window_layout(
    window: &WebviewWindow,
    settings: &AppSettings,
    focus: bool,
) -> Result<(), String> {
    let (width, height) = if settings.collapsed {
        if settings.collapse_to_edge {
            (COLLAPSED_WIDTH, COLLAPSED_HEIGHT)
        } else {
            (COLLAPSED_FLOATING_SIZE, COLLAPSED_FLOATING_SIZE)
        }
    } else {
        (settings.expanded_width, settings.expanded_height)
    };

    let desired_x = if settings.collapsed && settings.collapse_to_edge {
        None
    } else {
        settings.window_x
    };

    window
        .set_size(Size::Logical(LogicalSize::new(width, height)))
        .map_err(|error| error.to_string())?;

    if let Some(position) = clamp_window_position(window, desired_x, settings.window_y, width, height) {
        window
            .set_position(Position::Physical(position))
            .map_err(|error| error.to_string())?;
    }

    window
        .set_always_on_top(settings.always_on_top)
        .map_err(|error| error.to_string())?;
    let _ = window.show();

    if focus && !settings.collapsed {
        let _ = window.set_focus();
    }

    Ok(())
}

#[cfg(desktop)]
fn sync_autostart(app: &AppHandle, enabled: bool) {
    use tauri_plugin_autostart::ManagerExt;

    let manager = app.autolaunch();
    let current = manager.is_enabled().unwrap_or(false);

    if enabled && !current {
        let _ = manager.enable();
    } else if !enabled && current {
        let _ = manager.disable();
    }
}

#[cfg(not(desktop))]
fn sync_autostart(_app: &AppHandle, _enabled: bool) {}

#[tauri::command]
fn load_app_state(state: State<'_, SharedStore>) -> LoadedAppState {
    let store = state.0.lock().expect("store poisoned");

    LoadedAppState {
        todos: store.todos.clone(),
        settings: store.settings.clone(),
    }
}

#[tauri::command]
fn create_todo(state: State<'_, SharedStore>, title: String) -> Result<TodoItem, String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err("Todo title cannot be empty".to_string());
    }

    let mut store = state.0.lock().map_err(|_| "Store unavailable".to_string())?;
    let timestamp = now_millis();
    let todo = TodoItem {
        id: format!("todo-{}", timestamp),
        title: trimmed.to_string(),
        completed: false,
        pinned: false,
        created_at: timestamp,
        updated_at: timestamp,
        completed_at: None,
    };

    store.todos.push(todo.clone());
    persist_store(&store)?;
    Ok(todo)
}

#[tauri::command]
fn update_todo(
    state: State<'_, SharedStore>,
    id: String,
    patch: TodoPatch,
) -> Result<TodoItem, String> {
    let mut store = state.0.lock().map_err(|_| "Store unavailable".to_string())?;
    let todo = store
        .todos
        .iter_mut()
        .find(|item| item.id == id)
        .ok_or_else(|| "Todo not found".to_string())?;

    if let Some(title) = patch.title {
        let trimmed = title.trim();
        if trimmed.is_empty() {
            return Err("Todo title cannot be empty".to_string());
        }

        todo.title = trimmed.to_string();
    }

    if let Some(completed) = patch.completed {
        todo.completed = completed;
        todo.completed_at = if completed { Some(now_millis()) } else { None };
    }

    if let Some(pinned) = patch.pinned {
        todo.pinned = pinned;
    }

    todo.updated_at = now_millis();
    let saved = todo.clone();

    persist_store(&store)?;
    Ok(saved)
}

#[tauri::command]
fn delete_todo(state: State<'_, SharedStore>, id: String) -> Result<(), String> {
    let mut store = state.0.lock().map_err(|_| "Store unavailable".to_string())?;
    let original_len = store.todos.len();
    store.todos.retain(|item| item.id != id);

    if store.todos.len() == original_len {
        return Err("Todo not found".to_string());
    }

    persist_store(&store)?;
    Ok(())
}

#[tauri::command]
fn save_settings(
    app: AppHandle,
    state: State<'_, SharedStore>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    let mut store = state.0.lock().map_err(|_| "Store unavailable".to_string())?;
    store.settings = sanitize_settings(settings);
    let saved = store.settings.clone();
    persist_store(&store)?;
    drop(store);

    let window = get_window(&app)?;
    apply_window_layout(&window, &saved, false)?;
    sync_autostart(&app, saved.launch_at_login);

    Ok(saved)
}

#[tauri::command]
fn set_window_expanded(
    app: AppHandle,
    state: State<'_, SharedStore>,
    expanded: bool,
) -> Result<AppSettings, String> {
    let window = get_window(&app)?;
    let mut store = state.0.lock().map_err(|_| "Store unavailable".to_string())?;
    store.settings.collapsed = !expanded;
    if let Some(position) = clamp_window_position(
        &window,
        if expanded || !store.settings.collapse_to_edge {
            store.settings.window_x
        } else {
            None
        },
        store.settings.window_y,
        if store.settings.collapsed {
            if store.settings.collapse_to_edge {
                COLLAPSED_WIDTH
            } else {
                COLLAPSED_FLOATING_SIZE
            }
        } else {
            store.settings.expanded_width
        },
        if store.settings.collapsed {
            if store.settings.collapse_to_edge {
                COLLAPSED_HEIGHT
            } else {
                COLLAPSED_FLOATING_SIZE
            }
        } else {
            store.settings.expanded_height
        },
    ) {
        store.settings.window_y = position.y as f64;
        if expanded {
            store.settings.window_x = Some(position.x as f64);
        }
    }
    let saved = store.settings.clone();
    persist_store(&store)?;
    drop(store);

    apply_window_layout(&window, &saved, expanded)?;
    Ok(saved)
}

#[tauri::command]
fn set_window_opacity(
    app: AppHandle,
    state: State<'_, SharedStore>,
    opacity: f64,
) -> Result<AppSettings, String> {
    let mut store = state.0.lock().map_err(|_| "Store unavailable".to_string())?;
    store.settings.opacity = clamp_opacity(opacity);
    let saved = store.settings.clone();
    persist_store(&store)?;
    drop(store);

    let window = get_window(&app)?;
    apply_window_layout(&window, &saved, false)?;
    Ok(saved)
}

#[tauri::command]
fn set_launch_at_login(
    app: AppHandle,
    state: State<'_, SharedStore>,
    enabled: bool,
) -> Result<AppSettings, String> {
    let mut store = state.0.lock().map_err(|_| "Store unavailable".to_string())?;
    store.settings.launch_at_login = enabled;
    let saved = store.settings.clone();
    persist_store(&store)?;
    drop(store);

    sync_autostart(&app, enabled);
    Ok(saved)
}

#[tauri::command]
fn set_expanded_size(
    app: AppHandle,
    state: State<'_, SharedStore>,
    width: f64,
    height: f64,
    persist: bool,
) -> Result<AppSettings, String> {
    let window = get_window(&app)?;
    let mut store = state.0.lock().map_err(|_| "Store unavailable".to_string())?;
    store.settings.expanded_width = clamp_expanded_width(width);
    store.settings.expanded_height = clamp_expanded_height(height);

    if let Some(position) = clamp_window_position(
        &window,
        store.settings.window_x,
        store.settings.window_y,
        store.settings.expanded_width,
        store.settings.expanded_height,
    ) {
        store.settings.window_x = Some(position.x as f64);
        store.settings.window_y = position.y as f64;
    }

    let saved = store.settings.clone();
    if persist {
        persist_store(&store)?;
    }
    drop(store);

    if !saved.collapsed {
        apply_window_layout(&window, &saved, false)?;
    }

    Ok(saved)
}

#[tauri::command]
fn persist_window_position(
    app: AppHandle,
    state: State<'_, SharedStore>,
    x: f64,
    y: f64,
) -> Result<AppSettings, String> {
    let window = get_window(&app)?;
    let mut store = state.0.lock().map_err(|_| "Store unavailable".to_string())?;
    let width = if store.settings.collapsed {
        if store.settings.collapse_to_edge {
            COLLAPSED_WIDTH
        } else {
            COLLAPSED_FLOATING_SIZE
        }
    } else {
        store.settings.expanded_width
    };
    let height = if store.settings.collapsed {
        if store.settings.collapse_to_edge {
            COLLAPSED_HEIGHT
        } else {
            COLLAPSED_FLOATING_SIZE
        }
    } else {
        store.settings.expanded_height
    };
    let desired_x = if store.settings.collapsed && store.settings.collapse_to_edge {
        None
    } else {
        Some(x)
    };

    if let Some(position) = clamp_window_position(&window, desired_x, y, width, height) {
        if !(store.settings.collapsed && store.settings.collapse_to_edge) {
            store.settings.window_x = Some(position.x as f64);
        }
        store.settings.window_y = position.y as f64;
    }

    let saved = store.settings.clone();
    persist_store(&store)?;
    drop(store);
    Ok(saved)
}

#[tauri::command]
fn sync_git_todos(state: State<'_, SharedStore>) -> Result<GitSyncResult, String> {
    let mut store = state.0.lock().map_err(|_| "Store unavailable".to_string())?;
    sync_todos_with_git(&mut store)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let store = load_store(&app.handle());
            let settings = store.settings.clone();
            app.manage(SharedStore(Mutex::new(store)));

            sync_autostart(&app.handle(), settings.launch_at_login);

            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                let _ = apply_window_layout(&window, &settings, false);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_app_state,
            create_todo,
            update_todo,
            delete_todo,
            save_settings,
            set_window_expanded,
            set_window_opacity,
            set_launch_at_login,
            set_expanded_size,
            persist_window_position,
            sync_git_todos
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

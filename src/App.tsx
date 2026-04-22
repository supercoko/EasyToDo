import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  register as registerShortcut,
  unregister as unregisterShortcut
} from "@tauri-apps/plugin-global-shortcut";
import type { AppSettings, LoadedAppState, TodoItem, TodoPatch } from "./types";

const appWindow = getCurrentWindow();
const SHORTCUT = "CommandOrControl+Shift+Space";
const COLLAPSE_OPTIONS = [10, 30, 60, 300];
const THEMES = [
  { value: "graphite", label: "石墨灰" },
  { value: "sand", label: "暖沙色" },
  { value: "mint", label: "薄荷青" },
  { value: "sunset", label: "落日橙" }
] as const;
const WIDTH_MIN = 320;
const WIDTH_MAX = 520;
const HEIGHT_MIN = 460;
const HEIGHT_MAX = 920;
const DEFAULT_ERROR = "操作失败，请稍后再试。";

type ResizeState = {
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
};

type CollapsedDragState = {
  pointerId: number;
  startX: number;
  startY: number;
  dragged: boolean;
};

type GitSyncResult = {
  todos: TodoItem[];
  settings: AppSettings;
  commitMessage: string;
};

function sortOpenTodos(todos: TodoItem[]) {
  return [...todos].sort((left, right) => {
    if (left.pinned !== right.pinned) {
      return Number(right.pinned) - Number(left.pinned);
    }

    return right.updatedAt - left.updatedAt;
  });
}

function sortCompletedTodos(todos: TodoItem[]) {
  return [...todos].sort((left, right) => {
    return (right.completedAt ?? right.updatedAt) - (left.completedAt ?? left.updatedAt);
  });
}

function shortcutLabel() {
  return navigator.userAgent.includes("Mac")
    ? "Command + Shift + Space"
    : "Ctrl + Shift + Space";
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function App() {
  const [data, setData] = useState<LoadedAppState | null>(null);
  const [draft, setDraft] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [editingTodoId, setEditingTodoId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");

  const interactionRef = useRef(Date.now());
  const expandRef = useRef<() => void>(() => undefined);
  const movedDebounceRef = useRef<number | null>(null);
  const draggingWindowRef = useRef(false);
  const dragReleaseTimerRef = useRef<number | null>(null);
  const resizingWindowRef = useRef(false);
  const resizeStateRef = useRef<ResizeState | null>(null);
  const resizeDebounceRef = useRef<number | null>(null);
  const collapsedDragRef = useRef<CollapsedDragState | null>(null);

  const settings = data?.settings ?? null;
  const openTodos = useMemo(
    () => sortOpenTodos(data?.todos.filter((todo) => !todo.completed) ?? []),
    [data?.todos]
  );
  const completedTodos = useMemo(
    () => sortCompletedTodos(data?.todos.filter((todo) => todo.completed) ?? []),
    [data?.todos]
  );
  const pendingCount = openTodos.length;
  const isCollapsed = settings?.collapsed ?? false;

  const markInteraction = () => {
    interactionRef.current = Date.now();
  };

  const mergeSettings = (nextSettings: AppSettings) => {
    setData((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        settings: nextSettings
      };
    });
  };

  const finishWindowDrag = () => {
    draggingWindowRef.current = false;
    if (dragReleaseTimerRef.current !== null) {
      window.clearTimeout(dragReleaseTimerRef.current);
      dragReleaseTimerRef.current = null;
    }
  };

  const loadAppState = async () => {
    try {
      setLoading(true);
      setError(null);
      const loaded = await invoke<LoadedAppState>("load_app_state");
      setData(loaded);
      if (!loaded.settings.collapsed) {
        interactionRef.current = Date.now();
      }
    } catch (loadError) {
      console.error(loadError);
      setError("加载待办失败，请重启应用后再试。");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAppState();
  }, []);

  const updateTodoInState = (savedTodo: TodoItem) => {
    setData((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        todos: current.todos.map((todo) => (todo.id === savedTodo.id ? savedTodo : todo))
      };
    });
  };

  const expandWindow = async () => {
    if (!settings || !settings.collapsed) {
      markInteraction();
      return;
    }

    markInteraction();
    setError(null);

    try {
      const nextSettings = await invoke<AppSettings>("set_window_expanded", {
        expanded: true
      });
      mergeSettings(nextSettings);
    } catch (expandError) {
      console.error(expandError);
      setError(DEFAULT_ERROR);
    }
  };

  expandRef.current = () => {
    void expandWindow();
  };

  const collapseWindow = async () => {
    if (
      !settings ||
      settings.collapsed ||
      showSettings ||
      draggingWindowRef.current ||
      resizingWindowRef.current
    ) {
      return;
    }

    try {
      const nextSettings = await invoke<AppSettings>("set_window_expanded", {
        expanded: false
      });
      mergeSettings(nextSettings);
      setShowSettings(false);
    } catch (collapseError) {
      console.error(collapseError);
      setError(DEFAULT_ERROR);
    }
  };

  useEffect(() => {
    const onFocus = () => {
      finishWindowDrag();
      markInteraction();
    };

    const onMove = () => {
      markInteraction();
    };

    window.addEventListener("focus", onFocus);
    window.addEventListener("pointerdown", onMove, { passive: true });
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("keydown", onMove);

    return () => {
      finishWindowDrag();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pointerdown", onMove);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("keydown", onMove);
    };
  }, []);

  useEffect(() => {
    if (!settings || settings.collapsed || showSettings) {
      return;
    }

    const timer = window.setInterval(() => {
      if (draggingWindowRef.current || resizingWindowRef.current) {
        return;
      }

      if (Date.now() - interactionRef.current >= settings.autoCollapseSeconds * 1000) {
        void collapseWindow();
      }
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [settings, showSettings]);

  useEffect(() => {
    let active = true;

    const installShortcut = async () => {
      try {
        await registerShortcut(SHORTCUT, () => {
          expandRef.current();
        });
      } catch (shortcutError) {
        if (active) {
          console.error(shortcutError);
        }
      }
    };

    void installShortcut();

    return () => {
      active = false;
      void unregisterShortcut(SHORTCUT).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const bindMovedListener = async () => {
      unlisten = await appWindow.onMoved(({ payload }) => {
        setData((current) => {
          if (!current) {
            return current;
          }

          return {
            ...current,
            settings: {
              ...current.settings,
              windowX:
                current.settings.collapsed && current.settings.collapseToEdge
                  ? current.settings.windowX
                  : payload.x,
              windowY: payload.y
            }
          };
        });

        if (movedDebounceRef.current !== null) {
          window.clearTimeout(movedDebounceRef.current);
        }

        movedDebounceRef.current = window.setTimeout(() => {
          void invoke<AppSettings>("persist_window_position", {
            x: payload.x,
            y: payload.y
          })
            .then((nextSettings) => {
              mergeSettings(nextSettings);
            })
            .catch((moveError) => {
              console.error(moveError);
            });
        }, 160);
      });
    };

    void bindMovedListener();

    return () => {
      if (movedDebounceRef.current !== null) {
        window.clearTimeout(movedDebounceRef.current);
      }

      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  const saveSettings = async (nextSettings: AppSettings) => {
    setSaving(true);
    setError(null);

    try {
      const savedSettings = await invoke<AppSettings>("save_settings", {
        settings: nextSettings
      });
      mergeSettings(savedSettings);
      return savedSettings;
    } catch (saveError) {
      console.error(saveError);
      setError(DEFAULT_ERROR);
      return null;
    } finally {
      setSaving(false);
    }
  };

  const handleCreateTodo = async (event: FormEvent) => {
    event.preventDefault();
    const title = draft.trim();

    if (!title) {
      return;
    }

    markInteraction();
    setSaving(true);
    setError(null);

    try {
      const createdTodo = await invoke<TodoItem>("create_todo", { title });
      setData((current) => {
        if (!current) {
          return current;
        }

        return {
          ...current,
          todos: [createdTodo, ...current.todos]
        };
      });
      setDraft("");
    } catch (createError) {
      console.error(createError);
      setError("添加待办失败，请稍后再试。");
    } finally {
      setSaving(false);
    }
  };

  const patchTodo = async (todo: TodoItem, patch: TodoPatch) => {
    markInteraction();
    setSaving(true);
    setError(null);

    try {
      const savedTodo = await invoke<TodoItem>("update_todo", {
        id: todo.id,
        patch
      });
      updateTodoInState(savedTodo);
      return savedTodo;
    } catch (patchError) {
      console.error(patchError);
      setError(DEFAULT_ERROR);
      return null;
    } finally {
      setSaving(false);
    }
  };

  const removeTodo = async (todoId: string) => {
    markInteraction();
    setSaving(true);
    setError(null);

    try {
      await invoke("delete_todo", { id: todoId });
      setData((current) => {
        if (!current) {
          return current;
        }

        return {
          ...current,
          todos: current.todos.filter((todo) => todo.id !== todoId)
        };
      });

      if (editingTodoId === todoId) {
        setEditingTodoId(null);
        setEditingTitle("");
      }
    } catch (deleteError) {
      console.error(deleteError);
      setError(DEFAULT_ERROR);
    } finally {
      setSaving(false);
    }
  };

  const handleOpacityChange = async (value: number) => {
    if (!settings) {
      return;
    }

    markInteraction();
    const opacity = value / 100;
    mergeSettings({
      ...settings,
      opacity
    });

    try {
      const nextSettings = await invoke<AppSettings>("set_window_opacity", { opacity });
      mergeSettings(nextSettings);
    } catch (opacityError) {
      console.error(opacityError);
      setError(DEFAULT_ERROR);
    }
  };

  const updateExpandedSize = async (width: number, height: number, persist: boolean) => {
    try {
      const nextSettings = await invoke<AppSettings>("set_expanded_size", {
        width,
        height,
        persist
      });
      mergeSettings(nextSettings);
    } catch (resizeError) {
      console.error(resizeError);
      setError(DEFAULT_ERROR);
    }
  };

  const handleExpandedSizeChange = async (
    field: "expandedWidth" | "expandedHeight",
    value: number
  ) => {
    if (!settings) {
      return;
    }

    markInteraction();
    const nextSettings = {
      ...settings,
      [field]: value
    };
    mergeSettings(nextSettings);
    await saveSettings(nextSettings);
  };

  const handleLaunchAtLoginChange = async (enabled: boolean) => {
    if (!settings) {
      return;
    }

    markInteraction();
    mergeSettings({
      ...settings,
      launchAtLogin: enabled
    });

    try {
      const nextSettings = await invoke<AppSettings>("set_launch_at_login", {
        enabled
      });
      mergeSettings(nextSettings);
    } catch (launchError) {
      console.error(launchError);
      setError(DEFAULT_ERROR);
    }
  };

  const handleGitSync = async () => {
    setSyncing(true);
    setError(null);
    setSyncMessage(null);

    try {
      const result = await invoke<GitSyncResult>("sync_git_todos");
      setData({
        todos: result.todos,
        settings: result.settings
      });
      setSyncMessage(`同步完成：${result.commitMessage}`);
    } catch (syncError) {
      console.error(syncError);
      setError(typeof syncError === "string" ? syncError : "Git 同步失败。");
    } finally {
      setSyncing(false);
    }
  };

  const beginEditing = (todo: TodoItem) => {
    markInteraction();
    setEditingTodoId(todo.id);
    setEditingTitle(todo.title);
  };

  const cancelEditing = () => {
    setEditingTodoId(null);
    setEditingTitle("");
  };

  const saveEditedTodo = async (todo: TodoItem) => {
    const title = editingTitle.trim();
    if (!title) {
      setError("待办内容不能为空。");
      return;
    }

    const saved = await patchTodo(todo, { title });
    if (saved) {
      setEditingTodoId(null);
      setEditingTitle("");
    }
  };

  const startWindowDrag = (event: React.PointerEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("button, input, label, select, textarea, .resize-handle")) {
      return;
    }

    markInteraction();
    draggingWindowRef.current = true;
    window.addEventListener("pointerup", finishWindowDrag, { once: true });
    window.addEventListener("pointercancel", finishWindowDrag, { once: true });
    dragReleaseTimerRef.current = window.setTimeout(() => {
      finishWindowDrag();
    }, 1500);

    void appWindow.startDragging().catch((dragError) => {
      finishWindowDrag();
      console.error(dragError);
    });
  };

  const handleCollapsedPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!settings) {
      return;
    }

    collapsedDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragged: false
    };
  };

  const handleCollapsedPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const current = collapsedDragRef.current;
    if (!current || current.pointerId !== event.pointerId || current.dragged) {
      return;
    }

    const movedEnough =
      Math.abs(event.clientX - current.startX) > 4 || Math.abs(event.clientY - current.startY) > 4;
    if (!movedEnough) {
      return;
    }

    collapsedDragRef.current = {
      ...current,
      dragged: true
    };
    draggingWindowRef.current = true;
    dragReleaseTimerRef.current = window.setTimeout(() => {
      finishWindowDrag();
    }, 1500);
    void appWindow.startDragging().catch((dragError) => {
      finishWindowDrag();
      console.error(dragError);
    });
  };

  const handleCollapsedPointerUp = () => {
    const current = collapsedDragRef.current;
    collapsedDragRef.current = null;
    if (current?.dragged) {
      finishWindowDrag();
      return;
    }

    void expandWindow();
  };

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!settings || settings.collapsed) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    markInteraction();
    resizingWindowRef.current = true;
    resizeStateRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      startWidth: settings.expandedWidth,
      startHeight: settings.expandedHeight
    };

    let lastPointerX = event.clientX;
    let lastPointerY = event.clientY;

    const stopResize = () => {
      const current = resizeStateRef.current;
      resizingWindowRef.current = false;
      resizeStateRef.current = null;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);

      if (resizeDebounceRef.current !== null) {
        window.clearTimeout(resizeDebounceRef.current);
        resizeDebounceRef.current = null;
      }

      if (!current) {
        return;
      }

      const finalWidth = clamp(
        current.startWidth + (lastPointerX - current.startX),
        WIDTH_MIN,
        WIDTH_MAX
      );
      const finalHeight = clamp(
        current.startHeight + (lastPointerY - current.startY),
        HEIGHT_MIN,
        HEIGHT_MAX
      );

      void updateExpandedSize(finalWidth, finalHeight, true);
    };

    const onPointerMove = (moveEvent: PointerEvent) => {
      const current = resizeStateRef.current;
      if (!current || !settings) {
        return;
      }

      markInteraction();
      lastPointerX = moveEvent.clientX;
      lastPointerY = moveEvent.clientY;

      const nextWidth = clamp(
        current.startWidth + (moveEvent.clientX - current.startX),
        WIDTH_MIN,
        WIDTH_MAX
      );
      const nextHeight = clamp(
        current.startHeight + (moveEvent.clientY - current.startY),
        HEIGHT_MIN,
        HEIGHT_MAX
      );

      mergeSettings({
        ...settings,
        expandedWidth: nextWidth,
        expandedHeight: nextHeight
      });

      if (resizeDebounceRef.current !== null) {
        window.clearTimeout(resizeDebounceRef.current);
      }

      resizeDebounceRef.current = window.setTimeout(() => {
        void updateExpandedSize(nextWidth, nextHeight, false);
      }, 32);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopResize, { once: true });
    window.addEventListener("pointercancel", stopResize, { once: true });
  };

  const renderActionButtons = (todo: TodoItem) => {
    if (editingTodoId === todo.id) {
      return (
        <div className="todo-actions editing">
          <button className="mini-button" onClick={() => void saveEditedTodo(todo)} type="button">
            存
          </button>
          <button className="mini-button" onClick={cancelEditing} type="button">
            取
          </button>
        </div>
      );
    }

    return (
      <div className="todo-actions">
        {!todo.completed ? (
          <button
            className={`mini-button ${todo.pinned ? "active" : ""}`}
            onClick={() => void patchTodo(todo, { pinned: !todo.pinned })}
            title={todo.pinned ? "取消置顶" : "置顶"}
            type="button"
          >
            顶
          </button>
        ) : null}
        <button className="mini-button" onClick={() => beginEditing(todo)} title="编辑" type="button">
          改
        </button>
        <button
          className="mini-button danger"
          onClick={() => void removeTodo(todo.id)}
          title="删除"
          type="button"
        >
          删
        </button>
      </div>
    );
  };

  const renderTodoCard = (todo: TodoItem) => {
    const isEditing = editingTodoId === todo.id;

    return (
      <article
        className={`todo-card ${todo.pinned ? "pinned" : ""} ${todo.completed ? "completed" : ""}`}
        key={todo.id}
      >
        <button
          className={`check-button ${todo.completed ? "checked" : ""}`}
          onClick={() => void patchTodo(todo, { completed: !todo.completed })}
          type="button"
        >
          {todo.completed ? "✓" : ""}
        </button>

        <div className="todo-main">
          <div className="todo-copy">
            {isEditing ? (
              <form
                className="edit-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveEditedTodo(todo);
                }}
              >
                <input
                  autoFocus
                  className="edit-input"
                  onChange={(event) => setEditingTitle(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      cancelEditing();
                    }
                  }}
                  type="text"
                  value={editingTitle}
                />
              </form>
            ) : (
              <>
                <button
                  className="todo-title-button"
                  onClick={() => beginEditing(todo)}
                  type="button"
                >
                  <span className="todo-title" title={todo.title}>
                    {todo.title}
                  </span>
                </button>
                <div className="todo-meta">
                  {todo.completed ? "已完成" : todo.pinned ? "已置顶" : "进行中"}
                </div>
              </>
            )}
          </div>

          {renderActionButtons(todo)}
        </div>
      </article>
    );
  };

  if (loading) {
    return <div className="shell loading-shell">正在加载待办...</div>;
  }

  if (!data || !settings) {
    return (
      <div className="shell loading-shell">
        <div>无法加载待办数据。</div>
        <button className="ghost-button" onClick={() => void loadAppState()} type="button">
          重新加载
        </button>
      </div>
    );
  }

  const themeClass = `theme-${settings.theme}`;

  if (isCollapsed) {
    return (
      <button
        className={`collapsed-shell ${settings.collapseToEdge ? "edge" : "floating"} ${themeClass}`}
        onPointerDown={handleCollapsedPointerDown}
        onPointerMove={handleCollapsedPointerMove}
        onPointerUp={handleCollapsedPointerUp}
        onPointerCancel={() => {
          collapsedDragRef.current = null;
          finishWindowDrag();
        }}
        style={{ opacity: settings.opacity }}
        type="button"
      >
        {settings.collapseToEdge ? <span className="collapsed-label">待办</span> : null}
        <span className="collapsed-count">{pendingCount}</span>
      </button>
    );
  }

  return (
    <div
      className={`shell ${themeClass}`}
      onMouseEnter={markInteraction}
      style={{ opacity: settings.opacity }}
    >
      <header className="shell-header" onPointerDown={startWindowDrag}>
        <div>
          <div className="eyebrow">防遗忘悬浮待办</div>
          <div className="header-count">
            <span className="count-pill">{pendingCount}</span>
            <span className="count-label">个未完成</span>
          </div>
        </div>

        <div className="header-actions">
          <button
            className="icon-button"
            onClick={() => setShowSettings((current) => !current)}
            type="button"
          >
            设置
          </button>
          <button className="icon-button" onClick={() => void collapseWindow()} type="button">
            折叠
          </button>
        </div>
      </header>

      {showSettings ? (
        <section className="settings-panel">
          <div className="settings-row">
            <span>界面颜色</span>
            <select
              onChange={(event) => {
                void saveSettings({
                  ...settings,
                  theme: event.target.value
                });
              }}
              value={settings.theme}
            >
              {THEMES.map((theme) => (
                <option key={theme.value} value={theme.value}>
                  {theme.label}
                </option>
              ))}
            </select>
          </div>

          <div className="settings-row">
            <span>透明度</span>
            <label className="range-row">
              <input
                max={100}
                min={65}
                onChange={(event) => void handleOpacityChange(Number(event.target.value))}
                type="range"
                value={Math.round(settings.opacity * 100)}
              />
              <strong>{Math.round(settings.opacity * 100)}%</strong>
            </label>
          </div>

          <div className="settings-row">
            <span>自动折叠</span>
            <select
              onChange={(event) => {
                const nextValue = Number(event.target.value);
                void saveSettings({
                  ...settings,
                  autoCollapseSeconds: nextValue
                });
              }}
              value={settings.autoCollapseSeconds}
            >
              {COLLAPSE_OPTIONS.map((seconds) => (
                <option key={seconds} value={seconds}>
                  {seconds} 秒
                </option>
              ))}
            </select>
          </div>

          <div className="settings-row">
            <span>展开宽度</span>
            <label className="range-row">
              <input
                max={WIDTH_MAX}
                min={WIDTH_MIN}
                onChange={(event) =>
                  void handleExpandedSizeChange("expandedWidth", Number(event.target.value))
                }
                type="range"
                value={settings.expandedWidth}
              />
              <strong>{settings.expandedWidth}px</strong>
            </label>
          </div>

          <div className="settings-row">
            <span>展开高度</span>
            <label className="range-row">
              <input
                max={HEIGHT_MAX}
                min={HEIGHT_MIN}
                onChange={(event) =>
                  void handleExpandedSizeChange("expandedHeight", Number(event.target.value))
                }
                type="range"
                value={settings.expandedHeight}
              />
              <strong>{settings.expandedHeight}px</strong>
            </label>
          </div>

          <label className="toggle-row">
            <input
              checked={settings.collapseToEdge}
              onChange={(event) => {
                void saveSettings({
                  ...settings,
                  collapseToEdge: event.target.checked
                });
              }}
              type="checkbox"
            />
            折叠后贴边
          </label>

          <label className="toggle-row">
            <input
              checked={settings.alwaysOnTop}
              onChange={(event) => {
                void saveSettings({
                  ...settings,
                  alwaysOnTop: event.target.checked
                });
              }}
              type="checkbox"
            />
            始终置顶
          </label>

          <label className="toggle-row">
            <input
              checked={settings.launchAtLogin}
              onChange={(event) => {
                void handleLaunchAtLoginChange(event.target.checked);
              }}
              type="checkbox"
            />
            开机自启
          </label>

          <label className="toggle-row">
            <input
              checked={settings.gitSyncEnabled}
              onChange={(event) => {
                void saveSettings({
                  ...settings,
                  gitSyncEnabled: event.target.checked
                });
              }}
              type="checkbox"
            />
            启用 Git 同步
          </label>

          <div className="settings-row settings-stack">
            <span>Git 仓库路径</span>
            <input
              className="settings-text"
              onChange={(event) => {
                mergeSettings({
                  ...settings,
                  gitRepoPath: event.target.value
                });
              }}
              onBlur={() => void saveSettings(settings)}
              placeholder="例如 D:\sync\todo-repo"
              type="text"
              value={settings.gitRepoPath}
            />
          </div>

          <div className="settings-row settings-stack">
            <span>同步分支</span>
            <input
              className="settings-text"
              onChange={(event) => {
                mergeSettings({
                  ...settings,
                  gitBranch: event.target.value
                });
              }}
              onBlur={() => void saveSettings(settings)}
              placeholder="main"
              type="text"
              value={settings.gitBranch}
            />
          </div>

          <div className="settings-row settings-stack">
            <span>同步文件</span>
            <input
              className="settings-text"
              onChange={(event) => {
                mergeSettings({
                  ...settings,
                  gitTodosFile: event.target.value
                });
              }}
              onBlur={() => void saveSettings(settings)}
              placeholder="focus-float-todo/todos.json"
              type="text"
              value={settings.gitTodosFile}
            />
          </div>

          <button
            className="sync-button"
            disabled={!settings.gitSyncEnabled || syncing}
            onClick={() => void handleGitSync()}
            type="button"
          >
            {syncing ? "同步中..." : "立即同步"}
          </button>

          {syncMessage ? <div className="sync-banner success">{syncMessage}</div> : null}

          <div className="settings-hint">
            全局快捷键：<strong>{shortcutLabel()}</strong>
          </div>
          <div className="settings-hint">
            Git 同步流程：`pull --rebase` {"->"} 写入待办 JSON {"->"} `commit` {"->"} `push`
          </div>
        </section>
      ) : null}

      <section className="quick-add">
        <form onSubmit={handleCreateTodo}>
          <input
            onChange={(event) => setDraft(event.target.value)}
            placeholder="输入待办后回车"
            type="text"
            value={draft}
          />
        </form>
      </section>

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="todo-section">
        <div className="section-title">当前待办</div>
        <div className="todo-list">
          {openTodos.length === 0 ? (
            <div className="empty-state">暂时清空了，保持住。</div>
          ) : (
            openTodos.map((todo) => renderTodoCard(todo))
          )}
        </div>
      </section>

      <section className="todo-section completed-section">
        <button
          className="section-toggle"
          onClick={() => setShowCompleted((current) => !current)}
          type="button"
        >
          已完成 {completedTodos.length} {showCompleted ? "收起" : "展开"}
        </button>
        {showCompleted ? (
          <div className="todo-list compact">
            {completedTodos.length === 0 ? (
              <div className="empty-state subtle">还没有已完成待办。</div>
            ) : (
              completedTodos.map((todo) => renderTodoCard(todo))
            )}
          </div>
        ) : null}
      </section>

      <footer className="status-bar">
        <span>{saving ? "正在保存..." : "已自动保存"}</span>
        <span>{settings.gitSyncEnabled ? "Git 同步已启用" : "仅本地保存"}</span>
      </footer>

      <div className="resize-handle" onPointerDown={startResize} />
    </div>
  );
}

export default App;

export interface TodoItem {
  id: string;
  title: string;
  completed: boolean;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  completedAt?: number | null;
}

export interface AppSettings {
  opacity: number;
  autoCollapseSeconds: number;
  launchAtLogin: boolean;
  alwaysOnTop: boolean;
  anchorSide: "right";
  windowX: number | null;
  windowY: number;
  expandedWidth: number;
  expandedHeight: number;
  collapseToEdge: boolean;
  collapsed: boolean;
  theme: string;
}

export interface LoadedAppState {
  todos: TodoItem[];
  settings: AppSettings;
}

export interface TodoPatch {
  title?: string;
  completed?: boolean;
  pinned?: boolean;
}

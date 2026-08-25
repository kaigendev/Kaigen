export type BackendEvent<T> = {
  event: string;
  id: number;
  payload: T;
};

export type UnlistenFn = () => void;

export type DialogFilter = {
  name: string;
  extensions: string[];
};

export type OpenDialogOptions = {
  directory?: boolean;
  multiple?: boolean;
  title?: string;
  filters?: DialogFilter[];
};

export type NotificationPermission = "granted" | "denied" | "default";

export type NotificationOptions = {
  title: string;
  body?: string;
  autoCancel?: boolean;
};

export type PlatformCapabilities = {
  product: "desktop" | "web";
  nativeFilesystem: boolean;
  systemTray: boolean;
  browserAuthorization: boolean;
};

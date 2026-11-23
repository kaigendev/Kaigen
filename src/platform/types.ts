export type DialogFilter = {
  name: string;
  extensions: string[];
};

export type AttachmentFileRequest = {
  profileId: string;
  friendNumber: number;
  messageId: string;
  path: string;
  name: string;
};

export type AttachmentMediaSource = { url: string; blob: Blob; release: () => void };
export type AttachmentDirection = "incoming" | "outgoing";

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
  nativeFilesystem: boolean;
  systemTray: boolean;
  browserAuthorization: boolean;
  containerRelativeLayout: boolean;
  outgoingTransferRetry: boolean;
  proxyConnectivityTest: boolean;
};

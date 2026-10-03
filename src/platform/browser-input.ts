export type BrowserInput = {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  primaryCoarsePointer: boolean;
};

/** A first-run default only; a persisted user choice always takes precedence. */
export function getDefaultSendOnEnter(nativeFilesystem: boolean, input?: BrowserInput): boolean {
  if (nativeFilesystem) return true;
  const browser = input ?? {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    primaryCoarsePointer: window.matchMedia("(pointer: coarse)").matches,
  };
  const { userAgent, platform, maxTouchPoints, primaryCoarsePointer } = browser;
  const ipad = /iPad/iu.test(userAgent)
    || (/Macintosh/iu.test(userAgent) || /^Mac/iu.test(platform)) && maxTouchPoints > 1;
  const androidTablet = /Android/iu.test(userAgent) && !/Mobile/iu.test(userAgent);
  if (ipad || androidTablet) return false;
  // Touchscreen Windows/Linux computers retain the desktop keyboard default.
  if (/Windows/iu.test(userAgent) || /^(?:Win|Linux)/iu.test(platform) && !/Android/iu.test(userAgent)) return true;
  return !(maxTouchPoints > 0 && primaryCoarsePointer);
}

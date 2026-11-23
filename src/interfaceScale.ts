export type AppShellScaleStyle = {
  width: string;
  height: string;
  zoom?: number;
  transform?: string;
  transformOrigin?: string;
};

type RuntimePlatform = "windows" | "macos" | "linux" | "web";
declare const __KAIGEN_RUNTIME_PLATFORM__: RuntimePlatform;

export function appShellScaleStyle(
  interfaceScale: number,
  containerRelativeLayout: boolean,
  platform = typeof __KAIGEN_RUNTIME_PLATFORM__ === "undefined" ? undefined : __KAIGEN_RUNTIME_PLATFORM__,
): AppShellScaleStyle {
  const normalized = Number.isFinite(interfaceScale) && interfaceScale > 0 ? interfaceScale : 100;
  const scale = normalized / 100;
  const widthUnit = containerRelativeLayout ? "%" : "vw";
  const heightUnit = containerRelativeLayout ? "%" : "vh";
  const shared = {
    width: `${100 / scale}${widthUnit}`,
    height: `${100 / scale}${heightUnit}`,
  };
  // The Web grid needs a transform for percentage heights. Older native
  // WebKit also mismeasures viewport units and hit coordinates under CSS zoom.
  const scaledNativeWebKit = scale !== 1 && (platform === "macos" || platform === "linux");
  return containerRelativeLayout || scaledNativeWebKit
    ? { ...shared, transform: `scale(${scale})`, transformOrigin: "top left" }
    : { ...shared, zoom: scale };
}

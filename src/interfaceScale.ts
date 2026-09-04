export type AppShellScaleStyle = {
  width: string;
  height: string;
  zoom?: number;
  transform?: string;
  transformOrigin?: string;
};

export function appShellScaleStyle(interfaceScale: number, containerRelativeLayout: boolean): AppShellScaleStyle {
  const normalized = Number.isFinite(interfaceScale) && interfaceScale > 0 ? interfaceScale : 100;
  const scale = normalized / 100;
  const widthUnit = containerRelativeLayout ? "%" : "vw";
  const heightUnit = containerRelativeLayout ? "%" : "vh";
  const shared = {
    width: `${100 / scale}${widthUnit}`,
    height: `${100 / scale}${heightUnit}`,
  };
  // Chromium resolves percentage heights incorrectly for a zoomed child of
  // the clipped Web grid surface. A top-left transform keeps the scaled shell
  // inside that surface at 80/90% without changing desktop WebView behavior.
  return containerRelativeLayout
    ? { ...shared, transform: `scale(${scale})`, transformOrigin: "top left" }
    : { ...shared, zoom: scale };
}

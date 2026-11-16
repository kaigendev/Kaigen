import { useLayoutEffect, useRef } from "react";
import { useI18n } from "./i18n";
import appUiCatalog from "./App.ui-ids.json" with { type: "json" };

export function ChatImageViewer({ url, name, video = false, onClose }: { url: string; name: string; video?: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const viewerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const previousFocus = document.activeElement;
    viewerRef.current?.focus({ preventScroll: true });
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);
  return <div ref={viewerRef} className="image-viewer" tabIndex={-1} role="dialog" data-kaigen-ui-id={appUiCatalog.ids.main_chat_image_group_viewer}
    aria-label={video ? name : t("Полноразмерное изображение")} onClick={onClose}
    onKeyDown={(event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }}>
    {video ? <video src={url} aria-label={name} controls playsInline preload="metadata" onClick={(event) => event.stopPropagation()} />
      : <img src={url} alt={name} data-kaigen-ui-id={appUiCatalog.ids.main_chat_image_element_image} data-i18n-ignore translate="no" />}
    <button type="button" className="image-viewer-close" aria-label={t(video ? "Закрыть" : "Закрыть просмотр изображения")}
      data-kaigen-ui-id={appUiCatalog.ids.main_chat_image_element_close} title={t(video ? "Закрыть" : "Закрыть просмотр изображения")}>×</button>
  </div>;
}

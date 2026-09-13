import { useLayoutEffect, useRef } from "react";
import { useI18n } from "./i18n";
import appUiCatalog from "./App.ui-ids.json" with { type: "json" };

export function ChatImageViewer({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
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
    aria-label={t("Полноразмерное изображение")} onClick={onClose}
    onKeyDown={(event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }}>
    <img src={url} alt={name} data-kaigen-ui-id={appUiCatalog.ids.main_chat_image_element_image} data-i18n-ignore translate="no" />
    <button type="button" className="image-viewer-close" aria-label={t("Закрыть просмотр изображения")}
      data-kaigen-ui-id={appUiCatalog.ids.main_chat_image_element_close} title={t("Закрыть просмотр изображения")}>×</button>
  </div>;
}

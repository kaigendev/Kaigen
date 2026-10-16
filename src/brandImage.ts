export const brandImageUrl = "/kaigen-brand-93740b25.webp";

let readiness: Promise<void> | undefined;

export function prepareBrandImage(): Promise<void> {
  if (readiness) return readiness;

  readiness = new Promise<void>((resolve) => {
    const image = new Image();
    const finish = () => {
      image.onload = null;
      image.onerror = null;
      resolve();
    };
    const loaded = new Promise<void>((resolveLoaded) => {
      image.onload = () => resolveLoaded();
      image.onerror = () => resolveLoaded();
      image.src = brandImageUrl;
      if (image.complete) resolveLoaded();
    });

    // Older WebViews can load an image without supporting decode(). A failed
    // asset must not prevent access to the application.
    if (typeof image.decode === "function") {
      void image.decode().catch(() => loaded).then(finish);
    } else {
      void loaded.then(finish);
    }
  });

  return readiness;
}

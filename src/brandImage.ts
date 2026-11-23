export const brandImageUrl = "/kaigen-brand-93740b25.webp";

let readiness: Promise<void> | undefined;

export function prepareBrandImage(): Promise<void> {
  if (readiness) return readiness;

  readiness = new Promise<void>((resolve) => {
    const image = new Image();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
      resolve();
    };
    const timeout = setTimeout(finish, 3000);
    image.onerror = finish;
    image.onload = () => {
      if (typeof image.decode !== "function") finish();
    };
    image.src = brandImageUrl;

    // The decorative asset must never keep the application on its splash screen.
    if (typeof image.decode === "function") {
      try {
        void image.decode().then(finish, finish);
      } catch {
        finish();
      }
    } else if (image.complete) {
      finish();
    }
  });

  return readiness;
}

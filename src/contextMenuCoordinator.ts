type MenuDismissal = () => void;

const dismissals = new Set<MenuDismissal>();

/** Register the mounted owner, even while its menu is closed. */
export function registerContextMenuDismissal(dismiss: MenuDismissal) {
  // A distinct registration keeps an old cleanup from removing a newer owner
  // that happens to use the same callback (including React StrictMode mounts).
  const registration = () => dismiss();
  dismissals.add(registration);
  return () => { dismissals.delete(registration); };
}

/** Call synchronously before opening a menu, so portals share one menu slot. */
export function dismissContextMenus() {
  for (const dismiss of [...dismissals]) dismiss();
}

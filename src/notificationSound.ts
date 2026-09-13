export type NotificationAudio = Pick<HTMLAudioElement, "currentTime" | "volume" | "src" | "play" | "pause" | "load">;

export const DEFAULT_NOTIFICATION_SOUND = { notifySound: false, notificationVolume: 0.7 } as const;

export function normalizeNotificationSound(value: { notifySound?: unknown; notificationVolume?: unknown }) {
  return {
    notifySound: value.notifySound === true,
    notificationVolume: typeof value.notificationVolume === "number" && Number.isFinite(value.notificationVolume)
      ? Math.min(1, Math.max(0, value.notificationVolume)) : DEFAULT_NOTIFICATION_SOUND.notificationVolume,
  };
}

export function createNotificationSoundPlayer(createAudio: () => NotificationAudio, foreground: () => boolean) {
  let audio: NotificationAudio | undefined;
  let disposed = false;
  return {
    play(volume: unknown) {
      if (disposed || foreground() || typeof volume !== "number" || !Number.isFinite(volume) || volume <= 0) return;
      try {
        audio ??= createAudio();
        audio.volume = Math.min(1, volume);
        audio.currentTime = 0;
        void audio.play().catch(() => {});
      } catch {
        // A device/decoder failure must not escape the native event listener.
      }
    },
    stop() {
      audio?.pause();
    },
    dispose() {
      disposed = true;
      if (!audio) return;
      audio.pause();
      audio.src = "";
      audio.load();
      audio = undefined;
    },
  };
}

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { MAX_CHAT_FILE_BYTES } from "./fileReceiveSettings";
import { useI18n } from "./i18n";
import "./ChatMediaCard.css";

export type ChatMediaSource = { url: string; blob: Blob; release?: () => void };
export type ChatMediaCardProps = {
  kind: "audio" | "video";
  name: string;
  sourceKey: string;
  loadSource: (signal: AbortSignal) => Promise<ChatMediaSource>;
  onGeometryChange?: () => void;
  onOpenOriginal?: () => void;
  onExpandedChange?: (expanded: boolean) => void;
};

type MediaState = "loading" | "preparing" | "ready" | "cancelled" | "error";
const PLAYBACK_EVENT = "kaigen-chat-media-playing";
const LOAD_TIMEOUT_MS = 20_000;
const PREPARE_TIMEOUT_MS = 150_000;
const DEFAULT_VOLUME = 0.7;

export function stopChatMediaPlayback() {
  document.dispatchEvent(new CustomEvent(PLAYBACK_EVENT, { detail: null }));
}

function formatTime(value: number) {
  const seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function ChatMediaCard({ kind, name, sourceKey, loadSource, onGeometryChange, onOpenOriginal, onExpandedChange }: ChatMediaCardProps) {
  const { language } = useI18n();
  const label = (ru: string, en: string) => language === "en" ? en : ru;
  const id = useId();
  const slotRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const expandFocusRef = useRef<Element | null>(null);
  // A stable portal target lets expansion move the actual player without reloading it.
  const [portalHost] = useState(() => document.createElement("div"));
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<MediaState>("loading");
  const [url, setUrl] = useState<string>();
  const [poster, setPoster] = useState<string>();
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(DEFAULT_VOLUME);
  const [muted, setMuted] = useState(false);
  const lastAudibleVolumeRef = useRef(DEFAULT_VOLUME);
  const [retry, setRetry] = useState(0);
  const [needsTap, setNeedsTap] = useState(false);
  const [systemVolume, setSystemVolume] = useState(false);
  const [admittedKey, setAdmittedKey] = useState<string | null>(null);
  const callbacks = useRef({ loadSource, onGeometryChange, onExpandedChange });
  callbacks.current = { loadSource, onGeometryChange, onExpandedChange };
  const generationRef = useRef(0);
  const operationRef = useRef<AbortController | null>(null);
  const sourceRef = useRef<ChatMediaSource | null>(null);
  const convertedUrlRef = useRef<string | undefined>(undefined);
  const expectedUrlRef = useRef<string | undefined>(undefined);
  const posterCapturedRef = useRef(false);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fallbackAttemptedRef = useRef(false);
  const conversionPendingRef = useRef(false);
  const retryPlaybackRef = useRef(false);
  const wantsPlaybackRef = useRef(false);
  const fallbackRef = useRef<() => void>(() => undefined);
  const playRef = useRef<() => void>(() => undefined);
  const audioGraphRef = useRef<{ context: AudioContext; source: MediaElementAudioSourceNode; gain: GainNode } | null>(null);

  function applyVolume(media: HTMLMediaElement, value: number, mute: boolean, allowGraph = false) {
    let graph = audioGraphRef.current;
    if (!graph) {
      try { media.volume = value; } catch { /* Some mobile engines reserve element volume for the system. */ }
      media.muted = mute;
      const needsGain = Math.abs(media.volume - value) > 0.01;
      if (needsGain && allowGraph) {
        const Context = window.AudioContext
          ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (Context) {
          let context: AudioContext | undefined;
          try {
            context = new Context();
            const source = context.createMediaElementSource(media);
            const gain = context.createGain();
            gain.gain.value = mute ? 0 : value;
            source.connect(gain);
            gain.connect(context.destination);
            graph = { context, source, gain };
            audioGraphRef.current = graph;
          } catch {
            void context?.close().catch(() => undefined);
          }
        }
      }
      setSystemVolume(needsGain && !graph);
    }
    if (graph) {
      media.volume = 1;
      media.muted = false;
      graph.gain.gain.value = mute ? 0 : value;
      if (allowGraph) void graph.context.resume().catch(() => setNeedsTap(true));
      setSystemVolume(false);
    }
  }

  function clearWatchdog() {
    clearTimeout(watchdogRef.current);
    watchdogRef.current = undefined;
  }

  function toggleMute() {
    const nextMuted = !(muted || volume === 0);
    const nextVolume = !nextMuted && volume === 0 ? lastAudibleVolumeRef.current : volume;
    if (mediaRef.current) applyVolume(mediaRef.current, nextVolume, nextMuted, true);
    setVolume(nextVolume);
    setMuted(nextMuted);
  }

  function releaseSources() {
    const original = sourceRef.current;
    sourceRef.current = null;
    original?.release?.();
    if (convertedUrlRef.current) URL.revokeObjectURL(convertedUrlRef.current);
    convertedUrlRef.current = undefined;
  }

  function pause() {
    wantsPlaybackRef.current = false;
    mediaRef.current?.pause();
    void audioGraphRef.current?.context.suspend().catch(() => undefined);
    setPlaying(false);
    setBuffering(false);
  }

  function stop() {
    pause();
    const media = mediaRef.current;
    if (media?.readyState) media.currentTime = 0;
    setCurrentTime(0);
  }

  function play() {
    wantsPlaybackRef.current = true;
    setNeedsTap(false);
    const media = mediaRef.current;
    if (!media?.src || media.error) {
      if (media?.error) fallbackRef.current();
      return;
    }
    applyVolume(media, volume, muted, true);
    const generation = generationRef.current;
    void media.play().catch((error: unknown) => {
      if (generation !== generationRef.current || operationRef.current?.signal.aborted) return;
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        wantsPlaybackRef.current = false;
        setNeedsTap(true);
        setBuffering(false);
      } else if (!(error instanceof DOMException && error.name === "AbortError")) {
        fallbackRef.current();
      }
    });
  }
  playRef.current = play;

  function togglePlayback() {
    if (state === "error" || state === "cancelled") {
      retryPlaybackRef.current = true;
      setRetry((value) => value + 1);
    } else if (playing || wantsPlaybackRef.current) pause();
    else play();
  }

  function cancel() {
    generationRef.current += 1;
    pause();
    operationRef.current?.abort();
    clearWatchdog();
    setUrl(undefined);
    releaseSources();
    setState("cancelled");
  }

  fallbackRef.current = () => {
    const original = sourceRef.current;
    const controller = operationRef.current;
    const generation = generationRef.current;
    if (!original || !controller || controller.signal.aborted) return;
    if (fallbackAttemptedRef.current) {
      if (conversionPendingRef.current) return;
      wantsPlaybackRef.current = false;
      setPlaying(false);
      setBuffering(false);
      clearWatchdog();
      setState("error");
      return;
    }
    fallbackAttemptedRef.current = true;
    conversionPendingRef.current = true;
    mediaRef.current?.pause();
    clearWatchdog();
    setPlaying(false);
    setBuffering(false);
    setState("preparing");
    watchdogRef.current = setTimeout(() => {
      if (generation !== generationRef.current) return;
      controller.abort();
      wantsPlaybackRef.current = false;
      conversionPendingRef.current = false;
      setState("error");
    }, PREPARE_TIMEOUT_MS);
    void (async () => {
      // The producer already verified these bytes. Re-fetching a blob: URL here
      // is blocked by the desktop window's restrictive connect-src policy.
      const blob = original.blob;
      if (!(blob instanceof Blob) || blob.size < 1 || blob.size > MAX_CHAT_FILE_BYTES) throw new Error("MEDIA_SOURCE_TOO_LARGE");
      controller.signal.throwIfAborted();
      const { prepareChatMedia } = await import("./chatMediaDecoder");
      const prepared = await prepareChatMedia(blob, kind, controller.signal);
      if (controller.signal.aborted || generation !== generationRef.current) return;
      clearWatchdog();
      conversionPendingRef.current = false;
      const preparedUrl = URL.createObjectURL(prepared);
      convertedUrlRef.current = preparedUrl;
      expectedUrlRef.current = preparedUrl;
      setUrl(preparedUrl);
      // The decoder has its own deadline; bound the browser's subsequent load too.
      watchdogRef.current = setTimeout(() => {
        if (generation === generationRef.current && !controller.signal.aborted) {
          wantsPlaybackRef.current = false;
          setState("error");
        }
      }, LOAD_TIMEOUT_MS);
    })().catch(() => {
      if (generation !== generationRef.current || controller.signal.aborted) return;
      clearWatchdog();
      conversionPendingRef.current = false;
      wantsPlaybackRef.current = false;
      setPlaying(false);
      setState("error");
    });
  };

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    if (typeof IntersectionObserver === "undefined") {
      setAdmittedKey(sourceKey);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setAdmittedKey(sourceKey);
        observer.disconnect();
      }
    }, { root: slot.closest(".message-scroll"), rootMargin: "80px" });
    observer.observe(slot);
    return () => observer.disconnect();
  }, [sourceKey]);

  useEffect(() => {
    if (admittedKey !== sourceKey) return;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    operationRef.current = controller;
    fallbackAttemptedRef.current = false;
    conversionPendingRef.current = false;
    expectedUrlRef.current = undefined;
    posterCapturedRef.current = false;
    wantsPlaybackRef.current = retryPlaybackRef.current;
    retryPlaybackRef.current = false;
    setUrl(undefined);
    setPoster(undefined);
    setState("loading");
    setPlaying(false);
    setBuffering(false);
    setCurrentTime(0);
    setDuration(0);
    setNeedsTap(false);
    watchdogRef.current = setTimeout(() => {
      if (generation !== generationRef.current) return;
      if (sourceRef.current) fallbackRef.current();
      else {
        controller.abort();
        wantsPlaybackRef.current = false;
        setState("error");
      }
    }, LOAD_TIMEOUT_MS);
    void callbacks.current.loadSource(controller.signal).then((source) => {
      if (controller.signal.aborted || generation !== generationRef.current) {
        source.release?.();
        return;
      }
      sourceRef.current = source;
      expectedUrlRef.current = source.url;
      setUrl(source.url);
    }).catch(() => {
      if (generation !== generationRef.current || controller.signal.aborted) return;
      clearWatchdog();
      wantsPlaybackRef.current = false;
      setState("error");
    });
    return () => {
      generationRef.current += 1;
      controller.abort();
      clearWatchdog();
      mediaRef.current?.pause();
      wantsPlaybackRef.current = false;
      releaseSources();
    };
  }, [sourceKey, kind, retry, admittedKey]);

  useEffect(() => {
    const pauseOther = (event: Event) => {
      if ((event as CustomEvent).detail !== mediaRef.current) pause();
      if ((event as CustomEvent).detail === null) setExpanded(false);
    };
    document.addEventListener(PLAYBACK_EVENT, pauseOther);
    return () => document.removeEventListener(PLAYBACK_EVENT, pauseOther);
  }, []);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const media = mediaRef.current;
    const resume = !!media && !media.paused && wantsPlaybackRef.current;
    const position = media?.currentTime ?? 0;
    const destination = expanded ? slot.closest(".conversation") : slot;
    const messageKey = slot.closest<HTMLElement>("[data-message-key]")?.dataset.messageKey;
    // Expanded media lives outside its message row, but keeps the original menu owner.
    // Inline hosts must not duplicate the scroll container's geometry identities.
    if (expanded && messageKey) portalHost.dataset.messageKey = messageKey;
    else delete portalHost.dataset.messageKey;
    portalHost.className = `chat-media-portal${expanded ? " is-expanded" : ""}`;
    (destination ?? slot).appendChild(portalHost);
    // Some engines pause a media element when its ancestor moves in the DOM.
    if (media && Number.isFinite(position) && media.readyState && media.currentTime !== position) media.currentTime = position;
    if (resume) playRef.current();
    callbacks.current.onGeometryChange?.();
  }, [expanded, portalHost]);

  useEffect(() => () => { portalHost.remove(); }, [portalHost]);

  useEffect(() => {
    if (!expanded) return;
    const closeBackdrop = (event: MouseEvent) => {
      if (event.target === portalHost) setExpanded(false);
    };
    portalHost.addEventListener("click", closeBackdrop);
    return () => portalHost.removeEventListener("click", closeBackdrop);
  }, [expanded, portalHost]);

  useLayoutEffect(() => {
    callbacks.current.onExpandedChange?.(expanded);
    if (!expanded) return;
    const previousFocus = expandFocusRef.current;
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      callbacks.current.onExpandedChange?.(false);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected
        && (portalHost.contains(document.activeElement) || document.activeElement === document.body)) previousFocus.focus({ preventScroll: true });
    };
  }, [expanded]);

  useEffect(() => {
    const media = mediaRef.current;
    if (media) applyVolume(media, volume, muted);
  }, [volume, muted, url]);

  useEffect(() => () => {
    const graph = audioGraphRef.current;
    audioGraphRef.current = null;
    if (graph) {
      graph.source.disconnect();
      graph.gain.disconnect();
      void graph.context.close().catch(() => undefined);
    }
  }, []);

  function loaded(event: SyntheticEvent<HTMLMediaElement>) {
    if (event.currentTarget.getAttribute("src") !== expectedUrlRef.current) return;
    clearWatchdog();
    setState("ready");
    setBuffering(false);
    setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0);
    callbacks.current.onGeometryChange?.();
    if (wantsPlaybackRef.current) playRef.current();
  }

  function captureFirstFrame(event: SyntheticEvent<HTMLMediaElement>) {
    const video = event.currentTarget;
    if (video instanceof HTMLVideoElement && !posterCapturedRef.current && video.videoWidth > 0 && video.videoHeight > 0
      && video.getAttribute("src") === expectedUrlRef.current) {
      try {
        const canvas = document.createElement("canvas");
        const scale = Math.min(1, 640 / video.videoWidth, 640 / video.videoHeight);
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const context = canvas.getContext("2d");
        if (context) {
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          setPoster(canvas.toDataURL("image/jpeg", 0.82));
          posterCapturedRef.current = true;
        }
      } catch { /* The already decoded first frame remains visible if a platform disallows a canvas snapshot. */ }
    }
    loaded(event);
  }

  function navigateOverlay(event: KeyboardEvent<HTMLDivElement>) {
    if (!expanded) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setExpanded(false);
    } else if (event.key === "Tab") {
      const controls = Array.from(portalHost.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), video[tabindex]"))
        .filter((element) => element.getClientRects().length > 0);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !portalHost.contains(document.activeElement))) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !portalHost.contains(document.activeElement))) {
        event.preventDefault(); first?.focus();
      }
    }
  }

  const mediaEvents = {
    // iOS can stop preloading video after metadata until the user presses Play.
    // Keep the controls ready so that play() runs in that user gesture.
    onLoadedMetadata: loaded,
    onLoadedData: captureFirstFrame,
    onCanPlay: loaded,
    onDurationChange: (event: SyntheticEvent<HTMLMediaElement>) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0),
    onTimeUpdate: (event: SyntheticEvent<HTMLMediaElement>) => setCurrentTime(event.currentTarget.currentTime),
    onPlay: (event: SyntheticEvent<HTMLMediaElement>) => document.dispatchEvent(new CustomEvent(PLAYBACK_EVENT, { detail: event.currentTarget })),
    onPlaying: () => { setPlaying(true); setBuffering(false); },
    onPause: () => { setPlaying(false); setBuffering(false); },
    onWaiting: () => { setPlaying(false); setBuffering(true); },
    onEnded: () => { wantsPlaybackRef.current = false; setPlaying(false); setBuffering(false); },
    onError: (event: SyntheticEvent<HTMLMediaElement>) => {
      if (event.currentTarget.getAttribute("src") === expectedUrlRef.current) fallbackRef.current();
    },
  };
  const busy = state === "loading" || state === "preparing";
  const problem = state === "error" || state === "cancelled";
  const playable = state === "ready";
  const playbackRequested = playing || (buffering && wantsPlaybackRef.current);
  const playLabel = playbackRequested ? label("Пауза", "Pause") : label("Воспроизвести", "Play");
  const soundMuted = muted || volume === 0;
  const muteLabel = soundMuted ? label("Включить звук", "Unmute") : label("Выключить звук", "Mute");
  const title = kind === "video" ? label("Видео", "Video") : label("Аудио", "Audio");
  const content = <div className={`chat-media-overlay${expanded ? " is-expanded" : ""}`} onKeyDown={navigateOverlay}
    role={expanded ? "dialog" : undefined} aria-label={expanded ? name : undefined} aria-modal={expanded || undefined}
    onClick={(event) => { event.stopPropagation(); if (expanded && event.target === event.currentTarget) setExpanded(false); }}>
    {expanded && <button ref={closeRef} type="button" className="chat-media-close" onClick={() => setExpanded(false)}
      aria-label={label("Вернуться к карточке", "Return to card")} title={label("Вернуться к карточке", "Return to card")}>×</button>}
    <div className={`chat-media-card is-${kind}${playing ? " is-playing" : ""}`} aria-label={`${title}: ${name}`}
      onClick={(event) => event.stopPropagation()}>
      <div className="chat-media-name" title={name} data-i18n-ignore translate="no">{name}</div>
      <div className="chat-media-stage">
        {kind === "video" ? <video ref={(element) => { mediaRef.current = element; }} src={url} poster={poster} playsInline preload="auto"
          aria-label={`${playLabel}: ${name}`} tabIndex={0} role="button" onClick={togglePlayback}
          onKeyDown={(event) => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); event.stopPropagation(); togglePlayback(); } }}
          {...mediaEvents} /> : <>
          <audio ref={(element) => { mediaRef.current = element; }} src={url} preload="metadata" {...mediaEvents} />
          <button type="button" className="chat-media-audio-face" onClick={togglePlayback} aria-label={`${playLabel}: ${name}`}>
            <svg viewBox="0 0 32 40" className="chat-media-file-icon" aria-hidden="true"><path d="M4 2h15l9 9v27H4Z" /><path d="M19 2v10h9M12 24v-6l10-2v6M12 24c0 4-6 4-6 1s6-4 6-1Zm10-2c0 4-6 4-6 1s6-4 6-1Z" /></svg>
            <span className="chat-media-equalizer" aria-hidden="true">{Array.from({ length: 12 }, (_, index) => <i key={index} />)}</span>
          </button>
        </>}
        {kind === "video" && playable && !playing && !buffering && <button type="button" className="chat-media-launch"
          onClick={togglePlayback} aria-label={`${playLabel}: ${name}`}>▶</button>}
        {(busy || problem || buffering) && <div className="chat-media-status" role="status" aria-live="polite">
          <span>{state === "preparing" ? label("Подготовка для воспроизведения…", "Preparing playback…")
            : state === "loading" ? label("Загрузка превью…", "Loading preview…")
              : state === "cancelled" ? label("Подготовка отменена", "Preparation cancelled")
                : state === "error" ? label("Не удалось воспроизвести файл", "Could not play this file")
                  : label("Буферизация…", "Buffering…")}</span>
          <div className="chat-media-status-actions">
            {busy ? <button type="button" onClick={cancel}>{label("Отмена", "Cancel")}</button>
              : problem && <button type="button" onClick={() => setRetry((value) => value + 1)}>{label("Повторить", "Retry")}</button>}
            {problem && onOpenOriginal && <button type="button" onClick={onOpenOriginal}>{label("Оригинал файла", "Original file")}</button>}
            {buffering && <button type="button" onClick={stop}>{label("Стоп", "Stop")}</button>}
          </div>
        </div>}
      </div>
      <div className="chat-media-controls" role="group" aria-label={label("Управление воспроизведением", "Playback controls")}>
        <div className="chat-media-timeline">
          <input type="range" min="0" max={duration || 1} step="0.1" value={Math.min(currentTime, duration || 1)} disabled={!playable || duration <= 0}
            aria-label={label("Позиция воспроизведения", "Playback position")} onChange={(event) => {
              const value = Number(event.currentTarget.value);
              if (mediaRef.current) mediaRef.current.currentTime = value;
              setCurrentTime(value);
            }} />
          <span aria-live="off">{formatTime(currentTime)} / {formatTime(duration)}</span>
        </div>
        <div className="chat-media-buttons">
          <button type="button" onClick={togglePlayback} disabled={busy} aria-label={playLabel} title={playLabel}>{playbackRequested ? "Ⅱ" : "▶"}</button>
          <button type="button" onClick={stop} disabled={!playable} aria-label={label("Остановить и вернуться в начало", "Stop and return to start")} title={label("Стоп", "Stop")}>■</button>
          <button type="button" className="chat-media-sound-toggle" onClick={toggleMute} aria-label={muteLabel}
            title={muteLabel} aria-pressed={soundMuted}>
            <svg className="chat-media-sound-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="m11 5-5 4H3v6h3l5 4Z" />
              <path d="M15 8a5 5 0 0 1 0 8M18 5a9 9 0 0 1 0 14" />
              {soundMuted && <path d="m3 3 18 18" />}
            </svg>
          </button>
          <input className="chat-media-volume" type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume}
            aria-label={label("Громкость", "Volume")} onChange={(event) => {
              const value = Number(event.currentTarget.value);
              if (value > 0) lastAudibleVolumeRef.current = value;
              if (mediaRef.current) applyVolume(mediaRef.current, value, false, true);
              setVolume(value);
              setMuted(false);
            }} />
          <span className="chat-media-control-hint" role="status" title={systemVolume ? label("Громкость регулируется системой", "Volume is controlled by the system") : undefined}>
            {needsTap ? label("Нажмите ▶", "Tap ▶") : systemVolume ? label("Системная громкость", "System volume") : ""}
          </span>
          {kind === "video" && <button type="button" onClick={(event) => {
            if (!expanded) expandFocusRef.current = event.currentTarget;
            setExpanded((value) => !value);
          }} aria-expanded={expanded}
            aria-label={expanded ? label("Вернуться к карточке", "Return to card") : label("Развернуть в чате", "Expand in chat")}
            title={expanded ? label("Вернуться к карточке", "Return to card") : label("Развернуть в чате", "Expand in chat")}>{expanded ? "↙" : "⛶"}</button>}
        </div>
      </div>
    </div>
  </div>;

  return <div ref={slotRef} className="chat-media-slot" data-media-kind={kind} data-media-state={state} data-media-card-id={id}>
    {createPortal(content, portalHost)}
  </div>;
}

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useI18n } from "./i18n";
import "./PqEntropy.css";

export const PQ_ENTROPY_COLLECTION_MS = 3_000;
export const PQ_ENTROPY_SAMPLE_LIMIT = 96;
export const PQ_ENTROPY_DIGEST_BYTES = 32;

const SAMPLE_BYTES = 8;
const VIEWBOX_WIDTH = 480;
const VIEWBOX_HEIGHT = 96;

const STARS = [
  [34, 58, 2.2],
  [82, 27, 1.7],
  [128, 69, 2.7],
  [176, 39, 1.9],
  [226, 62, 2.4],
  [274, 25, 1.7],
  [322, 54, 2.8],
  [370, 31, 1.9],
  [418, 67, 2.4],
  [455, 39, 1.6],
] as const;

const EDGES = [
  [0, 1], [0, 2], [1, 3], [2, 3], [2, 4], [3, 4],
  [3, 5], [4, 6], [5, 6], [5, 7], [6, 7], [6, 8],
  [7, 9], [8, 9],
] as const;

type PqEntropyProps = {
  friendNumber: number;
  onBegin: (friendNumber: number) => Promise<number>;
  onComplete: (friendNumber: number, extraNoise: number[]) => Promise<void>;
};

type PqCapabilityWaitProps = {
  friendNumber: number;
  onSkip: (friendNumber: number) => Promise<void>;
  reason?: "checking" | "cancelled";
};

export type PqSessionUiStatus = {
  supported: boolean;
  state: string;
  auto_pending: boolean;
  identity_waiting: boolean;
  error?: string | null;
};

type PqSessionCommand = "request_pq_session" | "withdraw_pq_session" | "request_pq_shutdown";

const PQ_AUTO_DECISION_ERRORS = new Set([
  "PQ_PEER_CANCELLED_MESSAGES_WAIT_FOR_MANUAL_PQ",
  "PQ_NEGOTIATION_CANCELLED_MESSAGES_WAIT_FOR_MANUAL_PQ",
]);

export function isPqAwaitingManualDecision(status?: PqSessionUiStatus): boolean {
  return !!status?.auto_pending
    && !status.identity_waiting
    && PQ_AUTO_DECISION_ERRORS.has(status.error ?? "");
}

export function PqSessionControl({ status, onCommand }: {
  status?: PqSessionUiStatus;
  onCommand: (command: PqSessionCommand) => void;
}) {
  const { t } = useI18n();
  if (!status?.supported) return null;
  // Older snapshots called a cancelled first-message fence "accepting".
  // Only that explicit decision state may restart; a live handshake must wait.
  const canRetry = status.state === "accepting" && isPqAwaitingManualDecision(status);
  const command: PqSessionCommand | null = status.state === "available" || status.state === "error" || canRetry
    ? "request_pq_session"
    : status.state === "offered" ? "withdraw_pq_session"
      : status.state === "active" ? "request_pq_shutdown"
        : null;
  const label = command === "request_pq_session" ? "Включить PQ"
    : command === "withdraw_pq_session" ? "Отозвать предложение PQ"
      : command === "request_pq_shutdown" ? "Отменить PQ"
        : ["closing", "closing_commit", "closing_ack", "closing_final"].includes(status.state) ? "Отключение PQ…"
          : ["incoming_offer", "accepting"].includes(status.state) ? "Инициация PQ"
            : "Включить PQ";
  return <button disabled={!command} onClick={() => { if (command) onCommand(command); }}>{t(label)}</button>;
}

type LastPointer = {
  x: number;
  y: number;
  time: number;
  pointerId: number;
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function pointerKind(pointerType: string): number {
  if (pointerType === "touch") return 2;
  if (pointerType === "pen") return 3;
  return 1;
}

async function digestAdditionalNoise(buffer: Uint8Array, length: number): Promise<number[]> {
  if (length === 0 || !globalThis.crypto?.subtle) return [];
  const input = buffer.slice(0, length);
  try {
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", input));
    const result = Array.from(digest.slice(0, PQ_ENTROPY_DIGEST_BYTES));
    digest.fill(0);
    return result;
  } finally {
    input.fill(0);
  }
}

export function PqCapabilityWait({ friendNumber, onSkip, reason = "checking" }: PqCapabilityWaitProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const skip = async () => {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      await onSkip(friendNumber);
    } catch {
      setBusy(false);
      setError(true);
    }
  };

  return <aside className="pq-capability-wait" aria-labelledby="pq-capability-title" aria-live="polite">
    <span className="pq-capability-pulse" aria-hidden="true"><i /><i /><i /></span>
    <span className="pq-capability-copy">
      <strong id="pq-capability-title">{t(reason === "cancelled" ? "Согласование PQ остановлено" : "Проверяем поддержку PQ…")}</strong>
      <small>{t(error
        ? "Не удалось применить выбор. Повторите."
        : reason === "cancelled"
          ? "Сообщения ожидают. Включите PQ в меню чата или продолжите без него."
          : "Сообщения сохранены и ждут ответа клиента. Продолжение без PQ отключит автоматическое включение PQ для этого контакта.")}</small>
    </span>
    <button type="button" disabled={busy} onClick={() => void skip()}>{t(busy ? "Подождите…" : error ? "Повторить" : "Продолжить без PQ")}</button>
  </aside>;
}

export default function PqEntropy({ friendNumber, onBegin, onComplete }: PqEntropyProps) {
  const { t } = useI18n();
  const bufferRef = useRef(new Uint8Array(PQ_ENTROPY_SAMPLE_LIMIT * SAMPLE_BYTES));
  const sampleCountRef = useRef(0);
  const lastPointerRef = useRef<LastPointer | null>(null);
  const constellationRef = useRef<SVGSVGElement>(null);
  const pointerStarRef = useRef<SVGCircleElement>(null);
  const pointerLinesRef = useRef<Array<SVGLineElement | null>>([]);
  const mountedRef = useRef(true);
  const finishingRef = useRef(false);
  const onBeginRef = useRef(onBegin);
  const onCompleteRef = useRef(onComplete);
  const collectionDeadlineRef = useRef(0);
  const [collectionReady, setCollectionReady] = useState(false);
  const [beginAttempt, setBeginAttempt] = useState(0);
  const [hasActivity, setHasActivity] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [foreground, setForeground] = useState(() => document.visibilityState === "visible" && document.hasFocus());
  const [error, setError] = useState(false);

  onBeginRef.current = onBegin;
  onCompleteRef.current = onComplete;

  const discardSamples = useCallback(() => {
    bufferRef.current.fill(0);
    sampleCountRef.current = 0;
    lastPointerRef.current = null;
  }, []);

  const resetPointer = useCallback(() => {
    const pointerId = lastPointerRef.current?.pointerId;
    if (pointerId !== undefined && constellationRef.current?.hasPointerCapture(pointerId)) {
      constellationRef.current.releasePointerCapture(pointerId);
    }
    lastPointerRef.current = null;
    pointerStarRef.current?.classList.remove("visible");
    pointerLinesRef.current.forEach((line) => line?.classList.remove("visible"));
  }, []);

  const finish = useCallback(async (systemOnly: boolean) => {
    if (finishingRef.current || document.visibilityState !== "visible" || !document.hasFocus()) return;
    if (!systemOnly && collectionDeadlineRef.current > 0 && performance.now() >= collectionDeadlineRef.current) {
      discardSamples();
      setCollectionReady(false);
      setBeginAttempt((attempt) => attempt + 1);
      return;
    }
    finishingRef.current = true;
    if (mountedRef.current) {
      setFinishing(true);
      setError(false);
    }
    let extraNoise: number[] = [];
    try {
      if (!systemOnly) {
        extraNoise = await digestAdditionalNoise(
          bufferRef.current,
          sampleCountRef.current * SAMPLE_BYTES,
        );
      }
      discardSamples();
      if (!mountedRef.current) {
        extraNoise.fill(0);
        return;
      }
      await onCompleteRef.current(friendNumber, extraNoise);
    } catch {
      if (mountedRef.current) {
        finishingRef.current = false;
        setFinishing(false);
        setError(true);
      }
    } finally {
      extraNoise.fill(0);
    }
  }, [discardSamples, friendNumber]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      resetPointer();
      discardSamples();
    };
  }, [discardSamples, resetPointer]);

  useEffect(() => {
    const updateForeground = () => {
      const active = document.visibilityState === "visible" && document.hasFocus();
      if (!active) {
        resetPointer();
        discardSamples();
        setHasActivity(false);
        setCollectionReady(false);
      }
      setForeground(active);
    };
    document.addEventListener("visibilitychange", updateForeground);
    window.addEventListener("focus", updateForeground);
    window.addEventListener("blur", updateForeground);
    return () => {
      document.removeEventListener("visibilitychange", updateForeground);
      window.removeEventListener("focus", updateForeground);
      window.removeEventListener("blur", updateForeground);
    };
  }, [discardSamples, resetPointer]);

  useEffect(() => {
    if (!foreground || finishingRef.current) return;
    let cancelled = false;
    const requestedAt = performance.now();
    setError(false);
    // The core's fallback starts before the next status poll. Claim real time
    // for collection before displaying the surface, never after key creation.
    void onBeginRef.current(friendNumber).then((remainingMs) => {
      if (cancelled || !mountedRef.current) return;
      const usableMs = remainingMs - (performance.now() - requestedAt);
      if (usableMs >= PQ_ENTROPY_COLLECTION_MS + 250) {
        collectionDeadlineRef.current = requestedAt + remainingMs;
        setCollectionReady(true);
      }
    }).catch(() => { if (!cancelled && mountedRef.current) setError(true); });
    return () => { cancelled = true; };
  }, [beginAttempt, foreground, friendNumber]);

  useEffect(() => {
    if (!foreground || !collectionReady || finishingRef.current) return;
    let timer: number | undefined;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        timer = window.setTimeout(() => void finish(false), PQ_ENTROPY_COLLECTION_MS);
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [collectionReady, finish, foreground]);

  const updateConstellation = (x: number, y: number) => {
    const pointerStar = pointerStarRef.current;
    if (!pointerStar) return;
    pointerStar.setAttribute("cx", x.toFixed(2));
    pointerStar.setAttribute("cy", y.toFixed(2));
    pointerStar.classList.add("visible");
    const nearest = STARS
      .map(([starX, starY], index) => ({ index, distance: (starX - x) ** 2 + (starY - y) ** 2 }))
      .sort((left, right) => left.distance - right.distance)
      .slice(0, pointerLinesRef.current.length);
    pointerLinesRef.current.forEach((line, index) => {
      if (!line) return;
      const star = STARS[nearest[index]?.index ?? 0];
      line.setAttribute("x1", x.toFixed(2));
      line.setAttribute("y1", y.toFixed(2));
      line.setAttribute("x2", String(star[0]));
      line.setAttribute("y2", String(star[1]));
      line.classList.add("visible");
    });
  };

  const collectPoint = (point: PointerEvent) => {
    if (sampleCountRef.current >= PQ_ENTROPY_SAMPLE_LIMIT || document.visibilityState !== "visible" || !document.hasFocus()) return;
    const previous = lastPointerRef.current;
    lastPointerRef.current = {
      x: point.clientX,
      y: point.clientY,
      time: point.timeStamp,
      pointerId: point.pointerId,
    };
    if (!previous || previous.pointerId !== point.pointerId) return;
    const dx = clamp(Math.round(point.clientX - previous.x), -127, 127);
    const dy = clamp(Math.round(point.clientY - previous.y), -127, 127);
    const elapsed = clamp(Math.round((point.timeStamp - previous.time) * 8), 0, 65_535);
    if (dx === 0 && dy === 0 && elapsed === 0) return;

    const offset = sampleCountRef.current * SAMPLE_BYTES;
    const view = new DataView(bufferRef.current.buffer);
    view.setInt8(offset, dx);
    view.setInt8(offset + 1, dy);
    view.setUint16(offset + 2, elapsed, true);
    view.setUint16(offset + 4, clamp(Math.round(point.pressure * 1_023), 0, 1_023), true);
    view.setUint8(offset + 6, pointerKind(point.pointerType));
    view.setUint8(offset + 7, clamp(point.buttons, 0, 255));
    sampleCountRef.current += 1;
    if (!hasActivity) setHasActivity(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (finishing || !foreground || !collectionReady) return;
    const native = event.nativeEvent;
    const coalesced = typeof native.getCoalescedEvents === "function"
      ? native.getCoalescedEvents().slice(-4)
      : [native];
    coalesced.forEach(collectPoint);
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    updateConstellation(
      clamp((event.clientX - bounds.left) / bounds.width * VIEWBOX_WIDTH, 0, VIEWBOX_WIDTH),
      clamp((event.clientY - bounds.top) / bounds.height * VIEWBOX_HEIGHT, 0, VIEWBOX_HEIGHT),
    );
  };

  if (!collectionReady && !error) return null;

  return <aside className="pq-entropy-panel" aria-labelledby="pq-entropy-title" aria-live="polite">
    <div className="pq-entropy-copy">
      <span className="pq-entropy-kicker">PQ · ML-KEM-768</span>
      <strong id="pq-entropy-title">{t("Дополнительная случайность для нового PQ-ключа")}</strong>
      <p>{t("Проведите курсором или пальцем по созвездию. Системный генератор уже защищает ключ; движения добавятся как дополнительный шум.")}</p>
    </div>
    <svg
      ref={constellationRef}
      className="pq-entropy-constellation"
      viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
      role="img"
      aria-label={t("Созвездие для дополнительной случайности")}
      onPointerDown={(event) => {
        if (finishing || !foreground || !collectionReady) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        collectPoint(event.nativeEvent);
      }}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        resetPointer();
      }}
      onPointerCancel={resetPointer}
      onPointerLeave={(event) => { if (event.pointerType === "mouse" && event.buttons === 0) resetPointer(); }}
    >
      <g className="pq-entropy-map" aria-hidden="true">
        {EDGES.map(([from, to]) => <line key={`${from}-${to}`} x1={STARS[from][0]} y1={STARS[from][1]} x2={STARS[to][0]} y2={STARS[to][1]} />)}
        {STARS.map(([x, y, radius], index) => <circle key={`${x}-${y}`} cx={x} cy={y} r={radius} style={{ "--star-index": index } as React.CSSProperties} />)}
      </g>
      <g className="pq-entropy-pointer" aria-hidden="true">
        {[0, 1, 2].map((index) => <line key={index} ref={(line) => { pointerLinesRef.current[index] = line; }} />)}
        <circle ref={pointerStarRef} cx="-20" cy="-20" r="4" />
      </g>
    </svg>
    <div className="pq-entropy-status">
      <span>{t(error
        ? "Не удалось передать дополнительный шум. Повторите или используйте системную случайность."
        : finishing
          ? "Подготавливаем новый PQ-ключ…"
          : hasActivity
            ? "Движения добавляются только локально"
            : "Ключ будет создан автоматически через несколько секунд.")}</span>
      <i aria-hidden="true" />
    </div>
    <div className="pq-entropy-actions">
      <button type="button" className="pq-entropy-system" disabled={finishing} onClick={() => void finish(true)}>{t("Только системная случайность")}</button>
      <button type="button" className="pq-entropy-continue" disabled={finishing} onClick={() => {
        if (!collectionReady) setBeginAttempt((attempt) => attempt + 1);
        else void finish(false);
      }}>{t(error ? "Повторить" : "Продолжить")}</button>
    </div>
  </aside>;
}

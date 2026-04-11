// Annotation overlay — injected by the content script when the user presses
// the annotation hotkey. Renders a full-viewport canvas on top of the page,
// captures pointer events for drawing, shows iframe-sandboxed toolbar and
// bottom bar, resolves a promise with the user's note + metadata when they
// click Save. The content script handles sending the captured PNG to the
// server via the service worker.
//
// Toolbar chrome lives in sandboxed iframes (srcdoc) so the host page's CSS
// cannot restyle it. The canvas stays as a real DOM element so captureVisibleTab
// bakes the strokes into the PNG naturally.

import { loadDraft, saveDraft, type Draft } from "./drafts";
import { getRole, getAccessibleName } from "../element-resolver";
import { getParentElement } from "../element-utils";

export interface OverlayMetadata {
  viewport: {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
    dpr: number;
  };
  boundingBox?: { x: number; y: number; w: number; h: number };
  nearestElement?: {
    ref?: string;
    role?: string;
    name?: string;
    tagName?: string;
  };
}

export interface OverlayResult {
  note: string;
  metadata: OverlayMetadata;
  /** Opaque per-mount instance id — pass to remove/restore so a late ack
   *  from a torn-down overlay cannot tear down or mutate a new overlay. */
  instanceId: string;
}

export type DrawingTool = "pen" | "arrow" | "rect" | "text";

export interface PointXY {
  x: number;
  y: number;
}

export interface PenStroke {
  tool: "pen";
  color: string;
  width: number;
  points: PointXY[];
}

export interface ArrowStroke {
  tool: "arrow";
  color: string;
  width: number;
  start: PointXY;
  end: PointXY;
}

export interface RectStroke {
  tool: "rect";
  color: string;
  width: number;
  start: PointXY;
  end: PointXY;
}

export interface TextStroke {
  tool: "text";
  color: string;
  fontSize: number;
  position: PointXY;
  text: string;
}

export type Stroke = PenStroke | ArrowStroke | RectStroke | TextStroke;

interface OverlayState {
  strokes: Stroke[];
  pending: Stroke | null; // in-progress stroke (pen mid-draw, arrow/rect mid-drag)
  color: string;
  tool: DrawingTool;
  note: string;
}

const ROOT_ID = "mybrowser-annotation-root";
const Z_INDEX = 2147483647;
const DEFAULT_COLOR = "#ef4444";
const STROKE_WIDTH = 3;
const TEXT_FONT_SIZE = 18;

const COLORS = [
  "#ef4444", // red
  "#f59e0b", // amber
  "#10b981", // emerald
  "#3b82f6", // blue
  "#a855f7", // purple
  "#111827", // near-black
];

let activePromise: {
  resolve: (result: OverlayResult | null) => void;
} | null = null;

/** 128-bit URL-safe random token; used as the shared secret between the
 * overlay's iframes and its parent. */
function generateCapabilityToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * True if an overlay is currently on-screen OR if one has been submitted but
 * not yet torn down (waiting for the success/failure ack from the server).
 * Both conditions must block a reopen; otherwise an eager re-press would
 * leak the previous mount's window listeners.
 */
export function isOverlayOpen(): boolean {
  return activePromise !== null || currentMount !== null;
}

export function openAnnotationOverlay(): Promise<OverlayResult | null> {
  // If there's an unresolved promise, cancel it so we don't leak the resolver.
  if (activePromise) {
    closeOverlay(null);
  }
  // If a previous mount is still hanging around (submitted, waiting for ack),
  // tear it down cleanly before we make a new one. Otherwise the old window
  // listeners (keydown/resize/blur/message) stay attached forever.
  if (currentMount) {
    tearDownMount();
  }
  return new Promise<OverlayResult | null>((resolve) => {
    activePromise = { resolve };
    mountOverlay();
  });
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

interface ActiveMount {
  instanceId: string;
  root: HTMLElement;
  state: OverlayState;
  onKeyDown: (e: KeyboardEvent) => void;
  onMessage: (e: MessageEvent) => void;
  onResize: () => void;
  onBlur: () => void;
  topIframe: HTMLIFrameElement;
  bottomIframe: HTMLIFrameElement;
  textInput: HTMLInputElement | null;
}

let currentMount: ActiveMount | null = null;

function mountOverlay(): void {
  // Defense in depth: clean up any lingering mount before creating a new one.
  // openAnnotationOverlay already does this, but mountOverlay must be safe
  // to call on its own.
  if (currentMount) {
    tearDownMount();
  }
  // Fallback: if somehow the root DOM was left behind without a currentMount
  // pointer (e.g. an earlier crash mid-teardown), remove the orphan too.
  document.getElementById(ROOT_ID)?.remove();

  const state: OverlayState = {
    strokes: [],
    pending: null,
    color: DEFAULT_COLOR,
    tool: "pen",
    note: "",
  };

  // Per-mount capability token. Baked into each iframe's srcdoc at mount
  // time and required on every postMessage. A page script cannot forge
  // messages without knowing this token. Combined with sandbox="allow-scripts"
  // on the iframes (opaque origin → no same-origin code injection), this
  // closes the trust boundary opencode/codex flagged.
  const capabilityToken = generateCapabilityToken();

  // Per-mount instance id. Returned to the caller so a late ack from a
  // torn-down overlay cannot accidentally tear down a freshly opened one.
  const instanceId = generateCapabilityToken();

  const root = document.createElement("div");
  root.id = ROOT_ID;
  Object.assign(root.style, {
    position: "fixed",
    inset: "0",
    zIndex: String(Z_INDEX),
    pointerEvents: "none", // root passes events through; canvas re-enables
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  } as CSSStyleDeclaration);

  // --- canvas ---
  const canvas = document.createElement("canvas");
  // These change on window resize — see `onResize` below.
  let dpr = window.devicePixelRatio || 1;
  let vw = window.innerWidth;
  let vh = window.innerHeight;
  canvas.width = vw * dpr;
  canvas.height = vh * dpr;
  Object.assign(canvas.style, {
    position: "fixed",
    inset: "0",
    width: `${vw}px`,
    height: `${vh}px`,
    cursor: "crosshair",
    zIndex: String(Z_INDEX),
    pointerEvents: "auto",
  } as CSSStyleDeclaration);

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    activePromise?.resolve(null);
    activePromise = null;
    return;
  }
  ctx.scale(dpr, dpr);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.textBaseline = "top";

  // --- iframes ---
  // sandbox="allow-scripts" (no allow-same-origin) gives each iframe an
  // opaque origin so the host page cannot reach into contentWindow to
  // inject code. postMessage still works because it's cross-origin by design.
  const topIframe = document.createElement("iframe");
  topIframe.setAttribute("sandbox", "allow-scripts");
  topIframe.srcdoc = buildTopToolbarHtml(
    state.tool,
    state.color,
    capabilityToken,
  );
  Object.assign(topIframe.style, {
    position: "fixed",
    top: "16px",
    right: "16px",
    width: "560px",
    height: "54px",
    border: "none",
    background: "transparent",
    zIndex: String(Z_INDEX + 1),
    pointerEvents: "auto",
  } as CSSStyleDeclaration);

  const bottomIframe = document.createElement("iframe");
  bottomIframe.setAttribute("sandbox", "allow-scripts");
  bottomIframe.srcdoc = buildBottomBarHtml(capabilityToken);
  Object.assign(bottomIframe.style, {
    position: "fixed",
    left: "50%",
    bottom: "24px",
    transform: "translateX(-50%)",
    width: "640px",
    height: "58px",
    border: "none",
    background: "transparent",
    zIndex: String(Z_INDEX + 1),
    pointerEvents: "auto",
  } as CSSStyleDeclaration);

  root.appendChild(canvas);
  root.appendChild(topIframe);
  root.appendChild(bottomIframe);
  document.documentElement.appendChild(root);

  // --- redraw ---
  function redraw(): void {
    if (!ctx) return;
    ctx.clearRect(0, 0, vw, vh);
    for (const stroke of state.strokes) drawStroke(ctx, stroke);
    if (state.pending) drawStroke(ctx, state.pending);
  }

  // --- draft persistence ---
  let draftSaveTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleDraftSave(): void {
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(() => {
      draftSaveTimer = null;
      // Don't persist empty drafts
      if (state.strokes.length === 0 && !state.note.trim()) return;
      saveDraft({
        strokes: state.strokes,
        note: state.note,
        savedAt: Date.now(),
      }).catch(() => {});
    }, 400);
  }

  // Try to restore a draft for the current tab+URL. Runs async; if one
  // exists, replaces state.strokes and redraws, then shows a small toast.
  function maybeRestoreDraft(): void {
    loadDraft()
      .then((draft: Draft | null) => {
        if (!draft) return;
        // Guard: only restore if the user hasn't started drawing yet
        if (state.strokes.length > 0) return;
        state.strokes = draft.strokes;
        if (draft.note) {
          state.note = draft.note;
          postToIframes({
            type: "mybrowser_annotation_restore_note",
            payload: draft.note,
          });
        }
        redraw();
        showAnnotationToast(
          `Restored draft (${draft.strokes.length} shapes)`,
          "info",
        );
      })
      .catch(() => {});
  }

  function canvasPoint(e: PointerEvent): PointXY {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // --- text input (for text tool) ---
  let textInput: HTMLInputElement | null = null;
  function dismissTextInput(save: boolean): void {
    if (!textInput) return;
    const value = textInput.value.trim();
    const position = {
      x: parseFloat(textInput.dataset.x || "0"),
      y: parseFloat(textInput.dataset.y || "0"),
    };
    textInput.remove();
    textInput = null;
    if (save && value) {
      state.strokes.push({
        tool: "text",
        color: state.color,
        fontSize: TEXT_FONT_SIZE,
        position,
        text: value,
      });
      scheduleDraftSave();
      redraw();
    }
    if (currentMount) currentMount.textInput = null;
  }

  function openTextInput(at: PointXY): void {
    dismissTextInput(false);
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Type, Enter to add";
    input.dataset.x = String(at.x);
    input.dataset.y = String(at.y);
    Object.assign(input.style, {
      position: "fixed",
      left: `${at.x}px`,
      top: `${at.y}px`,
      padding: "4px 6px",
      background: "rgba(24,24,27,0.95)",
      color: state.color,
      border: `2px solid ${state.color}`,
      borderRadius: "4px",
      fontSize: `${TEXT_FONT_SIZE}px`,
      fontFamily: "inherit",
      zIndex: String(Z_INDEX + 2),
      outline: "none",
      minWidth: "120px",
      pointerEvents: "auto",
    } as CSSStyleDeclaration);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        ev.stopPropagation();
        dismissTextInput(true);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        dismissTextInput(false);
      }
    });
    root.appendChild(input);
    textInput = input;
    if (currentMount) currentMount.textInput = input;
    setTimeout(() => input.focus(), 0);
  }

  // --- pointer handlers ---
  function onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    if (e.target !== canvas) return;
    e.preventDefault();

    const pt = canvasPoint(e);

    // If a text input was left dangling (user opened it then switched
    // tools without committing), commit it so we don't lose their text.
    if (textInput && state.tool !== "text") {
      dismissTextInput(true);
    }

    if (state.tool === "text") {
      openTextInput(pt);
      return;
    }

    canvas.setPointerCapture(e.pointerId);

    if (state.tool === "pen") {
      state.pending = {
        tool: "pen",
        color: state.color,
        width: STROKE_WIDTH,
        points: [pt],
      };
    } else if (state.tool === "arrow") {
      state.pending = {
        tool: "arrow",
        color: state.color,
        width: STROKE_WIDTH,
        start: pt,
        end: pt,
      };
    } else if (state.tool === "rect") {
      state.pending = {
        tool: "rect",
        color: state.color,
        width: STROKE_WIDTH,
        start: pt,
        end: pt,
      };
    }
    redraw();
  }

  function onPointerMove(e: PointerEvent): void {
    if (!state.pending) return;
    const pt = canvasPoint(e);
    const p = state.pending;
    if (p.tool === "pen") {
      p.points.push(pt);
    } else if (p.tool === "arrow" || p.tool === "rect") {
      p.end = pt;
    }
    redraw();
  }

  function onPointerUp(e: PointerEvent): void {
    if (!state.pending) return;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    const p = state.pending;
    let keep = false;
    if (p.tool === "pen" && p.points.length > 1) keep = true;
    if (p.tool === "arrow" || p.tool === "rect") {
      const dx = p.end.x - p.start.x;
      const dy = p.end.y - p.start.y;
      if (dx * dx + dy * dy > 16) keep = true; // >4px movement
    }
    if (keep) {
      state.strokes.push(p);
      scheduleDraftSave();
    }
    state.pending = null;
    redraw();
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);

  // Resize handler — if the host page resizes the window while the
  // overlay is open, rebuild the canvas so strokes stay aligned.
  function onResize(): void {
    const newW = window.innerWidth;
    const newH = window.innerHeight;
    const newDpr = window.devicePixelRatio || 1;
    if (newW === vw && newH === vh && newDpr === dpr) return;
    vw = newW;
    vh = newH;
    dpr = newDpr;
    canvas.width = vw * dpr;
    canvas.height = vh * dpr;
    canvas.style.width = `${vw}px`;
    canvas.style.height = `${vh}px`;
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.textBaseline = "top";
    }
    redraw();
  }
  window.addEventListener("resize", onResize);

  // If the window loses focus mid-stroke, abandon the pending stroke so
  // we don't end up in a stuck state when pointerup never fires.
  function onBlur(): void {
    if (state.pending) {
      state.pending = null;
      redraw();
    }
  }
  window.addEventListener("blur", onBlur);

  // --- iframe message handling ---
  function postToIframes(msg: Record<string, unknown>): void {
    // Include capability token so iframe scripts can verify authenticity.
    // Target is "*" because sandbox="allow-scripts" iframes have opaque origin.
    const payload = { ...msg, token: capabilityToken };
    try {
      topIframe.contentWindow?.postMessage(payload, "*");
    } catch {
      /* ignore */
    }
    try {
      bottomIframe.contentWindow?.postMessage(payload, "*");
    } catch {
      /* ignore */
    }
  }

  let bottomIframeReady = false;
  function onMessage(e: MessageEvent): void {
    if (e.source !== topIframe.contentWindow && e.source !== bottomIframe.contentWindow) {
      return;
    }
    const data = e.data as { type?: string; payload?: unknown; token?: string };
    if (!data || typeof data.type !== "string") return;
    // Capability token required on every message. Defense in depth with
    // the iframe sandbox — a forged postMessage without the token is
    // ignored even if some future bug lets a page script reach the source.
    if (data.token !== capabilityToken) return;

    switch (data.type) {
      case "mybrowser_annotation_ready":
        // Send initial state to iframe
        postToIframes({
          type: "mybrowser_annotation_state",
          payload: {
            tool: state.tool,
            color: state.color,
            colors: COLORS,
          },
        });
        if (e.source === bottomIframe.contentWindow && !bottomIframeReady) {
          bottomIframeReady = true;
          // Bottom iframe is ready to receive restored note — try restoring now
          maybeRestoreDraft();
        }
        return;

      case "mybrowser_annotation_tool": {
        const tool = data.payload as DrawingTool;
        if (tool === "pen" || tool === "arrow" || tool === "rect" || tool === "text") {
          // Abandon any in-progress stroke from the old tool so the new
          // tool doesn't inherit a half-drawn shape.
          if (state.pending) {
            state.pending = null;
            redraw();
          }
          state.tool = tool;
          // If switching away from text while input is open, commit it
          if (tool !== "text") dismissTextInput(true);
          postToIframes({
            type: "mybrowser_annotation_state",
            payload: { tool, color: state.color, colors: COLORS },
          });
        }
        return;
      }

      case "mybrowser_annotation_color": {
        const c = data.payload as string;
        if (typeof c === "string") {
          state.color = c;
          postToIframes({
            type: "mybrowser_annotation_state",
            payload: { tool: state.tool, color: c, colors: COLORS },
          });
        }
        return;
      }

      case "mybrowser_annotation_undo":
        dismissTextInput(true);
        state.strokes.pop();
        scheduleDraftSave();
        redraw();
        return;

      case "mybrowser_annotation_clear":
        dismissTextInput(false);
        state.strokes = [];
        scheduleDraftSave();
        redraw();
        return;

      case "mybrowser_annotation_note":
        state.note = String(data.payload ?? "");
        scheduleDraftSave();
        return;

      case "mybrowser_annotation_cancel":
        dismissTextInput(false);
        // Preserve draft on cancel so the user can recover accidental closes
        closeOverlay(null);
        return;

      case "mybrowser_annotation_save":
        // Commit any pending text first
        dismissTextInput(true);
        // Final note value comes with the save event (source of truth)
        if (typeof data.payload === "string") {
          state.note = data.payload;
        }
        // Don't clear the draft here — the content script will clear it
        // only after the server confirms the save. If the save fails we
        // want the draft to survive so the user can retry.
        submit();
        return;
    }
  }
  window.addEventListener("message", onMessage);

  // --- keyboard shortcuts (parent window) ---
  function onKeyDown(e: KeyboardEvent): void {
    // If text input is focused, only intercept Esc (handled inline)
    if (textInput && document.activeElement === textInput) return;

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeOverlay(null);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      // Ask bottom iframe for the latest note value, then submit
      postToIframes({ type: "mybrowser_annotation_request_save" });
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.stopPropagation();
      dismissTextInput(true);
      state.strokes.pop();
      redraw();
      return;
    }
  }
  window.addEventListener("keydown", onKeyDown, { capture: true });

  // --- submit ---
  function submit(): void {
    const bbox = computeBoundingBox(state.strokes);

    // Try to identify the nearest element under the strokes for Claude.
    let nearestElement: OverlayMetadata["nearestElement"];
    if (bbox) {
      const center: PointXY = {
        x: bbox.x + bbox.w / 2,
        y: bbox.y + bbox.h / 2,
      };
      const found = findNearestElement(center, root);
      if (found) nearestElement = found;
    }

    const metadata: OverlayMetadata = {
      viewport: {
        width: vw,
        height: vh,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        dpr,
      },
      boundingBox: bbox ?? undefined,
      nearestElement,
    };
    // Hide UI chrome so captureVisibleTab records only the strokes on top of
    // the page content. The content script will call either
    // removeAnnotationOverlay() (success) or restoreAnnotationOverlay() (failure).
    topIframe.style.display = "none";
    bottomIframe.style.display = "none";
    if (textInput) textInput.style.display = "none";

    // Safety net: if neither removal nor restore happens within 30 s,
    // force teardown so the user isn't stuck with a half-hidden overlay.
    // Guard on instanceId so a late timeout can't teardown a newer mount.
    const submittedInstanceId = instanceId;
    setTimeout(() => {
      if (
        currentMount &&
        currentMount.instanceId === submittedInstanceId &&
        currentMount.topIframe.style.display === "none" &&
        currentMount.bottomIframe.style.display === "none"
      ) {
        console.warn(
          "[MyBrowser] annotation submit timeout — forcing teardown",
        );
        tearDownMount();
      }
    }, 30_000);

    closeOverlay({ note: state.note.trim(), metadata, instanceId });
  }

  currentMount = {
    instanceId,
    root,
    state,
    onKeyDown,
    onMessage,
    onResize,
    onBlur,
    topIframe,
    bottomIframe,
    textInput: null,
  };
}

function closeOverlay(result: OverlayResult | null): void {
  const promise = activePromise;
  activePromise = null;

  if (currentMount) {
    if (result) {
      // Resolve immediately; content script will call removeAnnotationOverlay
      // after capture to tear down the DOM.
      promise?.resolve(result);
    } else {
      tearDownMount();
      promise?.resolve(null);
    }
  } else {
    promise?.resolve(result);
  }
}

function tearDownMount(): void {
  if (!currentMount) return;
  const { root, onKeyDown, onMessage, onResize, onBlur } = currentMount;
  window.removeEventListener("keydown", onKeyDown, { capture: true });
  window.removeEventListener("message", onMessage);
  window.removeEventListener("resize", onResize);
  window.removeEventListener("blur", onBlur);
  root.remove();
  currentMount = null;
}

/**
 * Tear down the overlay. If `instanceId` is given, only tears down if the
 * currently-mounted overlay matches that instance — a late ack from an
 * older mount cannot affect a newer one.
 *
 * Returns `true` if teardown actually happened, `false` otherwise. Callers
 * that perform additional instance-scoped side effects (e.g. clearing the
 * draft for that mount) can gate on the return value so they don't race
 * against a newer overlay.
 */
export function removeAnnotationOverlay(instanceId?: string): boolean {
  if (instanceId !== undefined) {
    if (!currentMount || currentMount.instanceId !== instanceId) return false;
  }
  if (!currentMount) return false;
  tearDownMount();
  return true;
}

/**
 * Re-show an overlay that has been `submit()`-hidden but not torn down.
 * Used when a save attempt failed and we want the user to retry instead of
 * losing their drawing. Safe to call if no overlay is mounted. If
 * `instanceId` is given, only restores if the current mount matches — a
 * late failure ack from an older mount cannot un-hide a newer overlay.
 * Returns `true` if the overlay was actually restored.
 */
export function restoreAnnotationOverlay(instanceId?: string): boolean {
  if (!currentMount) return false;
  if (instanceId !== undefined && currentMount.instanceId !== instanceId) {
    return false;
  }
  try {
    currentMount.topIframe.style.display = "";
  } catch {
    /* iframe may be gone */
  }
  try {
    currentMount.bottomIframe.style.display = "";
  } catch {
    /* iframe may be gone */
  }
  if (currentMount.textInput) {
    try {
      currentMount.textInput.style.display = "";
    } catch {
      /* ignore */
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Toast (transient success/error feedback)
// ---------------------------------------------------------------------------

export function showAnnotationToast(
  message: string,
  variant: "success" | "error" | "info" = "info",
): void {
  const bg =
    variant === "success"
      ? "#16a34a"
      : variant === "error"
        ? "#dc2626"
        : "#27272a";
  const toast = document.createElement("div");
  Object.assign(toast.style, {
    position: "fixed",
    bottom: "24px",
    right: "24px",
    padding: "10px 16px",
    background: bg,
    color: "#fff",
    borderRadius: "8px",
    boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    fontSize: "13px",
    fontWeight: "500",
    zIndex: String(Z_INDEX + 2),
    opacity: "0",
    transition: "opacity 150ms ease-out",
    pointerEvents: "none",
  } as CSSStyleDeclaration);
  toast.textContent = message;
  document.documentElement.appendChild(toast);
  requestAnimationFrame(() => {
    toast.style.opacity = "1";
  });
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 200);
  }, 2800);
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
  ctx.strokeStyle = stroke.tool === "text" ? stroke.color : stroke.color;
  if (stroke.tool === "pen") {
    if (stroke.points.length < 2) return;
    ctx.beginPath();
    ctx.lineWidth = stroke.width;
    const first = stroke.points[0]!;
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < stroke.points.length; i++) {
      const pt = stroke.points[i]!;
      ctx.lineTo(pt.x, pt.y);
    }
    ctx.stroke();
    return;
  }
  if (stroke.tool === "arrow") {
    drawArrow(ctx, stroke.start, stroke.end, stroke.color, stroke.width);
    return;
  }
  if (stroke.tool === "rect") {
    ctx.beginPath();
    ctx.lineWidth = stroke.width;
    const x = Math.min(stroke.start.x, stroke.end.x);
    const y = Math.min(stroke.start.y, stroke.end.y);
    const w = Math.abs(stroke.end.x - stroke.start.x);
    const h = Math.abs(stroke.end.y - stroke.start.y);
    ctx.strokeRect(x, y, w, h);
    return;
  }
  if (stroke.tool === "text") {
    ctx.font = `600 ${stroke.fontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
    ctx.fillStyle = stroke.color;
    // Soft background box for legibility
    const metrics = ctx.measureText(stroke.text);
    const padX = 4;
    const padY = 2;
    const bgW = metrics.width + padX * 2;
    const bgH = stroke.fontSize + padY * 2;
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillRect(stroke.position.x - padX, stroke.position.y - padY, bgW, bgH);
    ctx.restore();
    ctx.fillStyle = stroke.color;
    ctx.fillText(stroke.text, stroke.position.x, stroke.position.y);
    return;
  }
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  start: PointXY,
  end: PointXY,
  color: string,
  width: number,
): void {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  const angle = Math.atan2(dy, dx);
  const headLen = Math.min(18, len * 0.35);
  const headAngle = Math.PI / 7;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Shaft
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();

  // Head
  ctx.beginPath();
  ctx.moveTo(end.x, end.y);
  ctx.lineTo(
    end.x - headLen * Math.cos(angle - headAngle),
    end.y - headLen * Math.sin(angle - headAngle),
  );
  ctx.lineTo(
    end.x - headLen * Math.cos(angle + headAngle),
    end.y - headLen * Math.sin(angle + headAngle),
  );
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

/**
 * Find the element underneath a given viewport point, ignoring our own
 * annotation DOM (canvas, iframes, text input). Walks up looking for a
 * [data-mb-id] ancestor and returns a descriptor with ref/role/name/tagName.
 * Returns null if no useful element was found.
 *
 * Uses the project-wide `getRole` and `getAccessibleName` helpers from
 * `element-resolver.ts` (proper ARIA role map + aria-labelledby chain +
 * labels resolution) instead of reinventing a weaker local version.
 * Ancestor walking uses `getParentElement` from `element-utils.ts` so
 * Shadow DOM hosts are traversed correctly.
 */
function findNearestElement(
  point: PointXY,
  ownedRoot: HTMLElement,
): {
  ref?: string;
  role?: string;
  name?: string;
  tagName?: string;
} | null {
  // Temporarily hide our root so elementFromPoint hits the page below.
  const prevDisplay = ownedRoot.style.display;
  ownedRoot.style.display = "none";
  let el: Element | null = null;
  try {
    el = document.elementFromPoint(point.x, point.y);
  } finally {
    ownedRoot.style.display = prevDisplay;
  }
  if (!el) return null;

  // Walk up to find an element with data-mb-id if present. Uses
  // getParentElement so a hit inside an open shadow root walks out
  // through the host rather than stopping at the shadow boundary.
  let cur: Element | null = el;
  let withRef: Element | null = null;
  while (cur && cur !== document.documentElement) {
    if ((cur as HTMLElement).dataset?.mbId) {
      withRef = cur;
      break;
    }
    cur = getParentElement(cur);
  }

  const target = withRef ?? el;
  const ref = withRef
    ? `e${(withRef as HTMLElement).dataset.mbId}`
    : undefined;

  const tagName = target.tagName.toLowerCase();
  const role = getRole(target) ?? undefined;

  let name: string | undefined = getAccessibleName(target) || undefined;
  if (name && name.length > 80) {
    name = name.slice(0, 77) + "...";
  }

  return { ref, role, name, tagName };
}

function computeBoundingBox(
  strokes: Stroke[],
): { x: number; y: number; w: number; h: number } | null {
  if (strokes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of strokes) {
    if (s.tool === "pen") {
      for (const pt of s.points) {
        if (pt.x < minX) minX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y > maxY) maxY = pt.y;
      }
    } else if (s.tool === "arrow" || s.tool === "rect") {
      for (const pt of [s.start, s.end]) {
        if (pt.x < minX) minX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y > maxY) maxY = pt.y;
      }
    } else if (s.tool === "text") {
      const tw = s.text.length * s.fontSize * 0.55;
      const th = s.fontSize;
      if (s.position.x < minX) minX = s.position.x;
      if (s.position.y < minY) minY = s.position.y;
      if (s.position.x + tw > maxX) maxX = s.position.x + tw;
      if (s.position.y + th > maxY) maxY = s.position.y + th;
    }
  }
  if (!isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// ---------------------------------------------------------------------------
// Iframe srcdoc builders
// ---------------------------------------------------------------------------

function buildTopToolbarHtml(
  initialTool: DrawingTool,
  initialColor: string,
  token: string,
): string {
  // IMPORTANT: inline HTML/CSS/JS, no external resources.
  // The capability token is baked into the iframe at mount; the iframe
  // includes it on every outbound message and verifies it on inbound.
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; padding: 0; background: transparent; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      color: #fff;
    }
    .bar {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px;
      background: rgba(24, 24, 27, 0.94);
      border-radius: 10px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      user-select: none;
    }
    .group { display: flex; gap: 4px; align-items: center; }
    .sep { width: 1px; height: 22px; background: rgba(255,255,255,0.15); margin: 0 4px; }
    button.tool, button.action {
      background: rgba(255,255,255,0.04);
      color: #fff;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 6px;
      padding: 5px 9px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      font-family: inherit;
    }
    button.tool:hover, button.action:hover { background: rgba(255,255,255,0.10); }
    button.tool.active {
      background: rgba(59, 130, 246, 0.35);
      border-color: rgba(59, 130, 246, 0.7);
    }
    .swatch {
      width: 20px; height: 20px;
      border-radius: 50%;
      border: 2px solid rgba(255,255,255,0.15);
      cursor: pointer;
      padding: 0;
    }
    .swatch.active { border-color: #fff; box-shadow: 0 0 0 2px rgba(255,255,255,0.2); }
  </style></head><body>
    <div class="bar">
      <div class="group" id="tools">
        <button class="tool" data-tool="pen">Pen</button>
        <button class="tool" data-tool="arrow">Arrow</button>
        <button class="tool" data-tool="rect">Rect</button>
        <button class="tool" data-tool="text">Text</button>
      </div>
      <div class="sep"></div>
      <div class="group" id="colors"></div>
      <div class="sep"></div>
      <div class="group">
        <button class="action" id="undo" title="Undo (Cmd/Ctrl+Z)">Undo</button>
        <button class="action" id="clear">Clear</button>
      </div>
    </div>
    <script>
      (function(){
        var TOKEN = ${JSON.stringify(token)};
        var currentTool = ${JSON.stringify(initialTool)};
        var currentColor = ${JSON.stringify(initialColor)};
        var colorsContainer = document.getElementById('colors');
        var knownColors = [];

        function post(type, payload){
          window.parent.postMessage({ type: type, payload: payload, token: TOKEN }, '*');
        }

        function renderColors() {
          colorsContainer.innerHTML = '';
          for (var i = 0; i < knownColors.length; i++) {
            var c = knownColors[i];
            var btn = document.createElement('button');
            btn.className = 'swatch' + (c === currentColor ? ' active' : '');
            btn.style.background = c;
            btn.setAttribute('data-color', c);
            btn.addEventListener('click', (function(col){
              return function(){ post('mybrowser_annotation_color', col); };
            })(c));
            colorsContainer.appendChild(btn);
          }
        }
        function renderTools() {
          var btns = document.querySelectorAll('button.tool');
          for (var i = 0; i < btns.length; i++) {
            if (btns[i].getAttribute('data-tool') === currentTool) {
              btns[i].classList.add('active');
            } else {
              btns[i].classList.remove('active');
            }
          }
        }

        var toolBtns = document.querySelectorAll('button.tool');
        for (var i = 0; i < toolBtns.length; i++) {
          toolBtns[i].addEventListener('click', function(ev){
            var t = ev.currentTarget.getAttribute('data-tool');
            post('mybrowser_annotation_tool', t);
          });
        }
        document.getElementById('undo').addEventListener('click', function(){
          post('mybrowser_annotation_undo');
        });
        document.getElementById('clear').addEventListener('click', function(){
          post('mybrowser_annotation_clear');
        });

        window.addEventListener('message', function(ev){
          var d = ev.data;
          if (!d || d.token !== TOKEN) return;
          if (d.type !== 'mybrowser_annotation_state') return;
          var p = d.payload || {};
          if (p.tool) currentTool = p.tool;
          if (p.color) currentColor = p.color;
          if (Array.isArray(p.colors)) knownColors = p.colors;
          renderTools();
          renderColors();
        });

        // Announce ready so parent sends initial state
        post('mybrowser_annotation_ready');
      })();
    </script>
  </body></html>`;
}

function buildBottomBarHtml(token: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; padding: 0; background: transparent; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      color: #fff;
    }
    .bar {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 14px;
      background: rgba(24, 24, 27, 0.96);
      border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      min-width: 600px;
    }
    input {
      flex: 1;
      padding: 8px 10px;
      background: rgba(255,255,255,0.06);
      color: #fff;
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 6px;
      font-size: 14px;
      font-family: inherit;
      outline: none;
    }
    input::placeholder { color: rgba(255,255,255,0.45); }
    input:focus { border-color: rgba(59,130,246,0.6); }
    button {
      padding: 7px 14px;
      border: none;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      color: #fff;
      font-family: inherit;
    }
    button.cancel { background: #dc2626; }
    button.save   { background: #16a34a; }
    button:hover  { filter: brightness(1.1); }
  </style></head><body>
    <div class="bar">
      <input id="note" type="text" placeholder="What's wrong? (Cmd+Enter to save, Esc to cancel)" autofocus />
      <button class="cancel" id="cancel">Cancel</button>
      <button class="save" id="save">Save</button>
    </div>
    <script>
      (function(){
        var TOKEN = ${JSON.stringify(token)};
        var noteEl = document.getElementById('note');
        var lastValue = '';

        function post(type, payload){
          window.parent.postMessage({ type: type, payload: payload, token: TOKEN }, '*');
        }

        function emitNote() {
          var v = noteEl.value;
          if (v !== lastValue) {
            lastValue = v;
            post('mybrowser_annotation_note', v);
          }
        }
        function emitSave() {
          post('mybrowser_annotation_save', noteEl.value);
        }
        function emitCancel() {
          post('mybrowser_annotation_cancel');
        }

        noteEl.addEventListener('input', emitNote);
        noteEl.addEventListener('keydown', function(ev){
          if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
            ev.preventDefault();
            emitSave();
          } else if (ev.key === 'Escape') {
            ev.preventDefault();
            emitCancel();
          }
        });
        document.getElementById('save').addEventListener('click', emitSave);
        document.getElementById('cancel').addEventListener('click', emitCancel);

        window.addEventListener('message', function(ev){
          var d = ev.data;
          if (!d || d.token !== TOKEN) return;
          if (d.type === 'mybrowser_annotation_request_save') {
            emitSave();
          } else if (d.type === 'mybrowser_annotation_restore_note') {
            var txt = typeof d.payload === 'string' ? d.payload : '';
            noteEl.value = txt;
            lastValue = txt;
          }
        });

        post('mybrowser_annotation_ready');
        setTimeout(function(){ noteEl.focus(); }, 0);
      })();
    </script>
  </body></html>`;
}

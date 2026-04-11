// Draft auto-save for the annotation overlay. Persists in-progress strokes
// and note text to chrome.storage.local so the user doesn't lose work if
// they accidentally cancel, navigate, or close the tab mid-draw.
//
// Keying design (revised for D5):
//   `${STORAGE_PREFIX}${normalizedUrl}::${tabSessionId}`
//
// - `normalizedUrl` strips the fragment, so `/page#section` and `/page`
//   share a slot. Two tabs on the same URL used to stomp each other's
//   drafts; that no longer happens because...
// - `tabSessionId` is a random id minted once per tab in `sessionStorage`.
//   sessionStorage is per-tab and survives same-tab navigations, so a
//   single tab's draft persists across reloads but doesn't leak to a
//   sibling tab. When the tab closes, sessionStorage is wiped, so the
//   old draft becomes orphaned — we sweep expired entries on load.
//
// Drafts older than 24h are ignored and cleaned up on the next access.

import type { Stroke } from "./overlay";

const STORAGE_PREFIX = "mybrowser_annotation_draft:";
const SESSION_ID_KEY = "mybrowser_annotation_session_id";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface Draft {
  /** Normalized URL (fragment stripped) for display/debug only.
   *  The storage key is derived from url + tab session id. */
  url: string;
  strokes: Stroke[];
  note: string;
  savedAt: number;
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/** Strip the URL fragment so `/page#section` and `/page` share a slot. */
function normalizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.hash = "";
    return u.toString();
  } catch {
    const hashIdx = rawUrl.indexOf("#");
    return hashIdx >= 0 ? rawUrl.slice(0, hashIdx) : rawUrl;
  }
}

/**
 * Per-tab session id. Generated once per tab in sessionStorage and reused
 * for the lifetime of that tab (including reloads). Falls back to a
 * random in-memory id if sessionStorage is unavailable — worse than
 * nothing (no cross-reload persistence) but still avoids cross-tab
 * collisions within a page load.
 */
let memoryFallbackId: string | null = null;
function getTabSessionId(): string {
  try {
    const existing = sessionStorage.getItem(SESSION_ID_KEY);
    if (existing) return existing;
    const fresh =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem(SESSION_ID_KEY, fresh);
    return fresh;
  } catch {
    if (!memoryFallbackId) {
      memoryFallbackId =
        "nosession_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
    return memoryFallbackId;
  }
}

function currentDraftKey(): string {
  return `${STORAGE_PREFIX}${normalizeUrl(location.href)}::${getTabSessionId()}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist a draft for the current tab+URL. Safe to call frequently —
 * callers should debounce at the source.
 *
 * The `url` field inside `draft` is ignored and rewritten to the
 * normalized current URL; callers can pass anything (or leave the old
 * value) without affecting the key.
 */
export async function saveDraft(
  draft: Omit<Draft, "url"> & { url?: string },
): Promise<void> {
  try {
    const payload: Draft = {
      url: normalizeUrl(location.href),
      strokes: draft.strokes,
      note: draft.note,
      savedAt: draft.savedAt,
    };
    await chrome.storage.local.set({ [currentDraftKey()]: payload });
  } catch {
    /* storage disabled / quota exceeded — silently no-op */
  }
}

/**
 * Load the draft for the current tab+URL if one exists and is still
 * fresh. Returns null otherwise. Also lazily sweeps expired drafts
 * across all tabs/URLs so old entries don't accumulate indefinitely.
 */
export async function loadDraft(): Promise<Draft | null> {
  try {
    const key = currentDraftKey();
    const result = await chrome.storage.local.get(key);
    const draft = result[key] as Draft | undefined;

    // Sweep expired drafts in the background — don't block restore.
    sweepExpiredDrafts().catch(() => {});

    if (!draft) return null;
    if (!Number.isFinite(draft.savedAt)) return null;
    if (Date.now() - draft.savedAt > MAX_AGE_MS) {
      // Stale — clear just this key (not a URL-wide wipe).
      await clearDraft();
      return null;
    }
    if (!Array.isArray(draft.strokes)) return null;
    return draft;
  } catch {
    return null;
  }
}

/** Clear the current tab+URL draft only. Never touches other tabs' slots. */
export async function clearDraft(): Promise<void> {
  try {
    await chrome.storage.local.remove(currentDraftKey());
  } catch {
    /* no-op */
  }
}

/**
 * One-shot cleanup of expired draft entries from all tabs/URLs in storage.
 * Runs in the background after loadDraft so the stale-draft population
 * doesn't grow unbounded as the user opens and closes tabs.
 */
let sweepInFlight = false;
async function sweepExpiredDrafts(): Promise<void> {
  if (sweepInFlight) return;
  sweepInFlight = true;
  try {
    const all = await chrome.storage.local.get(null);
    const now = Date.now();
    const toRemove: string[] = [];
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(STORAGE_PREFIX)) continue;
      const draft = value as Draft | undefined;
      if (
        !draft ||
        typeof draft !== "object" ||
        !Number.isFinite(draft.savedAt) ||
        now - draft.savedAt > MAX_AGE_MS
      ) {
        toRemove.push(key);
      }
    }
    if (toRemove.length > 0) {
      await chrome.storage.local.remove(toRemove);
    }
  } catch {
    /* best-effort — nothing we can do */
  } finally {
    sweepInFlight = false;
  }
}

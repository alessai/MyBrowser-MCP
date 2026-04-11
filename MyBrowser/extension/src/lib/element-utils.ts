// Element selection, coordinates, visibility, scrolling, and shadow DOM utilities.

/**
 * Query all matching elements with shadow DOM piercing via `>>>` separator.
 */
export function querySelectorAllDeep(selector: string, root: ParentNode = document): Element[] {
  if (!selector) return [];
  const parts = selector.split('>>>');
  if (parts.length === 1) {
    return Array.from(root.querySelectorAll(selector));
  }
  const head = parts[0] ?? '';
  const tail = parts.slice(1).join('>>>').trim();
  return querySelectorAllDeep(head.trim(), root).reduce<Element[]>((acc, el) => {
    if (el.shadowRoot) {
      return [...acc, ...querySelectorAllDeep(tail, el.shadowRoot)];
    }
    return acc;
  }, []);
}

/**
 * Query first matching element with shadow DOM piercing.
 */
export function querySelectorDeep(selector: string, root: ParentNode = document): Element | null {
  const results = querySelectorAllDeep(selector, root);
  return results[0] ?? null;
}

/**
 * Check if an element matches a selector (with shadow DOM piercing support).
 */
export function matchesDeep(
  el: Element,
  selector: string,
  scope: ParentNode = document,
): boolean {
  const parts = selector.split('>>>');
  if (parts.length === 1) {
    return el.matches(selector);
  }
  const head = parts[0] ?? '';
  const tail = parts.slice(1).join('>>>').trim();
  const host = querySelectorDeep(head.trim(), scope);
  if (!host || !host.shadowRoot) return false;
  return matchesDeep(el, tail, host.shadowRoot);
}

/**
 * Get the center coordinates of an element using getClientRects.
 */
export function getElementCenter(el: Element): { x: number; y: number } | null {
  const rects = el.getClientRects();
  const rect = rects[0];
  if (!rect) return null;
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * Check pseudo-element visibility (::before / ::after with content).
 */
function hasPseudoContent(el: Element, pseudo: '::before' | '::after'): boolean {
  const style = window.getComputedStyle(el, pseudo);
  if (style.content === 'normal' || style.content === 'none') return false;

  const parseDim = (value: string, dimension: 'width' | 'height'): number => {
    if (value.endsWith('%')) {
      return (el.getBoundingClientRect()[dimension] * parseInt(value)) / 100;
    }
    return parseInt(value);
  };
  const w = parseDim(style.width, 'width');
  const h = parseDim(style.height, 'height');
  if (w <= 0 || h <= 0) return false;
  if (style.visibility === 'hidden' || style.display === 'none') return false;

  // Check ancestors for hidden
  let parent = el.parentElement;
  while (parent) {
    const ps = window.getComputedStyle(parent);
    if (ps.display === 'none' || ps.visibility === 'hidden') return false;
    parent = parent.parentElement;
  }
  return true;
}

/**
 * Get direct children of a node (works for shadow roots too).
 */
export function getChildren(node: ParentNode): Element[] {
  if (node.children instanceof HTMLCollection) return Array.from(node.children);
  if (node.childNodes instanceof NodeList) {
    return Array.from(node.childNodes).filter((n): n is Element => n instanceof Element);
  }
  return [];
}

/**
 * Check if an element is visible (has dimensions + CSS visibility).
 */
export function isElementVisible(el: Element): boolean {
  const { width, height } = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);

  if (
    width > 0 &&
    height > 0 &&
    style.visibility !== 'hidden' &&
    style.display !== 'none'
  ) {
    return true;
  }
  if (hasPseudoContent(el, '::before') || hasPseudoContent(el, '::after')) {
    return true;
  }
  if (style.display === 'contents') {
    return getChildren(el).some((child) => isElementVisible(child));
  }
  return false;
}

/**
 * Check if element is within the viewport.
 */
export function isInViewport(el: Element): boolean {
  const { top, left, bottom, right } = el.getBoundingClientRect();
  const offScreen =
    bottom < 0 ||
    right < 0 ||
    left > document.documentElement.clientWidth ||
    top > document.documentElement.clientHeight;
  return isElementVisible(el) && !offScreen;
}

/**
 * Check if element is fully within the viewport.
 */
function isFullyInViewport(el: Element): boolean {
  const { top, left, bottom, right } = el.getBoundingClientRect();
  const vh = window.visualViewport?.height ?? document.documentElement.clientHeight;
  const vw = window.visualViewport?.width ?? document.documentElement.clientWidth;
  return top >= 0 && left >= 0 && bottom <= vh && right <= vw;
}

/**
 * Scroll an element into view.
 */
export function scrollIntoView(el: Element, options?: { force?: boolean }): void {
  if (isFullyInViewport(el) && !options?.force) return;

  const doScroll = (block: ScrollLogicalPosition) => {
    el.scrollIntoView({ block, inline: 'center', behavior: 'instant' });
  };

  if (el instanceof HTMLElement) {
    const vh = document.documentElement.clientHeight;
    if (el.offsetHeight > vh) {
      const prev = el.style.scrollMarginTop;
      el.style.scrollMarginTop = '100px';
      doScroll('start');
      el.style.scrollMarginTop = prev;
      return;
    }
  }
  doScroll('center');
}

/**
 * Wait for an element to stop moving (stable position).
 */
export async function waitForStablePosition(el: Element, maxWaitMs = 5000): Promise<void> {
  let prev = el.getBoundingClientRect();
  // Wait two frames first
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
  const deadline = Date.now() + maxWaitMs;
  return new Promise((resolve) => {
    function check() {
      if (Date.now() > deadline) {
        resolve(); // Timeout — resolve anyway to avoid hanging
        return;
      }
      const curr = el.getBoundingClientRect();
      if (
        prev.x === curr.x &&
        prev.y === curr.y &&
        prev.width === curr.width &&
        prev.height === curr.height
      ) {
        resolve();
        return;
      }
      prev = curr;
      requestAnimationFrame(check);
    }
    check();
  });
}

/**
 * Wait for the DOM to stabilize (no mutations for minStableMs).
 */
export async function waitForStableDOM(options: {
  minStableMs?: number;
  maxMutations?: number;
  maxWaitMs?: number;
} = {}): Promise<void> {
  const { minStableMs = 1000, maxMutations = 0, maxWaitMs } = options;
  return new Promise((resolve) => {
    const maxTimer = maxWaitMs
      ? window.setTimeout(() => {
          observer.disconnect();
          resolve();
          window.clearTimeout(stableTimer);
        }, maxWaitMs)
      : undefined;

    // Browser-land window.setTimeout returns a plain number, but with
    // Node types in the project, `ReturnType<typeof setTimeout>` resolves
    // to Node's `Timeout` class. Declare the number return explicitly.
    function resetStable(): number {
      return window.setTimeout(() => {
        observer.disconnect();
        resolve();
        if (maxTimer !== undefined) window.clearTimeout(maxTimer);
      }, minStableMs);
    }

    let count = 0;
    let stableTimer = resetStable();

    const observer = new MutationObserver(() => {
      count++;
      if (count > maxMutations) {
        window.clearTimeout(stableTimer);
        stableTimer = resetStable();
        count = 0;
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  });
}

/**
 * Get the parent element, piercing shadow roots.
 */
export function getParentElement(el: Element, pierceShadow = true): Element | null {
  if (pierceShadow && el.parentNode instanceof ShadowRoot) {
    return el.parentNode.host;
  }
  return el.parentElement;
}

/**
 * Get ancestor chain, optionally piercing shadow DOM.
 */
export function getAncestors(el: Element, pierceShadow = true): Element[] {
  const parent = getParentElement(el, pierceShadow);
  return parent ? [parent, ...getAncestors(parent, pierceShadow)] : [];
}

/**
 * Select text within an element (input, textarea, or contentEditable).
 */
export function selectText(el: Element): void {
  if (el instanceof HTMLElement && el.isContentEditable) {
    el.focus();
    const sel = document.getSelection();
    if (!sel) throw new Error('Unable to get selection.');
    sel.removeAllRanges();
    sel.selectAllChildren(el);
  } else if (
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement &&
      ['email', 'number', 'password', 'search', 'tel', 'text', 'url', 'datetime'].includes(
        el.getAttribute('type') || 'text',
      ))
  ) {
    el.focus();
    el.select();
  } else {
    throw new Error(`Unable to select text in element: ${el.tagName.toLowerCase()}`);
  }
}

/**
 * Resolve an element from selector, waiting for it to appear.
 */
export async function resolveElement(
  selector: string,
  options: {
    scope?: ParentNode;
    timeoutMs?: number;
    stable?: boolean;
    visible?: boolean;
    clickable?: boolean;
  } = {},
): Promise<Element> {
  const {
    scope = document,
    timeoutMs = 30000,
    stable,
    visible,
    clickable,
  } = options;

  let phase = 'exist';

  return new Promise<Element>((resolve, reject) => {
    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(
        new Error(
          `Timeout exceeded waiting for element to ${phase === 'exist' ? phase : `become ${phase}`}: ${selector}`,
        ),
      );
    }, timeoutMs);

    async function tryFind() {
      const el = querySelectorDeep(selector, scope);
      if (!el) return;

      if (stable) {
        phase = 'stable';
        await waitForStablePosition(el);
      }
      if (visible) {
        phase = 'visible';
        if (!isElementVisible(el)) return;
      }
      if (clickable) {
        phase = 'clickable';
        const center = getElementCenter(el);
        if (!center) return;
        const hits = document.elementsFromPoint(center.x, center.y);
        if (!hits.includes(el) && !hits.some((h) => el.contains(h))) return;
      }
      if (!el.isConnected) {
        phase = 'attached';
        return;
      }

      clearTimeout(timeout);
      observer.disconnect();
      resolve(el);
    }

    const observer = new MutationObserver(() => tryFind());
    observer.observe(scope instanceof Element ? scope : document, {
      childList: true,
      subtree: true,
      attributes: true,
    });

    // Try immediately
    tryFind();
  });
}

/**
 * Resize an image via canvas.
 */
export async function resizeImage(opts: {
  imageUrl: string;
  maxWidth: number;
  maxHeight: number;
}): Promise<{ dataUrl: string; width: number; height: number }> {
  const img = new Image();
  img.src = opts.imageUrl;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Failed to load image for resize'));
  });

  // Skip resize if image is already within bounds
  if (img.width <= opts.maxWidth && img.height <= opts.maxHeight) {
    return { dataUrl: opts.imageUrl, width: img.width, height: img.height };
  }

  const aspect = img.width / img.height;
  let width: number;
  let height: number;
  if (aspect > opts.maxWidth / opts.maxHeight) {
    width = opts.maxWidth;
    height = Math.round(opts.maxWidth / aspect);
  } else {
    height = opts.maxHeight;
    width = Math.round(opts.maxHeight * aspect);
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get canvas context');
  ctx.drawImage(img, 0, 0, width, height);
  return { dataUrl: canvas.toDataURL(), width, height };
}

// Content script entry point for MyBrowser extension.
// Registers all message handlers and sends 'ready' on load.

import { addMessageHandler, sendToBackground } from '../../lib/messaging';
import { generateAriaSnapshot, getLastSnapshot } from '../../lib/aria-snapshot';
import { generateSelector } from '../../lib/selector-engine';
import {
  resolveElement,
  getElementCenter,
  scrollIntoView,
  waitForStablePosition,
  isInViewport,
  isElementVisible,
  waitForStableDOM,
  selectText,
  resizeImage,
  querySelectorAllDeep,
  querySelectorDeep,
} from '../../lib/element-utils';
import { generateMarks, removeOverlay, getMarkById } from '../../lib/set-of-marks';
import {
  openAnnotationOverlay,
  removeAnnotationOverlay,
  restoreAnnotationOverlay,
  showAnnotationToast,
  isOverlayOpen,
} from '../../lib/annotation/overlay';
import { clearDraft } from '../../lib/annotation/drafts';
import {
  resolveElementSelector,
  resolveElementCoordinates,
  registerMarkLookup,
  type ElementDescriptor,
} from '../../lib/element-resolver';
import './style.css';

// ---------------------------------------------------------------------------
// Cursor overlay
// ---------------------------------------------------------------------------

const CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/></svg>`;

let cursorEl: HTMLDivElement | null = null;
let cursorPosition: { x: number; y: number } | null = null;

function ensureCursorOverlay(): HTMLDivElement {
  if (cursorEl && cursorEl.isConnected) return cursorEl;
  cursorEl = document.createElement('div');
  cursorEl.id = 'mybrowser-cursor-overlay';
  cursorEl.classList.add('hidden');
  cursorEl.innerHTML = CURSOR_SVG;
  document.documentElement.appendChild(cursorEl);
  return cursorEl;
}

function computeStartPosition(
  current: { x: number; y: number } | null,
  target: { x: number; y: number },
  distancePx = 100,
): { x: number; y: number } {
  const from = current ?? { x: 0, y: 0 };
  const dist = Math.sqrt((from.x - target.x) ** 2 + (from.y - target.y) ** 2);
  if (dist <= distancePx) return target;
  const angle = Math.atan2(from.y - target.y, from.x - target.x);
  return {
    x: target.x + distancePx * Math.cos(angle),
    y: target.y + distancePx * Math.sin(angle),
  };
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

function registerHandlers(): (() => void)[] {
  const cleanups: (() => void)[] = [];

  // ARIA snapshot
  cleanups.push(
    addMessageHandler('generateAriaSnapshot', async (payload: unknown) => {
      const { viewportOnly, mode } = (payload || {}) as {
        viewportOnly?: boolean;
        mode?: 'full' | 'diff' | 'auto';
      };
      return generateAriaSnapshot({ viewportOnly, mode });
    }),
  );

  // Get selector for ARIA ref — accepts both stable "e42" and legacy "s1e42" formats
  cleanups.push(
    addMessageHandler('getSelectorForAriaRef', async (payload: unknown) => {
      const { ariaRef } = payload as { ariaRef: string };

      // Try new stable format: e<id>
      const stableMatch = ariaRef.match(/^e(\d+)$/);
      // Try legacy format: s<gen>e<id>
      const legacyMatch = ariaRef.match(/^s(\d+)e(\d+)$/);

      if (!stableMatch && !legacyMatch) {
        throw new Error('Invalid aria-ref selector, should be of form e<number> or s<number>e<number>');
      }

      const elemId = stableMatch ? Number(stableMatch[1]) : Number(legacyMatch![2]);

      // For stable refs, try data-mb-id attribute lookup first
      if (stableMatch) {
        const el = document.querySelector(`[data-mb-id="${elemId}"]`);
        if (el) return generateSelector(el);
      }

      // Fall back to snapshot lookup
      const snapshot = getLastSnapshot();
      if (!snapshot) {
        throw new Error('No snapshot found. Please generate an aria snapshot before trying again.');
      }

      // For legacy format, validate generation
      if (legacyMatch) {
        const gen = Number(legacyMatch![1]);
        if (snapshot.generation !== gen) {
          throw new Error(
            `Stale aria-ref, expected s${snapshot.generation}e${elemId}, got ${ariaRef}. Please regenerate an aria snapshot before trying again.`,
          );
        }
      }

      const element = snapshot.elements.get(elemId);
      if (!element) {
        throw new Error(`Element with aria-ref ${ariaRef} not found`);
      }
      return generateSelector(element);
    }),
  );

  // Get element coordinates
  cleanups.push(
    addMessageHandler('getElementCoordinates', async (payload: unknown) => {
      const { selector, options = {} } = payload as {
        selector: string;
        options?: { clickable?: boolean };
      };
      const el = await resolveElement(selector, {
        visible: true,
        stable: true,
        clickable: options.clickable,
      });
      const coords = getElementCenter(el);
      if (!coords) throw new Error('Unable to get coordinates for element');
      return coords;
    }),
  );

  // Scroll into view
  cleanups.push(
    addMessageHandler('scrollIntoView', async (payload: unknown) => {
      const { selector, force } = payload as { selector: string; force?: boolean };
      const el = await resolveElement(selector);
      scrollIntoView(el, { force });
      await waitForStablePosition(el);
      if (!isInViewport(el)) {
        scrollIntoView(el, { force });
        await waitForStablePosition(el);
      }
    }),
  );

  // Select <option> in a <select>
  cleanups.push(
    addMessageHandler('selectOption', async (payload: unknown) => {
      const { selector, values, selectMethod } = payload as {
        selector: string;
        values: string[];
        selectMethod: 'text' | 'value';
      };
      const el = await resolveElement(selector);
      if (!(el instanceof HTMLSelectElement)) {
        throw new Error(`Element is not a <select> element: ${selector}`);
      }
      el.value = '';
      const toSelect = el.multiple ? values : [values[0]];
      const allOptions = Array.from(el.options);
      for (const val of toSelect) {
        const option = allOptions.find((opt) =>
          selectMethod === 'text' ? opt.innerText === val : opt.value === val,
        );
        if (!option) throw new Error(`Unable to find option for value: ${val}`);
        option.selected = true;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }),
  );

  // Wait for stable DOM
  cleanups.push(
    addMessageHandler('waitForStableDOM', async (payload: unknown) => {
      const { minStableMs, maxMutations, maxWaitMs } = (payload || {}) as {
        minStableMs?: number;
        maxMutations?: number;
        maxWaitMs?: number;
      };
      await waitForStableDOM({ minStableMs, maxMutations, maxWaitMs });
    }),
  );

  // Get input type
  cleanups.push(
    addMessageHandler('getInputType', async (payload: unknown) => {
      const { selector } = payload as { selector: string };
      const el = await resolveElement(selector);
      return el instanceof HTMLInputElement ? el.type.toLowerCase() : null;
    }),
  );

  // Set input value
  cleanups.push(
    addMessageHandler('setInputValue', async (payload: unknown) => {
      const { selector, value } = payload as { selector: string; value: string };
      const el = await resolveElement(selector);
      if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
        throw new Error(`Element is not an input element: ${selector}`);
      }
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }),
  );

  // Select text
  cleanups.push(
    addMessageHandler('selectText', async (payload: unknown) => {
      const { selector } = payload as { selector: string };
      const el = await resolveElement(selector);
      selectText(el);
    }),
  );

  // Resize image
  cleanups.push(
    addMessageHandler('resizeImage', async (payload: unknown) => {
      const { imageUrl, maxWidth, maxHeight } = payload as {
        imageUrl: string;
        maxWidth: number;
        maxHeight: number;
      };
      return resizeImage({ imageUrl, maxWidth, maxHeight });
    }),
  );

  // Set cursor position
  cleanups.push(
    addMessageHandler('setCursorPosition', async (payload: unknown) => {
      const { x, y } = payload as { x: number; y: number };
      const overlay = ensureCursorOverlay();
      if (!cursorPosition) {
        const startPos = computeStartPosition(cursorPosition, { x, y });
        cursorPosition = startPos;
        overlay.style.transform = `translate(${startPos.x}px, ${startPos.y}px)`;
      }
      overlay.classList.remove('hidden');
      // Brief delay to allow CSS transition from start position to target
      setTimeout(() => {
        cursorPosition = { x, y };
        overlay.style.transform = `translate(${x}px, ${y}px)`;
      }, 100);
    }),
  );

  // Hide cursor
  cleanups.push(
    addMessageHandler('hideCursor', async () => {
      const overlay = ensureCursorOverlay();
      overlay.classList.add('hidden');
    }),
  );

  // Ping / health check
  cleanups.push(
    addMessageHandler('ping', async () => {
      return true;
    }),
  );

  // Get current URL
  cleanups.push(
    addMessageHandler('getUrl', async () => {
      return window.location.href;
    }),
  );

  // Get page title
  cleanups.push(
    addMessageHandler('getTitle', async () => {
      return document.title;
    }),
  );

  // Remove extension iframes and password manager overlays before snapshots/screenshots
  cleanups.push(
    addMessageHandler('removeExtensionFrames', async () => {
      document.querySelectorAll('iframe, frame').forEach((el) => {
        const src = (el as HTMLIFrameElement).src || '';
        if (src.startsWith('chrome-extension://')) el.remove();
      });
    }),
  );

  // Get selector for element at given coordinates (used by browser_type without prior click)
  cleanups.push(
    addMessageHandler('getSelectorForCoordinates', async (payload: unknown) => {
      const { coordinates, targetOptions = {} } = payload as {
        coordinates: { x: number; y: number };
        targetOptions?: { editable?: boolean };
      };
      const elements = document.elementsFromPoint(coordinates.x, coordinates.y);
      let target: Element | null = null;
      for (const el of elements) {
        if (targetOptions.editable) {
          if (
            el instanceof HTMLInputElement ||
            el instanceof HTMLTextAreaElement ||
            (el as HTMLElement).isContentEditable
          ) {
            target = el;
            break;
          }
        } else {
          target = el;
          break;
        }
      }
      if (!target) throw new Error('No element found at coordinates');
      return generateSelector(target);
    }),
  );

  // Set-of-Marks: generate marks overlay and return label map
  cleanups.push(
    addMessageHandler('generateMarks', async () => {
      const { labelMap } = generateMarks();
      return labelMap;
    }),
  );

  // Set-of-Marks: clear overlay
  cleanups.push(
    addMessageHandler('clearMarks', async () => {
      removeOverlay();
    }),
  );

  // Set-of-Marks: get selector for a mark ID (for clicking/interacting)
  cleanups.push(
    addMessageHandler('getMarkElement', async (payload: unknown) => {
      const { id } = payload as { id: number };
      const mark = getMarkById(id);
      if (!mark) throw new Error(`Mark with id ${id} not found`);
      return generateSelector(mark.element);
    }),
  );

  // NL element resolver: find element by descriptor, return CSS selector
  cleanups.push(
    addMessageHandler('resolveElement', async (payload: unknown) => {
      const descriptor = payload as ElementDescriptor;
      return resolveElementSelector(descriptor);
    }),
  );

  // NL element resolver: find element by descriptor, return coordinates
  cleanups.push(
    addMessageHandler('resolveElementCoordinates', async (payload: unknown) => {
      const descriptor = payload as ElementDescriptor;
      return resolveElementCoordinates(descriptor);
    }),
  );

  // ULTRA: Conditional wait — polls for a condition to be met
  cleanups.push(
    addMessageHandler('browser_wait_for', async (payload: unknown) => {
      const { condition, value, selector, timeout = 10000, pollInterval = 500 } = payload as {
        condition: string;
        value?: string;
        selector?: string;
        timeout?: number;
        pollInterval?: number;
      };

      const start = Date.now();

      function checkCondition(): boolean {
        switch (condition) {
          case 'url_contains':
            return value ? window.location.href.includes(value) : false;
          case 'url_matches':
            try { return value ? new RegExp(value).test(window.location.href) : false; }
            catch { return false; }
          case 'element_visible': {
            if (!selector) return false;
            const el = querySelectorDeep(selector);
            return el ? isElementVisible(el) : false;
          }
          case 'element_not_visible': {
            if (!selector) return true;
            const el = querySelectorDeep(selector);
            return !el || !isElementVisible(el);
          }
          case 'text_visible':
            return value ? (document.body.innerText || '').includes(value) : false;
          case 'text_not_visible':
            return value ? !(document.body.innerText || '').includes(value) : true;
          case 'network_idle':
            // Heuristic: wait for DOM to stabilize (no mutations for 500ms)
            // Actual network_idle is handled in background; this is a fallback
            return true;
          default:
            return false;
        }
      }

      return new Promise<{ met: boolean; waitedMs: number }>((resolve, reject) => {
        function poll() {
          if (checkCondition()) {
            resolve({ met: true, waitedMs: Date.now() - start });
            return;
          }
          if (Date.now() - start >= timeout) {
            reject(new Error(`Timeout after ${timeout}ms waiting for condition: ${condition}${value ? ` (${value})` : ''}${selector ? ` [${selector}]` : ''}`));
            return;
          }
          setTimeout(poll, pollInterval);
        }
        poll();
      });
    }),
  );

  // ULTRA: Assertion checks — evaluates multiple conditions, returns structured results
  cleanups.push(
    addMessageHandler('browser_assert', async (payload: unknown) => {
      const { checks } = payload as {
        checks: Array<{
          type: string;
          value?: string;
          selector?: string;
          min?: number;
          max?: number;
        }>;
      };

      const results: Array<{ type: string; passed: boolean; message: string }> = [];

      for (const check of checks) {
        let passed = false;
        let message = '';

        switch (check.type) {
          case 'url_contains':
            passed = check.value ? window.location.href.includes(check.value) : false;
            message = passed
              ? `url_contains: '${check.value}' found in URL`
              : `url_contains: '${check.value}' NOT found in URL (current: ${window.location.href})`;
            break;
          case 'url_matches':
            try { passed = check.value ? new RegExp(check.value).test(window.location.href) : false; }
            catch { passed = false; }
            message = passed
              ? `url_matches: URL matches pattern '${check.value}'`
              : `url_matches: URL does NOT match pattern '${check.value}' (current: ${window.location.href})`;
            break;
          case 'element_visible': {
            const el = check.selector ? querySelectorDeep(check.selector) : null;
            passed = el ? isElementVisible(el) : false;
            message = passed
              ? `element_visible: '${check.selector}' is visible`
              : `element_visible: '${check.selector}' NOT visible`;
            break;
          }
          case 'element_not_visible': {
            const el = check.selector ? querySelectorDeep(check.selector) : null;
            passed = !el || !isElementVisible(el);
            message = passed
              ? `element_not_visible: '${check.selector}' is not visible`
              : `element_not_visible: '${check.selector}' IS visible (expected not visible)`;
            break;
          }
          case 'text_contains':
            passed = check.value ? (document.body.innerText || '').includes(check.value) : false;
            message = passed
              ? `text_contains: '${check.value}' found on page`
              : `text_contains: '${check.value}' NOT found on page`;
            break;
          case 'text_not_contains':
            passed = check.value ? !(document.body.innerText || '').includes(check.value) : true;
            message = passed
              ? `text_not_contains: '${check.value}' not on page (as expected)`
              : `text_not_contains: '${check.value}' IS on page (expected absent)`;
            break;
          case 'element_count': {
            const elements = check.selector ? querySelectorAllDeep(check.selector) : [];
            const count = elements.length;
            const minOk = check.min === undefined || count >= check.min;
            const maxOk = check.max === undefined || count <= check.max;
            passed = minOk && maxOk;
            const range = check.min !== undefined && check.max !== undefined
              ? `${check.min}-${check.max}`
              : check.min !== undefined ? `>=${check.min}` : `<=${check.max}`;
            message = passed
              ? `element_count: '${check.selector}' count=${count} (expected ${range})`
              : `element_count: '${check.selector}' count=${count} (expected ${range}, FAILED)`;
            break;
          }
          case 'title_contains':
            passed = check.value ? document.title.includes(check.value) : false;
            message = passed
              ? `title_contains: '${check.value}' found in title`
              : `title_contains: '${check.value}' NOT found in title (current: "${document.title}")`;
            break;
          case 'console_no_errors':
            // Handled in background — this is a placeholder; background merges its result
            passed = true;
            message = 'console_no_errors: checked in background';
            break;
          default:
            message = `unknown check type: ${check.type}`;
            break;
        }

        results.push({ type: check.type, passed, message });
      }

      return {
        passed: results.every((r) => r.passed),
        results,
      };
    }),
  );

  // ULTRA: Smart form filling by label association
  cleanups.push(
    addMessageHandler('browser_fill_form', async (payload: unknown) => {
      const { fields, submitAfter, submitText } = payload as {
        fields: Record<string, string>;
        submitAfter?: boolean;
        submitText?: string;
      };

      const filled: string[] = [];
      const failed: string[] = [];

      function normalizeLabel(s: string): string {
        return s.replace(/\s+/g, ' ').trim().toLowerCase();
      }

      function fuzzyMatch(actual: string, query: string): boolean {
        const a = normalizeLabel(actual);
        const q = normalizeLabel(query);
        if (!a || !q) return false;
        if (a === q || a.includes(q)) return true;
        const aCompact = a.replace(/\s/g, '');
        const qCompact = q.replace(/\s/g, '');
        return aCompact === qCompact || aCompact.includes(qCompact);
      }

      function isVisibleEl(el: Element): boolean {
        if ((el as HTMLInputElement).disabled) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      function findInputByLabel(labelText: string): HTMLElement | null {
        // Strategy 1: <label for="id"> association
        for (const label of document.querySelectorAll('label')) {
          const text = (label.textContent || '').trim();
          if (!fuzzyMatch(text, labelText)) continue;
          const forId = label.getAttribute('for');
          if (forId) {
            const target = document.getElementById(forId);
            if (target && isVisibleEl(target)) return target as HTMLElement;
          }
          // Strategy 2: wrapped input inside label
          const wrapped = label.querySelector('input, select, textarea');
          if (wrapped && isVisibleEl(wrapped)) return wrapped as HTMLElement;
        }

        // Strategy 3: aria-label
        for (const el of document.querySelectorAll('input, select, textarea')) {
          const ariaLabel = el.getAttribute('aria-label') || '';
          if (fuzzyMatch(ariaLabel, labelText) && isVisibleEl(el)) return el as HTMLElement;
        }

        // Strategy 4: placeholder
        for (const el of document.querySelectorAll('input[placeholder], textarea[placeholder]')) {
          const ph = el.getAttribute('placeholder') || '';
          if (fuzzyMatch(ph, labelText) && isVisibleEl(el)) return el as HTMLElement;
        }

        // Strategy 5: preceding text node / sibling text near input
        const allInputs = document.querySelectorAll('input, select, textarea');
        for (const input of allInputs) {
          if (!isVisibleEl(input)) continue;
          let prev = input.previousSibling;
          while (prev) {
            if (prev.nodeType === Node.TEXT_NODE) {
              const text = (prev.textContent || '').trim();
              if (text && fuzzyMatch(text, labelText)) return input as HTMLElement;
            }
            if (prev.nodeType === Node.ELEMENT_NODE) {
              const text = ((prev as HTMLElement).textContent || '').trim();
              if (text && fuzzyMatch(text, labelText)) return input as HTMLElement;
              break;
            }
            prev = prev.previousSibling;
          }
          const parentPrev = input.parentElement?.previousElementSibling;
          if (parentPrev) {
            const text = (parentPrev.textContent || '').trim();
            if (text && fuzzyMatch(text, labelText)) return input as HTMLElement;
          }
        }

        return null;
      }

      function dispatchEvents(el: HTMLElement): void {
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      function getRadioLabel(radio: HTMLInputElement): string {
        if (radio.labels && radio.labels.length > 0) {
          return Array.from(radio.labels).map((l) => (l.textContent || '').trim()).join(' ');
        }
        const parentLabel = radio.closest('label');
        if (parentLabel) return (parentLabel.textContent || '').trim();
        const next = radio.nextSibling;
        if (next && next.nodeType === Node.TEXT_NODE) return (next.textContent || '').trim();
        return '';
      }

      function fillInput(el: HTMLElement, value: string): void {
        if (el instanceof HTMLSelectElement) {
          const option = Array.from(el.options).find(
            (opt) => fuzzyMatch(opt.text, value) || opt.value === value,
          );
          if (option) {
            el.value = option.value;
          } else {
            el.value = value;
          }
          dispatchEvents(el);
          return;
        }

        if (el instanceof HTMLTextAreaElement) {
          el.focus();
          el.value = value;
          dispatchEvents(el);
          return;
        }

        if (el instanceof HTMLInputElement) {
          const inputType = el.type.toLowerCase();

          if (inputType === 'checkbox') {
            const shouldCheck = value === 'true' || value === '1' || value === 'yes' || value === 'on';
            if (el.checked !== shouldCheck) el.click();
            return;
          }

          if (inputType === 'radio') {
            if (el.value === value) {
              if (!el.checked) el.click();
            } else if (el.name) {
              const radios = document.querySelectorAll<HTMLInputElement>(
                `input[type="radio"][name="${CSS.escape(el.name)}"]`,
              );
              for (const radio of radios) {
                if (radio.value === value || fuzzyMatch(getRadioLabel(radio), value)) {
                  if (!radio.checked) radio.click();
                  break;
                }
              }
            }
            return;
          }

          if (inputType === 'date' || inputType === 'datetime-local' || inputType === 'time' || inputType === 'month' || inputType === 'week') {
            el.focus();
            el.value = value;
            dispatchEvents(el);
            return;
          }

          // text, email, password, tel, url, search, number
          el.focus();
          el.value = value;
          dispatchEvents(el);
          return;
        }

        if (el.isContentEditable) {
          el.focus();
          el.textContent = value;
          dispatchEvents(el);
        }
      }

      for (const [label, value] of Object.entries(fields)) {
        try {
          const input = findInputByLabel(label);
          if (!input) {
            failed.push(label);
            continue;
          }
          fillInput(input, value);
          filled.push(label);
        } catch {
          failed.push(label);
        }
      }

      let submitted = false;
      if (submitAfter) {
        const defaultPattern = /submit|log.?in|sign.?in|save|continue/i;
        const pattern = submitText ? new RegExp(submitText, 'i') : defaultPattern;

        const submitBtn =
          document.querySelector<HTMLElement>('button[type="submit"]') ||
          document.querySelector<HTMLElement>('input[type="submit"]') ||
          Array.from(document.querySelectorAll<HTMLElement>('button, input[type="button"], [role="button"]')).find(
            (btn) => {
              const text = (btn as HTMLElement).textContent || (btn as HTMLInputElement).value || '';
              return pattern.test(text.trim());
            },
          );

        if (submitBtn && isVisibleEl(submitBtn)) {
          submitBtn.click();
          submitted = true;
        }
      }

      return { filled, failed, submitted };
    }),
  );

  // ULTRA: Structured data extraction from page
  cleanups.push(
    addMessageHandler('browser_extract', async (payload: unknown) => {
      const { selector, fields, limit = 10 } = payload as {
        selector: string;
        fields: Record<string, string>;
        limit?: number;
      };
      const containers = Array.from(document.querySelectorAll(selector)).slice(0, limit);
      return containers.map((container) => {
        const result: Record<string, string | null> = {};
        for (const [fieldName, fieldSelector] of Object.entries(fields)) {
          if (fieldSelector === 'self') {
            result[fieldName] = (container as HTMLElement).innerText?.trim() ?? container.textContent?.trim() ?? null;
          } else if (fieldSelector.includes('@')) {
            const [sel, attr] = fieldSelector.split('@');
            const target = sel ? container.querySelector(sel) : container;
            result[fieldName] = target?.getAttribute(attr!) ?? null;
          } else {
            const target = container.querySelector(fieldSelector);
            result[fieldName] = target ? ((target as HTMLElement).innerText?.trim() ?? target.textContent?.trim() ?? null) : null;
          }
        }
        return result;
      });
    }),
  );

  // ULTRA Phase 3: Generate Page Object Model for current page
  cleanups.push(
    addMessageHandler('generatePageModel', async () => {
      const elements: Record<string, { selector: string; role: string; name: string }> = {};

      // Selectors for interactive elements with identifiable attributes
      const interactiveSelector = [
        '[id]',
        '[data-testid]',
        '[data-test]',
        '[data-test-id]',
        '[aria-label]',
        '[role="button"]',
        '[role="link"]',
        '[role="textbox"]',
        '[role="searchbox"]',
        '[role="combobox"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="tab"]',
        '[role="menuitem"]',
        '[role="navigation"]',
        '[role="dialog"]',
        'a[href]',
        'button',
        'input',
        'select',
        'textarea',
        'form',
        'nav',
      ].join(',');

      const seen = new Set<Element>();
      const allElements = document.querySelectorAll(interactiveSelector);

      for (const el of allElements) {
        if (seen.has(el)) continue;
        seen.add(el);

        // Skip hidden elements
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;

        // Build a human-friendly key name
        const id = el.getAttribute('id') || '';
        const testId = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-test-id') || '';
        const ariaLabel = el.getAttribute('aria-label') || '';
        const role = el.getAttribute('role') || el.tagName.toLowerCase();
        const name = ariaLabel || (el as HTMLElement).innerText?.trim().slice(0, 50) || '';

        // Derive a key: prefer testId, then id, then aria-label, then role+index
        let key = '';
        if (testId) {
          key = testId;
        } else if (id && !/^\d+$/.test(id) && id.length < 60) {
          key = id;
        } else if (ariaLabel) {
          key = ariaLabel.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
        } else if (name) {
          key = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
        }

        if (!key) continue;

        // Deduplicate keys
        let uniqueKey = key;
        let counter = 2;
        while (elements[uniqueKey]) {
          uniqueKey = `${key}_${counter}`;
          counter++;
        }

        try {
          elements[uniqueKey] = {
            selector: generateSelector(el),
            role,
            name: name.slice(0, 80),
          };
        } catch {
          // Skip elements that can't get a selector
        }
      }

      return {
        url: window.location.href,
        title: document.title,
        elements,
      };
    }),
  );

  // ULTRA: Find elements by role, name, text, or selector
  cleanups.push(
    addMessageHandler('browser_find', async (payload: unknown) => {
      const { role, name, text, selector, limit = 10 } = payload as {
        role?: string;
        name?: string;
        text?: string;
        selector?: string;
        limit?: number;
      };

      const results: Array<{ role: string; name: string; text: string; selector: string; rect: { x: number; y: number; w: number; h: number } }> = [];
      const candidates = selector
        ? Array.from(document.querySelectorAll(selector))
        : Array.from(document.querySelectorAll('a, button, input, select, textarea, [role], [tabindex], [contenteditable]'));

      for (const el of candidates) {
        if (results.length >= limit) break;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        const elRole = el.getAttribute('role') || el.tagName.toLowerCase();
        const elName = el.getAttribute('aria-label') || (el as HTMLElement).innerText?.trim().slice(0, 80) || '';

        if (role && !elRole.includes(role)) continue;
        if (name && !elName.toLowerCase().includes(name.toLowerCase())) continue;
        if (text) {
          const elText = (el as HTMLElement).innerText?.trim() || '';
          if (!elText.toLowerCase().includes(text.toLowerCase())) continue;
        }

        results.push({
          role: elRole,
          name: elName.slice(0, 80),
          text: ((el as HTMLElement).innerText?.trim() || '').slice(0, 100),
          selector: generateSelector(el),
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        });
      }

      return results;
    }),
  );

  // Content-script-based click (DOM events, no CDP debugger needed)
  cleanups.push(
    addMessageHandler('cs_click', async (payload: unknown) => {
      const { selector } = payload as { selector: string };
      const el = querySelectorDeep(selector) as HTMLElement | null;
      if (!el) throw new Error(`Element not found: ${selector}`);
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      await new Promise((r) => setTimeout(r, 100));
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
      el.focus?.();
      return { clicked: true, selector };
    }),
  );

  // Content-script-based hover (DOM events)
  cleanups.push(
    addMessageHandler('cs_hover', async (payload: unknown) => {
      const { selector } = payload as { selector: string };
      const el = querySelectorDeep(selector) as HTMLElement | null;
      if (!el) throw new Error(`Element not found: ${selector}`);
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: x, clientY: y }));
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
      return { hovered: true, selector };
    }),
  );

  // Content-script-based type (set value + events, no CDP)
  cleanups.push(
    addMessageHandler('cs_type', async (payload: unknown) => {
      const { selector, text, submit } = payload as { selector: string; text: string; submit?: boolean };
      const el = querySelectorDeep(selector) as HTMLElement | null;
      if (!el) throw new Error(`Element not found: ${selector}`);
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.focus?.();
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.value = text;
      } else if (el.isContentEditable) {
        el.textContent = text;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (submit) {
        const form = el.closest('form');
        if (form) {
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          form.submit?.();
        } else {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
        }
      }
      return { typed: true, selector, text };
    }),
  );

  // Content-script-based eval (fallback when CDP unavailable)
  cleanups.push(
    addMessageHandler('cs_eval', async (payload: unknown) => {
      const { code } = payload as { code: string };
      const evaluator = Reflect.get(globalThis, 'eval') as
        | ((source: string) => unknown)
        | undefined;
      if (typeof evaluator !== 'function') {
        throw new Error('Global eval is unavailable in this context');
      }
      return evaluator(code);
    }),
  );

  // Content-script-based press key
  cleanups.push(
    addMessageHandler('cs_press_key', async (payload: unknown) => {
      const { key } = payload as { key: string };
      const target = document.activeElement || document.body;
      target.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true }));
      target.dispatchEvent(new KeyboardEvent('keypress', { key, code: key, bubbles: true }));
      target.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true }));
      return { pressed: true, key };
    }),
  );

  // Annotation overlay — user presses the hotkey, SW routes the command here,
  // we mount the overlay. The overlay resolves with {note, metadata} on Save
  // or null on Cancel. On Save we message the SW to capture + upload.
  // We return immediately so sendToTab doesn't hit its 10s timeout while the
  // user is drawing.
  cleanups.push(
    addMessageHandler('open_annotation_overlay', async () => {
      if (isOverlayOpen()) return { ok: true, alreadyOpen: true };
      (async () => {
        try {
          const result = await openAnnotationOverlay();
          if (!result) return; // user cancelled — overlay already torn down
          // Capture the instance id so a late ack from this save can't
          // tear down or mutate a different overlay the user may have
          // opened in the meantime (e.g. after the 30s cleanup timeout).
          const savedInstanceId = result.instanceId;
          try {
            const ack = await sendToBackground<{ ok: boolean; pendingCount?: number; error?: string }>(
              'annotation_save',
              {
                url: location.href,
                title: document.title,
                note: result.note,
                metadata: result.metadata,
              },
            );
            if (ack?.ok) {
              // Success: tear down THIS overlay (scoped) FIRST. Only clear
              // the draft if we were still the current overlay — otherwise
              // a late ack from a superseded mount would clobber the new
              // overlay's draft (clearDraft is URL-keyed, not instance-keyed).
              const tornDown = removeAnnotationOverlay(savedInstanceId);
              if (tornDown) {
                await clearDraft();
                const n = ack.pendingCount ?? 0;
                showAnnotationToast(
                  `Note saved — ${n} pending`,
                  'success',
                );
              }
              // If !tornDown, a newer overlay has taken over; silently drop
              // this late success. The note was still saved server-side.
            } else {
              // Failure: leave the overlay in place so the user can retry
              // without losing their drawing. Draft is preserved.
              restoreAnnotationOverlay(savedInstanceId);
              showAnnotationToast(
                `Save failed: ${ack?.error ?? 'unknown error'}. Your drawing is preserved.`,
                'error',
              );
            }
          } catch (e) {
            // SW round-trip failed outright — same recovery path
            console.error('[MyBrowser] annotation save failed:', e);
            restoreAnnotationOverlay(savedInstanceId);
            showAnnotationToast(
              `Save failed: ${e instanceof Error ? e.message : String(e)}. Your drawing is preserved.`,
              'error',
            );
          }
        } catch (e) {
          // openAnnotationOverlay failed before we got an instance id.
          // Don't force-teardown here — openAnnotationOverlay() already
          // tears down any stale mount on its next call, and the 30s
          // safety-net timeout in submit() handles mid-save crashes.
          // Unconditional teardown would be an unscoped footgun for any
          // future overlay that might race in.
          console.error('[MyBrowser] annotation overlay error:', e);
        }
      })();
      return { ok: true };
    }),
  );

  return cleanups;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',

  main() {
    // Wire up SoM mark lookup for the element resolver
    registerMarkLookup(getMarkById);

    const cleanups = registerHandlers();

    // Notify background that content script is ready
    sendToBackground('ready').catch(() => {
      // Background may not be ready yet, that's ok
    });

    // Return cleanup function for WXT
    return () => {
      cleanups.forEach((fn) => fn());
      if (cursorEl?.isConnected) cursorEl.remove();
      removeOverlay();
    };
  },
});

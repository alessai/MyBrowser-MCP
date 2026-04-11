// Multi-strategy element resolver: finds DOM elements by natural language descriptors.
// Tries ref, mark, selector, role+name, label, text, and proximity strategies in order.

import { getLastSnapshot } from './aria-snapshot';
import {
  querySelectorDeep,
  isElementVisible,
  getElementCenter,
} from './element-utils';
import { generateSelector } from './selector-engine';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ElementDescriptor {
  ref?: string;
  mark?: number;
  selector?: string;
  role?: string;
  name?: string;
  text?: string;
  label?: string;
  placeholder?: string;
  near?: string;
  index?: number;
}

// ---------------------------------------------------------------------------
// Implicit role map (lightweight, for matching)
// ---------------------------------------------------------------------------

const TAG_TO_ROLE: Record<string, string | ((el: Element) => string | null)> = {
  A: (el) => (el.hasAttribute('href') ? 'link' : null),
  AREA: (el) => (el.hasAttribute('href') ? 'link' : null),
  ARTICLE: 'article',
  ASIDE: 'complementary',
  BUTTON: 'button',
  DATALIST: 'listbox',
  DETAILS: 'group',
  DIALOG: 'dialog',
  FIELDSET: 'group',
  FIGURE: 'figure',
  FOOTER: 'contentinfo',
  H1: 'heading',
  H2: 'heading',
  H3: 'heading',
  H4: 'heading',
  H5: 'heading',
  H6: 'heading',
  HEADER: 'banner',
  HR: 'separator',
  IMG: 'img',
  INPUT: (el) => {
    const type = (el as HTMLInputElement).type.toLowerCase();
    const map: Record<string, string> = {
      button: 'button', checkbox: 'checkbox', image: 'button',
      number: 'spinbutton', radio: 'radio', range: 'slider',
      reset: 'button', submit: 'button', search: 'searchbox',
    };
    if (map[type]) return map[type];
    if (type === 'hidden') return null;
    return 'textbox';
  },
  LI: 'listitem',
  MAIN: 'main',
  MATH: 'math',
  MENU: 'list',
  METER: 'meter',
  NAV: 'navigation',
  OL: 'list',
  OPTION: 'option',
  OUTPUT: 'status',
  PROGRESS: 'progressbar',
  SELECT: 'combobox',
  TABLE: 'table',
  TBODY: 'rowgroup',
  TD: 'cell',
  TEXTAREA: 'textbox',
  TFOOT: 'rowgroup',
  TH: 'columnheader',
  THEAD: 'rowgroup',
  TR: 'row',
  UL: 'list',
};

export function getRole(el: Element): string | null {
  const explicit = el.getAttribute('role')?.split(' ').find(Boolean);
  if (explicit) return explicit;
  const entry = TAG_TO_ROLE[el.tagName.toUpperCase()];
  if (!entry) return null;
  return typeof entry === 'function' ? entry(el) : entry;
}

// ---------------------------------------------------------------------------
// Accessible name (lightweight)
// ---------------------------------------------------------------------------

export function getAccessibleName(el: Element): string {
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy.split(/\s+/).filter(Boolean);
    const texts = parts.map((id) => {
      const ref = document.getElementById(id);
      return ref ? (ref.textContent || '').trim() : '';
    });
    const joined = texts.filter(Boolean).join(' ');
    if (joined) return joined;
  }

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.trim();

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const labels = el.labels;
    if (labels && labels.length > 0) {
      return Array.from(labels).map((l) => (l.textContent || '').trim()).join(' ');
    }
  }

  if (el instanceof HTMLButtonElement) {
    const labels = el.labels;
    if (labels && labels.length > 0) {
      return Array.from(labels).map((l) => (l.textContent || '').trim()).join(' ');
    }
  }

  if (el instanceof HTMLImageElement) {
    const alt = el.getAttribute('alt');
    if (alt) return alt.trim();
  }

  const title = el.getAttribute('title');
  if (title) return title.trim();

  const innerText = (el as HTMLElement).innerText;
  if (innerText) return innerText.trim();

  return (el.textContent || '').trim();
}

// ---------------------------------------------------------------------------
// Visibility / interactivity filters
// ---------------------------------------------------------------------------

const INTERACTIVE_SELECTORS = 'a[href], button, input, select, textarea, [role], [tabindex], [contenteditable="true"], [contenteditable=""]';

function isInteractive(el: Element): boolean {
  return el.matches(INTERACTIVE_SELECTORS);
}

function isVisibleAndInteractable(el: Element): boolean {
  return isElementVisible(el) && !isDisabledElement(el);
}

function isDisabledElement(el: Element): boolean {
  if ((el as HTMLButtonElement).disabled) return true;
  if (el.getAttribute('aria-disabled') === 'true') return true;
  return false;
}

// ---------------------------------------------------------------------------
// Text matching helpers
// ---------------------------------------------------------------------------

function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function textMatches(actual: string, query: string): boolean {
  const a = normalizeText(actual);
  const q = normalizeText(query);
  if (!a || !q) return false;
  return a === q || a.includes(q);
}

// ---------------------------------------------------------------------------
// Strategy implementations
// ---------------------------------------------------------------------------

function resolveByRef(ref: string): Element | null {
  // Stable format: e<id>
  const stableMatch = ref.match(/^e(\d+)$/);
  if (stableMatch && stableMatch[1]) {
    const elemId = +stableMatch[1];
    const el = document.querySelector(`[data-mb-id="${elemId}"]`);
    if (el) return el;
    // Fall through to snapshot lookup
    const snapshot = getLastSnapshot();
    return snapshot?.elements.get(elemId) ?? null;
  }
  // Legacy format: s<gen>e<id>
  const legacyMatch = ref.match(/^s(\d+)e(\d+)$/);
  if (!legacyMatch || !legacyMatch[1] || !legacyMatch[2]) return null;
  const snapshot = getLastSnapshot();
  if (!snapshot) return null;
  if (snapshot.generation !== +legacyMatch[1]) return null;
  return snapshot.elements.get(+legacyMatch[2]) ?? null;
}

// Registry for mark lookup — set by SoM module when loaded
let markLookup: ((id: number) => { element: Element } | null) | null = null;

export function registerMarkLookup(fn: (id: number) => { element: Element } | null): void {
  markLookup = fn;
}

function resolveByMark(markId: number): Element | null {
  if (!markLookup) return null;
  const mark = markLookup(markId);
  return mark?.element || null;
}

function resolveBySelector(selector: string): Element | null {
  return querySelectorDeep(selector);
}

function resolveByRoleAndName(role: string, name?: string): Element[] {
  const candidates: Element[] = [];
  for (const el of document.querySelectorAll('*')) {
    const elRole = getRole(el);
    if (elRole !== role) continue;
    if (!isVisibleAndInteractable(el)) continue;
    if (name) {
      const accName = getAccessibleName(el);
      if (!textMatches(accName, name)) continue;
    }
    candidates.push(el);
  }
  return candidates;
}

function resolveByLabel(labelText: string, placeholderText?: string): Element[] {
  const candidates: Element[] = [];

  // Strategy A: label[for] association
  for (const label of document.querySelectorAll('label')) {
    const text = (label.textContent || '').trim();
    if (!textMatches(text, labelText)) continue;
    const forId = label.getAttribute('for');
    if (forId) {
      const target = document.getElementById(forId);
      if (target && isVisibleAndInteractable(target)) {
        candidates.push(target);
      }
    }
    // Strategy B: wrapped input inside label
    const wrapped = label.querySelector('input, select, textarea');
    if (wrapped && isVisibleAndInteractable(wrapped) && !candidates.includes(wrapped)) {
      candidates.push(wrapped);
    }
  }

  // Strategy C: aria-label attribute match
  for (const el of document.querySelectorAll('[aria-label]')) {
    const ariaLabel = el.getAttribute('aria-label') || '';
    if (textMatches(ariaLabel, labelText) && isVisibleAndInteractable(el) && !candidates.includes(el)) {
      candidates.push(el);
    }
  }

  // Strategy D: placeholder match
  const placeholderQuery = placeholderText || labelText;
  for (const el of document.querySelectorAll('input[placeholder], textarea[placeholder]')) {
    const ph = el.getAttribute('placeholder') || '';
    if (textMatches(ph, placeholderQuery) && isVisibleAndInteractable(el) && !candidates.includes(el)) {
      candidates.push(el);
    }
  }

  return candidates;
}

function resolveByText(text: string): Element[] {
  const interactive: Element[] = [];
  const nonInteractive: Element[] = [];

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node) {
        const el = node as Element;
        if (!isElementVisible(el)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const el = node as Element;
    const elText = (el as HTMLElement).innerText ?? el.textContent ?? '';
    if (!textMatches(elText, text)) continue;
    // Prefer leaf-like matches: skip if a child also matches
    let childMatches = false;
    for (const child of el.children) {
      const childText = (child as HTMLElement).innerText ?? child.textContent ?? '';
      if (textMatches(childText, text)) {
        childMatches = true;
        break;
      }
    }
    if (childMatches) continue;

    if (isInteractive(el)) {
      interactive.push(el);
    } else {
      nonInteractive.push(el);
    }
  }

  return [...interactive, ...nonInteractive];
}

function resolveByProximity(
  nearText: string,
  descriptor: ElementDescriptor,
): Element[] {
  // Find the anchor element by text
  const anchors = resolveByText(nearText);
  const anchor = anchors[0];
  if (!anchor) return [];
  const anchorCenter = getElementCenter(anchor);
  if (!anchorCenter) return [];

  const RADIUS = 200;

  // Find candidate elements matching remaining criteria
  let candidates: Element[];
  if (descriptor.role) {
    candidates = resolveByRoleAndName(descriptor.role, descriptor.name);
  } else if (descriptor.label) {
    candidates = resolveByLabel(descriptor.label, descriptor.placeholder);
  } else if (descriptor.text) {
    candidates = resolveByText(descriptor.text);
  } else {
    // Fallback: find all visible interactive elements
    candidates = Array.from(document.querySelectorAll(INTERACTIVE_SELECTORS)).filter(isVisibleAndInteractable);
  }

  // Filter by proximity and sort by distance
  const withDistance = candidates
    .map((el) => {
      const center = getElementCenter(el);
      if (!center) return null;
      const dist = Math.sqrt((center.x - anchorCenter.x) ** 2 + (center.y - anchorCenter.y) ** 2);
      return { el, dist };
    })
    .filter((entry): entry is { el: Element; dist: number } => entry !== null && entry.dist <= RADIUS)
    .sort((a, b) => a.dist - b.dist);

  return withDistance.map((e) => e.el);
}

// ---------------------------------------------------------------------------
// Error message helpers
// ---------------------------------------------------------------------------

function describeDescriptor(descriptor: ElementDescriptor): string {
  const parts: string[] = [];
  if (descriptor.ref) parts.push(`ref: '${descriptor.ref}'`);
  if (descriptor.mark !== undefined) parts.push(`mark: ${descriptor.mark}`);
  if (descriptor.selector) parts.push(`selector: '${descriptor.selector}'`);
  if (descriptor.role) parts.push(`role: '${descriptor.role}'`);
  if (descriptor.name) parts.push(`name: '${descriptor.name}'`);
  if (descriptor.text) parts.push(`text: '${descriptor.text}'`);
  if (descriptor.label) parts.push(`label: '${descriptor.label}'`);
  if (descriptor.placeholder) parts.push(`placeholder: '${descriptor.placeholder}'`);
  if (descriptor.near) parts.push(`near: '${descriptor.near}'`);
  if (descriptor.index !== undefined) parts.push(`index: ${descriptor.index}`);
  return `{${parts.join(', ')}}`;
}

function collectVisibleNames(role?: string): string[] {
  const names: string[] = [];
  for (const el of document.querySelectorAll('*')) {
    if (names.length >= 10) break;
    if (!isElementVisible(el)) continue;
    if (role && getRole(el) !== role) continue;
    if (!role && !isInteractive(el)) continue;
    const accName = getAccessibleName(el);
    if (accName && accName.length < 80) {
      const truncated = accName.length > 50 ? accName.slice(0, 50) + '...' : accName;
      names.push(`'${truncated}'`);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

function pickByIndex(elements: Element[], index?: number): Element | null {
  if (elements.length === 0) return null;
  if (index !== undefined) {
    return (index >= 0 && index < elements.length ? elements[index] : null) ?? null;
  }
  return elements[0] ?? null;
}

export function resolveElementFromDescriptor(descriptor: ElementDescriptor): Element {
  // 1. Ref
  if (descriptor.ref) {
    const el = resolveByRef(descriptor.ref);
    if (el && isElementVisible(el)) return el;
    throw new Error(
      `Element with ref '${descriptor.ref}' not found or not visible. ` +
      'Please regenerate an aria snapshot and use a current ref.',
    );
  }

  // 2. Mark
  if (descriptor.mark !== undefined) {
    const el = resolveByMark(descriptor.mark);
    if (el && isElementVisible(el)) return el;
    throw new Error(
      `Element with mark ${descriptor.mark} not found or not visible. ` +
      'Please regenerate marks and use a current mark ID.',
    );
  }

  // 3. CSS Selector
  if (descriptor.selector) {
    const el = resolveBySelector(descriptor.selector);
    if (el && isElementVisible(el)) return el;
    throw new Error(
      `No visible element found for selector '${descriptor.selector}'.`,
    );
  }

  // 4. Role + Name
  if (descriptor.role) {
    const candidates = resolveByRoleAndName(descriptor.role, descriptor.name);
    const el = pickByIndex(candidates, descriptor.index);
    if (el) return el;
    const visible = collectVisibleNames(descriptor.role);
    throw new Error(
      `No element found matching ${describeDescriptor(descriptor)}.` +
      (visible.length > 0 ? ` Visible ${descriptor.role}s: [${visible.join(', ')}]` : ''),
    );
  }

  // 5. Label / Placeholder
  if (descriptor.label || descriptor.placeholder) {
    const labelText = descriptor.label || descriptor.placeholder!;
    const candidates = resolveByLabel(labelText, descriptor.placeholder);
    const el = pickByIndex(candidates, descriptor.index);
    if (el) return el;
    throw new Error(
      `No form element found with label matching ${describeDescriptor(descriptor)}.`,
    );
  }

  // 6. Text
  if (descriptor.text) {
    // If near is also specified, skip to proximity
    if (!descriptor.near) {
      const candidates = resolveByText(descriptor.text);
      const el = pickByIndex(candidates, descriptor.index);
      if (el) return el;
      const visible = collectVisibleNames();
      throw new Error(
        `No element found with text '${descriptor.text}'.` +
        (visible.length > 0 ? ` Visible interactive elements: [${visible.join(', ')}]` : ''),
      );
    }
  }

  // 7. Proximity
  if (descriptor.near) {
    const candidates = resolveByProximity(descriptor.near, descriptor);
    const el = pickByIndex(candidates, descriptor.index);
    if (el) return el;
    throw new Error(
      `No element found near '${descriptor.near}' matching ${describeDescriptor(descriptor)}.`,
    );
  }

  throw new Error(
    `Empty descriptor: at least one of ref, mark, selector, role, label, text, or near must be provided.`,
  );
}

export function resolveElementSelector(descriptor: ElementDescriptor): string {
  const el = resolveElementFromDescriptor(descriptor);
  return generateSelector(el);
}

export function resolveElementCoordinates(descriptor: ElementDescriptor): { x: number; y: number } {
  const el = resolveElementFromDescriptor(descriptor);
  const coords = getElementCenter(el);
  if (!coords) throw new Error('Unable to get coordinates for resolved element');
  return coords;
}

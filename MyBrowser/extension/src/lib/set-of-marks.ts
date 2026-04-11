// Set-of-Marks (SoM) engine: finds interactive viewport elements, assigns numbered IDs,
// renders colored bounding box overlays, and returns a compact label map.

import { isElementVisible, isInViewport } from './element-utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Mark {
  id: number;
  element: Element;
  role: string;
  name: string;
  rect: DOMRect;
  tag: string;
  type?: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let currentMarks: Mark[] = [];
let overlayEl: HTMLDivElement | null = null;

// ---------------------------------------------------------------------------
// Color palette (10 distinct colors, cycling)
// ---------------------------------------------------------------------------

const COLORS = [
  '#e6194b', // red
  '#3cb44b', // green
  '#4363d8', // blue
  '#f58231', // orange
  '#911eb4', // purple
  '#42d4f4', // cyan
  '#f032e6', // magenta
  '#bfef45', // lime
  '#fabed4', // pink
  '#469990', // teal
];

// ---------------------------------------------------------------------------
// Interactive element discovery
// ---------------------------------------------------------------------------

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="combobox"]',
  '[role="searchbox"]',
  '[role="textbox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="treeitem"]',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[tabindex]',
].join(',');

function getInteractiveElements(): Element[] {
  const all = document.querySelectorAll(INTERACTIVE_SELECTOR);
  const results: Element[] = [];
  const seen = new Set<Element>();

  for (const el of all) {
    if (seen.has(el)) continue;
    seen.add(el);

    // Skip elements with negative tabindex that aren't otherwise interactive
    if (el.getAttribute('tabindex') !== null) {
      const ti = parseInt(el.getAttribute('tabindex')!, 10);
      if (ti < 0 && !el.matches('a[href],button,input,select,textarea,[role],[contenteditable]')) {
        continue;
      }
    }

    // Skip disabled elements
    if ((el as HTMLButtonElement).disabled) continue;
    if (el.getAttribute('aria-disabled') === 'true') continue;

    // Skip invisible / off-viewport elements
    if (!isElementVisible(el)) continue;
    if (!isInViewport(el)) continue;

    // Skip elements that are too small to be meaningful (< 4x4)
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) continue;

    results.push(el);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Role / name extraction (lightweight, no full ARIA computation)
// ---------------------------------------------------------------------------

function getRole(el: Element): string {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit.split(' ')[0] ?? explicit;

  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'a': return el.hasAttribute('href') ? 'link' : 'generic';
    case 'button': return 'button';
    case 'input': {
      const type = (el as HTMLInputElement).type.toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      if (type === 'range') return 'slider';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    case 'select': return 'combobox';
    case 'textarea': return 'textbox';
    default: {
      if ((el as HTMLElement).isContentEditable) return 'textbox';
      if (el.hasAttribute('tabindex')) return 'generic';
      return 'generic';
    }
  }
}

function getAccessibleName(el: Element): string {
  // aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.trim();

  // aria-labelledby
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy.split(/\s+/).map((id) => {
      const ref = document.getElementById(id);
      return ref ? (ref.textContent || '').trim() : '';
    }).filter(Boolean);
    if (parts.length) return parts.join(' ');
  }

  const tag = el.tagName.toLowerCase();

  // Input elements: check label, placeholder, title
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const input = el as HTMLInputElement;
    // Check associated labels
    if (input.labels?.length) {
      return Array.from(input.labels).map((l) => (l.textContent || '').trim()).join(' ');
    }
    if (input.placeholder) return input.placeholder;
    if (input.title) return input.title;
    if (tag === 'input' && (input.type === 'submit' || input.type === 'reset' || input.type === 'button')) {
      return input.value || input.type;
    }
    return '';
  }

  // Images: alt text
  if (tag === 'img') {
    return el.getAttribute('alt') || el.getAttribute('title') || '';
  }

  // Links/buttons: inner text
  const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
  if (text.length <= 200) return text;
  return text.slice(0, 197) + '...';
}

// ---------------------------------------------------------------------------
// Mark generation
// ---------------------------------------------------------------------------

export function generateMarks(): { marks: Mark[]; labelMap: string } {
  // Clean up any existing overlay
  removeOverlay();

  const elements = getInteractiveElements();
  const marks: Mark[] = [];

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i]!;
    const rect = el.getBoundingClientRect();
    marks.push({
      id: i + 1,
      element: el,
      role: getRole(el),
      name: getAccessibleName(el),
      rect,
      tag: el.tagName.toLowerCase(),
      type: el.tagName.toLowerCase() === 'input' ? (el as HTMLInputElement).type.toLowerCase() : undefined,
    });
  }

  currentMarks = marks;
  overlayEl = renderOverlay(marks);
  document.documentElement.appendChild(overlayEl);

  return { marks, labelMap: formatLabelMap(marks) };
}

// ---------------------------------------------------------------------------
// Overlay rendering
// ---------------------------------------------------------------------------

function renderOverlay(marks: Mark[]): HTMLDivElement {
  const container = document.createElement('div');
  container.id = 'mybrowser-som-overlay';

  for (const mark of marks) {
    const color = COLORS[(mark.id - 1) % COLORS.length]!;
    const { left, top, width, height } = mark.rect;

    // Bounding box
    const box = document.createElement('div');
    box.className = 'mybrowser-som-box';
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${width}px`;
    box.style.height = `${height}px`;
    box.style.borderColor = color;

    // Number label
    const label = document.createElement('span');
    label.className = 'mybrowser-som-label';
    label.textContent = String(mark.id);
    label.style.backgroundColor = color;

    box.appendChild(label);
    container.appendChild(box);
  }

  return container;
}

// ---------------------------------------------------------------------------
// Overlay removal
// ---------------------------------------------------------------------------

export function removeOverlay(): void {
  if (overlayEl?.isConnected) {
    overlayEl.remove();
  }
  overlayEl = null;
}

// ---------------------------------------------------------------------------
// Label map formatting
// ---------------------------------------------------------------------------

const MAX_NAME_LEN = 60;

export function formatLabelMap(marks: Mark[]): string {
  const lines: string[] = [];

  for (const mark of marks) {
    let name = mark.name;
    if (name.length > MAX_NAME_LEN) {
      name = name.slice(0, MAX_NAME_LEN - 3) + '...';
    }

    let line = `[${mark.id}] ${mark.role}`;
    if (name) {
      line += ` "${name}"`;
    }
    // Add input type for textboxes
    if (mark.role === 'textbox' && mark.type && mark.type !== 'text') {
      line += ` (${mark.type})`;
    }
    // Show current value for inputs
    if (mark.tag === 'input' || mark.tag === 'textarea') {
      const val = (mark.element as HTMLInputElement).value;
      if (val && mark.type !== 'password') {
        const displayVal = val.length > 30 ? val.slice(0, 27) + '...' : val;
        line += ` value="${displayVal}"`;
      }
    }

    lines.push(line);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Mark lookup
// ---------------------------------------------------------------------------

export function getMarkById(id: number): Mark | null {
  return currentMarks.find((m) => m.id === id) || null;
}

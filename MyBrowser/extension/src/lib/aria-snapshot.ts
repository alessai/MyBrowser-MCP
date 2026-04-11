// ARIA tree builder: role mapping, accessible name computation, and YAML serialization.
// Ported from the original Browser MCP content script.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AriaNode {
  role: string;
  name: string;
  children: (AriaNode | string)[];
  props: Record<string, string>;
  element: Element;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  expanded?: boolean;
  level?: number;
  pressed?: boolean | 'mixed';
  selected?: boolean;
}

export interface AriaSnapshot {
  root: AriaNode;
  elements: Map<number, Element>;
  ids: Map<Element, number>;
  generation: number;
}

// ---------------------------------------------------------------------------
// Caches (scope-local, cleared after each snapshot)
// ---------------------------------------------------------------------------

let cacheDepth = 0;
let accessibleNameCache: Map<Element, string> | undefined;
let hiddenCache: Map<Element, boolean> | undefined;
let beforePseudoCache: Map<Element, string> | undefined;
let afterPseudoCache: Map<Element, string> | undefined;

function beginCaches() {
  cacheDepth++;
  accessibleNameCache ??= new Map();
  hiddenCache ??= new Map();
  beforePseudoCache ??= new Map();
  afterPseudoCache ??= new Map();
}

function endCaches() {
  if (--cacheDepth === 0) {
    accessibleNameCache = undefined;
    hiddenCache = undefined;
    beforePseudoCache = undefined;
    afterPseudoCache = undefined;
  }
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function tagName(el: Element): string {
  return el instanceof HTMLFormElement ? 'FORM' : el.tagName.toUpperCase();
}

function getParent(el: Element): Element | undefined {
  if (el.parentElement) return el.parentElement;
  const pn = el.parentNode;
  if (pn && pn.nodeType === 11 && (pn as ShadowRoot).host) return (pn as ShadowRoot).host;
  return undefined;
}

function getRootNode(el: Element): Document | ShadowRoot | undefined {
  let node: Node = el;
  while (node.parentNode) node = node.parentNode;
  if (node.nodeType === 11 || node.nodeType === 9) return node as Document | ShadowRoot;
  return undefined;
}

function getOuterShadowHost(el: Element): Element | undefined {
  let node: Element = el;
  while (node.parentElement) node = node.parentElement;
  return getParent(node);
}

function closestAcrossShadow(el: Element | undefined, selector: string): Element | undefined {
  while (el) {
    const match = el.closest(selector);
    if (match) return match;
    el = getOuterShadowHost(el);
  }
  return undefined;
}

function getComputedStyleSafe(
  el: Element,
  pseudo?: string,
): CSSStyleDeclaration | undefined {
  return el.ownerDocument?.defaultView
    ? el.ownerDocument.defaultView.getComputedStyle(el, pseudo)
    : undefined;
}

function resolveIdRefs(el: Element, idList: string | null): Element[] {
  if (!idList) return [];
  const root = getRootNode(el);
  if (!root) return [];
  try {
    const ids = idList.split(' ').filter(Boolean);
    const result: Element[] = [];
    for (const id of ids) {
      const found = root.querySelector('#' + CSS.escape(id));
      if (found && !result.includes(found)) result.push(found);
    }
    return result;
  } catch {
    return [];
  }
}

function cleanText(text: string): string {
  return text.replace(/[\u200b\u00ad]/g, '').trim().replace(/\s+/g, ' ');
}

function trimText(s: string): string {
  return s.trim();
}

function normalizeWhitespace(text: string): string {
  return text
    .split(' ')
    .map((w) =>
      w
        .replace(/\r\n/g, '\n')
        .replace(/[\u200b\u00ad]/g, '')
        .replace(/\s\s*/g, ' '),
    )
    .join(' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Landmark / attribute checks
// ---------------------------------------------------------------------------

const LANDMARK_SELECTOR =
  'article:not([role]), aside:not([role]), main:not([role]), nav:not([role]), section:not([role]), [role=article], [role=complementary], [role=main], [role=navigation], [role=region]';

function hasAriaLabel(el: Element): boolean {
  return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby');
}

const GLOBAL_ARIA_ATTRS: [string, string[] | undefined][] = [
  ['aria-atomic', undefined],
  ['aria-busy', undefined],
  ['aria-controls', undefined],
  ['aria-current', undefined],
  ['aria-describedby', undefined],
  ['aria-details', undefined],
  ['aria-dropeffect', undefined],
  ['aria-flowto', undefined],
  ['aria-grabbed', undefined],
  ['aria-hidden', undefined],
  ['aria-keyshortcuts', undefined],
  [
    'aria-label',
    [
      'caption', 'code', 'deletion', 'emphasis', 'generic',
      'insertion', 'paragraph', 'presentation', 'strong',
      'subscript', 'superscript',
    ],
  ],
  [
    'aria-labelledby',
    [
      'caption', 'code', 'deletion', 'emphasis', 'generic',
      'insertion', 'paragraph', 'presentation', 'strong',
      'subscript', 'superscript',
    ],
  ],
  ['aria-live', undefined],
  ['aria-owns', undefined],
  ['aria-relevant', undefined],
  ['aria-roledescription', ['generic']],
];

function hasGlobalAriaAttr(el: Element, role?: string): boolean {
  return GLOBAL_ARIA_ATTRS.some(
    ([attr, prohibitedRoles]) =>
      !(prohibitedRoles?.includes(role || '')) && el.hasAttribute(attr),
  );
}

function hasTabIndex(el: Element): boolean {
  return !Number.isNaN(Number(String(el.getAttribute('tabindex'))));
}

function isNativeDisabled(el: Element): boolean {
  if (
    !['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'OPTGROUP'].includes(el.tagName)
  ) return false;
  if ((el as HTMLButtonElement).hasAttribute('disabled')) return true;
  const fs = el.closest?.('FIELDSET[DISABLED]');
  if (!fs) return false;
  const legend = fs.querySelector(':scope > LEGEND');
  return !legend || !legend.contains(el);
}

function isFocusable(el: Element): boolean {
  if (isNativeDisabled(el)) return false;
  const tag = tagName(el);
  if (['BUTTON', 'DETAILS', 'SELECT', 'TEXTAREA'].includes(tag)) return true;
  if (tag === 'A' || tag === 'AREA') return el.hasAttribute('href');
  if (tag === 'INPUT') return (el as HTMLInputElement).type !== 'hidden';
  return hasTabIndex(el);
}

// ---------------------------------------------------------------------------
// Valid ARIA roles
// ---------------------------------------------------------------------------

const VALID_ROLES = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote',
  'button', 'caption', 'cell', 'checkbox', 'code', 'columnheader', 'combobox',
  'complementary', 'contentinfo', 'definition', 'deletion', 'dialog',
  'directory', 'document', 'emphasis', 'feed', 'figure', 'form', 'generic',
  'grid', 'gridcell', 'group', 'heading', 'img', 'insertion', 'link', 'list',
  'listbox', 'listitem', 'log', 'main', 'mark', 'marquee', 'math', 'meter',
  'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'navigation', 'none', 'note', 'option', 'paragraph', 'presentation',
  'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup',
  'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider',
  'spinbutton', 'status', 'strong', 'subscript', 'superscript', 'switch',
  'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox', 'time', 'timer',
  'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem',
]);

function getExplicitRole(el: Element): string | null {
  return (el.getAttribute('role') || '')
    .split(' ')
    .map((r) => r.trim())
    .find((r) => VALID_ROLES.has(r)) || null;
}

// ---------------------------------------------------------------------------
// Input-type to role mapping
// ---------------------------------------------------------------------------

const INPUT_TYPE_ROLE: Record<string, string> = {
  button: 'button',
  checkbox: 'checkbox',
  image: 'button',
  number: 'spinbutton',
  radio: 'radio',
  range: 'slider',
  reset: 'button',
  submit: 'button',
};

// ---------------------------------------------------------------------------
// HTML tag to implicit ARIA role mapping
// ---------------------------------------------------------------------------

const IMPLICIT_ROLE_MAP: Record<string, (el: Element) => string | null> = {
  A: (el) => (el.hasAttribute('href') ? 'link' : null),
  AREA: (el) => (el.hasAttribute('href') ? 'link' : null),
  ARTICLE: () => 'article',
  ASIDE: () => 'complementary',
  BLOCKQUOTE: () => 'blockquote',
  BUTTON: () => 'button',
  CAPTION: () => 'caption',
  CODE: () => 'code',
  DATALIST: () => 'listbox',
  DD: () => 'definition',
  DEL: () => 'deletion',
  DETAILS: () => 'group',
  DFN: () => 'term',
  DIALOG: () => 'dialog',
  DT: () => 'term',
  EM: () => 'emphasis',
  FIELDSET: () => 'group',
  FIGURE: () => 'figure',
  FOOTER: (el) => (closestAcrossShadow(el, LANDMARK_SELECTOR) ? null : 'contentinfo'),
  FORM: (el) => (hasAriaLabel(el) ? 'form' : null),
  H1: () => 'heading',
  H2: () => 'heading',
  H3: () => 'heading',
  H4: () => 'heading',
  H5: () => 'heading',
  H6: () => 'heading',
  HEADER: (el) => (closestAcrossShadow(el, LANDMARK_SELECTOR) ? null : 'banner'),
  HR: () => 'separator',
  HTML: () => 'document',
  IMG: (el) =>
    el.getAttribute('alt') === '' &&
    !el.getAttribute('title') &&
    !hasGlobalAriaAttr(el) &&
    !hasTabIndex(el)
      ? 'presentation'
      : 'img',
  INPUT: (el) => {
    const type = (el as HTMLInputElement).type.toLowerCase();
    if (type === 'search') {
      return el.hasAttribute('list') ? 'combobox' : 'searchbox';
    }
    if (['email', 'tel', 'text', 'url', ''].includes(type)) {
      const listId = el.getAttribute('list');
      const refs = resolveIdRefs(el, listId);
      const firstRef = refs[0];
      return firstRef && tagName(firstRef) === 'DATALIST' ? 'combobox' : 'textbox';
    }
    if (type === 'hidden') return null;
    return INPUT_TYPE_ROLE[type] || 'textbox';
  },
  INS: () => 'insertion',
  LI: () => 'listitem',
  MAIN: () => 'main',
  MARK: () => 'mark',
  MATH: () => 'math',
  MENU: () => 'list',
  METER: () => 'meter',
  NAV: () => 'navigation',
  OL: () => 'list',
  OPTGROUP: () => 'group',
  OPTION: () => 'option',
  OUTPUT: () => 'status',
  P: () => 'paragraph',
  PROGRESS: () => 'progressbar',
  SECTION: (el) => (hasAriaLabel(el) ? 'region' : null),
  SELECT: (el) =>
    (el as HTMLSelectElement).hasAttribute('multiple') ||
    (el as HTMLSelectElement).size > 1
      ? 'listbox'
      : 'combobox',
  STRONG: () => 'strong',
  SUB: () => 'subscript',
  SUP: () => 'superscript',
  SVG: () => 'img',
  TABLE: () => 'table',
  TBODY: () => 'rowgroup',
  TD: (el) => {
    const table = closestAcrossShadow(el, 'table');
    const tableRole = table ? getExplicitRole(table) : '';
    return tableRole === 'grid' || tableRole === 'treegrid' ? 'gridcell' : 'cell';
  },
  TEXTAREA: () => 'textbox',
  TFOOT: () => 'rowgroup',
  TH: (el) => {
    if (el.getAttribute('scope') === 'col') return 'columnheader';
    if (el.getAttribute('scope') === 'row') return 'rowheader';
    const table = closestAcrossShadow(el, 'table');
    const tableRole = table ? getExplicitRole(table) : '';
    return tableRole === 'grid' || tableRole === 'treegrid' ? 'gridcell' : 'cell';
  },
  THEAD: () => 'rowgroup',
  TIME: () => 'time',
  TR: () => 'row',
  UL: () => 'list',
};

// Required context (parent chain check for presentational inheritance)
const REQUIRED_CONTEXT: Record<string, string[]> = {
  DD: ['DL', 'DIV'],
  DIV: ['DL'],
  DT: ['DL', 'DIV'],
  LI: ['OL', 'UL'],
  TBODY: ['TABLE'],
  TD: ['TR'],
  TFOOT: ['TABLE'],
  TH: ['TR'],
  THEAD: ['TABLE'],
  TR: ['THEAD', 'TBODY', 'TFOOT', 'TABLE'],
};

// ---------------------------------------------------------------------------
// Role computation
// ---------------------------------------------------------------------------

function shouldNotBePresentational(el: Element, role: string | null): boolean {
  return hasGlobalAriaAttr(el, role || undefined) || isFocusable(el);
}

function getImplicitRole(el: Element): string | null {
  const fn = IMPLICIT_ROLE_MAP[tagName(el)];
  const role = fn?.(el) || '';
  if (!role) return null;

  let node: Element | undefined = el;
  while (node) {
    const parent = getParent(node);
    const ctx = REQUIRED_CONTEXT[tagName(node)];
    if (!ctx || !parent || !ctx.includes(tagName(parent))) break;
    const parentExplicit = getExplicitRole(parent);
    if (
      (parentExplicit === 'none' || parentExplicit === 'presentation') &&
      !shouldNotBePresentational(parent, parentExplicit)
    )
      return parentExplicit;
    node = parent;
  }
  return role;
}

function getEffectiveRole(el: Element): string | null {
  const explicit = getExplicitRole(el);
  if (!explicit) return getImplicitRole(el);
  if (explicit === 'none' || explicit === 'presentation') {
    const implicit = getImplicitRole(el);
    if (shouldNotBePresentational(el, implicit)) return implicit;
  }
  return explicit;
}

// ---------------------------------------------------------------------------
// Visibility / hidden checks used by ARIA
// ---------------------------------------------------------------------------

function isScriptOrStyle(el: Element): boolean {
  return ['STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE'].includes(tagName(el));
}

function isAriaVisible(el: Element, style?: CSSStyleDeclaration): boolean {
  style = style ?? getComputedStyleSafe(el);
  if (!style) return true;
  if (typeof Element.prototype.checkVisibility === 'function') {
    if (!el.checkVisibility()) return false;
  } else {
    const details = el.closest('details,summary');
    if (
      details !== el &&
      details?.nodeName === 'DETAILS' &&
      !(details as HTMLDetailsElement).open
    )
      return false;
  }
  return style.visibility === 'visible';
}

function hasVisibleBounds(node: Node): boolean {
  const range = node.ownerDocument!.createRange();
  range.selectNode(node);
  const rect = range.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isDeepHidden(el: Element): boolean {
  let cached = hiddenCache?.get(el);
  if (cached !== undefined) return cached;

  cached = false;
  // Elements in parent shadow root without assigned slot
  if (
    el.parentElement?.shadowRoot &&
    !(el as HTMLElement).assignedSlot
  ) {
    cached = true;
  }
  if (!cached) {
    const style = getComputedStyleSafe(el);
    cached =
      !style ||
      style.display === 'none' ||
      el.getAttribute('aria-hidden')?.toLowerCase() === 'true';
  }
  if (!cached) {
    const parent = getParent(el);
    if (parent) cached = isDeepHidden(parent);
  }
  hiddenCache?.set(el, cached);
  return cached;
}

function isAriaHidden(el: Element): boolean {
  if (isScriptOrStyle(el)) return true;
  const style = getComputedStyleSafe(el);
  const isSlot = el.nodeName === 'SLOT';

  if (style?.display === 'contents' && !isSlot) {
    // display:contents elements are hidden only if ALL children are hidden
    for (let child = el.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1 && !isAriaHidden(child as Element)) return false;
      if (child.nodeType === 3 && hasVisibleBounds(child)) return false;
    }
    return true;
  }

  if (el.nodeName === 'OPTION' && el.closest('select')) return false;
  if (isSlot) return false;
  if (!isAriaVisible(el, style)) return true;
  return isDeepHidden(el);
}

// ---------------------------------------------------------------------------
// Pseudo-element content
// ---------------------------------------------------------------------------

function getPseudoContent(el: Element, pseudo: '::before' | '::after'): string {
  const cache = pseudo === '::before' ? beforePseudoCache : afterPseudoCache;
  if (cache?.has(el)) return cache.get(el) || '';

  const style = getComputedStyleSafe(el, pseudo);
  let text = '';

  if (style && style.display !== 'none' && style.visibility !== 'hidden') {
    const content = style.content;
    if (
      (content[0] === "'" && content[content.length - 1] === "'") ||
      (content[0] === '"' && content[content.length - 1] === '"')
    ) {
      text = content.substring(1, content.length - 1);
    } else if (content.startsWith('attr(') && content.endsWith(')')) {
      const attrName = content.substring(5, content.length - 1).trim();
      text = el.getAttribute(attrName) || '';
    }
    if (text !== undefined && (style.display || 'inline') !== 'inline') {
      text = ' ' + text + ' ';
    }
  }

  cache?.set(el, text);
  return text;
}

// ---------------------------------------------------------------------------
// Accessible name computation (W3C algorithm)
// ---------------------------------------------------------------------------

interface AccNameContext {
  includeHidden: boolean;
  visitedElements: Set<Element>;
  embeddedInTargetElement?: 'self' | 'descendant';
  embeddedInLabelledBy?: { element: Element; hidden: boolean };
  embeddedInDescribedBy?: { element: Element; hidden: boolean };
  embeddedInLabel?: { element: Element; hidden: boolean };
  embeddedInNativeTextAlternative?: { element: Element; hidden: boolean };
}

function getAriaLabelledByElements(el: Element): Element[] | null {
  const attr = el.getAttribute('aria-labelledby');
  if (attr === null) return null;
  const elements = resolveIdRefs(el, attr);
  return elements.length ? elements : null;
}

const NAME_FROM_CONTENT_ROLES = new Set([
  'button', 'cell', 'checkbox', 'columnheader', 'gridcell', 'heading',
  'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
  'radio', 'row', 'rowheader', 'switch', 'tab', 'tooltip', 'treeitem',
]);

const NAME_FROM_CONTENT_CONTAINER_ROLES = new Set([
  '', 'caption', 'code', 'contentinfo', 'definition', 'deletion',
  'emphasis', 'insertion', 'list', 'listitem', 'mark', 'none',
  'paragraph', 'presentation', 'region', 'row', 'rowgroup', 'section',
  'strong', 'subscript', 'superscript', 'table', 'term', 'time',
]);

function shouldNameFromContent(role: string, isDescendant: boolean): boolean {
  return (
    NAME_FROM_CONTENT_ROLES.has(role) ||
    (isDescendant && NAME_FROM_CONTENT_CONTAINER_ROLES.has(role))
  );
}

const SKIP_NAME_COMPUTATION_ROLES = new Set([
  'caption', 'code', 'definition', 'deletion', 'emphasis', 'generic',
  'insertion', 'mark', 'paragraph', 'presentation', 'strong',
  'subscript', 'suggestion', 'superscript', 'term', 'time',
]);

function computeAccessibleName(el: Element, includeHidden: boolean): string {
  let cached = accessibleNameCache?.get(el);
  if (cached !== undefined) return cached;

  cached = '';
  const role = getEffectiveRole(el) || '';
  if (!SKIP_NAME_COMPUTATION_ROLES.has(role)) {
    cached = normalizeWhitespace(
      computeAccName(el, {
        includeHidden,
        visitedElements: new Set(),
        embeddedInTargetElement: 'self',
      }),
    );
  }
  accessibleNameCache?.set(el, cached);
  return cached;
}

function computeLabelsName(labels: NodeListOf<HTMLLabelElement>, ctx: AccNameContext): string {
  return [...labels]
    .map((label) =>
      computeAccName(label, {
        ...ctx,
        embeddedInLabel: { element: label, hidden: isAriaHidden(label) },
        embeddedInNativeTextAlternative: undefined,
        embeddedInLabelledBy: undefined,
        embeddedInDescribedBy: undefined,
        embeddedInTargetElement: undefined,
      }),
    )
    .filter(Boolean)
    .join(' ');
}

function queryWithOwns(el: Element, selector: string): Element[] {
  const results = [...el.querySelectorAll(selector)];
  for (const owned of resolveIdRefs(el, el.getAttribute('aria-owns'))) {
    if (owned.matches(selector)) results.push(owned);
    results.push(...owned.querySelectorAll(selector));
  }
  return results;
}

function computeAccName(el: Element, ctx: AccNameContext): string {
  if (ctx.visitedElements.has(el)) return '';

  const childCtx: AccNameContext = {
    ...ctx,
    embeddedInTargetElement:
      ctx.embeddedInTargetElement === 'self' ? 'descendant' : ctx.embeddedInTargetElement,
  };

  // Hidden check
  if (!ctx.includeHidden) {
    const isLabelContext =
      !!ctx.embeddedInLabelledBy?.hidden ||
      !!ctx.embeddedInDescribedBy?.hidden ||
      !!ctx.embeddedInNativeTextAlternative?.hidden ||
      !!ctx.embeddedInLabel?.hidden;
    if (isScriptOrStyle(el) || (!isLabelContext && isAriaHidden(el))) {
      ctx.visitedElements.add(el);
      return '';
    }
  }

  // Step 1: aria-labelledby
  const labelledByEls = getAriaLabelledByElements(el);
  if (!ctx.embeddedInLabelledBy) {
    const parts = (labelledByEls || []).map((ref) =>
      computeAccName(ref, {
        ...ctx,
        embeddedInLabelledBy: { element: ref, hidden: isAriaHidden(ref) },
        embeddedInDescribedBy: undefined,
        embeddedInTargetElement: undefined,
        embeddedInLabel: undefined,
        embeddedInNativeTextAlternative: undefined,
      }),
    );
    const joined = parts.join(' ');
    if (joined) return joined;
  }

  const role = getEffectiveRole(el) || '';
  const tag = tagName(el);

  // Step 2: Embedded control value
  if (ctx.embeddedInLabel || ctx.embeddedInLabelledBy || ctx.embeddedInTargetElement === 'descendant') {
    // `labels` only exists on labelable elements (input/button/select/textarea/etc).
    // Cast through an index type so TS stops complaining on plain HTMLElement.
    const labelsOfEl =
      (el as unknown as { labels?: NodeListOf<HTMLLabelElement> | null }).labels;
    const isOwnLabel = [...(labelsOfEl || [])].includes(el as HTMLLabelElement);
    const isOwnLabelledBy = (labelledByEls || []).includes(el);
    if (!isOwnLabel && !isOwnLabelledBy) {
      if (role === 'textbox') {
        ctx.visitedElements.add(el);
        return tag === 'INPUT' || tag === 'TEXTAREA'
          ? (el as HTMLInputElement | HTMLTextAreaElement).value
          : el.textContent || '';
      }
      if (['combobox', 'listbox'].includes(role)) {
        ctx.visitedElements.add(el);
        let options: Element[];
        if (tag === 'SELECT') {
          const sel = el as HTMLSelectElement;
          options = [...sel.selectedOptions];
          if (options.length === 0) {
            const first = sel.options[0];
            if (first) options.push(first);
          }
        } else {
          const listbox =
            role === 'combobox'
              ? queryWithOwns(el, '*').find((c) => getEffectiveRole(c) === 'listbox')
              : el;
          options = listbox
            ? queryWithOwns(listbox, '[aria-selected="true"]').filter(
                (c) => getEffectiveRole(c) === 'option',
              )
            : [];
        }
        if (!options.length && tag === 'INPUT') {
          return (el as HTMLInputElement).value;
        }
        return options.map((o) => computeAccName(o, childCtx)).join(' ');
      }
      if (['progressbar', 'scrollbar', 'slider', 'spinbutton', 'meter'].includes(role)) {
        ctx.visitedElements.add(el);
        if (el.hasAttribute('aria-valuetext')) return el.getAttribute('aria-valuetext') || '';
        if (el.hasAttribute('aria-valuenow')) return el.getAttribute('aria-valuenow') || '';
        return el.getAttribute('value') || '';
      }
      if (role === 'menu') {
        ctx.visitedElements.add(el);
        return '';
      }
    }
  }

  // Step 3: aria-label
  const ariaLabel = el.getAttribute('aria-label') || '';
  if (trimText(ariaLabel)) {
    ctx.visitedElements.add(el);
    return ariaLabel;
  }

  // Step 4: Native text alternatives
  if (!['presentation', 'none'].includes(role)) {
    // Input buttons
    if (tag === 'INPUT' && ['button', 'submit', 'reset'].includes((el as HTMLInputElement).type)) {
      ctx.visitedElements.add(el);
      const val = (el as HTMLInputElement).value || '';
      if (trimText(val)) return val;
      if ((el as HTMLInputElement).type === 'submit') return 'Submit';
      if ((el as HTMLInputElement).type === 'reset') return 'Reset';
      return el.getAttribute('title') || '';
    }
    if (tag === 'INPUT' && (el as HTMLInputElement).type === 'image') {
      ctx.visitedElements.add(el);
      const labels = (el as HTMLInputElement).labels;
      if (labels?.length && !ctx.embeddedInLabelledBy) return computeLabelsName(labels, ctx);
      const alt = el.getAttribute('alt') || '';
      if (trimText(alt)) return alt;
      const title = el.getAttribute('title') || '';
      if (trimText(title)) return title;
      return 'Submit';
    }
    if (!labelledByEls && tag === 'BUTTON') {
      ctx.visitedElements.add(el);
      const labels = (el as HTMLButtonElement).labels;
      if (labels?.length) return computeLabelsName(labels, ctx);
    }
    if (!labelledByEls && tag === 'OUTPUT') {
      ctx.visitedElements.add(el);
      const labels = (el as HTMLOutputElement).labels;
      return labels?.length ? computeLabelsName(labels, ctx) : el.getAttribute('title') || '';
    }
    if (!labelledByEls && (tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'INPUT')) {
      ctx.visitedElements.add(el);
      const labels = (el as HTMLInputElement).labels;
      if (labels?.length) return computeLabelsName(labels, ctx);
      const isTextLike =
        (tag === 'INPUT' &&
          ['text', 'password', 'search', 'tel', 'email', 'url'].includes(
            (el as HTMLInputElement).type,
          )) ||
        tag === 'TEXTAREA';
      const placeholder = el.getAttribute('placeholder') || '';
      const title = el.getAttribute('title') || '';
      if (!isTextLike || title) return title;
      return placeholder;
    }
    if (!labelledByEls && tag === 'FIELDSET') {
      ctx.visitedElements.add(el);
      for (let child = el.firstElementChild; child; child = child.nextElementSibling) {
        if (tagName(child) === 'LEGEND')
          return computeAccName(child, {
            ...childCtx,
            embeddedInNativeTextAlternative: { element: child, hidden: isAriaHidden(child) },
          });
      }
      return el.getAttribute('title') || '';
    }
    if (!labelledByEls && tag === 'FIGURE') {
      ctx.visitedElements.add(el);
      for (let child = el.firstElementChild; child; child = child.nextElementSibling) {
        if (tagName(child) === 'FIGCAPTION')
          return computeAccName(child, {
            ...childCtx,
            embeddedInNativeTextAlternative: { element: child, hidden: isAriaHidden(child) },
          });
      }
      return el.getAttribute('title') || '';
    }
    if (tag === 'IMG') {
      ctx.visitedElements.add(el);
      const alt = el.getAttribute('alt') || '';
      if (trimText(alt)) return alt;
      return el.getAttribute('title') || '';
    }
    if (tag === 'TABLE') {
      ctx.visitedElements.add(el);
      for (let child = el.firstElementChild; child; child = child.nextElementSibling) {
        if (tagName(child) === 'CAPTION')
          return computeAccName(child, {
            ...childCtx,
            embeddedInNativeTextAlternative: { element: child, hidden: isAriaHidden(child) },
          });
      }
      const summary = el.getAttribute('summary') || '';
      if (summary) return summary;
    }
    if (tag === 'AREA') {
      ctx.visitedElements.add(el);
      const alt = el.getAttribute('alt') || '';
      if (trimText(alt)) return alt;
      return el.getAttribute('title') || '';
    }
    if (tag === 'SVG' || (el as SVGElement).ownerSVGElement) {
      ctx.visitedElements.add(el);
      for (let child = el.firstElementChild; child; child = child.nextElementSibling) {
        if (tagName(child) === 'TITLE' && (child as SVGElement).ownerSVGElement)
          return computeAccName(child, {
            ...childCtx,
            embeddedInLabelledBy: { element: child, hidden: isAriaHidden(child) },
          });
      }
    }
    if ((el as SVGElement).ownerSVGElement && tag === 'A') {
      const xlinkTitle = el.getAttribute('xlink:title') || '';
      if (trimText(xlinkTitle)) {
        ctx.visitedElements.add(el);
        return xlinkTitle;
      }
    }
  }

  // Step 5: Name from content
  const isSummary = tag === 'SUMMARY' && !['presentation', 'none'].includes(role);
  if (
    shouldNameFromContent(role, ctx.embeddedInTargetElement === 'descendant') ||
    isSummary ||
    ctx.embeddedInLabelledBy ||
    ctx.embeddedInDescribedBy ||
    ctx.embeddedInLabel ||
    ctx.embeddedInNativeTextAlternative
  ) {
    ctx.visitedElements.add(el);
    const text = computeChildrenText(el, childCtx);
    if (ctx.embeddedInTargetElement === 'self' ? trimText(text) : text) return text;
  }

  // Step 6: title attribute fallback
  if (!['presentation', 'none'].includes(role) || tag === 'IFRAME') {
    ctx.visitedElements.add(el);
    const title = el.getAttribute('title') || '';
    if (trimText(title)) return title;
  }

  ctx.visitedElements.add(el);
  return '';
}

function computeChildrenText(el: Element, ctx: AccNameContext): string {
  const parts: string[] = [];

  const processChild = (child: Node, checkSlotAssignment: boolean) => {
    if (checkSlotAssignment && (child as HTMLElement).assignedSlot) return;
    if (child.nodeType === 1) {
      const childEl = child as Element;
      const display = getComputedStyleSafe(childEl)?.display || 'inline';
      let text = computeAccName(childEl, ctx);
      if (display !== 'inline' || childEl.nodeName === 'BR') text = ' ' + text + ' ';
      parts.push(text);
    } else if (child.nodeType === 3) {
      parts.push(child.textContent || '');
    }
  };

  parts.push(getPseudoContent(el, '::before'));

  const assignedNodes =
    el.nodeName === 'SLOT' ? (el as HTMLSlotElement).assignedNodes() : [];
  if (assignedNodes.length) {
    for (const node of assignedNodes) processChild(node, false);
  } else {
    for (let child = el.firstChild; child; child = child.nextSibling) processChild(child, true);
    if (el.shadowRoot) {
      for (let child = el.shadowRoot.firstChild; child; child = child.nextSibling)
        processChild(child, true);
    }
    for (const owned of resolveIdRefs(el, el.getAttribute('aria-owns')))
      processChild(owned, true);
  }

  parts.push(getPseudoContent(el, '::after'));
  return parts.join('');
}

// ---------------------------------------------------------------------------
// ARIA property extraction
// ---------------------------------------------------------------------------

const CHECKED_ROLES = new Set([
  'checkbox', 'menuitemcheckbox', 'option', 'radio', 'switch', 'menuitemradio', 'treeitem',
]);

function getChecked(el: Element): boolean | 'mixed' | undefined {
  const tag = tagName(el);
  if (tag === 'INPUT' && (el as HTMLInputElement).indeterminate) return 'mixed';
  if (tag === 'INPUT' && ['checkbox', 'radio'].includes((el as HTMLInputElement).type))
    return (el as HTMLInputElement).checked;
  const role = getEffectiveRole(el) || '';
  if (!CHECKED_ROLES.has(role)) return undefined;
  const val = el.getAttribute('aria-checked');
  if (val === 'true') return true;
  if (val === 'mixed') return 'mixed';
  return false;
}

const EXPANDED_ROLES = new Set([
  'application', 'button', 'checkbox', 'combobox', 'gridcell', 'link',
  'listbox', 'menuitem', 'row', 'rowheader', 'tab', 'treeitem',
  'columnheader', 'menuitemcheckbox', 'menuitemradio', 'switch',
]);

function getExpanded(el: Element): boolean | undefined {
  if (tagName(el) === 'DETAILS') return (el as HTMLDetailsElement).open;
  const role = getEffectiveRole(el) || '';
  if (!EXPANDED_ROLES.has(role)) return undefined;
  const val = el.getAttribute('aria-expanded');
  if (val === null) return undefined;
  return val === 'true';
}

const LEVEL_ROLES = new Set(['heading', 'listitem', 'row', 'treeitem']);
const HEADING_LEVELS: Record<string, number> = {
  H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6,
};

function getLevel(el: Element): number {
  const fromTag = HEADING_LEVELS[tagName(el)];
  if (fromTag) return fromTag;
  const role = getEffectiveRole(el) || '';
  if (!LEVEL_ROLES.has(role)) return 0;
  const val = el.getAttribute('aria-level');
  const n = val === null ? NaN : Number(val);
  return Number.isInteger(n) && n >= 1 ? n : 0;
}

const PRESSED_ROLES = new Set(['button']);

function getPressed(el: Element): boolean | 'mixed' {
  const role = getEffectiveRole(el) || '';
  if (!PRESSED_ROLES.has(role)) return false;
  const val = el.getAttribute('aria-pressed');
  if (val === 'true') return true;
  if (val === 'mixed') return 'mixed';
  return false;
}

const SELECTED_ROLES = new Set([
  'gridcell', 'option', 'row', 'tab', 'rowheader', 'columnheader', 'treeitem',
]);

function getSelected(el: Element): boolean {
  if (tagName(el) === 'OPTION') return (el as HTMLOptionElement).selected;
  const role = getEffectiveRole(el) || '';
  if (!SELECTED_ROLES.has(role)) return false;
  return el.getAttribute('aria-selected')?.toLowerCase() === 'true';
}

const DISABLED_ARIA_ROLES = new Set([
  'application', 'button', 'composite', 'gridcell', 'group', 'input',
  'link', 'menuitem', 'scrollbar', 'separator', 'tab', 'checkbox',
  'columnheader', 'combobox', 'grid', 'listbox', 'menu', 'menubar',
  'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'radiogroup',
  'row', 'rowheader', 'searchbox', 'select', 'slider', 'spinbutton',
  'switch', 'tablist', 'textbox', 'toolbar', 'tree', 'treegrid', 'treeitem',
]);

function isAriaDisabled(el: Element | undefined): boolean {
  if (!el) return false;
  const role = getEffectiveRole(el) || '';
  if (DISABLED_ARIA_ROLES.has(role)) {
    const val = (el.getAttribute('aria-disabled') || '').toLowerCase();
    if (val === 'true') return true;
    if (val === 'false') return false;
  }
  return isAriaDisabled(getParent(el));
}

function isDisabled(el: Element): boolean {
  return isNativeDisabled(el) || isAriaDisabled(el);
}

// ---------------------------------------------------------------------------
// ARIA tree node construction
// ---------------------------------------------------------------------------

function buildAriaNode(el: Element): AriaNode | null {
  const role = getEffectiveRole(el);
  if (!role || role === 'presentation' || role === 'none') return null;

  const name = cleanText(computeAccessibleName(el, false) || '');
  const node: AriaNode = {
    role,
    name,
    children: [],
    props: {},
    element: el,
  };

  if (CHECKED_ROLES.has(role)) node.checked = getChecked(el);
  if (DISABLED_ARIA_ROLES.has(role)) node.disabled = isDisabled(el);
  if (EXPANDED_ROLES.has(role)) node.expanded = getExpanded(el);
  if (LEVEL_ROLES.has(role) || HEADING_LEVELS[tagName(el)]) node.level = getLevel(el);
  if (PRESSED_ROLES.has(role)) node.pressed = getPressed(el);
  if (SELECTED_ROLES.has(role)) node.selected = getSelected(el);

  // Input/textarea value becomes child
  if (
    (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
    (el as HTMLInputElement).type !== 'checkbox' &&
    (el as HTMLInputElement).type !== 'radio'
  ) {
    node.children = [(el as HTMLInputElement | HTMLTextAreaElement).value];
  }

  return node;
}

// ---------------------------------------------------------------------------
// Tree builder
// ---------------------------------------------------------------------------

export function buildAriaTree(root: Element, generation: number): AriaSnapshot {
  const visited = new Set<Node>();
  const snapshot: AriaSnapshot = {
    root: {
      role: 'fragment',
      name: '',
      children: [],
      element: root,
      props: {},
    },
    elements: new Map(),
    ids: new Map(),
    generation,
  };

  const registerElement = (el: Element) => {
    const id = getOrAssignId(el);
    snapshot.elements.set(id, el);
    snapshot.ids.set(el, id);
  };
  registerElement(root);

  const walk = (parent: AriaNode, node: Node) => {
    if (visited.has(node)) return;
    visited.add(node);

    if (node.nodeType === Node.TEXT_NODE && node.nodeValue) {
      if (parent.role !== 'textbox' && node.nodeValue) {
        parent.children.push(node.nodeValue);
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = node as Element;
    if (isAriaHidden(el)) return;

    // Collect aria-owns targets
    const ownedElements: Element[] = [];
    if (el.hasAttribute('aria-owns')) {
      for (const id of el.getAttribute('aria-owns')!.split(/\s+/)) {
        const owned = root.ownerDocument.getElementById(id);
        if (owned) ownedElements.push(owned);
      }
    }

    registerElement(el);
    const ariaNode = buildAriaNode(el);
    if (ariaNode) parent.children.push(ariaNode);
    processChildren(ariaNode || parent, el, ownedElements);
  };

  function processChildren(parent: AriaNode, el: Element, ownedElements: Element[] = []) {
    const display = (getComputedStyleSafe(el)?.display || 'inline');
    const isBlock = display !== 'inline' || el.nodeName === 'BR';
    const spacer = isBlock ? ' ' : '';

    if (spacer) parent.children.push(spacer);
    parent.children.push(getPseudoContent(el, '::before'));

    const assignedNodes =
      el.nodeName === 'SLOT' ? (el as HTMLSlotElement).assignedNodes() : [];
    if (assignedNodes.length) {
      for (const child of assignedNodes) walk(parent, child);
    } else {
      for (let child = el.firstChild; child; child = child.nextSibling) {
        if (!(child as HTMLElement).assignedSlot) walk(parent, child);
      }
      if (el.shadowRoot) {
        for (let child = el.shadowRoot.firstChild; child; child = child.nextSibling)
          walk(parent, child);
      }
    }
    for (const owned of ownedElements) walk(parent, owned);

    parent.children.push(getPseudoContent(el, '::after'));
    if (spacer) parent.children.push(spacer);

    // Dedupe: if only child is same as name, clear children
    if (parent.children.length === 1 && parent.name === parent.children[0]) {
      parent.children = [];
    }

    // Add URL for links
    if (parent.role === 'link' && el.hasAttribute('href')) {
      parent.props.url = el.getAttribute('href')!;
    }
  }

  beginCaches();
  try {
    walk(snapshot.root, root);
  } finally {
    endCaches();
  }

  // Post-process: collapse string runs
  collapseStrings(snapshot.root);
  return snapshot;
}

function collapseStrings(node: AriaNode): void {
  const flush = (strings: string[], out: (AriaNode | string)[]) => {
    if (!strings.length) return;
    const joined = cleanText(strings.join(''));
    if (joined) out.push(joined);
    strings.length = 0;
  };

  const process = (n: AriaNode) => {
    const result: (AriaNode | string)[] = [];
    const pending: string[] = [];
    for (const child of n.children || []) {
      if (typeof child === 'string') {
        pending.push(child);
      } else {
        flush(pending, result);
        process(child);
        result.push(child);
      }
    }
    flush(pending, result);
    n.children = result.length ? result : [];
    if (n.children.length === 1 && n.children[0] === n.name) n.children = [];
  };
  process(node);
}

// ---------------------------------------------------------------------------
// YAML serialization
// ---------------------------------------------------------------------------

function needsYamlQuoting(s: string): boolean {
  return !!(
    s.length === 0 ||
    /^\s|\s$/.test(s) ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(s) ||
    /^-/.test(s) ||
    /[\n:](\s|$)/.test(s) ||
    /\s#/.test(s) ||
    /[\n\r]/.test(s) ||
    /^[&*\],?!>|@"'#%]/.test(s) ||
    /[{}`]/.test(s) ||
    /^\[/.test(s) ||
    !isNaN(Number(s)) ||
    ['y', 'n', 'yes', 'no', 'true', 'false', 'on', 'off', 'null'].includes(s.toLowerCase())
  );
}

function yamlQuoteSingle(s: string): string {
  return needsYamlQuoting(s) ? "'" + s.replace(/'/g, "''") + "'" : s;
}

function yamlQuoteDouble(s: string): string {
  if (!needsYamlQuoting(s)) return s;
  return (
    '"' +
    s.replace(/[\\"\x00-\x1f\x7f-\x9f]/g, (ch) => {
      switch (ch) {
        case '\\': return '\\\\';
        case '"': return '\\"';
        case '\b': return '\\b';
        case '\f': return '\\f';
        case '\n': return '\\n';
        case '\r': return '\\r';
        case '\t': return '\\t';
        default: return '\\x' + ch.charCodeAt(0).toString(16).padStart(2, '0');
      }
    }) +
    '"'
  );
}

export function serializeToYaml(snapshot: AriaSnapshot): string {
  const lines: string[] = [];

  const serialize = (
    node: AriaNode | string,
    _parentNode: AriaNode | null,
    indent: string,
  ) => {
    if (typeof node === 'string') {
      const quoted = yamlQuoteDouble(node);
      if (quoted) lines.push(indent + '- text: ' + quoted);
      return;
    }

    let header = node.role;

    // Add name
    if (node.name && node.name.length <= 900) {
      header += ' ' + JSON.stringify(node.name);
    }

    // Add ARIA state props
    if (node.checked === 'mixed') header += ' [checked=mixed]';
    if (node.checked === true) header += ' [checked]';
    if (node.disabled) header += ' [disabled]';
    if (node.expanded) header += ' [expanded]';
    if (node.level) header += ` [level=${node.level}]`;
    if (node.pressed === 'mixed') header += ' [pressed=mixed]';
    if (node.pressed === true) header += ' [pressed]';
    if (node.selected === true) header += ' [selected]';

    // Add ref (stable ID, no generation prefix)
    const elementId = snapshot.ids.get(node.element);
    if (elementId) {
      header += ` [ref=e${elementId}]`;
    }

    const line = indent + '- ' + yamlQuoteSingle(header);
    const hasProps = Object.keys(node.props).length > 0;

    if (!node.children.length && !hasProps) {
      lines.push(line);
    } else if (node.children.length === 1 && typeof node.children[0] === 'string' && !hasProps) {
      lines.push(line + ': ' + yamlQuoteDouble(node.children[0]));
    } else {
      lines.push(line + ':');
      for (const [key, val] of Object.entries(node.props)) {
        lines.push(indent + '  - /' + key + ': ' + yamlQuoteDouble(val));
      }
      for (const child of node.children || []) {
        serialize(child, node, indent + '  ');
      }
    }
  };

  const root = snapshot.root;
  if (root.role === 'fragment') {
    for (const child of root.children || []) serialize(child, root, '');
  } else {
    serialize(root, null, '');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Stable element IDs
// ---------------------------------------------------------------------------

let nextElementId = 1;
const elementIdMap = new WeakMap<Element, number>();

function getOrAssignId(element: Element): number {
  let id = elementIdMap.get(element);
  if (id === undefined) {
    id = nextElementId++;
    elementIdMap.set(element, id);
    element.setAttribute('data-mb-id', String(id));
  }
  return id;
}

// ---------------------------------------------------------------------------
// Viewport intersection check
// ---------------------------------------------------------------------------

function intersectsViewport(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  return (
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  );
}

// ---------------------------------------------------------------------------
// Viewport filtering pass
// ---------------------------------------------------------------------------

function markViewportVisible(node: AriaNode): boolean {
  // Check if this element itself is in the viewport
  let selfVisible = intersectsViewport(node.element);

  // Recursively check children
  for (const child of node.children) {
    if (typeof child !== 'string' && markViewportVisible(child)) {
      selfVisible = true;
    }
  }

  (node as any)._viewportVisible = selfVisible;
  return selfVisible;
}

function pruneInvisible(node: AriaNode): void {
  node.children = node.children.filter((child) => {
    if (typeof child === 'string') return true;
    if (!(child as any)._viewportVisible) return false;
    pruneInvisible(child);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Sibling collapsing: 20+ consecutive same-role siblings => "role x N"
// ---------------------------------------------------------------------------

const COLLAPSE_THRESHOLD = 20;
const COLLAPSE_SHOW = 3;

function collapseSiblings(node: AriaNode): void {
  // Recurse first
  for (const child of node.children) {
    if (typeof child !== 'string') collapseSiblings(child);
  }

  // Find runs of consecutive children with same role
  const newChildren: (AriaNode | string)[] = [];
  let i = 0;
  while (i < node.children.length) {
    const child = node.children[i]!;
    if (typeof child === 'string') {
      newChildren.push(child);
      i++;
      continue;
    }

    // Count consecutive siblings with same role
    let runEnd = i + 1;
    while (runEnd < node.children.length) {
      const sibling = node.children[runEnd]!;
      if (typeof sibling === 'string' || sibling.role !== child.role) break;
      runEnd++;
    }

    const runLength = runEnd - i;
    if (runLength >= COLLAPSE_THRESHOLD) {
      // Keep first COLLAPSE_SHOW, then add a placeholder
      for (let j = i; j < i + COLLAPSE_SHOW; j++) {
        newChildren.push(node.children[j]!);
      }
      const collapsedCount = runLength - COLLAPSE_SHOW;
      const placeholder: AriaNode = {
        role: child.role,
        name: `\u2026 ${collapsedCount} more ${child.role} items`,
        children: [],
        props: {},
        element: child.element,
      };
      newChildren.push(placeholder);
      i = runEnd;
    } else {
      newChildren.push(child as AriaNode);
      i++;
    }
  }
  node.children = newChildren;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let lastSnapshot: AriaSnapshot | undefined;
/** Timestamp of the last full snapshot. Exposed as `baseline_age` in
 *  diff output so callers can judge freshness. */
let lastSnapshotAt = 0;
/** Mode the baseline was captured under. If the caller requests a
 *  different mode, we can't diff (different node populations). */
let lastSnapshotMode: "full" | "viewport" = "viewport";
/** URL at capture time. If the tab has navigated, the id space is
 *  entirely different and a diff is meaningless — fall back to full. */
let lastSnapshotUrl = "";

export type SnapshotMode = "full" | "diff" | "auto";

export interface GenerateAriaSnapshotOptions {
  viewportOnly?: boolean;
  /** full (default) returns the whole tree. diff returns only
   *  added/removed/changed nodes relative to the previous snapshot.
   *  auto prefers diff when a usable baseline exists and the diff is
   *  meaningfully smaller than a full tree, else falls back to full. */
  mode?: SnapshotMode;
}

export interface AriaDiff {
  /** Nodes present in current but not in baseline. */
  added: Array<{ id: number; node: AriaNode }>;
  /** Stable ids present in baseline but not in current. */
  removed: number[];
  /** Nodes whose role/name/state/text-content differs. */
  changed: Array<{ id: number; before: AriaNode; after: AriaNode }>;
  baselineSize: number;
  currentSize: number;
}

// Public re-export of the stable id lookup so callers outside this
// file can compare ids (F2 DOM diff uses this).
export function getElementId(el: Element): number | undefined {
  return elementIdMap.get(el);
}

/**
 * Walk an AriaNode tree and collect every node keyed by its stable id.
 * Nodes whose element has no id are skipped (they can't be diffed).
 */
function collectNodesById(
  root: AriaNode,
  out: Map<number, AriaNode>,
): void {
  const id = elementIdMap.get(root.element);
  if (id !== undefined) out.set(id, root);
  for (const child of root.children) {
    if (typeof child !== "string") collectNodesById(child, out);
  }
}

/**
 * Concatenate all direct text children of a node into a single string.
 * Used for text-change detection at the node level. Nested element
 * children are ignored — they have their own ids and get diffed separately.
 */
function directText(node: AriaNode): string {
  const parts: string[] = [];
  for (const child of node.children) {
    if (typeof child === "string") parts.push(child);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * True if two nodes share every field that isn't direct text. Extracted
 * so `nodesDiffer` and the `onlyTextChanged` fast-path in the
 * serializer stay in sync automatically — historically they drifted
 * because the field list was duplicated in two places.
 */
function sameNonTextFields(a: AriaNode, b: AriaNode): boolean {
  return (
    a.role === b.role &&
    a.name === b.name &&
    a.checked === b.checked &&
    a.disabled === b.disabled &&
    a.expanded === b.expanded &&
    a.level === b.level &&
    a.pressed === b.pressed &&
    a.selected === b.selected
  );
}

/**
 * Return true if two nodes with the same stable id differ in any way
 * that Claude would care about: role, accessible name, boolean state,
 * level, or direct text content. Structural child additions/removals
 * are handled by the id-level diff, not here.
 */
function nodesDiffer(a: AriaNode, b: AriaNode): boolean {
  if (!sameNonTextFields(a, b)) return true;
  if (directText(a) !== directText(b)) return true;
  return false;
}

export function computeAriaDiff(
  baseline: AriaSnapshot,
  current: AriaSnapshot,
): AriaDiff {
  const baseMap = new Map<number, AriaNode>();
  const curMap = new Map<number, AriaNode>();
  collectNodesById(baseline.root, baseMap);
  collectNodesById(current.root, curMap);

  const added: Array<{ id: number; node: AriaNode }> = [];
  const changed: Array<{ id: number; before: AriaNode; after: AriaNode }> = [];
  const removed: number[] = [];

  for (const [id, node] of curMap) {
    const before = baseMap.get(id);
    if (!before) {
      added.push({ id, node });
    } else if (nodesDiffer(before, node)) {
      changed.push({ id, before, after: node });
    }
  }
  for (const id of baseMap.keys()) {
    if (!curMap.has(id)) removed.push(id);
  }

  return {
    added,
    removed,
    changed,
    baselineSize: baseMap.size,
    currentSize: curMap.size,
  };
}

/**
 * Format a single AriaNode as a one-line YAML-ish summary for the diff
 * output. Includes role, accessible name, any state flags, AND the
 * node's direct text content — without text, an added paragraph or
 * listitem would surface in the diff as an empty entry.
 */
function formatNodeLine(id: number, node: AriaNode): string {
  const parts = [`- e${id}: ${node.role}`];
  if (node.name) parts.push(` "${escapeYamlString(node.name)}"`);
  const stateFlags: string[] = [];
  if (node.checked !== undefined) stateFlags.push(`checked=${node.checked}`);
  if (node.disabled) stateFlags.push("disabled");
  if (node.expanded !== undefined) stateFlags.push(`expanded=${node.expanded}`);
  if (node.level !== undefined) stateFlags.push(`level=${node.level}`);
  if (node.pressed !== undefined) stateFlags.push(`pressed=${node.pressed}`);
  if (node.selected !== undefined) stateFlags.push(`selected=${node.selected}`);
  if (stateFlags.length > 0) parts.push(` [${stateFlags.join(", ")}]`);
  const text = directText(node);
  if (text) {
    // Truncate very long text runs so a single blog-post add doesn't
    // blow the diff past the fallback threshold. Use code-point-safe
    // slicing so we don't split a surrogate pair mid-character.
    const truncated = codePointSlice(text, 197);
    const display = truncated.length < text.length ? truncated + "..." : text;
    parts.push(` — "${escapeYamlString(display)}"`);
  }
  return parts.join("");
}

/** Slice a string to at most `n` code points (not UTF-16 code units)
 *  so multi-char emoji / surrogate pairs don't get split in half. */
function codePointSlice(s: string, n: number): string {
  if (s.length <= n) return s; // fast path — no multibyte concern possible
  return Array.from(s).slice(0, n).join("");
}

function escapeYamlString(s: string): string {
  return s.replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Serialize a diff as YAML. Omits empty sections so the payload stays
 * tight when the user made a small change.
 */
export function serializeDiffToYaml(
  diff: AriaDiff,
  baselineAgeMs: number,
): string {
  const lines: string[] = [];
  lines.push("# DOM diff since last snapshot");
  lines.push(`baseline_age_ms: ${baselineAgeMs}`);
  lines.push(`baseline_node_count: ${diff.baselineSize}`);
  lines.push(`current_node_count: ${diff.currentSize}`);
  const unchanged =
    diff.baselineSize -
    diff.removed.length -
    diff.changed.length;
  lines.push(`unchanged_node_count: ${unchanged}`);

  if (diff.added.length > 0) {
    lines.push("added:");
    for (const { id, node } of diff.added) {
      lines.push(`  ${formatNodeLine(id, node)}`);
    }
  }

  if (diff.removed.length > 0) {
    lines.push("removed:");
    for (const id of diff.removed) {
      lines.push(`  - e${id}`);
    }
  }

  if (diff.changed.length > 0) {
    lines.push("changed:");
    for (const { id, before, after } of diff.changed) {
      // Compact "before → after" representation when only text changed,
      // otherwise emit both full lines.
      const beforeText = directText(before);
      const afterText = directText(after);
      // Uses the shared `sameNonTextFields` helper so a future addition
      // to `nodesDiffer`'s field set can't silently get hidden behind
      // the text-only compact format.
      const onlyTextChanged = sameNonTextFields(before, after);
      if (onlyTextChanged && beforeText !== afterText) {
        lines.push(
          `  - e${id}: "${escapeYamlString(beforeText)}" → "${escapeYamlString(
            afterText,
          )}"`,
        );
      } else {
        lines.push(`  ${formatNodeLine(id, before)}`);
        lines.push(`    → ${formatNodeLine(id, after).slice(2)}`);
      }
    }
  }

  if (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0
  ) {
    lines.push("# no changes since last snapshot");
  }

  return lines.join("\n");
}

// Diff fallback thresholds (codex recommendation):
//  - If > 25% of baseline nodes changed structurally → diff is too big
//  - If serialized diff length > 50% of baseline full-snapshot length → not worth it
const DIFF_NODE_CHANGE_RATIO = 0.25;
const DIFF_SIZE_RATIO = 0.5;

function isDiffWorthwhile(
  diff: AriaDiff,
  diffYamlLength: number,
  baselineYamlLength: number,
): boolean {
  const totalChanges = diff.added.length + diff.removed.length + diff.changed.length;
  if (diff.baselineSize === 0) return false;
  const ratio = totalChanges / diff.baselineSize;
  if (ratio > DIFF_NODE_CHANGE_RATIO) return false;
  if (diffYamlLength > baselineYamlLength * DIFF_SIZE_RATIO) return false;
  return true;
}

export function generateAriaSnapshot(options?: GenerateAriaSnapshotOptions): string {
  const mode: SnapshotMode = options?.mode ?? "full";
  const wantViewport = options?.viewportOnly ?? false;
  const captureMode: "full" | "viewport" = wantViewport ? "viewport" : "full";
  const currentUrl =
    typeof location !== "undefined" ? location.href : "";

  // Stash previous snapshot for possible diff. We must do this BEFORE
  // we overwrite lastSnapshot with the new tree.
  const previousSnapshot = lastSnapshot;
  const previousAt = lastSnapshotAt;
  const previousMode = lastSnapshotMode;
  const previousUrl = lastSnapshotUrl;

  const generation = ((previousSnapshot?.generation) ?? 0) + 1;
  const newSnapshot = buildAriaTree(document.documentElement, generation);

  if (wantViewport) {
    markViewportVisible(newSnapshot.root);
    pruneInvisible(newSnapshot.root);
    collapseSiblings(newSnapshot.root);
    collapseStrings(newSnapshot.root);
  }

  // Always update the baseline first — even if we return a diff, the
  // baseline for the NEXT call should be this new tree.
  lastSnapshot = newSnapshot;
  lastSnapshotAt = Date.now();
  lastSnapshotMode = captureMode;
  lastSnapshotUrl = currentUrl;

  // Can we even consider a diff?
  const canDiff =
    mode !== "full" &&
    previousSnapshot !== undefined &&
    previousMode === captureMode &&
    previousUrl === currentUrl;

  // Explicit header line so callers (and Claude) can always tell at a
  // glance whether they got a full tree or a diff, without guessing
  // from the content.
  const FULL_HEADER = "# full snapshot";

  if (!canDiff) {
    return `${FULL_HEADER}\n${serializeToYaml(newSnapshot)}`;
  }

  const diff = computeAriaDiff(previousSnapshot!, newSnapshot);
  const diffYaml = serializeDiffToYaml(diff, Date.now() - previousAt);

  if (mode === "diff") {
    // Explicit diff requested — return it even if it's not smaller.
    return diffYaml;
  }

  // mode === "auto": compare diff size against the CURRENT full
  // snapshot size (not the previous one — the tree may have grown
  // or shrunk). Always serialize full first so the comparison is
  // apples-to-apples, then decide which to return.
  const currentFullYaml = serializeToYaml(newSnapshot);
  if (isDiffWorthwhile(diff, diffYaml.length, currentFullYaml.length)) {
    return diffYaml;
  }
  return `${FULL_HEADER}\n${currentFullYaml}`;
}

export function getLastSnapshot(): AriaSnapshot | undefined {
  return lastSnapshot;
}

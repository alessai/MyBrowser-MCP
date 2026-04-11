// CSS selector generation for DOM elements.
// Ported from the original Browser MCP content script.

import {
  querySelectorAllDeep,
  getParentElement,
  getAncestors,
  getChildren,
} from './element-utils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeTag(el: Element): string {
  return CSS.escape(el.tagName.toLowerCase());
}

function getSiblings(el: Element): Element[] {
  const parent = el.parentNode;
  if (!parent) throw new Error('Unable to get parent');
  return getChildren(parent);
}

/** Build nth-of-type selector for an element. */
function nthOfType(el: Element): string {
  const index =
    getSiblings(el)
      .filter((s) => s.tagName === el.tagName)
      .findIndex((s) => s === el) + 1;
  return `${escapeTag(el)}:nth-of-type(${index})`;
}

/** Get shadow DOM connector between parent and child. */
function getConnector(parent: Element, child: Element): string {
  if (parent.shadowRoot?.contains(child)) return ' >>> ';
  if (!parent.contains(child)) throw new Error('Parent does not contain descendant');
  return child.parentElement === parent ? ' > ' : ' ';
}

/** Join a prefix and local selector with >>> if needed. */
function joinSelectors(prefix: string, local: string): string {
  if (!local) throw new Error('Missing local selector');
  return prefix ? `${prefix} >>> ${local}` : local;
}

// ---------------------------------------------------------------------------
// Character classification for ID quality check
// ---------------------------------------------------------------------------

type CharType = 'lower' | 'upper' | 'digit' | 'other';

function charType(ch: string): CharType {
  if (ch >= 'a' && ch <= 'z') return 'lower';
  if (ch >= 'A' && ch <= 'Z') return 'upper';
  if (ch >= '0' && ch <= '9') return 'digit';
  return 'other';
}

function countTransitions(s: string): number {
  if (s.length === 0) return 0;
  let transitions = 0;
  let prev = charType(s[0]!);
  for (let i = 1; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '-' || ch === '_') continue;
    const ct = charType(ch);
    if (ct !== prev) {
      transitions++;
      prev = ct;
    }
  }
  return transitions;
}

function isGoodId(
  id: string,
  opts: { disallowedTypes?: CharType[] } = {},
): boolean {
  const { disallowedTypes = [] } = opts;
  for (const ch of id) {
    if (disallowedTypes.includes(charType(ch))) return false;
  }
  return id.length / countTransitions(id) > 4;
}

// ---------------------------------------------------------------------------
// CSS value escaping / cleaning
// ---------------------------------------------------------------------------

function cleanCssValue(value: string, opts: { removeNumbers?: boolean } = {}): string {
  if (opts.removeNumbers && /\d/.test(value)) {
    const longestNonNumericWord = extractLongestNonNumeric(value);
    if (longestNonNumericWord.length > 0) value = longestNonNumericWord;
  }
  return CSS.escape(value).replace(/\\ /g, ' ');
}

function extractLongestNonNumeric(text: string): string {
  // Try word-boundary split first
  const words = text.split(/\b\w*\d\w*\b/).map((s) => s.trim()).filter(Boolean);
  const candidates = words.length > 0 ? words : text.split(/\d+/).map((s) => s.trim()).filter(Boolean);
  return candidates.reduce((longest, w) => (w.length > longest.length ? w : longest), '');
}

function isAllDigits(value: string): boolean {
  return value.split(/\s+/).every((w) => /\d/.test(w));
}

function buildAttrSelector(attr: string, value: string, opts: { removeNumbers?: boolean } = {}): string {
  const cleaned = cleanCssValue(value, opts);
  if (opts.removeNumbers && /\d/.test(value)) {
    return `[${attr}*="${cleaned}"]`;
  }
  return `[${attr}="${cleaned}"]`;
}

// ---------------------------------------------------------------------------
// Candidate selector strategies
// ---------------------------------------------------------------------------

function dataTestSelectors(el: Element): string[] {
  return Array.from(el.attributes)
    .filter((a) => a.name.startsWith('data-test'))
    .map((a) => buildAttrSelector(a.name, a.value, { removeNumbers: true }));
}

function idSelector(el: Element): string {
  const id = el.getAttribute('id');
  if (!id || !isGoodId(id, { disallowedTypes: ['digit'] })) return '';
  return `#${CSS.escape(id)}`;
}

function classSelectors(el: Element): string[] {
  const hoverClasses =
    el instanceof HTMLElement || el instanceof SVGElement
      ? (el.dataset['hoverClass'] || '').split(/\s+/)
      : [];
  const clickClasses =
    el instanceof HTMLElement || el instanceof SVGElement
      ? (el.dataset['clickClass'] || '').split(/\s+/)
      : [];
  const exclude = [...hoverClasses, ...clickClasses];
  return Array.from(el.classList)
    .filter((c) => !exclude.includes(c))
    .map((c) => `.${CSS.escape(c)}`);
}

function attributeSelectors(el: Element): string[] {
  const attrs = [
    'aria-label', 'aria-labelledby', 'role', 'tabindex',
    'title', 'name', 'placeholder', 'type', 'alt',
  ];
  const tag = escapeTag(el);
  return attrs.reduce<string[]>((acc, attr) => {
    const val = el.getAttribute(attr);
    if (!val || isAllDigits(val)) return acc;
    const selectors = [buildAttrSelector(attr, val, { removeNumbers: true })];
    // For aria-label, also try prefix match
    if (attr === 'aria-label') {
      const words = cleanCssValue(val).split(/\s+/);
      if (words.length > 1) {
        selectors.push(`[${attr}^="${words[0]}"]`);
      }
    }
    return [...acc, ...selectors.map((s) => `${tag}${s}`)];
  }, []);
}

function textSelector(el: Element): string {
  if (!(el instanceof HTMLElement)) return '';
  const isButton =
    el instanceof HTMLButtonElement || el.getAttribute('role') === 'button';
  const isLink = el instanceof HTMLAnchorElement;
  if (!isButton && !isLink) return '';
  const text = el.innerText;
  if (!text.length) return '';
  const words = text
    .split(/\s+/)
    .filter((w) => !/\d/.test(w))
    .filter((w) => !w.includes('.'));
  if (words.length === 0 || words.length > 3) return '';
  const tag = escapeTag(el);
  const roleAttr = el.getAttribute('role') === 'button' ? '[role="button"]' : '';
  const cleaned = cleanCssValue(text, { removeNumbers: true });
  // :contains() is not standard CSS — skip text-based selectors
  // (they would fail in querySelectorAll)
  return '';
}

/** Generate candidate selectors for an element, ordered by preference. */
function getCandidateSelectors(el: Element): string[] {
  return [
    ...dataTestSelectors(el),
    textSelector(el),
    ...attributeSelectors(el),
    idSelector(el),
    ...classSelectors(el),
  ].filter(Boolean);
}

// ---------------------------------------------------------------------------
// Full selector path construction
// ---------------------------------------------------------------------------

function buildFullPath(el: Element, opts: { ancestorSelector?: string } = {}): string {
  const { ancestorSelector } = opts;
  const chain = [el, ...getAncestors(el, true)];
  let path = '';

  for (let i = 0; i < chain.length; i++) {
    const current = chain[i];
    if (!current) continue;
    const prev = i > 0 ? chain[i - 1] : null;
    const connector = prev ? getConnector(current, prev) : '';

    if (ancestorSelector && matchesSelector(current, ancestorSelector)) {
      return prev ? `${ancestorSelector}${connector}${path}` : ancestorSelector;
    }

    const segment = nthOfType(current);
    path = prev ? `${segment}${connector}${path}` : segment;
  }
  return path;
}

function matchesSelector(el: Element, selector: string): boolean {
  try {
    const parts = selector.split('>>>');
    if (parts.length === 1) return el.matches(selector);
    // For shadow-piercing selectors, check via querySelectorAllDeep
    return querySelectorAllDeep(selector).includes(el);
  } catch {
    return false;
  }
}

function arraysEqual(a: Element[], b: Element[]): boolean {
  return a.length === b.length && a.every((el) => b.includes(el));
}

// ---------------------------------------------------------------------------
// Selector shortening
// ---------------------------------------------------------------------------

const MAX_COMBINATIONS = 1000;

function cartesianProduct(arrays: string[][]): string[][] {
  const result: string[][] = [];
  const build = (arr: string[][], current: string[], depth: number) => {
    if (depth === arr.length) {
      result.push([...current]);
      return;
    }
    const level = arr[depth];
    if (!level) return;
    for (const item of level) {
      current.push(item);
      build(arr, current, depth + 1);
      current.pop();
      if (result.length >= MAX_COMBINATIONS) break;
    }
  };
  build(arrays, [], 0);
  return result;
}

function shortenSelector(
  fullSelector: string,
  prefix: string,
  opts: {
    ancestorSelector?: string;
    limit?: number;
  },
): string[] {
  const { ancestorSelector, limit = 1 } = opts;
  const combined = joinSelectors(prefix, fullSelector);
  const elements = querySelectorAllDeep(combined);
  if (elements.length === 0) throw new Error(`Unable to get elements: ${fullSelector}`);

  if (ancestorSelector) {
    const ancestorEls = querySelectorAllDeep(ancestorSelector);
    if (arraysEqual(ancestorEls, elements)) return [ancestorSelector];
  }

  const target = elements[0];
  if (!target) throw new Error(`Unable to get elements: ${fullSelector}`);
  const chain: Element[] = [target, ...getAncestors(target, false)];
  const segments = fullSelector.split('>').map((s) => s.trim()).reverse();

  const results: string[] = [];
  const candidatesPerLevel: string[][] = [];
  const usedSets: Set<string>[] = [];

  const resolveFrom = (startIdx: number): Element[] => {
    const partial = segments.slice(startIdx).reverse().join(' > ');
    return querySelectorAllDeep(joinSelectors(prefix, partial));
  };

  const endIdx = ancestorSelector
    ? chain.findIndex((el) => matchesSelector(el, ancestorSelector))
    : segments.length;
  const maxDepth = endIdx !== -1 ? endIdx : segments.length;

  for (let depth = 0; results.length < limit && depth < maxDepth; depth++) {
    const segment = segments[depth];
    const current = chain[depth];
    if (segment === undefined || current === undefined) break;
    const candidates: string[] = [...getCandidateSelectors(current), segment];

    const contextElements = resolveFrom(depth);

    // Filter candidates that still resolve to the same elements
    const validCandidates = candidates.filter((candidate) => {
      const rest = segments.slice(depth + 1).reverse().join(' > ');
      const partial = rest ? `${rest} > ${candidate}` : candidate;
      const fullCheck = joinSelectors(prefix, partial);
      return arraysEqual(querySelectorAllDeep(fullCheck), contextElements);
    });

    // If multiple siblings of same type, drop the base nth-of-type if we have alternatives
    if (
      getSiblings(current).filter((s) => s.tagName === current.tagName).length > 1 &&
      validCandidates.length > 1
    ) {
      const baseIdx = validCandidates.indexOf(segment);
      if (baseIdx !== -1) validCandidates.splice(baseIdx, 1);
    }

    candidatesPerLevel[depth] = validCandidates;

    const combos = cartesianProduct(candidatesPerLevel);
    if (combos.length >= MAX_COMBINATIONS && results.length > 0) break;

    for (let ci = 0; results.length < limit && ci < combos.length; ci++) {
      const combo = combos[ci];
      if (!combo) continue;
      const selector = [...combo].reverse().join(' > ');

      let fullCheck: string;
      if (ancestorSelector) {
        const anchor = chain[Math.min(depth, chain.length - 1)] ?? current;
        const connector = getConnector(anchor, current);
        fullCheck = `${ancestorSelector}${connector}${selector}`;
      } else {
        fullCheck = joinSelectors(prefix, selector);
      }

      const resolved = querySelectorAllDeep(fullCheck);
      const isUnique = combo.every((s, level) => {
        const used = usedSets[level];
        return !used || !used.has(s);
      });

      if (arraysEqual(resolved, elements) && isUnique) {
        const finalSelector = ancestorSelector
          ? fullCheck
          : selector;
        results.push(finalSelector);
        combo.forEach((s, level) => {
          let used = usedSets[level];
          if (!used) {
            used = new Set();
            usedSets[level] = used;
          }
          used.add(s);
          if (used.size === candidatesPerLevel[level]?.length) {
            usedSets[level] = new Set();
          }
        });
      }
    }

    candidatesPerLevel[depth] = validCandidates.slice(0, limit);
  }

  if (results.length === 0) throw new Error(`Unable to shorten selector: ${fullSelector}`);
  return results.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a unique CSS selector for an element.
 * Supports shadow DOM via >>> piercing syntax.
 */
export function generateSelector(el: Element, opts: { ancestorSelector?: string } = {}): string {
  const fullPath = buildFullPath(el, opts);

  // Split by shadow boundaries
  const shadowParts = fullPath.split(' >>> ');
  let prefix = '';

  for (let i = 0; i < shadowParts.length; i++) {
    const part = shadowParts[i];
    if (part === undefined) continue;
    const isLast = i === shadowParts.length - 1;
    const shortened = shortenSelector(part, prefix, {
      ancestorSelector: i === 0 ? opts.ancestorSelector : undefined,
      limit: 1,
    });
    const first = shortened[0];
    if (first === undefined) continue;

    if (isLast) {
      return first;
    } else {
      prefix = joinSelectors(prefix, first);
    }
  }

  return fullPath;
}

/**
 * Validate that a selector resolves to the expected element.
 */
export function validateSelector(selector: string, expected: Element): boolean {
  const results = querySelectorAllDeep(selector);
  return results.length === 1 && results[0] === expected;
}

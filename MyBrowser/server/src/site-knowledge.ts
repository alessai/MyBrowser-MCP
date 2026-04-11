import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PageElement {
  selector: string;
  role?: string;
  name?: string;
  stable: boolean;
}

export interface PageModel {
  urlPattern: string;
  elements: Record<string, PageElement>;
  lastUpdated: number;
}

export interface SiteKnowledge {
  domain: string;
  pages: Record<string, PageModel>;
  flows: Record<string, string[]>;
  quirks: string[];
  lastVisited: number;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const MYBROWSER_DIR = join(homedir(), ".mybrowser");
const SITES_DIR = join(MYBROWSER_DIR, "sites");

// ---------------------------------------------------------------------------
// Directory setup (called once at startup)
// ---------------------------------------------------------------------------

export function ensureDirectories(): void {
  mkdirSync(SITES_DIR, { recursive: true });
  mkdirSync(join(MYBROWSER_DIR, "recordings"), { recursive: true });
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

function siteFile(domain: string): string {
  // Sanitize domain to safe filename
  const safe = domain.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(SITES_DIR, `${safe}.json`);
}

export function loadSiteKnowledge(domain: string): SiteKnowledge | null {
  const file = siteFile(domain);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf-8");
    return JSON.parse(raw) as SiteKnowledge;
  } catch {
    return null;
  }
}

export function saveSiteKnowledge(domain: string, knowledge: SiteKnowledge): void {
  mkdirSync(SITES_DIR, { recursive: true });
  const file = siteFile(domain);
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(knowledge, null, 2) + "\n");
  renameSync(tmp, file);
}

export function getSiteKnowledge(domain: string): SiteKnowledge | null {
  return loadSiteKnowledge(domain);
}

// ---------------------------------------------------------------------------
// Update helpers
// ---------------------------------------------------------------------------

export function updatePageModel(
  domain: string,
  pageName: string,
  model: {
    urlPattern: string;
    elements: Record<string, PageElement>;
  },
): SiteKnowledge {
  let knowledge = loadSiteKnowledge(domain);
  if (!knowledge) {
    knowledge = {
      domain,
      pages: {},
      flows: {},
      quirks: [],
      lastVisited: Date.now(),
    };
  }

  const existing = knowledge.pages[pageName];
  if (existing) {
    // Merge elements: keep existing ones, update with new
    knowledge.pages[pageName] = {
      urlPattern: model.urlPattern || existing.urlPattern,
      elements: { ...existing.elements, ...model.elements },
      lastUpdated: Date.now(),
    };
  } else {
    knowledge.pages[pageName] = {
      urlPattern: model.urlPattern,
      elements: model.elements,
      lastUpdated: Date.now(),
    };
  }

  knowledge.lastVisited = Date.now();
  saveSiteKnowledge(domain, knowledge);
  return knowledge;
}

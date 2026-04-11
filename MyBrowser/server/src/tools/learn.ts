import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool } from "./types.js";
import {
  updatePageModel,
  getSiteKnowledge,
  type PageElement,
} from "../site-knowledge.js";

// ---------------------------------------------------------------------------
// browser_learn — trigger POM generation for current page
// ---------------------------------------------------------------------------

const LearnArgs = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses the active tab."),
  pageName: z
    .string()
    .optional()
    .describe(
      "Name for this page model (e.g. 'homepage', 'search', 'login'). If omitted, derived from page title.",
    ),
});

export const learn: Tool = {
  schema: {
    name: "browser_learn",
    description:
      "Learn the current page's interactive elements and save a Page Object Model. Captures all interactive elements with stable CSS selectors. Results are persisted to ~/.mybrowser/sites/{domain}.json for future reference.",
    inputSchema: zodToJsonSchema(LearnArgs),
  },
  handle: async (context, params) => {
    const validated = LearnArgs.parse(params);
    const { tabId, pageName } = validated;

    // Ask the extension to generate a page model
    const payload = tabId !== undefined ? { tabId } : {};
    const model = (await context.sendSocketMessage("generatePageModel", payload)) as {
      url: string;
      title: string;
      elements: Record<string, { selector: string; role: string; name: string }>;
    };

    // Extract domain from URL
    let domain: string;
    try {
      domain = new URL(model.url).hostname;
    } catch {
      return {
        content: [{ type: "text" as const, text: "Could not determine domain from current page URL." }],
        isError: true,
      };
    }

    // Derive page name if not provided
    const name =
      pageName ||
      model.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "")
        .slice(0, 40) ||
      "unnamed";

    // Build URL pattern from current URL (strip query params, replace dynamic path segments with regex)
    const url = new URL(model.url);
    const urlPattern = `^${url.origin}${url.pathname.replace(/\/\d+/g, "/\\d+")}`;

    // Convert to PageElement format
    const elements: Record<string, PageElement> = {};
    for (const [key, value] of Object.entries(model.elements)) {
      elements[key] = {
        selector: value.selector,
        role: value.role || undefined,
        name: value.name || undefined,
        stable: true,
      };
    }

    const knowledge = updatePageModel(domain, name, { urlPattern, elements });

    const elementCount = Object.keys(elements).length;
    const pageCount = Object.keys(knowledge.pages).length;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              status: "learned",
              domain,
              pageName: name,
              elementsFound: elementCount,
              totalPagesKnown: pageCount,
              elements: model.elements,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// browser_site_info — return site knowledge for a domain
// ---------------------------------------------------------------------------

const SiteInfoArgs = z.object({
  tabId: z.number().optional().describe("Target tab ID. If omitted, uses the active tab."),
  domain: z
    .string()
    .optional()
    .describe("Domain to look up (e.g. 'github.com'). If omitted, uses the current tab's domain."),
});

export const siteInfo: Tool = {
  schema: {
    name: "browser_site_info",
    description:
      "Return stored site knowledge for a domain, including known pages, element maps, flows, and quirks. Uses previously learned Page Object Models from browser_learn.",
    inputSchema: zodToJsonSchema(SiteInfoArgs),
  },
  handle: async (context, params) => {
    const validated = SiteInfoArgs.parse(params);
    let { domain } = validated;

    // If no domain provided, get it from current tab
    if (!domain) {
      const payload = validated.tabId !== undefined ? { tabId: validated.tabId } : {};
      const url = (await context.sendSocketMessage("getUrl", payload)) as string;
      try {
        domain = new URL(url).hostname;
      } catch {
        return {
          content: [{ type: "text" as const, text: "Could not determine domain from current page URL." }],
          isError: true,
        };
      }
    }

    const knowledge = getSiteKnowledge(domain);
    if (!knowledge) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { domain, known: false, message: `No site knowledge found for ${domain}. Use browser_learn to capture page models.` },
              null,
              2,
            ),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ known: true, ...knowledge }, null, 2),
        },
      ],
    };
  },
};

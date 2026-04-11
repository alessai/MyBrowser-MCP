import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool } from "./types.js";
import type { IStateManager, NoteMetadata } from "../state-manager.js";

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatMetadataLine(m: NoteMetadata): string {
  const age = timeSince(m.createdAt);
  const notePreview =
    m.note.length > 80 ? m.note.slice(0, 77) + "..." : m.note;
  const resolved = m.resolution ? ` [resolved: ${m.resolution}]` : "";
  return `  ${m.id}  (${age})  ${m.url}\n    "${notePreview}"${resolved}`;
}

function timeSince(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// ---------------------------------------------------------------------------
// Factory — all 5 tools share a closed-over IStateManager so in client mode
// they transparently proxy through the hub RPC.
// ---------------------------------------------------------------------------

export function createNotesTools(sm: IStateManager): {
  notesList: Tool;
  notesGet: Tool;
  notesArchive: Tool;
  notesUnarchive: Tool;
  notesDelete: Tool;
} {

// ---------------------------------------------------------------------------
// browser_notes_list
// ---------------------------------------------------------------------------

const ListArgs = z.object({
  status: z
    .enum(["pending", "archived", "all"])
    .optional()
    .default("pending")
    .describe(
      "Which notes to list. Default 'pending' — notes the user has saved but not yet been addressed.",
    ),
});

const notesList: Tool = {
  schema: {
    name: "browser_notes_list",
    description:
      "List annotated notes the user has saved via the browser extension. Each note is an annotated screenshot plus a text comment. Default returns pending notes only. Use this to see what visual feedback the user has left for you to work through.",
    inputSchema: zodToJsonSchema(ListArgs),
  },
  handle: async (_context, params) => {
    const args = ListArgs.parse(params ?? {});
    const notes = await sm.notesList(args.status);
    if (notes.length === 0) {
      const scope = args.status === "all" ? "" : ` ${args.status}`;
      return {
        content: [{ type: "text", text: `No${scope} notes.` }],
      };
    }
    const header = `${notes.length} ${args.status} note${notes.length === 1 ? "" : "s"}:`;
    const body = notes.map(formatMetadataLine).join("\n");
    const hint =
      args.status === "pending"
        ? "\n\nUse browser_notes_get to fetch full image, then browser_notes_archive once resolved."
        : "";
    return {
      content: [{ type: "text", text: `${header}\n${body}${hint}` }],
    };
  },
};

// ---------------------------------------------------------------------------
// browser_notes_get
// ---------------------------------------------------------------------------

const GetArgs = z.object({
  id: z.string().describe("The note ID (from browser_notes_list)"),
});

const notesGet: Tool = {
  schema: {
    name: "browser_notes_get",
    description:
      "Fetch a single note with its full-resolution annotated screenshot. The image includes any arrows, boxes, and text the user drew on the page.",
    inputSchema: zodToJsonSchema(GetArgs),
  },
  handle: async (_context, params) => {
    const args = GetArgs.parse(params);
    const note = await sm.notesGet(args.id);
    if (!note) {
      return {
        content: [{ type: "text", text: `Note "${args.id}" not found.` }],
        isError: true,
      };
    }
    const m = note.metadata;
    const lines = [
      `Note ${m.id} (${m.status})`,
      `URL: ${m.url}`,
      `Title: ${m.title}`,
      `Created: ${m.createdAt}`,
      `User note: ${m.note}`,
    ];
    if (m.viewport) {
      lines.push(
        `Viewport: ${m.viewport.width}x${m.viewport.height} @${m.viewport.dpr}x, scroll (${m.viewport.scrollX}, ${m.viewport.scrollY})`,
      );
    }
    if (m.nearestElement?.ref) {
      const el = m.nearestElement;
      const parts = [el.ref];
      if (el.role) parts.push(`role=${el.role}`);
      if (el.name) parts.push(`name="${el.name}"`);
      lines.push(`Nearest element: ${parts.join(" ")}`);
    }
    if (m.resolution) lines.push(`Resolution: ${m.resolution}`);
    return {
      content: [
        { type: "text", text: lines.join("\n") },
        { type: "image", data: note.pngBase64, mimeType: "image/png" },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// browser_notes_archive
// ---------------------------------------------------------------------------

const ArchiveArgs = z.object({
  id: z.string().describe("The note ID to archive"),
  resolution: z
    .string()
    .optional()
    .describe(
      "Optional short note about how this was resolved (e.g. 'fixed button alignment in Header.tsx'). Preserved on the archived note for audit.",
    ),
});

const notesArchive: Tool = {
  schema: {
    name: "browser_notes_archive",
    description:
      "Mark a note as archived (hidden from the default pending list). Use this after you've addressed the user's feedback so the next agent doesn't see stale items.",
    inputSchema: zodToJsonSchema(ArchiveArgs),
  },
  handle: async (_context, params) => {
    const args = ArchiveArgs.parse(params);
    const result = await sm.notesArchive(args.id, args.resolution);
    if (!result) {
      return {
        content: [{ type: "text", text: `Note "${args.id}" not found.` }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Archived ${result.id}${args.resolution ? ` — ${args.resolution}` : ""}`,
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// browser_notes_unarchive
// ---------------------------------------------------------------------------

const UnarchiveArgs = z.object({
  id: z.string().describe("The note ID to restore to pending"),
});

const notesUnarchive: Tool = {
  schema: {
    name: "browser_notes_unarchive",
    description:
      "Restore an archived note to pending status so it shows up in the default list again.",
    inputSchema: zodToJsonSchema(UnarchiveArgs),
  },
  handle: async (_context, params) => {
    const args = UnarchiveArgs.parse(params);
    const result = await sm.notesUnarchive(args.id);
    if (!result) {
      return {
        content: [{ type: "text", text: `Note "${args.id}" not found.` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `Restored ${result.id} to pending.` }],
    };
  },
};

// ---------------------------------------------------------------------------
// browser_notes_delete
// ---------------------------------------------------------------------------

const DeleteArgs = z.object({
  id: z.string().describe("The note ID to permanently delete"),
  force: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Required to delete a pending note. Archived notes can always be deleted.",
    ),
});

const notesDelete: Tool = {
  schema: {
    name: "browser_notes_delete",
    description:
      "Permanently delete a note (both metadata and PNG). Archived notes can be deleted without force; pending notes require force=true to protect unreviewed feedback.",
    inputSchema: zodToJsonSchema(DeleteArgs),
  },
  handle: async (_context, params) => {
    const args = DeleteArgs.parse(params);
    const result = await sm.notesDelete(args.id, args.force);
    if (!result.deleted) {
      return {
        content: [
          {
            type: "text",
            text: `Could not delete ${args.id}: ${result.reason}`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `Deleted ${args.id}.` }],
    };
  },
};

  return { notesList, notesGet, notesArchive, notesUnarchive, notesDelete };
}

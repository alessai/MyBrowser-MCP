import type { Context } from "../context.js";

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
}

export interface Tool {
  schema: ToolSchema;
  handle: (context: Context, params: unknown) => Promise<ToolResult>;
}

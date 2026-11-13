import { z } from "zod";

/**
 * JSON Schema for a tool's input, from Zod 4's built-in converter
 * (zod-to-json-schema only understands Zod 3). "input" mode keeps fields with
 * defaults optional, as clients may omit them. Dialect JSON Schema 2020-12, the
 * MCP default since 2025-11-25 (and the 2026-07-28 revision).
 */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-2020-12", io: "input", unrepresentable: "any" }) as Record<string, unknown>;
}

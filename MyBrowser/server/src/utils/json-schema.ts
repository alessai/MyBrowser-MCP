import { z } from "zod";

/**
 * JSON Schema for a tool's input, from Zod 4's built-in converter
 * (zod-to-json-schema only understands Zod 3). "input" mode keeps fields with
 * defaults optional, as clients may omit them.
 */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-7", io: "input", unrepresentable: "any" }) as Record<string, unknown>;
}

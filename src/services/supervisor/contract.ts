import { createHash } from "node:crypto";
import { z } from "zod";

export class SupervisorError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export const scopeSchema = z.object({ projectId: z.number().int().positive(), scriptId: z.number().int().positive(), reviewKey: z.string().min(1).max(160) }).strict();
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const issueSchema = z.object({ severity: z.enum(["BLOCKER", "WARNING", "INFO"]), code: z.string().regex(/^[A-Z][A-Z0-9_]{1,79}$/), message: z.string().trim().min(1).max(2000), suggestion: z.string().trim().max(2000).nullable().default(null), evidence: z.string().trim().max(2000).nullable().default(null) }).strict();
export const decisionSchema = scopeSchema.extend({ expectedTargetHash: hashSchema, expectedControlContextHash: hashSchema, decision: z.enum(["PASS", "REVISE"]), summary: z.string().trim().min(1).max(4000), issues: z.array(issueSchema).max(100) }).strict();
export type HumanDecision = z.infer<typeof decisionSchema>;
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, nested]) => [key, canonical(nested)]));
  return value === undefined ? null : value;
}
export function canonicalJson(value: unknown) { return JSON.stringify(canonical(value)); }
export function sha256(value: unknown) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }

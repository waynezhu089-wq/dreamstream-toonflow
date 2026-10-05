import { z } from "zod";

export const studioOutput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("ASSET_IMAGE_EDIT"), reply: z.string().min(1).max(12000), imageIntent: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ mode: z.literal("DISCUSS"), reply: z.string().min(1).max(12000) }).strict(),
  z.object({ mode: z.literal("NEEDS_TARGET_CONFIRMATION"), reply: z.string().min(1).max(12000) }).strict(),
  z.object({ mode: z.literal("PROPOSE_CHANGE"), reply: z.string().min(1).max(12000),
    summary: z.string().min(1).max(500), rationale: z.string().max(1000),
    patch: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ mode: z.literal("ASSET_CREATE"), reply: z.string().min(1).max(12000),
    summary: z.string().min(1).max(500), rationale: z.string().max(1000),
    asset: z.record(z.string(), z.unknown()) }).strict(),
]);

export type StudioOutput = z.infer<typeof studioOutput>;
export type StudioFailureStage = "EMPTY_RESPONSE" | "JSON_EXTRACTION_FAILED" |
  "SEMANTIC_NORMALIZATION_FAILED" | "STRICT_VALIDATION_FAILED";

export class StudioSemanticError extends Error {
  constructor(public stage: StudioFailureStage, public paths: string[] = [], public repairable = false) {
    super(stage);
    this.name = "StudioSemanticError";
  }
}

const modes: Record<string, StudioOutput["mode"]> = {
  ASSET_IMAGE_EDIT: "ASSET_IMAGE_EDIT",
  DISCUSS: "DISCUSS", DISCUSSION: "DISCUSS", "讨论": "DISCUSS",
  PROPOSE_CHANGE: "PROPOSE_CHANGE", CHANGE: "PROPOSE_CHANGE", "修改": "PROPOSE_CHANGE", "修改提案": "PROPOSE_CHANGE",
  ASSET_CREATE: "ASSET_CREATE", CREATE_ASSET: "ASSET_CREATE", "新增素材": "ASSET_CREATE", "创建资产": "ASSET_CREATE",
  NEEDS_TARGET_CONFIRMATION: "NEEDS_TARGET_CONFIRMATION", TARGET_CONFIRMATION: "NEEDS_TARGET_CONFIRMATION", "需要确认目标": "NEEDS_TARGET_CONFIRMATION",
};
const canonicalMode = (label: string) => modes[label.trim().replace(/[\s-]+/g, "_").toUpperCase()] ?? null;

// Only a single explicit, recognizable model mode can authorize a format-only
// repair. A repair must never invent or silently downgrade action intent.
export function studioModeHint(raw: string): StudioOutput["mode"] | null {
  const matches = [...raw.matchAll(/["']mode["']\s*:\s*["']([^"']+)["']/gi)];
  return matches.length === 1 ? canonicalMode(matches[0][1]) : null;
}

// The model may wrap one object in a short explanation or a markdown fence. It
// may not supply several objects and leave Dream Stream to guess which is true.
function oneObject(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const source = fenced ? fenced[1].trim() : trimmed;
  const ranges: Array<[number, number]> = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (depth === 0 && ch === "{") { start = i; depth = 1; continue; }
    if (depth === 0) continue;
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) ranges.push([start, i + 1]);
  }
  if (ranges.length !== 1 || depth !== 0)
    throw new StudioSemanticError("JSON_EXTRACTION_FAILED", [], ranges.length === 0 && source.includes("{") && source.length <= 24000);
  const [from, to] = ranges[0];
  const prefix = source.slice(0, from).trim(), suffix = source.slice(to).trim();
  if (prefix.length + suffix.length > 200 || /[{}\[\]]|```/.test(prefix + suffix))
    throw new StudioSemanticError("JSON_EXTRACTION_FAILED");
  return source.slice(from, to);
}

export function parseStudioTurnSemantic(raw: unknown): StudioOutput {
  if (typeof raw !== "string" || !raw.trim()) throw new StudioSemanticError("EMPTY_RESPONSE");
  if (raw.length > 24000) throw new StudioSemanticError("JSON_EXTRACTION_FAILED");
  let value: unknown;
  try { value = JSON.parse(oneObject(raw)); }
  catch (error) {
    if (error instanceof StudioSemanticError) throw error;
    throw new StudioSemanticError("JSON_EXTRACTION_FAILED", [], true);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new StudioSemanticError("STRICT_VALIDATION_FAILED", ["root"]);
  const candidate = { ...value } as Record<string, unknown>;
  if (typeof candidate.mode !== "string") throw new StudioSemanticError("SEMANTIC_NORMALIZATION_FAILED", ["mode"]);
  const mode = canonicalMode(candidate.mode);
  if (!mode) throw new StudioSemanticError("SEMANTIC_NORMALIZATION_FAILED", ["mode"]);
  candidate.mode = mode;
  const parsed = studioOutput.safeParse(candidate);
  if (!parsed.success) throw new StudioSemanticError("STRICT_VALIDATION_FAILED",
    parsed.error.issues.map(issue => issue.path.join(".") || "root"));
  return parsed.data;
}

export const studioTurnFormat = `Return exactly one JSON object, with no markdown. Modes:\n` +
  `ASSET_IMAGE_EDIT: {"mode":"ASSET_IMAGE_EDIT","reply":"brief reply","imageIntent":{"canonicalKey":"CHAR-001","editMode":"TEXT_EDIT","targetRole":"EDIT_CANDIDATE","editPrompt":"concise English image edit instruction","preserveIntent":{},"referenceBindings":[]}}.\n` +
  `DISCUSS: {"mode":"DISCUSS","reply":"your answer"}.\n` +
  `NEEDS_TARGET_CONFIRMATION: {"mode":"NEEDS_TARGET_CONFIRMATION","reply":"your question"}.\n` +
  `PROPOSE_CHANGE: {"mode":"PROPOSE_CHANGE","reply":"your answer","summary":"brief change","rationale":"reason","patch":{}}.\n` +
  `ASSET_CREATE: {"mode":"ASSET_CREATE","reply":"your answer","summary":"new asset","rationale":"reason","asset":{"name":"...","category":"ACC","assetKind":"PROP","description":"...","sourcePolicy":"AI_ALLOWED","ownerKey":"CHAR-001"}}. Only use when the user explicitly requests a separate new asset.\n` +
  `Do not omit required fields or add extra fields. Never turn a failed change proposal into DISCUSS.`;

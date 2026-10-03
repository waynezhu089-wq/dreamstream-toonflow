import { NoObjectGeneratedError } from "ai";
import { ZodError } from "zod";

function errorChain(error: unknown) {
  const queue: unknown[] = [error];
  const seen = new Set<object>();
  const chain: Record<string, unknown>[] = [];
  while (queue.length && seen.size < 12) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    chain.push(current as Record<string, unknown>);
    const nested = current as { cause?: unknown; errors?: unknown[] };
    if (nested.cause) queue.push(nested.cause);
    if (Array.isArray(nested.errors)) queue.push(...nested.errors.slice(-4));
  }
  return chain;
}

export function structuredFailure(error: unknown): boolean {
  const chain = errorChain(error);
  // A provider rejection can be wrapped by an SDK object-generation error.
  if (chain.some(item => /^(APICallError|AI_APICallError)$/i.test(String(item.name ?? "")))) return false;
  return chain.some(item => item instanceof ZodError || NoObjectGeneratedError.isInstance(item)
    || /^(NoObjectGeneratedError|AI_NoObjectGeneratedError|TypeValidationError|JSONParseError|AI_TypeValidationError|AI_JSONParseError)$/.test(String(item.name ?? "")));
}

export function structuredRepairContext(error: unknown, candidate: unknown): string {
  const previous = candidate === undefined ? errorChain(error).find(item => typeof item.text === "string")?.text : candidate;
  const text = typeof previous === "string" ? previous : previous === undefined ? "(SDK returned no object)" : JSON.stringify(previous);
  const issues = errorChain(error).flatMap(item => item instanceof ZodError
    ? item.issues.slice(0, 20).map(issue => ({ path: issue.path.join("."), code: issue.code })) : []);
  return JSON.stringify({ previous: String(text).slice(0, 16000), issues });
}

export function safeStructuredStatus(error: unknown): number | null {
  for (const item of errorChain(error)) {
    const status = item.statusCode ?? item.status;
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
  return null;
}

// Paths and issue types only: never include the model response, prompt or provider headers in logs.
export function structuredValidationSummary(error: unknown) {
  return errorChain(error).flatMap(item => item instanceof ZodError
    ? item.issues.slice(0, 20).map(issue => ({ path: issue.path.join("."), failureType: issue.code })) : []);
}

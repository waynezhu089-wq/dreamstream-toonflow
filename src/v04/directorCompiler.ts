import { createHash } from "node:crypto";
import { directorIntentSchema, emptyDirectorIntent } from "./directorContract";
export class DirectorValidationError extends Error {
  constructor(
    public path: string,
    public reason: string,
  ) {
    super("Director candidate invalid: " + path + " (" + reason + ")");
  }
}
export function directorCanonical(value: any): string {
  if (Array.isArray(value))
    return "[" + value.map(directorCanonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .filter((k) => value[k] !== undefined)
        .map((k) => JSON.stringify(k) + ":" + directorCanonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
const digest = (v: unknown) =>
  createHash("sha256").update(directorCanonical(v)).digest("hex");
export function compileDirectorCandidate(state: any, semantic?: unknown) {
  if (
    Buffer.byteLength(JSON.stringify(state), "utf8") > 2_000_000 ||
    state.assets.length > 300 ||
    state.storyboards.length > 300
  )
    throw new DirectorValidationError("source", "SIZE_LIMIT");
  const active = state.assets
    .filter((a: any) => a.status === "ACTIVE")
    .sort((a: any, b: any) => a.canonicalKey.localeCompare(b.canonicalKey));
  const intent = directorIntentSchema.parse(semantic ?? emptyDirectorIntent()),
    keys = new Set(active.map((a: any) => a.canonicalKey)),
    shots = new Set(state.storyboards.map((s: any) => s.id));
  const reference = (key: string, path: string) => {
    if (!keys.has(key))
      throw new DirectorValidationError(path, "UNKNOWN_ACTIVE_ASSET");
  };
  const unique = (rows: any[], field: string, path: string) => {
    const seen = new Set();
    rows.forEach((row, i) => {
      if (seen.has(row[field]))
        throw new DirectorValidationError(
          path + "." + i + "." + field,
          "DUPLICATE",
        );
      seen.add(row[field]);
    });
  };
  unique(intent.emotionalArc, "beatRef", "emotionalArc");
  unique(intent.narrativeVisualRoles, "canonicalKey", "narrativeVisualRoles");
  unique(intent.shotDramaticIntents, "clientRef", "shotDramaticIntents");
  const beats = new Set(intent.emotionalArc.map((b) => b.beatRef)),
    shotRefs = new Set(intent.shotDramaticIntents.map((s) => s.clientRef));
  intent.narrativeVisualRoles.forEach((r, i) =>
    reference(r.canonicalKey, "narrativeVisualRoles." + i + ".canonicalKey"),
  );
  intent.scaleRelations.forEach((r, i) => {
    reference(r.smaller, "scaleRelations." + i + ".smaller");
    reference(r.larger, "scaleRelations." + i + ".larger");
    if (r.smaller === r.larger)
      throw new DirectorValidationError("scaleRelations." + i, "SELF_RELATION");
    if (r.kind === "SHOT_SPECIFIC" && (!r.shotRef || !shotRefs.has(r.shotRef)))
      throw new DirectorValidationError(
        "scaleRelations." + i + ".shotRef",
        "UNKNOWN_SHOT",
      );
    if (r.kind !== "SHOT_SPECIFIC" && r.shotRef !== null)
      throw new DirectorValidationError(
        "scaleRelations." + i + ".shotRef",
        "UNEXPECTED_SHOT",
      );
  });
  intent.transformationLineage.forEach((r, i) => {
    reference(r.from, "transformationLineage." + i + ".from");
    reference(r.to, "transformationLineage." + i + ".to");
    if (r.from === r.to)
      throw new DirectorValidationError(
        "transformationLineage." + i,
        "SELF_RELATION",
      );
  });
  // Relative inequalities are checked per shot: dramatic/readability relations are not physical ratios.
  const acyclic = (edges: { from: string; to: string }[], path: string) => {
    const graph = new Map<string, string[]>(),
      seen = new Set<string>();
    for (const e of edges) {
      const id = e.from + ">" + e.to;
      if (seen.has(id))
        throw new DirectorValidationError(path, "DUPLICATE_EDGE");
      seen.add(id);
      graph.set(e.from, [...(graph.get(e.from) ?? []), e.to]);
    }
    const visiting = new Set<string>(),
      done = new Set<string>();
    const visit = (key: string) => {
      if (visiting.has(key)) throw new DirectorValidationError(path, "CYCLE");
      if (done.has(key)) return;
      visiting.add(key);
      for (const target of graph.get(key) ?? []) visit(target);
      visiting.delete(key);
      done.add(key);
    };
    for (const key of graph.keys()) visit(key);
  };
  const relative = intent.scaleRelations.filter((r) => r.kind === "RELATIVE");
  acyclic(
    relative.map((r) => ({ from: r.smaller, to: r.larger })),
    "scaleRelations",
  );
  for (const shotRef of shotRefs)
    acyclic(
      [
        ...relative,
        ...intent.scaleRelations.filter(
          (r) => r.kind === "SHOT_SPECIFIC" && r.shotRef === shotRef,
        ),
      ].map((r) => ({ from: r.smaller, to: r.larger })),
      "scaleRelations." + shotRef,
    );
  // Transformation lineage may legitimately revisit forms; unlike scale it is not required to be a DAG.
  for (const [i, r] of intent.transformationLineage.entries()) {
    if (r.relationType === "MATERIAL_TRANSFORMATION") {
      const target = active.find((a: any) => a.canonicalKey === r.to);
      if (["BRAND", "UI"].includes(target.category))
        throw new DirectorValidationError(
          "transformationLineage." + i + ".relationType",
          "REAL_REFERENCE_CANNOT_BE_MATERIAL_TRANSFORM",
        );
    }
  }
  intent.shotDramaticIntents.forEach((s, i) => {
    reference(s.primarySubject, "shotDramaticIntents." + i + ".primarySubject");
    s.secondarySubjects.forEach((k, j) =>
      reference(k, "shotDramaticIntents." + i + ".secondarySubjects." + j),
    );
    if (!beats.has(s.narrativeBeat))
      throw new DirectorValidationError(
        "shotDramaticIntents." + i + ".narrativeBeat",
        "UNKNOWN_BEAT",
      );
    if (s.storyboardId !== null && !shots.has(s.storyboardId))
      throw new DirectorValidationError(
        "shotDramaticIntents." + i + ".storyboardId",
        "UNKNOWN_STORYBOARD",
      );
  });
  const source = {
    project: state.project,
    creative: state.creative,
    assets: active,
    storyboards: state.storyboards,
    visualSpecs: state.visualSpecs.filter(
      (s: any) => s.effectiveStatus === "CONFIRMED",
    ),
    references: state.agentReferences,
    coverage: state.coverage,
  };
  const sourceHash = digest(source),
    warnings: string[] = [];
  if (!intent.globalVisualDNA.artStyle) warnings.push("GLOBAL_DNA_UNRESOLVED");
  if (!intent.emotionalArc.length) warnings.push("EMOTIONAL_ARC_UNRESOLVED");
  if (!intent.narrativeVisualRoles.length)
    warnings.push("NARRATIVE_ROLES_UNRESOLVED");
  for (const a of active) {
    if (
      !intent.narrativeVisualRoles.some(
        (r) => r.canonicalKey === a.canonicalKey,
      )
    )
      warnings.push("ROLE_UNRESOLVED:" + a.canonicalKey);
    if (
      ["BRAND", "UI"].includes(a.category) &&
      a.sourcePolicy !== "REAL_REQUIRED"
    )
      throw new DirectorValidationError(
        "source.assets." + a.canonicalKey,
        "REAL_SOURCE_REQUIRED",
      );
  }
  return {
    schemaVersion: 1,
    compilerVersion: "v04.director-candidate.1",
    status: "CANDIDATE_ONLY",
    persisted: false,
    affectsGeneration: false,
    projectId: state.project.id,
    scriptId: state.creative.scriptId,
    sourceCreativeVersion: state.creative.version,
    sourceHash,
    candidateHash: digest({ sourceHash, intent }),
    intent,
    assetIndex: active.map((a: any) => ({
      canonicalKey: a.canonicalKey,
      name: a.name,
      revision: a.revision,
      sourcePolicy: a.sourcePolicy,
      assetKind: a.assetKind,
      sharedVisualSystemKey: a.sharedVisualSystemKey ?? null,
    })),
    warnings,
  };
}

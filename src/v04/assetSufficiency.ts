import { assetExtractionProposalSchema } from "./assetExtractionOutput";
import { z } from "zod";

type Proposal = z.infer<typeof assetExtractionProposalSchema>;
const auditResponse = z.object({
  environments: z.array(z.object({ label: z.string().trim().min(1).max(200), evidenceQuote: z.string().trim().min(3).max(300),
    coveredByName: z.string().trim().min(1).max(256).nullable(), reason: z.string().max(600) }).passthrough()).max(30).default([]),
  missing: z.array(z.object({ label: z.string().trim().min(1).max(200), type: z.enum(["SCENE", "PERSON", "CREATURE", "VEHICLE", "PROP", "FX_MATERIAL", "BRAND", "OTHER"]),
    evidenceQuote: z.string().trim().min(3).max(300), reason: z.string().max(600) }).passthrough()).max(30),
  unsupportedCoverageLabels: z.array(z.string().trim().min(1).max(200)).max(30),
}).passthrough();
const key = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
type Requirement = {
  requirementKey: string; sourceCoverageIndex: number | null; label: string; coverageType: string; classification: string;
  status: string; candidateNames: string[]; existingCanonicalKeys: string[]; note: string;
  suggestedAsset: { name: string; category: string; assetKind: string; importance: string; sourcePolicy: string } | null;
};

// A review aid, never a Gate or an automatic Asset Bible mutation. Coverage
// ownership is evidence; a fixed candidate count is not.
export function auditAssetSufficiency(proposal: Proposal, treatment: string, rawAudit?: unknown, existing: { name: string; category: string }[] = []) {
  const audit = rawAudit === undefined ? null : auditResponse.parse(rawAudit);
  const unsupported = new Set((audit?.unsupportedCoverageLabels ?? []).map(key));
  const retainedCoverage = proposal.coverage.filter(item => {
    // A model may challenge an unassigned requirement. Linked identities remain
    // visible for human review even if the audit disagrees with the label.
    if (item.candidateIndexes.length || item.existingCanonicalKeys.length) return true;
    const interfaceOnly = /(?:\bUI\b|软件界面|产品界面|应用界面)/iu.test(item.label)
      && !/(?:\bUI\b|软件界面|产品界面|应用界面)/iu.test(treatment);
    return !interfaceOnly && !unsupported.has(key(item.label));
  });
  const nextProposal = retainedCoverage.length === proposal.coverage.length ? proposal
    : assetExtractionProposalSchema.parse({ ...proposal, coverage: retainedCoverage });
  const occurrences = new Map<string, number>();
  const requirementKey = (source: string, type: string, label: string) => {
    const base = `${source}:${type}:${key(label)}`;
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    return `${base}:${occurrence}`;
  };
  const requirements: Requirement[] = nextProposal.coverage.map((item, index) => {
    const candidateNames = item.candidateIndexes.map(i => nextProposal.candidates[i].name);
    const hasOwner = candidateNames.length > 0 || item.existingCanonicalKeys.length > 0;
    const documented = item.classification === "SHOT_LOCAL" || item.classification === "COMPOSITION_MOTIF";
    const status = documented ? "DOCUMENTED" : hasOwner ? "COVERED" : "MISSING";
    return {
      requirementKey: requirementKey("coverage", item.coverageType, item.label), sourceCoverageIndex: index,
      label: item.label, coverageType: item.coverageType, classification: item.classification,
      status, candidateNames, existingCanonicalKeys: item.existingCanonicalKeys,
      note: item.note,
      suggestedAsset: status === "MISSING" && item.coverageType === "SCENE"
        ? { name: item.label, category: "LOC", assetKind: "ENVIRONMENT", importance: "SUPPORTING", sourcePolicy: "AI_ALLOWED" }
        : null,
    };
  });
  let ungrounded = 0;
  const candidateEnvironmentNames = new Set([...nextProposal.candidates.filter(item => item.assetKind === "ENVIRONMENT").map(item => key(item.name)),
    ...existing.filter(item => item.category === "LOC").map(item => key(item.name))]);
  for (const environment of audit?.environments ?? []) {
    const quote = key(environment.evidenceQuote);
    if (quote.length < 3 || !key(treatment).includes(quote)) { ungrounded++; continue; }
    if (environment.coveredByName && candidateEnvironmentNames.has(key(environment.coveredByName))) continue;
    if (requirements.some(row => key(row.label) === key(environment.label))) continue;
    requirements.push({ requirementKey: requirementKey("audit", "SCENE", environment.label), sourceCoverageIndex: null,
      label: environment.label, coverageType: "SCENE", classification: "SCENE_ANCHOR",
      status: "MISSING", candidateNames: [], existingCanonicalKeys: [], note: environment.reason,
      suggestedAsset: { name: environment.label, category: "LOC", assetKind: "ENVIRONMENT", importance: "SUPPORTING", sourcePolicy: "AI_ALLOWED" } });
  }
  for (const item of audit?.missing ?? []) {
    const quote = key(item.evidenceQuote);
    if (quote.length < 3 || !key(treatment).includes(quote)) { ungrounded++; continue; }
    if (requirements.some(row => key(row.label) === key(item.label))) continue;
    requirements.push({ requirementKey: requirementKey("audit", item.type, item.label), sourceCoverageIndex: null,
      label: item.label, coverageType: item.type,
      classification: item.type === "SCENE" ? "SCENE_ANCHOR" : "CANONICAL_ASSET",
      status: "MISSING", candidateNames: [], existingCanonicalKeys: [], note: item.reason,
      suggestedAsset: item.type === "SCENE"
        ? { name: item.label, category: "LOC", assetKind: "ENVIRONMENT", importance: "SUPPORTING", sourcePolicy: "AI_ALLOWED" }
        : null });
  }
  // An ascent toward a celestial/sky destination is a change of production
  // space, even when the extraction pass lists only the vehicle and target.
  // This is a generic, grounded review cue, not an automatic environment ADD.
  const ascentEvidence = treatment.match(/(?:向上|上升|升空|飞升|飞向|冲向).{0,24}(?:月亮|月球|天空|星空|高空|云层)|(?:月亮|月球|天空|星空|高空|云层).{0,24}(?:向上|上升|升空|飞升|飞向|冲向)/u)?.[0];
  const hasSkyEnvironment = [...nextProposal.candidates, ...existing].some(item =>
    ("assetKind" in item ? item.assetKind === "ENVIRONMENT" : item.category === "LOC") &&
    /高空|天空|空中|云端|云层|云海|天际|月夜|星空/u.test(item.name));
  if (ascentEvidence && !hasSkyEnvironment && !requirements.some(row =>
    row.status === "MISSING" && row.coverageType === "SCENE" && /高空|天空|空中|云端|云层|云海|月夜|星空/u.test(row.label))) {
    const destinationLabel = /月亮|月球/u.test(ascentEvidence) ? "高空月夜／目的地环境" : "天空目的地环境";
    requirements.push({ requirementKey: requirementKey("deterministic", "SCENE", destinationLabel), sourceCoverageIndex: null,
      label: destinationLabel, coverageType: "SCENE", classification: "SCENE_ANCHOR",
      status: "MISSING", candidateNames: [], existingCanonicalKeys: [], note: `Treatment 写到“${ascentEvidence}”，但尚无明确的目的地环境；请确认是否需要独立场景资产或现有环境变体`,
      suggestedAsset: { name: destinationLabel, category: "LOC", assetKind: "ENVIRONMENT", importance: "SUPPORTING", sourcePolicy: "AI_ALLOWED" } });
  }
  const missing = requirements.filter(item => item.status === "MISSING");
  return {
    proposal: nextProposal,
    status: !treatment.trim() || !requirements.length || missing.length || ungrounded || !audit || !audit.environments.length ? "NEEDS_REVIEW" : "READY",
    reason: !audit ? "独立充分性检查未完成，不能宣称素材已足够"
      : ungrounded ? "部分缺口无法在 Treatment 找到依据，请人工复核"
      : !audit.environments.length ? "独立空间审计未列出任何环境，请人工核对场景"
      : !treatment.trim() ? "已确认 Treatment 为空，无法判断视觉覆盖"
      : !requirements.length ? "尚无 Treatment 视觉覆盖记录"
      : missing.length ? `${missing.length} 项重要视觉内容尚无明确生产归属` : "已列视觉内容均有生产归属或明确标为镜头局部／构图",
    candidateCount: nextProposal.candidates.length - new Set(nextProposal.mergeSuggestions.map(item => item.candidateIndex)).size,
    existingReferenceCount: new Set([
      ...nextProposal.mergeSuggestions.map(item => item.existingCanonicalKey),
      ...nextProposal.coverage.flatMap(item => item.existingCanonicalKeys),
    ]).size,
    excludedUngroundedCoverage: proposal.coverage.length - retainedCoverage.length,
    auditComplete: !!audit && audit.environments.length > 0 && ungrounded === 0,
    requirements,
  } as const;
}

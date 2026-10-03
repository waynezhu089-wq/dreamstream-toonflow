import { z } from "zod";
import { assetExtractionProposalSchema } from "./assetExtractionOutput";

const name = z.string().trim().min(1).max(256);
export const extractionRelationsSchema = z.object({
  sharedSystems: z.array(z.object({ systemName: name, memberNames: z.array(name).min(1).max(30) }).passthrough()).max(30),
  continuityGroups: z.array(z.object({ memberNames: z.array(name).min(2).max(30) }).passthrough()).max(30),
}).passthrough();

const key = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
function invalid(path: (string | number)[], message: string): never {
  throw new z.ZodError([{ code: "custom", path, message }]);
}

export function compileAssetExtractionRelations(proposal: z.infer<typeof assetExtractionProposalSchema>, raw: unknown) {
  const relations = extractionRelationsSchema.parse(raw);
  const indexByName = new Map<string, number>();
  proposal.candidates.forEach((candidate, index) => indexByName.set(key(candidate.name), index));
  const resolve = (value: string, path: (string | number)[]) => {
    const index = indexByName.get(key(value));
    if (index === undefined) invalid(path, "关系引用不是本次候选元素");
    return index;
  };
  const candidates = proposal.candidates.map(candidate => ({ ...candidate,
    relatedCandidateIndexes: [] as number[], sharedVisualSystemCandidateIndex: null as number | null }));
  for (const [i, system] of relations.sharedSystems.entries()) {
    const systemIndex = resolve(system.systemName, ["sharedSystems", i, "systemName"]);
    if (candidates[systemIndex].assetKind !== "MATERIAL_FX")
      invalid(["sharedSystems", i, "systemName"], "共享视觉系统必须指向 MATERIAL_FX 候选");
    for (const [j, memberName] of system.memberNames.entries()) {
      const memberIndex = resolve(memberName, ["sharedSystems", i, "memberNames", j]);
      if (memberIndex === systemIndex) invalid(["sharedSystems", i, "memberNames", j], "视觉系统不能关联自身");
      const previous = candidates[memberIndex].sharedVisualSystemCandidateIndex;
      if (previous !== null && previous !== systemIndex) invalid(["sharedSystems", i, "memberNames", j], "同一元素不能同时归属多个系统");
      candidates[memberIndex].sharedVisualSystemCandidateIndex = systemIndex;
      candidates[memberIndex].relatedCandidateIndexes.push(systemIndex);
    }
  }
  for (const [i, group] of relations.continuityGroups.entries()) {
    const indexes = group.memberNames.map((member, j) => resolve(member, ["continuityGroups", i, "memberNames", j]));
    if (new Set(indexes).size !== indexes.length) invalid(["continuityGroups", i, "memberNames"], "同一持续形态不能重复列出");
    for (const index of indexes) candidates[index].relatedCandidateIndexes.push(...indexes.filter(other => other !== index));
  }
  return assetExtractionProposalSchema.parse({ ...proposal, candidates: candidates.map(candidate => ({
    ...candidate, relatedCandidateIndexes: [...new Set(candidate.relatedCandidateIndexes)],
  })) });
}

export interface ProductionProjectLike {
  projectType?: string | null;
  type?: string | null;
}

export interface ProductionProfile {
  key: "legacy" | "advertisement";
  skillRoot: string[];
  includeStorySkills: boolean;
  productionSkillRoot?: string[];
}

const LEGACY_PROFILE: ProductionProfile = {
  key: "legacy",
  skillRoot: [],
  includeStorySkills: true,
};

const ADVERTISEMENT_PROFILE: ProductionProfile = {
  key: "advertisement",
  skillRoot: ["profiles", "advertisement"],
  includeStorySkills: false,
  productionSkillRoot: ["profiles", "advertisement", "production_skills"],
};

export function resolveProductionProfile(project: ProductionProjectLike): ProductionProfile {
  if (project.projectType === "general_video" && project.type === "advertisement") {
    return ADVERTISEMENT_PROFILE;
  }
  return LEGACY_PROFILE;
}

export function getProductionSkillPathSegments(profile: ProductionProfile, fileName: string): string[] {
  return ["skills", ...profile.skillRoot, fileName];
}

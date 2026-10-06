// Experimental project-specific user direction. Not global policy, Creative,
// appearance truth, or a generation input. Exact project scope is mandatory.
export const dreamDirectorSeed = {
  projectId: 1790941805789310,
  canonicalKeys: ["CHAR-003", "FX-001", "PROP-001", "PROP-002", "CHAR-002", "BRAND-001"],
  projectDirectionSources: [{ type: "USER_CONFIRMED_DIRECTION", sourceId: "OPT-DIR-031B/user-work-order", scope: "PROJECT" }],
  directions: {
    whale: { canonicalKey: "CHAR-003", role: "SUBLIME COLOSSUS", perception: "ancient / majestic / overwhelming; awe first, fear second; not cute, not evil monster, not gore" },
    materialLineage: ["FX-001", "PROP-001", "PROP-002", "CHAR-002"],
    materialRelation: "MATERIAL_TRANSFORMATION",
    ending: { from: "CHAR-002", to: "BRAND-001", relationType: "COMPOSITION_RESOLUTION", rule: "graphic match/dissolve to confirmed real Logo, no physical transformation or AI redraw" },
  },
};

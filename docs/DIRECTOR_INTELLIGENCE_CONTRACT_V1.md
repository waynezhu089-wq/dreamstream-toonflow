# Director Intelligence Contract V1
Status: EXPERIMENTAL / CANDIDATE_CONTRACT / NOT_FROZEN
Source: directorContract.ts / directorCompiler.ts; schemaVersion1, compilerVersion=v04.director-candidate.1.

GLOBAL_VISUAL_DNA: artStyle, colorLanguage[], lightingLanguage[], materialLanguage[], motionLanguage[], recurringVisualMotifs[], realismLevel, atmosphere, forbiddenStyleDrift[]. Nullable text is unresolved.
EMOTIONAL_ARC[]: beatRef, emotion, intensity nullable 0..1, transition, visualExpression. Intensity is intent, not measured audience response.
NARRATIVE_VISUAL_ROLE[]: active canonicalKey, narrativeFunction, emotionalRead, dramaticImportance, scaleFunction, requiredAudiencePerception[], forbiddenInterpretations[]. Asset Bible still owns identity.
SCALE_RELATION_GRAPH[]: smaller/larger keys, RELATIVE/DRAMATIC/SHOT_SPECIFIC, shotRef only for shot-specific, requirement. Qualitative inequalities, not metres. Global + applicable per-shot inequalities reject duplicate edges/cycles. Dramatic perception does not redefine anatomy.
TRANSFORMATION_LINEAGE[]: from/to keys, MATERIAL_TRANSFORMATION/COMPOSITION_RESOLUTION, inheritedVisualDNA[], preservedTraits[], transformedTraits[], visualContinuityRules[]. Material may revisit a form; lineage is not forced into a DAG. BRAND/UI can be composition resolution, never a generated material target.
SHOT_DRAMATIC_INTENT[]: clientRef, nullable existing storyboardId, narrativeBeat, audienceFeeling, primarySubject, secondarySubjects[], scaleRelationship[], compositionIntent, lightingIntent, motionIntent, continuityIntent[], storyConstraints[]. Null ID is unpersisted planning, not forged production identity.

Strict objects reject unknown executor fields. Text<=1600 chars; field arrays<=30; <=100 beats, <=300 roles/relations/shots, <=20 secondary subjects. Source<=2MB/300 assets/300 shots. Active asset/project and storyboard/unit scope enforced; beat/role/clientRef uniqueness. BRAND/UI must be REAL_REQUIRED. No OTHER fallback.
Sorted-key JSON SHA-256: sourceHash captures existing relevant state; candidateHash binds sourceHash+intent. Null/empty and existing metadata preserved, no new clock/random. These are diagnostic candidate identities, not authorization.

POST /api/v04/director/dry-run {projectId,scriptId,intent?}. Existing V0.4 auth/project access rule. Response data: CANDIDATE_ONLY,persisted=false,affectsGeneration=false,sourceCreativeVersion,sourceHash,candidateHash,intent,assetIndex,warnings. Scope-only request returns honest unresolved semantics. One readPilot SQLite transaction then pure computation; no AI/media/Comfy/queue/writers. No Confirm/Apply endpoint.

DECISION REQUIRED: future accepted Director version. Option A project-level accepted proposal with dependent unit projections (recommended); Option B Creative-associated extension. Either needs source binding/staleness and separate reviewed migration/hash semantics. Neither implemented tonight.

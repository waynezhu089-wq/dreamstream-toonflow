import { z } from "zod";
const text = z.string().max(1600),
  line = text.nullable(),
  lines = z.array(text).max(30),
  key = z.string().min(1).max(128);
const object = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
export const globalVisualDnaSchema = object({
  artStyle: line,
  colorLanguage: lines,
  lightingLanguage: lines,
  materialLanguage: lines,
  motionLanguage: lines,
  recurringVisualMotifs: lines,
  realismLevel: line,
  atmosphere: line,
  forbiddenStyleDrift: lines,
});
export const directorIntentSchema = object({
  schemaVersion: z.literal(1),
  globalVisualDNA: globalVisualDnaSchema,
  emotionalArc: z
    .array(
      object({
        beatRef: key,
        emotion: line,
        intensity: z.number().min(0).max(1).nullable(),
        transition: line,
        visualExpression: line,
      }),
    )
    .max(100),
  narrativeVisualRoles: z
    .array(
      object({
        canonicalKey: key,
        narrativeFunction: line,
        emotionalRead: line,
        dramaticImportance: line,
        scaleFunction: line,
        requiredAudiencePerception: lines,
        forbiddenInterpretations: lines,
      }),
    )
    .max(300),
  scaleRelations: z
    .array(
      object({
        smaller: key,
        larger: key,
        kind: z.enum(["RELATIVE", "DRAMATIC", "SHOT_SPECIFIC"]),
        shotRef: key.nullable(),
        requirement: text,
      }),
    )
    .max(300),
  transformationLineage: z
    .array(
      object({
        from: key,
        to: key,
        relationType: z.enum([
          "MATERIAL_TRANSFORMATION",
          "COMPOSITION_RESOLUTION",
        ]),
        inheritedVisualDNA: lines,
        preservedTraits: lines,
        transformedTraits: lines,
        visualContinuityRules: lines,
      }),
    )
    .max(300),
  shotDramaticIntents: z
    .array(
      object({
        clientRef: key,
        storyboardId: z.number().int().positive().nullable(),
        narrativeBeat: key,
        audienceFeeling: line,
        primarySubject: key,
        secondarySubjects: z.array(key).max(20),
        scaleRelationship: lines,
        compositionIntent: line,
        lightingIntent: line,
        motionIntent: line,
        continuityIntent: lines,
        storyConstraints: lines,
      }),
    )
    .max(300),
});
export type DirectorIntent = z.infer<typeof directorIntentSchema>;
export const directorDryRunRequest = z
  .object({
    projectId: z.number().int().positive(),
    scriptId: z.number().int().positive(),
    intent: directorIntentSchema.optional(),
  })
  .strict();
export function emptyDirectorIntent(): DirectorIntent {
  return {
    schemaVersion: 1,
    globalVisualDNA: {
      artStyle: null,
      colorLanguage: [],
      lightingLanguage: [],
      materialLanguage: [],
      motionLanguage: [],
      recurringVisualMotifs: [],
      realismLevel: null,
      atmosphere: null,
      forbiddenStyleDrift: [],
    },
    emotionalArc: [],
    narrativeVisualRoles: [],
    scaleRelations: [],
    transformationLineage: [],
    shotDramaticIntents: [],
  };
}

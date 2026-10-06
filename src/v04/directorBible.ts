import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { z } from "zod";
import u from "@/utils";
import { db } from "@/utils/db";
import { requireModel } from "@/services/modelPreset";
import { readPilot, PilotError } from "./service";
import {
  compileDirectorCandidate,
  directorCanonical,
  DirectorValidationError,
} from "./directorCompiler";
import { directorIntentSchema, emptyDirectorIntent } from "./directorContract";
import { resolveDirectorContext, resolveProjectDirectorSeed } from "./directorContext";
import { assertActiveDirectorProposal, confirmedDirectorAncestors, finalizeDirectorAncestors } from "./directorLineage";
import { oneObject } from "./studioTurnSemantic";

const compilerVersion = "v04.director-bible.1",
  schemaVersion = 1;
const scopeSchema = z
  .object({
    projectId: z.number().int().positive(),
    scriptId: z.number().int().positive(),
  })
  .strict();
const proposalRequest = scopeSchema
  .extend({
    userInstruction: z.string().max(8000).default("整理当前影片的导演视觉方向"),
    baseProposalId: z.string().uuid().optional(),
    baseDirectorVersion: z.number().int().positive().optional(),
    selectedObject: z.object({ type: z.enum(["PROJECT", "ASSET", "SHOT"]), key: z.string().min(1).max(128) }).strict().nullable().optional(),
  })
  .strict();
const proposalCommand = scopeSchema
  .extend({ proposalId: z.string().uuid() })
  .strict();
const confirmation = proposalCommand
  .extend({ previewHash: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
const q = db as Knex,
  hash = (x: unknown) =>
    createHash("sha256").update(directorCanonical(x)).digest("hex");
const deny = (code: string, message: string, status = 409): never => {
  throw new PilotError(code, message, status);
};
type Scope = z.infer<typeof scopeSchema>;
async function authorize(trx: Knex.Transaction, scope: Scope, actor: number) {
  const p = await trx("o_project").where({ id: scope.projectId }).first();
  if (!Number.isSafeInteger(actor) || actor < 1)
    deny("PILOT_AUTH_REQUIRED", "需要登录", 401);
  if (!p || Number(p.userId) !== actor)
    deny("PILOT_FORBIDDEN", "无权访问这个项目", 403);
}
async function capture(trx: Knex.Transaction, scope: Scope) {
  const state = await readPilot(
    { projectId: scope.projectId, scriptId: scope.scriptId },
    false,
    trx,
  );
  const creativeUnits = await trx("o_v04Creative")
    .where({ projectId: scope.projectId })
    .orderBy("scriptId")
    .limit(101);
  const refCount = Number(
    (
      await trx("o_v04AgentReference")
        .where({ projectId: scope.projectId })
        .count({ n: "*" })
        .first()
    )?.n ?? 0,
  );
  if (creativeUnits.length > 100 || refCount > 200)
    deny("DIRECTOR_SOURCE_TOO_LARGE", "项目来源超过本阶段安全读取限制", 422);
  const assets = state.assets
    .filter((a) => a.status === "ACTIVE")
    .map((a) => ({
      canonicalKey: a.canonicalKey,
      name: a.name,
      category: a.category,
      assetKind: a.assetKind,
      sourcePolicy: a.sourcePolicy,
      revision: a.revision,
      description: a.description,
      identityAnchors: a.identityAnchors,
      mustPreserve: a.mustPreserve,
      forbiddenChanges: a.forbiddenChanges,
      ownerKey: a.ownerKey,
      variantOf: a.variantOf,
      sharedVisualSystemKey: a.sharedVisualSystemKey,
      relatedKeys: a.relatedKeys,
    }));
  const specKeys = new Set<string>();
  const confirmedSpecs = state.visualSpecs.filter(
    (s) =>
      s.effectiveStatus === "CONFIRMED" &&
      !specKeys.has(s.canonicalKey) &&
      !!specKeys.add(s.canonicalKey),
  );
  const source = {
    creativeUnits: creativeUnits.map((c) => ({
      scriptId: c.scriptId,
      version: c.version,
      brief: c.brief,
      treatment: c.treatment,
      script: c.script,
      targetDuration: c.targetDuration,
      aspectRatio: c.aspectRatio,
    })),
    assets,
    confirmedSpecs: confirmedSpecs.map((s) => ({
      canonicalKey: s.canonicalKey,
      revision: s.revision,
      sourceAssetRevision: s.sourceAssetRevision,
      spec: s.spec,
    })),
    references: state.agentReferences
      .filter((r) => r.targetType !== "PRODUCTION_ASSET")
      .map((r) => ({
        targetType: r.targetType,
        targetKey: r.targetKey,
        attachmentId: r.attachmentId,
        sha256: r.sha256,
        originalName: r.originalName,
      }))
      .sort((a, b) => directorCanonical(a).localeCompare(directorCanonical(b))),
    storyboards: state.storyboards.map((s) => ({
      id: s.id,
      index: s.index,
      prompt: s.prompt,
      duration: s.duration,
      videoDesc: s.videoDesc,
      productionSpec: s.productionSpec,
    })),
  };
  if (Buffer.byteLength(directorCanonical(source)) > 2_000_000)
    deny("DIRECTOR_SOURCE_TOO_LARGE", "项目来源超过本阶段安全读取限制", 422);
  return {
    state,
    source,
    sourceHash: hash({
      projectId: scope.projectId,
      scriptId: scope.scriptId,
      source,
    }),
    sourceCreativeVersion: state.creative.version,
  };
}
function parts(intent: z.infer<typeof directorIntentSchema>) {
  const { emotionalArc, shotDramaticIntents, ...projectBible } = intent;
  return {
    projectBible,
    unitProjection: { emotionalArc, shotDramaticIntents },
  };
}
function content(row: any) {
  return {
    ...JSON.parse(row.projectBibleJson),
    ...JSON.parse(row.unitProjectionJson),
  };
}
function candidateHash(sourceHash: string, intent: unknown) {
  return hash({ sourceHash, intent, schemaVersion, compilerVersion });
}
function present(row: any, status = row.status) {
  return {
    ...row,
    status,
    projectBible: JSON.parse(row.projectBibleJson),
    unitProjection: JSON.parse(row.unitProjectionJson),
    evidence: JSON.parse(row.evidenceJson),
    diff: row.diffJson ? JSON.parse(row.diffJson) : undefined,
    affectsGeneration: false,
  };
}
async function latest(trx: Knex.Transaction, projectId: number) {
  return trx("o_v04DirectorVersion")
    .where({ projectId })
    .orderBy("directorVersion", "desc")
    .first();
}
// Read-only seam: experiment capture shares its caller's SQLite snapshot.
export async function captureCurrentDirectorForExperiment(trx: Knex.Transaction, scope: Scope) {
  const current = await latest(trx, scope.projectId);
  if (!current || current.scriptId !== scope.scriptId || current.status !== "CURRENT")
    deny("DIRECTOR_AB_NOT_READY", "需要当前制作单元已确认的导演版本");
  const captured = await capture(trx, scope);
  if (current.sourceHash !== captured.sourceHash)
    deny("DIRECTOR_AB_NOT_READY", "导演来源已变化，请先审阅导演版本");
  return { current, intent: directorIntentSchema.parse(content(current)) };
}

export const DIRECTOR_REFERENCE_CONTINUITY_V1 = 'director.reference-continuity.1';
// Called inside the authoritative MAIN-adoption transaction, never by a read.
export async function captureDirectorReferenceBoundary(trx: Knex.Transaction, scope: Scope) {
  if (!await trx.schema.hasTable('o_v04DirectorVersion')) return null;
  const current = await latest(trx, scope.projectId);
  if (!current) return null;
  const captured = await capture(trx, scope);
  if (current.scriptId !== scope.scriptId || current.status !== 'CURRENT' || current.sourceHash !== captured.sourceHash)
    deny('DIRECTOR_RECONFIRM_REQUIRED', '导演来源已变化，请先重新确认视觉方向');
  return {current, captured};
}
export async function inheritDirectorMainReference(trx: Knex.Transaction, scope: Scope,
  before: Awaited<ReturnType<typeof captureDirectorReferenceBoundary>>, canonicalKey: string, attachmentId: string,
  reason:'MAIN_REFERENCE_REPLACEMENT'|'DERIVED_REFERENCE_ADOPTION'='MAIN_REFERENCE_REPLACEMENT') {
  if (!before) return null;
  const after = await capture(trx, scope), current = await latest(trx, scope.projectId);
  const semantic = (s: any) => {const {references, ...rest} = s; return rest;};
  const refs = after.source.references.filter((r: any) => r.attachmentId !== attachmentId);
  const added = after.source.references.filter((r: any) => r.attachmentId === attachmentId);
  if (current?.id !== before.current.id || hash(semantic(after.source)) !== hash(semantic(before.captured.source)) ||
      hash(refs) !== hash(before.captured.source.references) || added.length !== 1 ||
      added[0].targetType !== 'ASSET_BIBLE' || added[0].targetKey !== canonicalKey)
    deny('DIRECTOR_RECONFIRM_REQUIRED', '变化不只是当前主图替换，请重新确认导演方向');
  const intent = directorIntentSchema.parse(content(current));
  const directorVersion = current.directorVersion + 1;
  const projection = await trx('o_v04DirectorProjection').where(scope).orderBy('unitProjectionVersion', 'desc').first();
  const now = Date.now(), proposalId = randomUUID();
  const evidence = {...JSON.parse(current.evidenceJson), truthConstraints: after.source,
    continuity: {version:DIRECTOR_REFERENCE_CONTINUITY_V1, inheritedFromDirectorRevision:current.directorVersion,
      inheritanceReason:reason, oldReferenceHash:hash(before.captured.source.references),
      newReferenceHash:hash(after.source.references), directorSemanticHash:hash(intent), automaticInheritance:true,
      canonicalKey, attachmentId}};
  const base = {...scope, sourceCreativeVersion:after.sourceCreativeVersion, sourceHash:after.sourceHash,
    candidateHash:candidateHash(after.sourceHash,intent), schemaVersion, compilerVersion,
    projectBibleJson:current.projectBibleJson, unitProjectionJson:current.unitProjectionJson,
    evidenceJson:JSON.stringify(evidence), status:'CONFIRMED', createdAt:now, updatedAt:now, actorUserId:current.actorUserId};
  const previewHash = hash({version:DIRECTOR_REFERENCE_CONTINUITY_V1, old:current.id, sourceHash:after.sourceHash});
  await trx('o_v04DirectorProposal').insert({...base,id:proposalId,baseProposalId:current.proposalId,
    baseDirectorVersion:current.directorVersion,previewHash,diffJson:'[]'});
  const row = {...base,status:'CURRENT',proposalId,previewHash,directorVersion,
    unitProjectionVersion:(projection?.unitProjectionVersion??0)+1,confirmedAt:now};
  // Append only. Even old status/content is untouched by automatic inheritance.
  await trx('o_v04DirectorVersion').insert({...row,id:randomUUID()});
  await trx('o_v04DirectorProjection').insert({...row,id:randomUUID()});
  return evidence.continuity;
}
async function checkedProposal(
  trx: Knex.Transaction,
  scope: Scope,
  id: string,
) {
  const p = await trx("o_v04DirectorProposal")
    .where({ projectId: scope.projectId, scriptId: scope.scriptId, id })
    .first();
  if (!p)
    deny("DIRECTOR_PROPOSAL_NOT_FOUND", "找不到此制作单元的导演提案", 404);
  return p;
}
function validate(
  captured: Awaited<ReturnType<typeof capture>>,
  intent: unknown,
) {
  try {
    const result = compileDirectorCandidate(captured.state, intent).intent;
    for (const [field, rows] of [
      ["transformationLineage", result.transformationLineage],
      ["scaleRelations", result.scaleRelations],
    ] as const) {
      const seen = new Set<string>();
      for (const row of rows) {
        const key =
          field === "transformationLineage"
            ? JSON.stringify([
                (row as any).from,
                (row as any).to,
                (row as any).relationType,
              ])
            : JSON.stringify([
                (row as any).smaller,
                (row as any).larger,
                (row as any).kind,
                (row as any).shotRef,
              ]);
        if (seen.has(key))
          deny("DIRECTOR_CANDIDATE_INVALID", "导演关系重复，请检查候选", 422);
        seen.add(key);
      }
    }
    for (const edge of result.transformationLineage) {
      const target = captured.state.assets.find(
        (a) => a.canonicalKey === edge.to,
      );
      if (
        edge.relationType === "COMPOSITION_RESOLUTION" &&
        target &&
        ["BRAND", "UI"].includes(target.category) &&
        !captured.state.agentReferences.some(
          (r) => r.targetType === "ASSET_BIBLE" && r.targetKey === edge.to,
        )
      )
        deny(
          "DIRECTOR_REFERENCE_REQUIRED",
          "真实标识需要已有确认参考，不能仅凭对话或模型推断",
          422,
        );
    }
    return result;
  } catch (e) {
    if (e instanceof DirectorValidationError || e instanceof z.ZodError)
      deny("DIRECTOR_CANDIDATE_INVALID", "导演候选的结构或素材关系无效", 422);
    throw e;
  }
}
function diff(old: any, next: any, state: any) {
  const labels = {
    globalVisualDNA: "整体视觉",
    narrativeVisualRoles: "关键角色",
    scaleRelations: "尺度关系",
    transformationLineage: "视觉变形",
    emotionalArc: "情绪进程",
    shotDramaticIntents: "镜头意图",
  };
  return Object.entries(labels)
    .filter(
      ([key]) =>
        directorCanonical(old?.[key] ?? null) !== directorCanonical(next[key]),
    )
    .map(([key, label]) => ({
      section: key,
      label,
      before: old?.[key] ?? null,
      after: next[key],
      names:
        key === "narrativeVisualRoles"
          ? next[key]
              .filter(
                (r: any) =>
                  directorCanonical(
                    old?.[key]?.find(
                      (x: any) => x.canonicalKey === r.canonicalKey,
                    ) ?? null,
                  ) !== directorCanonical(r),
              )
              .map(
                (r: any) =>
                  state.assets.find(
                    (a: any) => a.canonicalKey === r.canonicalKey,
                  )?.name ?? "素材",
              )
          : [],
    }));
}
export async function proposeDirector(input: unknown, actor: number) {
  const data = proposalRequest.parse(input),
    scope = { projectId: data.projectId, scriptId: data.scriptId };
  const initial = await q.transaction(async (trx) => {
    await authorize(trx, scope, actor);
    const captured = await capture(trx, scope);
    let base: any = null;
    if (data.baseProposalId) {
      base = await checkedProposal(trx, scope, data.baseProposalId);
      // A confirmed proposal may be explicitly referenced as immutable history,
      // but is never returned as an active candidate or reactivated.
      if (base.status !== "CONFIRMED") await assertActiveDirectorProposal(trx, scope, base);
      if (base.sourceHash !== captured.sourceHash)
        deny("DIRECTOR_SOURCE_STALE", "影片来源已变化，请重新准备导演方向");
    }
    const current = await latest(trx, scope.projectId);
    if (
      data.baseDirectorVersion &&
      current?.directorVersion !== data.baseDirectorVersion
    )
      deny("DIRECTOR_VERSION_STALE", "导演版本已变化，请刷新");
    if (
      !base &&
      current &&
      current.scriptId === scope.scriptId
    )
      base = current;
    const requestContext = resolveDirectorContext(captured.state, data.userInstruction, data.selectedObject);
    const seed = !base && !current ? resolveProjectDirectorSeed(captured.state) : null;
    return { captured, base, current, requestContext, seed };
  });
  let model: any;
  try {
    model = await requireModel(scope.projectId, "text");
  } catch {
    deny("DIRECTOR_MODEL_FAILED", "文本模型不可用，请检查模型配置", 502);
  }
  const template = emptyDirectorIntent();
  const system = `You are a visual director / art director semantic planner, NOT screenwriter, asset generator or image prompt writer. Write human-facing descriptions in Chinese. Return exactly one JSON object matching the supplied semantic template; no executor syntax, seed, CFG, sampler, workflow, image generation. Creative facts, active canonical identity, confirmed appearance and REAL_REQUIRED reference win. Never invent story events or redesign costume, anatomy or identity. Supporting roles may remain unresolved/null. Existing proposal is the base: revise only user-requested direction and preserve other semantic sections. Emotional beats follow Creative, not a fixed count. BRAND/UI cannot be MATERIAL_TRANSFORMATION targets. Composition Resolution to a confirmed real reference is allowed. Preserve confirmed palettes. Project seed is scoped input, never global policy; accepted/base content is the revision base, user instruction changes only the requested direction, seed is used only for initial defaults. Follow the resolved revision scope: for SINGLE_ASSET return its revised Narrative Visual Role and leave every other section unchanged. Any inference is only a candidate. Template ${JSON.stringify(template)}. Field definitions: keys must refer to supplied active assets; relationType MATERIAL_TRANSFORMATION or COMPOSITION_RESOLUTION; scale kind RELATIVE/DRAMATIC/SHOT_SPECIFIC with shotRef null except for a real candidate clientRef; null storyboardId for unpersisted intentions. Narrative roles contain nullable narrativeFunction/emotionalRead/dramaticImportance/scaleFunction and string arrays requiredAudiencePerception/forbiddenInterpretations. All global DNA arrays are strings. Do not introduce unknown fields.`;
  let intent: any;
  try {
    const session = await u.Ai.Text(model).trackedSession();
    const result = await session.invoke({
      system,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                source: initial.captured.source,
                projectDirectorSeed: initial.seed,
                requestContext: initial.requestContext,
                baseProposal: initial.base ? content(initial.base) : null,
                currentAccepted: initial.current
                  ? {
                      content: content(initial.current),
                      sourceFresh:
                        initial.current.sourceHash ===
                        initial.captured.sourceHash,
                      originScriptId: initial.current.scriptId,
                    }
                  : null,
                userInstruction: data.userInstruction,
              }),
            },
          ],
        },
      ],
    });
    intent = validate(initial.captured, JSON.parse(oneObject(result.text)));
  } catch (e) {
    if (e instanceof PilotError) throw e;
    const id = randomUUID();
    console.error("[V04 Director]", {
      correlationId: id,
      errorName: e instanceof Error ? e.name : "Error",
      projectId: scope.projectId,
    });
    deny(
      e instanceof z.ZodError ||
        e instanceof SyntaxError ||
        String((e as any)?.name).includes("Semantic")
        ? "DIRECTOR_SCHEMA_FAILED"
        : "DIRECTOR_MODEL_FAILED",
      "导演提案未能可靠完成，请重试；现有方向没有改变",
      502,
    );
  }
  if (initial.base) {
    if (initial.requestContext.resolvedCanonicalKey) {
      const base = content(initial.base),
        key = initial.requestContext.resolvedCanonicalKey,
        role = intent.narrativeVisualRoles.find(
          (r: any) => r.canonicalKey === key,
        );
      if (!role)
        deny("DIRECTOR_CANDIDATE_INVALID", "目标素材的导演角色缺失", 422);
      const related = /关系|变形链|血缘|大小关系|比例关系/.test(data.userInstruction);
      const mergeEdges = (field: "scaleRelations" | "transformationLineage") => {
        const touches = (edge: any) => field === "scaleRelations"
          ? edge.smaller === key || edge.larger === key : edge.from === key || edge.to === key;
        return related ? [...base[field].filter((e: any) => !touches(e)), ...intent[field].filter(touches)] : base[field];
      };
      intent = validate(initial.captured, {
        ...base,
        scaleRelations: mergeEdges("scaleRelations"),
        transformationLineage: mergeEdges("transformationLineage"),
        narrativeVisualRoles: [
          ...base.narrativeVisualRoles.filter(
            (r: any) => r.canonicalKey !== key,
          ),
          role,
        ].sort((a: any, b: any) =>
          a.canonicalKey.localeCompare(b.canonicalKey),
        ),
      });
    }
  }
  const divided = parts(intent),
    now = Date.now(),
    proposal = {
      id: randomUUID(),
      ...scope,
      sourceCreativeVersion: initial.captured.sourceCreativeVersion,
      sourceHash: initial.captured.sourceHash,
      candidateHash: candidateHash(initial.captured.sourceHash, intent),
      schemaVersion,
      compilerVersion,
      projectBibleJson: JSON.stringify(divided.projectBible),
      unitProjectionJson: JSON.stringify(divided.unitProjection),
      evidenceJson: JSON.stringify({
        assetRevisions: initial.captured.source.assets.map((a) => ({
          canonicalKey: a.canonicalKey,
          revision: a.revision,
        })),
        truthConstraints: initial.captured.source,
        provenance: {
          source: "SOURCE_DERIVED",
          interpretation: "DIRECTOR_INFERENCE",
          userInstruction: "USER_CONFIRMED",
        },
        userInstruction: data.userInstruction,
        appearancePolicy: "PRESERVE_CONFIRMED",
        authority: "VISUAL_INTERPRETATION_ONLY",
        projectDirectionSources: initial.seed?.projectDirectionSources ?? (initial.base ? [{ type: "DIRECTOR_BASE", sourceId: initial.base.id, scope: "PROJECT" }] : initial.current ? [{ type: "ACCEPTED_DIRECTOR", sourceId: initial.current.id, scope: "PROJECT" }] : []),
        projectDirectorSeed: initial.seed,
        requestContext: initial.requestContext,
      }),
      status: "DRAFT",
      createdAt: now,
      updatedAt: now,
      actorUserId: actor,
      baseProposalId: data.baseProposalId ?? null,
      baseDirectorVersion: initial.current?.directorVersion ?? null,
      previewHash: null,
      diffJson: JSON.stringify(
        diff(
          initial.base ? content(initial.base) : null,
          intent,
          initial.captured.state,
        ),
      ),
    };
  return q.transaction(async (trx) => {
    await authorize(trx, scope, actor);
    const fresh = await capture(trx, scope);
    if (fresh.sourceHash !== proposal.sourceHash)
      deny("DIRECTOR_SOURCE_STALE", "生成期间影片来源已变化，请重新准备");
    if (data.baseProposalId) {
      const base = await checkedProposal(trx, scope, data.baseProposalId);
      if (base.status !== "CONFIRMED") await assertActiveDirectorProposal(trx, scope, base);
    }
    await trx("o_v04DirectorProposal").insert(proposal);
    return present(proposal);
  });
}
function previewIdentity(p: any, captured: any, current: any) {
  return hash({
    schemaVersion,
    compilerVersion,
    projectId: p.projectId,
    scriptId: p.scriptId,
    sourceHash: captured.sourceHash,
    candidateHash: p.candidateHash,
    currentDirectorVersion: current?.directorVersion ?? null,
    assetRevisions: captured.source.assets.map((a: any) => ({
      canonicalKey: a.canonicalKey,
      revision: a.revision,
    })),
  });
}
function verify(p: any, captured: any) {
  if (
    p.sourceHash !== captured.sourceHash ||
    p.sourceCreativeVersion !== captured.sourceCreativeVersion
  )
    deny(
      "DIRECTOR_SOURCE_STALE",
      "影片创意或素材已变化，这版导演方向需要重新准备",
    );
  const intent = validate(captured, content(p));
  if (candidateHash(captured.sourceHash, intent) !== p.candidateHash)
    deny("DIRECTOR_CANDIDATE_CHANGED", "导演候选已变化，请重新预览");
  return intent;
}
export async function previewDirector(input: unknown, actor: number) {
  const data = proposalCommand.parse(input);
  return q.transaction(async (trx) => {
    await authorize(trx, data, actor);
    const p = await checkedProposal(trx, data, data.proposalId);
    await assertActiveDirectorProposal(trx, data, p);
    const captured = await capture(trx, data);
    verify(p, captured);
    const current = await latest(trx, data.projectId),
      previewHash = previewIdentity(p, captured, current);
    await trx("o_v04DirectorProposal")
      .where({ id: p.id })
      .update({ status: "PREVIEWED", previewHash, updatedAt: Date.now() });
    return {
      proposalId: p.id,
      previewHash,
      candidateHash: p.candidateHash,
      diff: diff(current ? content(current) : null, content(p), captured.state),
      sourceCreativeVersion: captured.sourceCreativeVersion,
      currentDirectorVersion: current?.directorVersion ?? null,
      affectsGeneration: false,
    };
  });
}
export async function confirmDirector(input: unknown, actor: number) {
  const data = confirmation.parse(input);
  try {
    return await q.transaction(async (trx) => {
      // First write is confined to the proposal table: acquire SQLite's writer before source capture.
      await trx("o_v04DirectorProposal")
        .where({
          id: data.proposalId,
          projectId: data.projectId,
          scriptId: data.scriptId,
        })
        .update({ status: trx.raw("status") });
      await authorize(trx, data, actor);
      const p = await checkedProposal(trx, data, data.proposalId);
      const prior = await trx("o_v04DirectorVersion")
        .where({ proposalId: p.id })
        .first();
      if (prior) {
        if (prior.previewHash !== data.previewHash)
          deny("DIRECTOR_CONFIRM_CONFLICT", "此提案已经用不同的预览确认");
        return {
          directorVersion: prior.directorVersion,
          unitProjectionVersion: prior.unitProjectionVersion,
          delivery: "REPLAYED",
          affectsGeneration: false,
        };
      }
      await assertActiveDirectorProposal(trx, data, p);
      if (p.status !== "PREVIEWED" || p.previewHash !== data.previewHash)
        deny("DIRECTOR_PREVIEW_REQUIRED", "请先预览这版导演方向");
      const captured = await capture(trx, data);
      verify(p, captured);
      const current = await latest(trx, data.projectId);
      if (previewIdentity(p, captured, current) !== data.previewHash)
        deny("DIRECTOR_PREVIEW_STALE", "当前导演版本或来源已变化，请重新预览");
      const directorVersion = (current?.directorVersion ?? 0) + 1,
        lastProjection = await trx("o_v04DirectorProjection")
          .where({ projectId: data.projectId, scriptId: data.scriptId })
          .orderBy("unitProjectionVersion", "desc")
          .first(),
        unitProjectionVersion =
          (lastProjection?.unitProjectionVersion ?? 0) + 1,
        now = Date.now();
      if (current) {
        await trx("o_v04DirectorVersion")
          .where({ id: current.id })
          .update({ status: "SUPERSEDED" });
        await trx("o_v04DirectorProjection")
          .where({
            projectId: data.projectId,
            directorVersion: current.directorVersion,
          })
          .update({ status: "SUPERSEDED" });
      }
      const accepted = {
        id: randomUUID(),
        projectId: data.projectId,
        scriptId: data.scriptId,
        directorVersion,
        unitProjectionVersion,
        proposalId: p.id,
        sourceCreativeVersion: p.sourceCreativeVersion,
        sourceHash: p.sourceHash,
        candidateHash: p.candidateHash,
        schemaVersion,
        compilerVersion,
        projectBibleJson: p.projectBibleJson,
        unitProjectionJson: p.unitProjectionJson,
        evidenceJson: p.evidenceJson,
        status: "CURRENT",
        previewHash: data.previewHash,
        actorUserId: actor,
        createdAt: now,
        updatedAt: now,
        confirmedAt: now,
      };
      await trx("o_v04DirectorVersion").insert(accepted);
      await trx("o_v04DirectorProjection").insert({
        ...accepted,
        id: randomUUID(),
      });
      await trx("o_v04DirectorProposal")
        .where({ id: p.id })
        .update({ status: "CONFIRMED", updatedAt: now });
      await finalizeDirectorAncestors(trx, data, p.id, now);
      return {
        directorVersion,
        unitProjectionVersion,
        delivery: "APPLIED",
        affectsGeneration: false,
      };
    });
  } catch (e: any) {
    if (/SQLITE_BUSY|SQLITE_LOCKED/.test(e?.code ?? ""))
      deny(
        "DIRECTOR_CONCURRENT_UPDATE",
        "正在处理其他确认，请使用同一提案和预览重试",
      );
    throw e;
  }
}
export async function readDirector(input: unknown, actor: number) {
  const scope = scopeSchema.parse(input);
  return q.transaction(async (trx) => {
    await authorize(trx, scope, actor);
    const captured = await capture(trx, scope),
      current = await latest(trx, scope.projectId);
    let accepted = null;
    if (current) {
      const original =
        current.scriptId === scope.scriptId
          ? captured
          : await capture(trx, { ...scope, scriptId: current.scriptId });
      accepted = present(
        current,
        original.sourceHash === current.sourceHash ? "CURRENT" : "STALE",
      );
      if (current.scriptId !== scope.scriptId)
        accepted.unitProjection = { emotionalArc: [], shotDramaticIntents: [] };
      accepted.staleReason =
        accepted.status === "STALE"
          ? "影片创意或素材来源已变化，需要重新确认"
          : null;
    }
    const obsolete = await confirmedDirectorAncestors(trx, scope);
    let pending = trx("o_v04DirectorProposal")
      .where(scope)
      .whereIn("status", ["DRAFT", "PREVIEWED"])
      .where({ sourceHash: captured.sourceHash, sourceCreativeVersion: captured.sourceCreativeVersion });
    if (obsolete.size) pending = pending.whereNotIn("id", [...obsolete]);
    const p = await pending
      .orderBy("createdAt", "desc")
      .orderBy("id")
      .first();
    return {
      accepted,
      proposal: p ? present(p) : null,
      unitProjection: current
        ? ((await trx("o_v04DirectorProjection")
            .where({
              projectId: scope.projectId,
              scriptId: scope.scriptId,
              directorVersion: current.directorVersion,
            })
            .first()) ?? null)
        : null,
      assetNames: captured.source.assets.map((a) => ({
        canonicalKey: a.canonicalKey,
        name: a.name,
      })),
      affectsGeneration: false,
    };
  });
}
export async function directorHistory(input: unknown, actor: number) {
  const request = scopeSchema
      .extend({
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).max(10000).default(0),
      })
      .strict()
      .parse(input),
    scope = { projectId: request.projectId, scriptId: request.scriptId };
  return q.transaction(async (trx) => {
    await authorize(trx, scope, actor);
    const current = await latest(trx, scope.projectId);
    let newestStatus = "CURRENT";
    if (current) {
      const captured = await capture(trx, {
        projectId: scope.projectId,
        scriptId: current.scriptId,
      });
      newestStatus =
        captured.sourceHash === current.sourceHash ? "CURRENT" : "STALE";
    }
    const rows = await trx("o_v04DirectorVersion")
        .where({ projectId: scope.projectId })
        .orderBy("directorVersion", "desc")
        .limit(request.limit + 1)
        .offset(request.offset),
      projections = await trx("o_v04DirectorProjection")
        .where(scope)
        .orderBy("unitProjectionVersion", "desc")
        .limit(request.limit + 1)
        .offset(request.offset);
    const proposalSource = await capture(trx, scope),
      obsolete = await confirmedDirectorAncestors(trx, scope),
      proposals = await trx("o_v04DirectorProposal").where(scope)
        .orderBy("createdAt", "desc").orderBy("id").limit(request.limit + 1).offset(request.offset);
    return {
      proposals: proposals.slice(0, request.limit).map(p => present(p,
        ["DRAFT", "PREVIEWED"].includes(p.status) ? obsolete.has(p.id) ? "SUPERSEDED" :
          p.sourceHash === proposalSource.sourceHash ? p.status : "STALE" : p.status)),
      hasMoreProposals: proposals.length > request.limit,
      versions: rows
        .slice(0, request.limit)
        .map((r) =>
          present(
            r,
            r.directorVersion === current?.directorVersion
              ? newestStatus
              : "SUPERSEDED",
          ),
        ),
      projections: projections
        .slice(0, request.limit)
        .map((r) =>
          present(
            r,
            r.directorVersion === current?.directorVersion
              ? newestStatus
              : "SUPERSEDED",
          ),
        ),
      hasMoreVersions: rows.length > request.limit,
      hasMoreProjections: projections.length > request.limit,
      offset: request.offset,
      limit: request.limit,
      affectsGeneration: false,
    };
  });
}
export async function rejectDirector(input: unknown, actor: number) {
  const data = proposalCommand.parse(input);
  return q.transaction(async (trx) => {
    await authorize(trx, data, actor);
    const p = await checkedProposal(trx, data, data.proposalId);
    await assertActiveDirectorProposal(trx, data, p);
    await trx("o_v04DirectorProposal")
      .where({ id: p.id })
      .update({ status: "REJECTED", updatedAt: Date.now() });
    return { rejected: true, affectsGeneration: false };
  });
}

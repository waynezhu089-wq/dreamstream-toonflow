import type { Knex } from "knex";
import u from "@/utils";
import { checkGate, type StageGateResult } from "./gateRegistry";
import { positiveId, ProfileError, versionNumber, type ProfileDefinition } from "./profileDefinition";
import { resolveProfile } from "./profileRegistry";

const db = () => u.db as Knex;
type PersistentState = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "SKIPPED";
type Availability = "READY" | "BLOCKED" | "ACTIVE" | "DONE";
type Action = "start" | "complete" | "skip";
type StageView = { stageKey: string; displayName: string; description: string; required: boolean; allowSkip: boolean; uiOrder: number; persistentState: PersistentState; availability: Availability; predecessorKeys: string[]; nextStageKeys: string[]; entryGate: StageGateResult; exitGate: StageGateResult; blockerReasons: string[] };

function ids(input: unknown) { return { projectId: positiveId((input as any)?.projectId), scriptId: positiveId((input as any)?.scriptId) }; }
async function scope(input: unknown, q: Knex | Knex.Transaction = db()) {
  const { projectId, scriptId } = ids(input);
  if (!await q("o_project").where({ id: projectId }).first() || !await q("o_script").where({ id: scriptId, projectId }).first()) throw new ProfileError("PROFILE_SCOPE_INVALID", "制作单元不存在或不属于当前项目", 404);
  const profile = await resolveProfile({ projectId }, q);
  if (!profile.managed) throw new ProfileError("PROFILE_NOT_FOUND", "当前项目尚未由 Production Profile 管理", 409);
  return { projectId, scriptId, profile };
}
function graph(definition: ProfileDefinition) {
  const incoming = new Map(definition.stages.map(stage => [stage.stageKey, [] as string[]]));
  const outgoing = new Map(definition.stages.map(stage => [stage.stageKey, [] as string[]]));
  for (const edge of definition.transitions) { incoming.get(edge.toStageKey)!.push(edge.fromStageKey); outgoing.get(edge.fromStageKey)!.push(edge.toStageKey); }
  return { incoming, outgoing };
}
export async function readOrchestrator(input: unknown) {
  const { projectId, scriptId, profile } = await scope(input);
  const definition = profile.definition, version = versionNumber(profile.version);
  const rows = await db()("o_stageRun").where({ projectId, scriptId, profileKey: profile.profileKey, profileVersion: version });
  const state = new Map<string, PersistentState>(rows.map(row => [row.stageKey, row.state as PersistentState]));
  const { incoming, outgoing } = graph(definition);
  const stages: StageView[] = [];
  for (const stage of [...definition.stages].sort((a, b) => a.uiOrder - b.uiOrder)) {
    const persistentState = state.get(stage.stageKey) ?? "PENDING";
    const predecessorKeys = incoming.get(stage.stageKey)!;
    const nextStageKeys = outgoing.get(stage.stageKey)!;
    const context = { projectId, scriptId, profileKey: profile.profileKey, profileVersion: profile.version, stageKey: stage.stageKey };
    const entryGate = await checkGate(stage.entryGateKey, context);
    const exitGate = await checkGate(stage.exitGateKey, context);
    const blockerReasons: string[] = [];
    if (persistentState === "PENDING") {
      const unfinished = predecessorKeys.filter(key => !["COMPLETED", "SKIPPED"].includes(state.get(key) ?? "PENDING"));
      if (unfinished.length) blockerReasons.push(`前置工序未完成：${unfinished.join("、")}`);
      if (!entryGate.pass) blockerReasons.push(`${entryGate.code}: ${entryGate.reason ?? "入口 Gate 未通过"}`);
    } else if (persistentState === "IN_PROGRESS" && !exitGate.pass) blockerReasons.push(`${exitGate.code}: ${exitGate.reason ?? "出口 Gate 未通过"}`);
    const availability: Availability = persistentState === "PENDING" ? blockerReasons.length ? "BLOCKED" : "READY" : persistentState === "IN_PROGRESS" ? "ACTIVE" : "DONE";
    stages.push({ ...stage, persistentState, availability, predecessorKeys, nextStageKeys, entryGate, exitGate, blockerReasons });
  }
  const keys = (filter: (stage: StageView) => boolean) => stages.filter(filter).map(stage => stage.stageKey);
  return {
    profile: { profileKey: profile.profileKey, version: profile.version, status: profile.status, source: profile.source, persisted: profile.persisted },
    productionUnit: { projectId, scriptId }, stages,
    readyStages: keys(stage => stage.availability === "READY"), blockedStages: keys(stage => stage.availability === "BLOCKED"),
    inProgressStages: keys(stage => stage.persistentState === "IN_PROGRESS"), completedStages: keys(stage => stage.persistentState === "COMPLETED"), skippedStages: keys(stage => stage.persistentState === "SKIPPED"),
  };
}

function transitionError(error: unknown): never {
  if (error instanceof ProfileError) throw error;
  if (String((error as any)?.code).includes("SQLITE_BUSY") || String((error as any)?.code).includes("CONSTRAINT")) throw new ProfileError("STAGE_TRANSITION_INVALID", "Stage 状态已被其他操作更新，请刷新", 409);
  throw error;
}
export async function actOnStage(action: Action, input: unknown) {
  const { projectId, scriptId } = ids(input), stageKey = (input as any)?.stageKey;
  if (typeof stageKey !== "string" || !/^[a-z][a-z0-9_-]*$/.test(stageKey)) throw new ProfileError("STAGE_NOT_FOUND", "请选择有效 Stage", 404);
  const actorType = (input as any)?.actorType ?? "HUMAN", reason = (input as any)?.reason ?? null;
  if (!["HUMAN", "SYSTEM"].includes(actorType) || !(reason === null || typeof reason === "string" && reason.length <= 4000)) throw new ProfileError("STAGE_TRANSITION_INVALID", "Stage 操作人或原因不合法");
  // Gate reads use the existing V0.2 snapshot transaction, outside this mutation transaction.
  const snapshot = await readOrchestrator({ projectId, scriptId });
  const stage = snapshot.stages.find(row => row.stageKey === stageKey);
  if (!stage) throw new ProfileError("STAGE_NOT_FOUND", "Stage 不存在", 404);
  if (["COMPLETED", "SKIPPED"].includes(stage.persistentState)) throw new ProfileError("STAGE_ALREADY_DONE", "Stage 已完成或跳过", 409);
  if (action === "start" && stage.availability !== "READY") throw new ProfileError(stage.entryGate.pass ? "STAGE_NOT_READY" : stage.entryGate.code, stage.blockerReasons.join("；") || "Stage 尚未就绪", 409);
  if (action === "complete" && stage.persistentState !== "IN_PROGRESS") throw new ProfileError("STAGE_TRANSITION_INVALID", "请先开始此 Stage", 409);
  if (action === "complete" && !stage.exitGate.pass) throw new ProfileError(stage.exitGate.code === "GATE_ADAPTER_NOT_REGISTERED" || stage.exitGate.code === "STAGE_GATE_UNAVAILABLE" ? stage.exitGate.code : "STAGE_GATE_BLOCKED", `${stage.exitGate.code}: ${stage.exitGate.reason ?? "Gate 未通过"}`, 409);
  if (action === "skip") {
    if (stage.required || !stage.allowSkip) throw new ProfileError("STAGE_SKIP_NOT_ALLOWED", "此 Stage 不允许跳过", 409);
    if (stage.persistentState === "PENDING" && stage.availability !== "READY") throw new ProfileError("STAGE_NOT_READY", stage.blockerReasons.join("；") || "Stage 尚未就绪，不能跳过", 409);
    if (stage.persistentState === "IN_PROGRESS" && (actorType !== "HUMAN" || !String(reason ?? "").trim())) throw new ProfileError("STAGE_SKIP_NOT_ALLOWED", "进行中的 Stage 只能由真人填写原因后跳过", 409);
  }
  const fromState = stage.persistentState;
  const toState: PersistentState = action === "start" ? "IN_PROGRESS" : action === "complete" ? "COMPLETED" : "SKIPPED";
  const version = versionNumber(snapshot.profile.version), now = Date.now();
  try {
    await db().transaction(async trx => {
      const current = await scope({ projectId, scriptId }, trx);
      if (current.profile.profileKey !== snapshot.profile.profileKey || current.profile.version !== snapshot.profile.version) throw new ProfileError("STAGE_TRANSITION_INVALID", "项目 Profile 已变化，请刷新", 409);
      const where = { projectId, scriptId, profileKey: snapshot.profile.profileKey, profileVersion: version, stageKey };
      if (fromState === "PENDING") await trx("o_stageRun").insert({ ...where, state: "PENDING", startedAt: null, completedAt: null, skippedAt: null, updatedAt: now, lastReason: null }).onConflict(["projectId", "scriptId", "profileKey", "profileVersion", "stageKey"]).ignore();
      const mutation: any = { state: toState, updatedAt: now, lastReason: reason };
      if (action === "start") mutation.startedAt = now;
      if (action === "complete") mutation.completedAt = now;
      if (action === "skip") mutation.skippedAt = now;
      const changed = await trx("o_stageRun").where({ ...where, state: fromState }).update(mutation);
      if (changed !== 1) throw new ProfileError("STAGE_TRANSITION_INVALID", "Stage 状态已变化，请刷新", 409);
      await trx("o_stageEvent").insert({ ...where, eventType: action.toUpperCase(), fromState, toState, reason, actorType, createdAt: now });
    });
  } catch (error) { transitionError(error); }
  return readOrchestrator({ projectId, scriptId });
}
export async function stageEvents(input: unknown) {
  const { projectId, scriptId, profile } = await scope(input);
  return db()("o_stageEvent").where({ projectId, scriptId, profileKey: profile.profileKey, profileVersion: versionNumber(profile.version) }).orderBy("id", "asc");
}

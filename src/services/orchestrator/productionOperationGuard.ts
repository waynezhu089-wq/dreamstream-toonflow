import type { Knex } from "knex";
import u from "@/utils";
import { ProductionGateError } from "@/services/advertisementGate";
import { checkGate, type StageGateResult } from "@/services/orchestrator/gateRegistry";
import { positiveId, versionNumber } from "@/services/orchestrator/profileDefinition";
import { resolveProfile } from "@/services/orchestrator/profileRegistry";
import type { ProductionOperationKey } from "@/services/orchestrator/productionOperationRegistry";

type GateRead = { gateKey: string; stageKey: string; boundary: "ENTRY" | "EXIT"; result: StageGateResult };
export type OperationAdmission = {
  enforced: boolean; snapshotConsistent: boolean; operationKey: ProductionOperationKey;
  profileKey: string | null; profileVersion: string | null; schemaVersion: number | null;
  stageKey: string | null; stageState: string | null; gates: GateRead[];
  allowed: boolean; code: string; reason: string | null;
};

export async function readProductionOperationAdmission(operationKey: ProductionOperationKey, input: { projectId: number; scriptId: number }): Promise<OperationAdmission> {
  const projectId = positiveId(input.projectId), scriptId = positiveId(input.scriptId);
  try {
    // Every enforced decision, including nested Asset and Supervisor Gate reads,
    // uses this single SQLite snapshot. No control read may escape through u.db.
    return await (u.db as Knex).transaction(async trx => {
      if (!await trx("o_script").where({ id: scriptId, projectId }).first()) throw new Error("Production unit missing");
      const profile = await resolveProfile({ projectId }, trx);
      const base: OperationAdmission = {
        enforced: false, snapshotConsistent: false, operationKey,
        profileKey: profile.managed ? profile.profileKey : null,
        profileVersion: profile.managed ? profile.version : null,
        schemaVersion: profile.managed ? profile.definition.schemaVersion : null,
        stageKey: null, stageState: null, gates: [], allowed: true,
        code: "LEGACY_ADVISORY", reason: null,
      };
      if (!profile.managed || profile.definition.schemaVersion === 1) return base;
      base.enforced = true;
      base.snapshotConsistent = true;
      const definition = profile.definition;
      const owners = definition.stages.filter(stage => stage.operationKeys.includes(operationKey));
      const block = (code: string, reason: string): OperationAdmission => ({ ...base, allowed: false, code, reason });
      if (owners.length !== 1) return block("PRODUCTION_OPERATION_NOT_DECLARED", `当前 Profile 没有唯一声明生产操作 ${operationKey}`);
      const stage = owners[0];
      base.stageKey = stage.stageKey;
      const run = await trx("o_stageRun").where({ projectId, scriptId, profileKey: profile.profileKey, profileVersion: versionNumber(profile.version), stageKey: stage.stageKey }).first();
      base.stageState = run?.state ?? "PENDING";
      if (base.stageState === "PENDING") return block("PRODUCTION_STAGE_NOT_ACTIVE", `请先开始 ${stage.displayName}`);
      if (base.stageState !== "IN_PROGRESS") return block("PRODUCTION_STAGE_REOPEN_REQUIRED", `${stage.displayName} 已结束，需要显式重新打开`);

      const stageByKey = new Map(definition.stages.map(item => [item.stageKey, item]));
      const ancestors = new Set<string>();
      const visit = (key: string) => {
        for (const edge of definition.transitions) if (edge.toStageKey === key && !ancestors.has(edge.fromStageKey)) {
          ancestors.add(edge.fromStageKey);
          visit(edge.fromStageKey);
        }
      };
      visit(stage.stageKey);
      const ancestorStages = [...ancestors].map(key => stageByKey.get(key)!).sort((a, b) => a.uiOrder - b.uiOrder);
      const runs = await trx("o_stageRun").where({ projectId, scriptId, profileKey: profile.profileKey, profileVersion: versionNumber(profile.version) }).whereIn("stageKey", [...ancestors]);
      const state = new Map<string, string>(runs.map(row => [row.stageKey, row.state]));
      const unfinished = ancestorStages.filter(item => {
        const value = state.get(item.stageKey) ?? "PENDING";
        return value !== "COMPLETED" && !(value === "SKIPPED" && item.allowSkip && !item.required);
      });
      if (unfinished.length) return block("PRODUCTION_STAGE_DEPENDENCY_BLOCKED", `前置工序未完成：${unfinished.map(item => item.displayName).join("、")}`);

      const seen = new Set<string>();
      for (const item of [...ancestorStages, stage]) {
        const boundaries: Array<["ENTRY" | "EXIT", string | null]> = item.stageKey === stage.stageKey
          ? [["ENTRY", item.entryGateKey]] : [["ENTRY", item.entryGateKey], ["EXIT", item.exitGateKey]];
        for (const [boundary, gateKey] of boundaries) {
          if (!gateKey || seen.has(gateKey)) continue;
          seen.add(gateKey);
          const result = await checkGate(gateKey, { projectId, scriptId, profileKey: profile.profileKey, profileVersion: profile.version, stageKey: item.stageKey }, trx);
          base.gates.push({ gateKey, stageKey: item.stageKey, boundary, result });
        }
      }
      const failed = base.gates.find(gate => !gate.result.pass);
      return failed ? block(failed.result.code, failed.result.reason ?? `Gate ${failed.gateKey} 未通过`) : { ...base, code: "PRODUCTION_OPERATION_ALLOWED" };
    });
  } catch {
    return { enforced: true, snapshotConsistent: false, operationKey, profileKey: null, profileVersion: null,
      schemaVersion: null, stageKey: null, stageState: null, gates: [], allowed: false,
      code: "PRODUCTION_CONTROL_UNAVAILABLE", reason: "当前生产控制状态不可用，请稍后重试" };
  }
}

export async function assertProductionOperationAllowed(operationKey: ProductionOperationKey, input: { projectId: number; scriptId: number }) {
  const admission = await readProductionOperationAdmission(operationKey, input);
  if (!admission.allowed) throw new ProductionGateError(admission.reason ?? "生产工序尚未放行", admission.code, admission.code === "PRODUCTION_CONTROL_UNAVAILABLE" ? 503 : 409);
  return admission;
}

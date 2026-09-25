import { readState } from "@/services/advertisementGate";
import { supervisorStageGate } from "@/services/supervisor/review";

export type StageGateContext = { projectId: number; scriptId: number; profileKey: string; profileVersion: string; stageKey: string };
export type StageGateResult = { pass: boolean; code: string; reason: string | null; details?: unknown };
export type GateAdapter = (context: StageGateContext) => Promise<StageGateResult>;
const adapters = new Map<string, GateAdapter>();

export function registerGate(key: string, adapter: GateAdapter) { adapters.set(key, adapter); }
export async function checkGate(key: string | null, context: StageGateContext): Promise<StageGateResult> {
  if (key === null) return { pass: true, code: "NO_GATE", reason: null };
  const adapter = adapters.get(key);
  if (!adapter) return { pass: false, code: "GATE_ADAPTER_NOT_REGISTERED", reason: `Gate ${key} 尚未注册` };
  try {
    const result = await adapter(context);
    if (!result || typeof result.pass !== "boolean" || typeof result.code !== "string" || !result.code || !(typeof result.reason === "string" || result.reason === null)) throw new Error("Untrusted gate result");
    return result;
  } catch {
    return { pass: false, code: "STAGE_GATE_UNAVAILABLE", reason: `Gate ${key} 暂时不可用，请稍后重试` };
  }
}

registerGate("advertisement.asset-ready", async context => {
  const state = await readState(context.projectId, context.scriptId);
  if (state.ready === true) return { pass: true, code: "ADVERTISEMENT_ASSET_READY", reason: null, details: state };
  const missing = state.incompleteAssets.map(item => item.name).filter(Boolean);
  const reason = !state.prepared ? (state.assetCount === 0 ? "素材清单为空，请先填写并准备必需素材" : missing.length ? `必需素材尚未准备：${missing.join("、")}` : "广告资产准备尚未完成") : "素材已准备，请先人工确认资产准备完成";
  return { pass: false, code: "ADVERTISEMENT_ASSET_GATE_BLOCKED", reason, details: state };
});
registerGate("supervisor.storyboard-approved", context => supervisorStageGate("supervisor.storyboard-approved", context));

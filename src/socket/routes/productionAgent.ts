import jwt from "jsonwebtoken";
import u from "@/utils";
import { Namespace, Socket } from "socket.io";
import * as agent from "@/agents/productionAgent/index";
import ResTool from "@/socket/resTool";
import { assertProductionReady, gateFailure, ProductionGateError } from "@/services/advertisementGate";

async function verifyToken(rawToken: string): Promise<Boolean> {
  const setting = await u.db("o_setting").where("key", "tokenKey").select("value").first();
  if (!setting) return false;
  const { value: tokenKey } = setting;
  if (!rawToken) return false;
  const token = rawToken.replace("Bearer ", "");
  try {
    jwt.verify(token, tokenKey as string);
    return true;
  } catch (err) {
    return false;
  }
}

export default (nsp: Namespace) => {
  // Complete authentication and Gate checks before accepting the namespace.
  // Otherwise a client can emit chat while asynchronous setup has no handlers.
  nsp.use(async (socket, next) => {
    try {
      const { token, isolationKey } = socket.handshake.auth;
      if (typeof token !== "string" || !(await verifyToken(token))) {
        throw new ProductionGateError("连接失败，token无效", "PRODUCTION_UNAUTHORIZED", 401);
      }
      if (typeof isolationKey !== "string" || !isolationKey) throw new ProductionGateError("缺少制作会话标识");
      await assertProductionReady(socket.handshake.auth.projectId, socket.handshake.auth.scriptId);
      next();
    } catch (error) {
      const failure = gateFailure(error);
      next(Object.assign(new Error(failure.message), { data: failure }));
    }
  });
  nsp.on("connection", (socket: Socket) => {
    let isolationKey = socket.handshake.auth.isolationKey;
    console.log("[productionAgent] 已连接:", socket.id);

    let resTool = new ResTool(socket, {
      projectId: socket.handshake.auth.projectId,
      scriptId: socket.handshake.auth.scriptId,
    });
    let abortController: AbortController | null = null;
    let contextReady = true;
    let contextVersion = 0;
    let requestVersion = 0;

    const thinkConfig: agent.AgentContext["thinkConfig"] = {
      think: false,
      thinlLevel: 0,
    };

    socket.on("updateContext", async (data: { isolationKey: string; projectId: number; scriptId: number }, callback) => {
      const version = ++contextVersion;
      ++requestVersion;
      contextReady = false;
      abortController?.abort();
      abortController = null;
      try {
        if (!data || typeof data.isolationKey !== "string" || !data.isolationKey) throw new ProductionGateError("缺少制作会话标识");
        await assertProductionReady(data.projectId, data.scriptId);
        if (version !== contextVersion || !socket.connected) throw new ProductionGateError("制作上下文已变更，请重试");
        isolationKey = data.isolationKey;
        resTool = new ResTool(socket, { projectId: data.projectId, scriptId: data.scriptId });
        contextReady = true;
        console.log("[productionAgent] 上下文已更新:", isolationKey);
        if (typeof callback === "function") callback({ success: true });
      } catch (error) {
        const failure = gateFailure(error);
        if (version === contextVersion) socket.emit("error", failure);
        if (typeof callback === "function") callback(failure);
      }
    });

    socket.on("chat", async (data: { content: string }, callback) => {
      const version = contextVersion;
      const request = ++requestVersion;
      const currentTool = resTool;
      const currentIsolationKey = isolationKey;
      try {
        if (!contextReady) throw new ProductionGateError("当前制作单元尚未通过门禁校验");
        await assertProductionReady(currentTool.data.projectId, currentTool.data.scriptId);
        if (version !== contextVersion || request !== requestVersion || !contextReady || !socket.connected) {
          throw new ProductionGateError("制作上下文已变更或请求已停止，请重试");
        }
      } catch (error) {
        const failure = gateFailure(error);
        socket.emit("error", failure);
        if (typeof callback === "function") callback(failure);
        return;
      }
      const { content } = data;
      abortController?.abort();
      abortController = new AbortController();
      const currentController = abortController;

      const msg = currentTool.newMessage("assistant", "视频策划");
      const ctx: agent.AgentContext = {
        socket,
        isolationKey: currentIsolationKey,
        text: content,
        userMessageTime: new Date(msg.datetime).getTime() - 1,
        abortSignal: currentController.signal,
        resTool: currentTool,
        msg,
        thinkConfig,
      };

      try {
        await agent.runDecisionAI(ctx);
        if (typeof callback === "function") callback({ success: true });
      } catch (err: any) {
        if (err instanceof ProductionGateError) {
          const failure = gateFailure(err);
          msg.error(failure.message);
          socket.emit("error", failure);
          if (typeof callback === "function") callback(failure);
        }
        if (err.name !== "AbortError" && !currentController.signal.aborted) {
          console.error("[productionAgent] chat error:", u.error(err).message);
        }
      } finally {
        if (abortController === currentController) {
          abortController = null;
        }
      }
    });

    socket.on("updateThinkConfig", (data: { think: boolean; thinlLevel: 0 | 1 | 2 | 3 }) => {
      thinkConfig.think = data.think;
      thinkConfig.thinlLevel = data.thinlLevel;
      console.log("[productionAgent] 更新思考配置:", thinkConfig);
    });

    socket.on("stop", () => {
      ++requestVersion;
      abortController?.abort();
      abortController = null;
    });
    socket.on("disconnect", () => {
      ++requestVersion;
      ++contextVersion;
      contextReady = false;
      abortController?.abort();
      abortController = null;
    });
  });
  nsp.on("disconnect", (socket: Socket) => {
    console.log("[productionAgent] 已断开连接:", socket.id);
  });
};

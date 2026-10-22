"use client";

import { useEffect, useRef, useState } from "react";
import {
    createCodexAgentClient, normalizeCodexEndpoint, readCodexAgentConfig, type CodexConnection, type CodexModel, type CodexRpcEvent, type CodexToolEvent,
} from "@/services/api/codex-agent";
import { canvasAgentSystemPrompt } from "@/services/api/canvas-agent";
import type { CanvasAgentState } from "../types";
import { canvasAgentAllowsArrangement, executeActions, type RunCanvasAgentInput, type RunCanvasAgentResult } from "./canvas-agent-runtime";
import { buildCanvasAgentSkillPrompt } from "./canvas-agent-skills";
import {
    CANVAS_AGENT_TOOLS, CANVAS_AGENT_SKILL_FILE_TOOL, normalizeCanvasAgentAction,
    type CanvasAgentAction, type CanvasAgentToolResult,
} from "./canvas-agent-tools";

type Client = ReturnType<typeof createCodexAgentClient>;
type RunInput = RunCanvasAgentInput & {
    threadId?: string; serviceId?: string; model?: string; effort?: string;
    onThread: (threadId: string, serviceId: string) => void; onText: (text: string) => void;
    onImageGenerated?: (dataUrl: string, prompt: string, signal?: AbortSignal) => Promise<void>;
};
type ActiveRun = {
    input: RunInput; state: CanvasAgentState; threadId?: string; turnId?: string;
    buffer: CodexRpcEvent[]; messages: Map<string, string>; imageTasks: Promise<void>[]; imageError?: Error; finishing?: boolean; finished: boolean; controller: AbortController;
    finish: (error?: Error) => void;
};
const CONNECTION_KEY = "canvas-codex-connection";
const defaultConnection = { endpoint: "http://127.0.0.1:3210", token: "" };
const agentTools = [...CANVAS_AGENT_TOOLS, CANVAS_AGENT_SKILL_FILE_TOOL]
    .filter(({ function: tool }) => tool.name !== "generate_image" && tool.name !== "edit_image")
    .map(({ function: tool }) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters }));
const stopped = () => new DOMException("Agent 已停止", "AbortError");

export function useCodexAgent(options: {
    canvasId: string;
    executeTool: (action: CanvasAgentAction, signal: AbortSignal) => Promise<CanvasAgentToolResult>;
    onApproval: (request: CodexRpcEvent, signal: AbortSignal) => Promise<unknown>;
    onBootstrap: () => void;
}) {
    const [connection, setConnectionState] = useState<CodexConnection>(defaultConnection);
    const [models, setModels] = useState<CodexModel[]>([]);
    const [status, setStatus] = useState<"idle" | "connecting" | "ready" | "error">("idle");
    const [error, setError] = useState("");
    const [retry, setRetry] = useState(0);
    const [enabled, setEnabled] = useState(true);
    const connectionAttempt = useRef(0);
    const client = useRef<Client | null>(null);
    const active = useRef<ActiveRun | null>(null);
    const dispatch = useRef<((event: CodexRpcEvent) => void) | null>(null);
    const latest = useRef(options);
    latest.current = options;
    const disconnect = () => {
        connectionAttempt.current += 1;
        active.current?.finish(stopped());
        client.current?.close();
        client.current = null;
        dispatch.current = null;
        setEnabled(false);
        setStatus("idle");
        setError("");
    };
    const connect = async (next: CodexConnection) => {
        disconnect();
        const attempt = connectionAttempt.current;
        setStatus("connecting");
        try {
            const value = { endpoint: normalizeCodexEndpoint(next.endpoint), token: next.token.trim() };
            if (!value.token) {
                await readCodexAgentConfig(value.endpoint);
                throw new Error("已发现本地 Agent，请使用插件自动连接，或手动填写 Token");
            }
            try { localStorage.setItem(CONNECTION_KEY, JSON.stringify(value)); } catch { /* 仍允许当前页面连接 */ }
            setConnectionState(value);
            setEnabled(true);
            setRetry((value) => value + 1);
            return true;
        } catch (reason) {
            if (connectionAttempt.current === attempt) {
                setError(reason instanceof Error ? reason.message : "连接本地 Agent 失败");
                setStatus("error");
            }
            return false;
        }
    };
    useEffect(() => {
        try {
            const stored = JSON.parse(localStorage.getItem(CONNECTION_KEY) || "null");
            if (stored && typeof stored.endpoint === "string" && typeof stored.token === "string") setConnectionState(stored);
        } catch { /* 本地配置不可用时使用默认值 */ }
        const bootstrap = () => {
            const hash = window.location.hash.slice(1);
            const params = new URLSearchParams(hash);
            if (!params.has("agentUrl") && !params.has("agentToken")) return;
            const remaining = hash.split("&").filter((part) => !["agentUrl", "agentToken"].includes(new URLSearchParams(part).keys().next().value || "")).join("&");
            window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search + (remaining ? "#" + remaining : ""));
            if (!params.get("agentUrl") || !params.get("agentToken")?.trim()) {
                disconnect();
                setError("自动连接链接缺少地址或 Token，请重新通过插件连接");
                setStatus("error");
                return;
            }
            void connect({ endpoint: params.get("agentUrl")!, token: params.get("agentToken")! }).then((connected) => {
                if (connected) latest.current.onBootstrap();
            });
        };
        bootstrap();
        window.addEventListener("hashchange", bootstrap);
        return () => { connectionAttempt.current += 1; window.removeEventListener("hashchange", bootstrap); };
    }, []);

    useEffect(() => {
        if (!enabled || !connection.token || !options.canvasId) return;
        try { normalizeCodexEndpoint(connection.endpoint); }
        catch (reason) { setError((reason as Error).message); setStatus("error"); return; }
        setStatus("connecting");
        setError("");
        let toolQueue = Promise.resolve();
        let approvalQueue = Promise.resolve();
        const approvals = new Map<string, AbortController>();
        const toolControllers = new Map<string, AbortController>();
        const failCodex = (reason: unknown, pending: ActiveRun | null) => {
            if (client.current !== link || pending?.finished) return;
            const error = reason instanceof Error ? reason : new Error("Codex 请求失败");
            setError(error.message);
            pending?.finish(error);
        };
        const fail = (reason: Error) => {
            if (client.current !== link) return;
            setError(reason.message);
            setStatus("error");
            active.current?.finish(reason);
            approvals.forEach((controller) => controller.abort());
            client.current = null;
            dispatch.current = null;
            link.close();
        };
        const handleRpc = (event: CodexRpcEvent) => {
            const pending = active.current;
            const params = event.params;
            if (event.method === "serverRequest/resolved") {
                approvals.get(String(params.requestId))?.abort();
                if (pending) pending.buffer = pending.buffer.filter((item) => String(item.id) !== String(params.requestId));
                return;
            }
            if (pending && pending.threadId && pending.threadId === params.threadId && !pending.turnId) { pending.buffer.push(event); return; }
            const belongs = pending && !pending.finished && pending.threadId === params.threadId && pending.turnId === (params.turnId || params.turn?.id);
            if (event.method === "bridge/disconnected") {
                failCodex(new Error(String(params.message || "Codex 连接已断开")), pending);
                approvals.forEach((controller) => controller.abort());
                return;
            }
            if (event.id !== undefined) {
                const supported = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput", "mcpServer/elicitation/request"].includes(event.method);
                if (!supported) { void link.reply(event, undefined, { code: -32601, message: "当前画布未支持此 Codex 请求" }).catch((reason) => failCodex(reason, pending)); return; }
                const controller = new AbortController();
                approvals.set(String(event.id), controller);
                approvalQueue = approvalQueue.then(async () => {
                    const denied = event.method === "item/permissions/requestApproval" ? { permissions: {}, scope: "turn" }
                        : event.method === "item/tool/requestUserInput" ? { answers: {} }
                        : event.method === "mcpServer/elicitation/request" ? { action: "decline", content: null } : { decision: "decline" };
                    try {
                        if (controller.signal.aborted) return;
                        const result = belongs && !pending.finished
                            ? await latest.current.onApproval(event, AbortSignal.any([pending.controller.signal, controller.signal])) : denied;
                        if (!controller.signal.aborted) await link.reply(event, pending?.finished ? denied : result);
                    } finally { if (approvals.get(String(event.id)) === controller) approvals.delete(String(event.id)); }
                }).catch((reason) => failCodex(reason, pending));
                return;
            }
            if (!belongs) return;
            if (event.method === "item/agentMessage/delta" && params.itemId) {
                pending.messages.set(params.itemId, (pending.messages.get(params.itemId) || "") + (params.delta || ""));
                pending.input.onText([...pending.messages.values()].join("\n\n"));
            } else if (event.method === "item/completed" && params.item?.type === "agentMessage") {
                pending.messages.set(params.item.id, params.item.text || "");
                pending.input.onText([...pending.messages.values()].join("\n\n"));
            } else if (event.method === "item/completed" && params.item?.type === "imageGeneration") {
                const item = params.item;
                if (item.status && item.status !== "completed") {
                    if (item.status === "failed") {
                        const failure = item.failure;
                        if (failure?.type === "usageLimitExceeded") {
                            const resetsAt = typeof failure.resetsAt === "number" ? new Date(failure.resetsAt * 1000).toLocaleString() : "";
                            pending.imageError = new Error(`Codex 图片生成额度已用完${resetsAt ? `，预计于 ${resetsAt} 重置` : "，请稍后重试"}`);
                        } else {
                            pending.imageError = new Error(`Codex 图片生成失败${failure?.type ? `（${failure.type}）` : "，Codex 未返回具体失败原因"}`);
                        }
                    }
                    return;
                }
                if (!item.result) {
                    pending.imageError = new Error("Codex 完成了图片生成，但没有返回图片数据，无法自动保存到画布");
                    return;
                }
                const dataUrl = item.result.startsWith("data:image/") ? item.result : `data:image/png;base64,${item.result}`;
                const generatedPrompt = item.revisedPrompt || pending.input.userText;
                pending.input.onEvent?.({ status: "running", label: "正在保存 Codex 生成图片到画布" });
                if (pending.input.onImageGenerated) {
                    pending.imageTasks.push(Promise.resolve().then(() => pending.input.onImageGenerated!(dataUrl, generatedPrompt, pending.controller.signal)).catch((reason) => {
                        pending.imageError = reason instanceof Error ? reason : new Error("保存 Codex 生成图片失败");
                    }));
                }
            } else if (event.method === "turn/completed") {
                const turn = params.turn!;
                if (pending.finishing) return;
                pending.finishing = true;
                void Promise.all(pending.imageTasks).then(() => {
                    const imageError = pending.imageError;
                    const messages = [...pending.messages.values()].filter(Boolean);
                    const explanation = imageError && messages[messages.length - 1]?.trim();
                    pending.finish(turn.status === "failed" ? new Error(turn.error?.message || "Codex 执行失败")
                        : turn.status === "interrupted" ? stopped()
                            : imageError && explanation ? new Error(`${imageError.message}\n\nCodex 的说明：\n${explanation}`) : imageError);
                });
            } else if (event.method === "item/started") {
                pending.input.onEvent?.({ status: "running", label: "Codex 正在处理" });
            }
        };
        dispatch.current = handleRpc;
        const handleTool = (event: CodexToolEvent) => {
            const pending = event.source === "codex" ? active.current : null;
            const controller = new AbortController();
            const signal = AbortSignal.any([link.signal, controller.signal, ...(pending ? [pending.controller.signal] : [])]);
            toolControllers.set(event.requestId, controller);
            toolQueue = toolQueue.then(async () => {
                try {
                    signal.throwIfAborted();
                    if (client.current !== link || (event.source === "codex" && !pending)) throw stopped();
                    const action = normalizeCanvasAgentAction(event.name, event.arguments, event.requestId);
                    let result: CanvasAgentToolResult;
                    if (pending && action.name === "arrange_nodes" && !canvasAgentAllowsArrangement(pending.input.userText)) {
                        result = { ok: false, code: "action_not_requested", message: "用户没有要求整理画布，未执行节点排列" };
                    } else if (pending) {
                        const execution = await executeActions([action], pending.state, (action) => pending.input.executeAction(action, signal), signal, pending.input.onEvent);
                        signal.throwIfAborted();
                        pending.state = execution.state;
                        pending.input.onCheckpoint?.({ state: pending.state, protocolMessages: [] });
                        result = execution.items[0].result;
                    } else result = await latest.current.executeTool(action, signal);
                    signal.throwIfAborted();
                    await link.result(event.requestId, result);
                } catch (reason) {
                    if (!signal.aborted) await link.result(event.requestId, undefined, reason instanceof Error ? reason.message : "画布工具执行失败");
                } finally { toolControllers.delete(event.requestId); }
            }).catch(fail);
        };
        const link = createCodexAgentClient(connection, options.canvasId, agentTools, {
            rpc: handleRpc, tool: handleTool, error: fail,
            cancelTool: (requestId) => toolControllers.get(requestId)?.abort(new Error("画布工具执行超时")),
            ready: async () => {
                setModels([]);
                try {
                    let cursor: string | null = null;
                    const available: CodexModel[] = [];
                    do {
                        const page: { data: CodexModel[]; nextCursor: string | null } = await link.rpc("model/list", { limit: 100, cursor, includeHidden: false });
                        available.push(...page.data);
                        cursor = page.nextCursor;
                    } while (cursor);
                    if (client.current !== link || !link.connected()) return;
                    setModels(available);
                    setError("");
                } catch (reason) { if (!(reason instanceof Error && reason.name === "AbortError")) failCodex(reason, null); }
                finally { if (client.current === link && link.connected()) setStatus("ready"); }
            },
        });
        client.current = link;
        return () => {
            active.current?.finish(stopped());
            approvals.forEach((controller) => controller.abort());
            if (client.current === link) { client.current = null; dispatch.current = null; }
            link.close();
        };
    }, [options.canvasId, connection.endpoint, connection.token, retry, enabled]);

    const getClient = () => {
        if (!client.current?.connected() || status !== "ready") throw new Error(error || "请先连接本地 Agent");
        return client.current;
    };
    const run = async (input: RunInput): Promise<RunCanvasAgentResult> => {
        const link = getClient();
        const threadId = input.serviceId === link.serviceId ? input.threadId : undefined;
        if (active.current) throw new Error("当前 Codex 对话仍在运行");
        input.signal?.throwIfAborted();
        return new Promise((resolve, reject) => {
            const abort = () => {
                pending.finish(stopped());
                void link.stop().catch((reason) => { if (client.current === link && reason.name !== "AbortError") setError(reason.message); });
            };
            const pending: ActiveRun = {
                input, state: input.initialState, threadId,
                buffer: [], messages: new Map(), imageTasks: [], finished: false, controller: new AbortController(),
                finish: (reason) => {
                    if (pending.finished) return;
                    pending.finished = true;
                    pending.controller.abort();
                    input.signal?.removeEventListener("abort", abort);
                    if (active.current === pending) active.current = null;
                    if (reason) reject(reason);
                    else resolve({ reply: [...pending.messages.values()].join("\n\n"), state: pending.state, protocolMessages: [] });
                },
            };
            active.current = pending;
            input.signal?.addEventListener("abort", abort, { once: true });
            void (async () => {
                const skills = input.activeSkillContents?.map((skill) => "【完整 Skill：" + skill.name + "，ID：" + skill.id + "】\n" + skill.content).join("\n\n");
                const hasFiles = Boolean(input.activeSkillContents?.some((skill) => skill.source === "system" && skill.hasFiles));
                const images = input.references.filter((item) => item.dataUrl && /^(data:image\/|https?:\/\/)/.test(item.dataUrl));
                const imageInstructions = `\n\n画布图片生成要求：当用户在本次画布任务中要求生成或迭代图片时，使用 Codex 内置的 ImageGen 工具，不要调用画布的 generate_image 或 edit_image 工具，也不要使用画布配置的外部生图模型。${images.length ? `若本轮附有图片，将它们作为 ImageGen 的参考图（最多 ${Math.min(images.length, 5)} 张；使用 num_last_images_to_include 参数），按本轮文字要求生成。` : ""}不要默认复用前几轮的图片。本次生成的图片会由系统自动保存为画布图片节点并连接到本轮引用的素材节点。`;
                const developerInstructions = canvasAgentSystemPrompt(input.config, buildCanvasAgentSkillPrompt(input.initialState.phase, input.userText, input.getContext(input.initialState), skills, input.contextCheckpoint, hasFiles)) + imageInstructions;
                const { thread } = await link.rpc<{ thread: { id: string } }>(threadId ? "thread/resume" : "thread/start", {
                    ...(threadId ? { threadId } : {}), developerInstructions, ...(input.model ? { model: input.model } : {}),
                });
                if (pending.finished) return;
                pending.threadId = thread.id;
                input.onThread(thread.id, link.serviceId);
                input.onEvent?.({ status: "thinking", label: "Codex 正在理解画布和创作目标" });
                const references = input.references.map((item) => (item.label || item.title) + " → 节点 " + item.id + "（" + item.title + "）").join("；");
                const imageOrder = images.map((item, index) => "第 " + (index + 1) + " 张 = " + (item.label || item.title)).join("；");
                const text = input.userText + (references ? "\n本次引用：" + references : "") + (imageOrder ? "\n附图顺序：" + imageOrder : "");
                const { turn } = await link.rpc<{ turn: { id: string } }>("turn/start", {
                    threadId: thread.id,
                    input: [{ type: "text", text }, ...images.map((item) => ({ type: "image", url: item.dataUrl }))],
                    ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}),
                });
                pending.turnId = turn.id;
                if (pending.finished) {
                    await link.rpc("turn/interrupt", { threadId: thread.id, turnId: turn.id });
                    return;
                }
                for (const event of pending.buffer.splice(0)) dispatch.current?.(event);
            })().catch((reason) => pending.finish(reason instanceof Error ? reason : new Error("Codex 请求失败")));
        });
    };
    return {
        connection, connect, disconnect, models, status, error, run,
        archive: (threadId: string, serviceId?: string) => {
            const link = getClient();
            return serviceId === link.serviceId ? link.rpc("thread/archive", { threadId }) : Promise.resolve();
        },
    };
}

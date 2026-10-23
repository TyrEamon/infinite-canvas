import { readFileAsDataUrl } from "@/lib/image-utils";
import { audioMimeType } from "@/lib/audio-generation";
import { dashScopeWanVideoTranslation, isDashScopeWanVideoModel } from "@/lib/dashscope-video";
import { modelChannelAttributionHeaders } from "@/lib/model-channel";
import { translationPrograms, translationVariableNames, type TranslationVariables } from "@/lib/channel-parameter-translation";
import { channelIdForActiveModel, localChannelForActiveModel, type AiConfig } from "@/stores/use-config-store";
import { useChannelTranslationStore } from "@/stores/use-channel-translation-store";
import { useUserStore } from "@/stores/use-user-store";
import { uploadMediaFile } from "@/services/file-storage";
import { WorkflowRequestError } from "./workflow-generation";

export type TranslationInput = { kind: "image" | "video" | "audio"; variables: TranslationVariables };
export type MatchedTranslation = { channelId: string; source: string; timeout: number; accountProxy: boolean };
export type TranslationResult = { status: string; progress: number; taskIds?: string[]; urls: string[]; storageKey?: string; responseBody?: unknown };
type RequestPlan = { url: string; headers?: Record<string, unknown>; params?: Record<string, unknown>; body?: unknown; format?: string; responseType?: string };

const TRANSLATION_ASPECT_RATIOS = [
    ["1:1", 1],
    ["3:2", 3 / 2],
    ["2:3", 2 / 3],
    ["4:3", 4 / 3],
    ["3:4", 3 / 4],
    ["16:9", 16 / 9],
    ["9:16", 9 / 16],
    ["21:9", 21 / 9],
] as const;

export function normalizeTranslationAspectRatio(value: string) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || normalized === "auto" || normalized === "adaptive" || /^[1-9]\d*:[1-9]\d*$/.test(normalized)) return normalized;
    const match = normalized.match(/^([1-9]\d*)x([1-9]\d*)$/);
    if (!match) return value;
    const ratio = Number(match[1]) / Number(match[2]);
    return TRANSLATION_ASPECT_RATIOS.reduce((best, current) =>
        Math.abs(current[1] - ratio) < Math.abs(best[1] - ratio) ? current : best,
    )[0];
}

export async function findParameterTranslation(config: AiConfig): Promise<MatchedTranslation | null> {
    const { user, token } = useUserStore.getState();
    const channelId = config.channelMode === "remote" ? channelIdForActiveModel(config) : localChannelForActiveModel(config)?.id || "";
    if (!channelId) return null;
    if (config.channelMode === "remote") {
        const channel = config.publicChannels.find((item) => item.id === channelId);
        return channel?.parameterTranslationModels?.includes(config.model) || isDashScopeWanVideoModel(channel?.protocol || "", config.model) ? { channelId, source: "", timeout: channel?.timeout || 600, accountProxy: true } : null;
    }
    const channel = localChannelForActiveModel(config);
    const source = (await useChannelTranslationStore.getState().load(user?.id || "guest"))[channelId];
    if (source?.trim() && (await translationPrograms(source))[config.model]) return { channelId, source, timeout: Number(config.timeout) || 600, accountProxy: Boolean(token) };
    if (!isDashScopeWanVideoModel(channel?.protocol || "", config.model)) return null;
    return { channelId, source: dashScopeWanVideoTranslation, timeout: Number(config.timeout) || 600, accountProxy: Boolean(token) };
}

export function translationHeaders(config: AiConfig, match: MatchedTranslation): Record<string, string> {
    const token = useUserStore.getState().token;
    if (!token) throw new Error("请先登录后再使用账号渠道");
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", [config.channelMode === "remote" ? "X-Model-Channel-ID" : "X-User-Model-Channel-ID"]: match.channelId };
}

export function translationBody(config: AiConfig, input: TranslationInput) {
    return { model: config.model, n: input.variables.count || 1, ...(input.kind === "video" ? { seconds: input.variables.seconds } : {}), _parameterTranslation: input };
}

export function translationMediaURLs(value: unknown, kind: TranslationInput["kind"], mimeType = `${kind}/${kind === "image" ? "png" : kind === "video" ? "mp4" : "mpeg"}`, depth = 0): string[] {
    if (depth > 8 || value == null) return [];
    if (typeof value === "string") {
        const text = value.trim();
        if (/^https?:\/\//i.test(text) || text.startsWith(`data:${kind}/`)) return [text];
        if (text && mimeType.startsWith(`${kind}/`)) {
            try {
                atob(text);
                return [`data:${mimeType.split(";")[0]};base64,${text}`];
            } catch {}
        }
        return [];
    }
    if (Array.isArray(value)) return value.flatMap((item) => translationMediaURLs(item, kind, mimeType, depth + 1));
    if (typeof value !== "object") return [];
    const object = value as Record<string, unknown>;
    const mime = typeof object.mime_type === "string" ? object.mime_type : typeof object.mimeType === "string" ? object.mimeType : mimeType;
    return ["url", "uri", "download_url", "image_url", "video_url", "audio_url", "images", "videos", "audios", "data", "outputs", "results", "result", "b64_json", "base64"].flatMap((key) => translationMediaURLs(object[key], kind, mime, depth + 1));
}

export class BrowserParameterTranslation {
    private worker = new Worker(new URL("./parameter-translation-worker.ts", import.meta.url));
    private constructor(
        private config: AiConfig,
        private match: MatchedTranslation,
        private input: TranslationInput,
    ) {}
    static async create(config: AiConfig, match: MatchedTranslation, input: TranslationInput) {
        const translation = new BrowserParameterTranslation(config, match, input);
        try {
            const code = (await translationPrograms(match.source))[config.model];
            if (!code) throw new Error("该模型没有自定义配置");
            const polling = await translation.evaluate<boolean>({ action: "init", code, names: translationVariableNames, variables: { images: [], videos: [], audios: [], firstFrame: "", lastFrame: "", ...input.variables, model: config.model } });
            // 查询和提交的配置都在付费提交前完成编码校验。
            await translation.prepare(false, "");
            if (polling) await translation.prepare(true, "任务ID");
            return translation;
        } catch (error) {
            translation.dispose();
            throw error;
        }
    }
    dispose() {
        this.worker.terminate();
    }
    private evaluate<T>(message: unknown): Promise<T> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.dispose();
                reject(new Error("自定配置执行超时"));
            }, 1000);
            this.worker.onmessage = (event) => {
                clearTimeout(timer);
                event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.result as T);
            };
            this.worker.onerror = (event) => {
                clearTimeout(timer);
                reject(new Error(event.message || "配置执行失败"));
            };
            this.worker.postMessage(message);
        });
    }
    private async prepare(query: boolean, taskId: string) {
        const { method, request: plan, headers: common } = await this.evaluate<{ method: string; request: RequestPlan; headers: Record<string, unknown> }>({ action: "request", query });
        if (!plan || typeof plan !== "object" || !plan.url?.trim()) throw new Error("自定配置缺少接口地址 url");
        const channel = localChannelForActiveModel(this.config);
        const key = channel?.apiKey || this.config.apiKey;
        const replace = (text: string) => text.replaceAll("{taskId}", taskId).replaceAll("{channelKey}", key);
        const text = (value: unknown) => replace(typeof value === "string" ? value : JSON.stringify(value));
        const target = plan.url.replaceAll("{taskId}", encodeURIComponent(taskId)).replaceAll("{channelKey}", encodeURIComponent(key));
        const base = new URL(channel?.baseUrl || this.config.baseUrl);
        const absolute = /^[a-z][a-z0-9+.-]*:/i.test(target);
        const url = new URL(absolute ? target : `${base.origin}${base.pathname.replace(/\/$/, "")}/${target.replace(/^\//, "")}`);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("接口地址必须是 HTTP 或 HTTPS 地址");
        if (!absolute) for (const [name, values] of base.searchParams) if (!url.searchParams.has(name)) url.searchParams.append(name, values);
        for (const [name, value] of Object.entries(plan.params || {})) {
            url.searchParams.delete(name);
            for (const item of Array.isArray(value) ? (value.length ? value : [""]) : [value]) url.searchParams.append(name, text(item));
        }
        const headers = new Headers(Object.fromEntries(Object.entries(modelChannelAttributionHeaders(channel?.protocol || "")).filter((entry): entry is [string, string] => typeof entry[1] === "string")));
        if (!common || typeof common !== "object" || Array.isArray(common) || (plan.headers && (typeof plan.headers !== "object" || Array.isArray(plan.headers)))) throw new Error("headers 必须是字段对象");
        for (const [name, value] of Object.entries(common)) headers.set(name, text(value));
        const authNames = ["authorization", "x-api-key", "x-goog-api-key"];
        if (Object.keys(plan.headers || {}).some((name) => authNames.includes(name.toLowerCase()))) authNames.forEach((name) => headers.delete(name));
        for (const [name, value] of Object.entries(plan.headers || {})) headers.set(name, text(value));
        const customAuth = JSON.stringify({ plan, common }).includes("{channelKey}") || authNames.some((name) => headers.has(name));
        if (!customAuth) headers.set(channel?.protocol === "gemini" ? "x-goog-api-key" : "Authorization", channel?.protocol === "gemini" || channel?.protocol === "autodl" ? key : `Bearer ${key}`);
        const format = plan.format || "json",
            responseType = plan.responseType || "json";
        if (!["json", "formData", "urlencoded", "raw"].includes(format) || !["json", "text", "blob", "arraybuffer"].includes(responseType)) throw new Error("不支持的请求或返回数据格式");
        const replaceValues = (value: unknown): unknown =>
            typeof value === "string" ? replace(value) : Array.isArray(value) ? value.map(replaceValues) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceValues(item)])) : value;
        const bodyValue = replaceValues(plan.body);
        let body: BodyInit | undefined;
        if (bodyValue !== undefined) {
            if (format === "json") {
                body = JSON.stringify(bodyValue);
                if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
            } else if (format === "raw") body = text(bodyValue);
            else {
                if (!bodyValue || typeof bodyValue !== "object" || Array.isArray(bodyValue)) throw new Error("表单请求体必须是字段对象");
                const form = format === "formData" ? new FormData() : new URLSearchParams();
                for (const [name, value] of Object.entries(bodyValue)) for (const item of Array.isArray(value) ? (value.length ? value : [""]) : [value]) form.append(name, text(item));
                body = form;
                if (format === "formData") headers.delete("Content-Type");
                else if (!headers.has("Content-Type")) headers.set("Content-Type", "application/x-www-form-urlencoded");
            }
        }
        if (["GET", "HEAD"].includes(method) && body !== undefined) throw new Error("浏览器的 GET 和 HEAD 请求不能携带请求体");
        return { url: url.href, options: { method, headers, body }, responseType };
    }
    async send(query = false, taskId = "", signal?: AbortSignal): Promise<TranslationResult> {
        const { url, options, responseType } = await this.prepare(query, taskId);
        const timeout = AbortSignal.timeout(this.match.timeout * 1000);
        signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const binary = responseType === "blob" || responseType === "arraybuffer";
        let response: Response, blob: Blob | undefined, payload: string | null;
        try {
            response = await fetch(url, { ...options, signal });
            blob = binary && response.ok ? await response.blob() : undefined;
            let json = Boolean(blob && /json/i.test(blob.type));
            for (let offset = 0; blob && !json && offset < blob.size; offset += 512) {
                const prefix = (await blob.slice(offset, offset + 512).text()).trimStart();
                if (!prefix) continue;
                json = prefix.startsWith("{") || prefix.startsWith("[");
                break;
            }
            payload = blob ? (json ? await blob.text() : null) : await response.text();
        } catch (error) {
            if (this.input.kind === "video" && query && error instanceof Error && (signal.reason?.name === "TimeoutError" || !signal.aborted && error.name !== "AbortError")) throw new WorkflowRequestError(error.message, undefined, true);
            throw error;
        }
        const mime = response.headers.get("Content-Type") || `${this.input.kind}/${this.input.kind === "audio" ? "mpeg" : this.input.kind === "image" ? "png" : "mp4"}`;
        let data: unknown = payload;
        if (payload !== null && responseType !== "text") {
            try {
                data = JSON.parse(payload);
            } catch {
                if (response.ok && !blob) throw new Error("接口没有返回有效 JSON");
                if (blob) data = payload = null;
            }
        }
        if (!response.ok) {
            const error = await this.evaluate<unknown>({ action: "error", data });
            const message = error ? (typeof error === "string" ? error : JSON.stringify(error)) : `请求失败（${response.status}）`;
            throw this.input.kind === "video" && query && response.status === 429 ? new WorkflowRequestError(message, 429, true) : new Error(message);
        }
        if (blob && payload !== null) {
            const error = await this.evaluate<unknown>({ action: "error", data });
            throw new Error(error ? (typeof error === "string" ? error : JSON.stringify(error)) : payload);
        }
        const { defaultResult, ...result } = await this.evaluate<TranslationResult & { value: unknown; defaultResult?: boolean }>({ action: "response", query, data });
        const resultMime = mime.startsWith(`${this.input.kind}/`) ? mime : this.input.kind === "audio" ? audioMimeType(String(this.input.variables.audioFormat || "mp3")) : `${this.input.kind}/${this.input.kind === "image" ? "png" : "mp4"}`;
        let urls: string[] = [];
        if (result.status === "completed") {
            if (binary) {
                blob ||= await response.blob();
                if (!blob.size) throw new Error("接口返回了空媒体文件");
                if (this.input.kind !== "video") urls = [await readFileAsDataUrl(new File([blob], "media", { type: resultMime }))];
            } else urls = translationMediaURLs(result.value, this.input.kind, resultMime);
        }
        if (this.input.kind === "video" && result.status === "completed" && (binary || urls[0]?.startsWith("data:video/"))) {
            const media = await uploadMediaFile(binary ? new Blob([blob!], { type: resultMime }) : urls[0], "generated-video");
            return { status: result.status, progress: result.progress, urls: [media.url], storageKey: media.storageKey };
        }
        if (this.input.kind === "video" && result.status === "completed" && !binary) {
            const source = new URL(url);
            let content = urls.length === 1 && /^https?:\/\//i.test(urls[0]) ? new URL(urls[0]) : undefined;
            if (content && (content.username || content.password || content.origin !== source.origin)) content = undefined;
            if (!urls.length && query && defaultResult && options.method === "GET" && taskId && source.pathname.endsWith(`/videos/${encodeURIComponent(taskId)}`)) {
                source.pathname += "/content";
                content = source;
            }
            if (content?.pathname.endsWith("/content")) {
                const params = new URLSearchParams(content.search);
                for (const [name, value] of source.searchParams) if (!params.has(name)) content.searchParams.append(name, value);
                const video = await (await import("./video")).cacheProtectedVideo(this.config, this.config.model, { id: taskId || content.pathname, status: "completed", video_url: content.href }, { method: "GET", headers: options.headers, signal });
                if (video.storageKey) return { ...result, urls: [video.video_url!], storageKey: video.storageKey, responseBody: data };
            }
        }
        if (result.status === "completed" && !urls.length) throw new Error("生成已完成，但配置的结果位置没有可用媒体地址");
        return { ...result, urls, responseBody: data };
    }
    async execute(onProgress?: (progress: number) => void, externalSignal?: AbortSignal): Promise<TranslationResult> {
        const timeout = AbortSignal.timeout(this.match.timeout * 1000);
        const signal = externalSignal ? AbortSignal.any([timeout, externalSignal]) : timeout;
        const result = await this.send(false, "", signal);
        if (result.status === "completed") return result;
        const results: Record<string, TranslationResult> = {};
        const progress: Record<string, number> = {};
        for (;;) {
            for (const id of result.taskIds || []) {
                if (results[id]) continue;
                const polled = await this.send(true, id, signal);
                progress[id] = polled.progress;
                onProgress?.(Object.values(progress).reduce((sum, value) => sum + value, 0) / (result.taskIds?.length || 1));
                if (polled.status === "completed") results[id] = polled;
            }
            if (Object.keys(results).length === result.taskIds?.length) return { ...result, status: "completed", progress: 100, urls: result.taskIds.flatMap((id) => results[id].urls) };
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => {
                    signal.removeEventListener("abort", abort);
                    resolve();
                }, 5000);
                const abort = () => {
                    clearTimeout(timer);
                    reject(signal.reason);
                };
                if (signal.aborted) abort();
                else signal.addEventListener("abort", abort, { once: true });
            });
        }
    }
}

export async function executeParameterTranslation(config: AiConfig, match: MatchedTranslation, input: TranslationInput, signal?: AbortSignal): Promise<TranslationResult> {
    if (match.accountProxy) {
        const timeout = AbortSignal.timeout(match.timeout * 1000);
        const endpoint = input.kind === "audio" ? "/audio/speech" : Array.isArray(input.variables.images) && input.variables.images.length ? "/images/edits" : "/images/generations";
        const response = await fetch(`/api/v1${endpoint}`, { method: "POST", headers: translationHeaders(config, match), body: JSON.stringify(translationBody(config, input)), signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
        const data = response.headers.get("Content-Type")?.includes("json") ? await response.json() : await response.blob();
        if (!response.ok || (data.code && data.code !== 0)) throw new Error(data.msg || data.error?.message || `请求失败（${response.status}）`);
        const urls = data instanceof Blob ? [await readFileAsDataUrl(new File([data], "media", { type: data.type }))] : translationMediaURLs(data, input.kind);
        if (!urls.length) throw new Error("接口没有返回可用媒体结果");
        return { status: "completed", progress: 100, urls };
    }
    const translation = await BrowserParameterTranslation.create(config, match, input);
    try {
        return await translation.execute(undefined, signal);
    } finally {
        translation.dispose();
    }
}

export async function translationMediaAddress(url: string): Promise<string> {
    if (!url) throw new Error("参考素材不可用");
    if (url.startsWith("data:")) return url;
    if (/^https?:\/\//i.test(url) && new URL(url).origin !== location.origin && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) return url;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`读取参考素材失败（${response.status}）`);
    const blob = await response.blob();
    return readFileAsDataUrl(new File([blob], "reference", { type: blob.type }));
}

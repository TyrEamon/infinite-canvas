const DB_NAME = "infinite-canvas-wanx-bridge";
const DB_VERSION = 1;
const SESSION_KEY = "active-session";
const QIANWEN_URL = "https://platform.qianwenai.com/try-ai?scene=video";
const CANVAS_PATTERNS = ["http://localhost:3000/*", "http://127.0.0.1:3000/*"];
const ACTIVE_TASK_STATES = new Set(["awaiting", "running", "waiting-url", "importing"]);
let taskEventQueue = Promise.resolve();

function serializeTaskEvent(operation) {
  const next = taskEventQueue.then(operation, operation);
  taskEventQueue = next.catch(() => {});
  return next;
}

function normalizePrompt(prompt) {
  return String(prompt || "").replace(/\s+/g, " ").trim();
}

function normalizeStatus(status) {
  const value = String(status || "").trim().toUpperCase();
  return ["SUCCESS", "FINISHED", "DONE", "COMPLETED"].includes(value) ? "SUCCEEDED" : value;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore("sessions", { keyPath: "key" });
      database.createObjectStore("chunks", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("扩展素材缓存不可用"));
  });
}

async function transact(storeName, mode, operation) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    let result;
    try {
      result = operation(store);
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(result?.result);
    transaction.onerror = () => reject(transaction.error || new Error("扩展素材缓存失败"));
    transaction.onabort = () => reject(transaction.error || new Error("扩展素材缓存已取消"));
  });
}

async function clearChunks() {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("chunks", "readwrite");
    transaction.objectStore("chunks").clear();
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("清理扩展缓存失败"));
  });
}

async function getSession() {
  return (await transact("sessions", "readonly", (store) => store.get(SESSION_KEY)))?.value || null;
}

async function saveSession(session) {
  const current = await getSession();
  if (current?.autoSubmit && ACTIVE_TASK_STATES.has(current.taskState) && Date.now() < current.taskDeadline) {
    throw new Error("上一条万相任务还在生成或回传；请等待完成后再提交新任务");
  }
  await clearChunks();
  await transact("sessions", "readwrite", (store) => store.put({ key: SESSION_KEY, value: { ...session, files: [], ready: false, taskState: "preparing" } }));
}

async function updateSession(update) {
  const current = await getSession();
  if (!current || current.sessionId !== update.sessionId) throw new Error("桥接任务已过期，请重新从画布发送");
  const next = typeof update.apply === "function" ? update.apply(current) : { ...current, ...update.patch };
  await transact("sessions", "readwrite", (store) => store.put({ key: SESSION_KEY, value: next }));
  return next;
}

function waitForTab(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete") return resolve(tab);
      } catch (error) {
        return reject(error);
      }
      if (Date.now() - started > timeoutMs) return reject(new Error("页面加载超时"));
      setTimeout(check, 300);
    };
    check();
  });
}

async function sendToTabWhenReady(tabId, message) {
  await waitForTab(tabId);
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      lastError = error;
      if (attempt === 0 && /Receiving end does not exist/i.test(String(error))) {
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
        } catch (injectionError) {
          throw new Error(`无法注入页面脚本：${injectionError instanceof Error ? injectionError.message : String(injectionError)}`);
        }
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  throw lastError || new Error("无法连接页面扩展脚本");
}

function findWanxTab(tabs, windowId) {
  const pages = tabs.filter((item) => item.url?.includes("/try-ai"));
  const video = pages.filter((item) => item.url?.includes("scene=video"));
  return video.find((item) => item.windowId === windowId) || video.find((item) => item.active) || video[0]
    || pages.find((item) => item.windowId === windowId) || pages.find((item) => item.active) || pages[0];
}

async function openWanxAndApply(windowId) {
  let tabs = await chrome.tabs.query({ url: "https://platform.qianwenai.com/*" });
  let tab = findWanxTab(tabs, windowId) || tabs[0];
  if (!tab?.id) tab = await chrome.tabs.create({ url: QIANWEN_URL, active: false });
  if (!tab?.id) throw new Error("无法打开通义万相页面");
  let result = await sendToTabWhenReady(tab.id, { type: "wanx:apply-context" });
  if (!result?.ok && result?.error?.includes("找不到万象提示词输入框")) {
    await chrome.tabs.update(tab.id, { active: true });
    result = await sendToTabWhenReady(tab.id, { type: "wanx:apply-context" });
  }
  return result;
}

async function findCanvasTab(session) {
  const allTabs = await chrome.tabs.query({ url: CANVAS_PATTERNS });
  const exact = allTabs.find((tab) => tab.url === session.canvasUrl);
  if (exact?.id) return exact;
  const sameProject = allTabs.find((tab) => tab.url?.startsWith(session.canvasUrl.split("?")[0]));
  if (sameProject?.id) return sameProject;
  const created = await chrome.tabs.create({ url: session.canvasUrl, active: true });
  if (!created.id) throw new Error("无法重新打开原画布");
  return created;
}

async function importVideoToCanvas(fileId) {
  const session = await getSession();
  if (!session?.ready) throw new Error("没有可导入的万相视频");
  const canvasTab = await findCanvasTab(session);
  const result = await sendToTabWhenReady(canvasTab.id, { type: "canvas:import-video", sessionId: session.sessionId, fileId });
  if (result?.ok) {
    await clearChunks();
    await updateSession({ sessionId: session.sessionId, patch: { ready: false, files: [], taskState: "completed" } });
  }
  return result;
}

async function notifyCanvasImportFailure(error) {
  const session = await getSession();
  if (!session?.ready || !session.autoSubmit || !session.targetNodeId) return { ok: true };
  const canvasTab = await findCanvasTab(session);
  return sendToTabWhenReady(canvasTab.id, { type: "canvas:import-failed", targetNodeId: session.targetNodeId, error });
}

async function failTask(session, error) {
  await updateSession({ sessionId: session.sessionId, patch: { taskState: "error", taskError: error } });
  await notifyCanvasImportFailure(error).catch(() => {});
  return { ok: true, notice: error, error: true };
}

async function claimVideo(session, video) {
  const url = video.url?.startsWith("//") ? `https:${video.url}` : video.url;
  if (!/^https?:\/\//i.test(url || "")) {
    if (!video.key) return failTask(session, "万相任务没有返回可读取的视频地址或文件标识，请手动检查结果");
    await updateSession({ sessionId: session.sessionId, patch: { taskState: "waiting-url", pendingVideoKey: video.key, taskDeadline: Date.now() + 30 * 1000 } });
    return { ok: true, notice: "已匹配万相任务，正在获取视频地址…", waitForUrl: true, sessionId: session.sessionId };
  }
  await updateSession({ sessionId: session.sessionId, patch: { taskState: "importing", pendingVideoKey: video.key || "" } });
  return { ok: true, notice: "万相视频已生成，正在自动回传画布…", autoImport: { sessionId: session.sessionId, taskId: session.taskId, url } };
}

async function handleTaskResult(session, event) {
  const status = normalizeStatus(event.status);
  if (["FAILED", "UNKNOWN", "CANCELED", "ABORT", "ABORTED", "TIMEOUT"].includes(status)) {
    return failTask(session, event.reason ? `万相生成失败：${event.reason}` : `万相任务 ${status}，网页没有返回具体原因`);
  }
  if (status !== "SUCCEEDED") return { ok: true };
  const videos = Array.isArray(event.videos) ? event.videos : [];
  if (!videos.length) return event.reason ? failTask(session, `万相未生成视频：${event.reason}`) : { ok: true };
  if (videos.length !== 1) return failTask(session, `万相任务返回 ${videos.length} 个视频，无法唯一确定回传结果，请手动选择`);
  return claimVideo(session, videos[0]);
}

async function handleTaskEvent(event, sender) {
  const session = await getSession();
  if (!session?.ready || !session.autoSubmit || sender.tab?.id !== session.wanxTabId) return { ok: true };
  if (!ACTIVE_TASK_STATES.has(session.taskState)) return { ok: true };
  if (Date.now() > session.taskDeadline) return failTask(session, "万相任务等待超时，请检查网页结果后重新发送");

  if (event?.kind === "created") {
    if (normalizePrompt(event.prompt) !== normalizePrompt(session.prompt)) return { ok: true };
    if (!event.taskId && event.reason) return failTask(session, `万相提交失败：${event.reason}`);
    if (session.taskState !== "awaiting" && event.taskId !== session.taskId) {
      return failTask(session, "同一提示词出现多个万相任务，无法安全自动回传，请手动选择");
    }
    if (session.taskState !== "awaiting") return { ok: true };
    if (!event.taskId) return failTask(session, "万相未返回任务 ID，无法安全自动回传");
    const linked = await updateSession({ sessionId: session.sessionId, patch: { taskState: "running", taskId: event.taskId, taskDeadline: Date.now() + 15 * 60 * 1000 } });
    const result = await handleTaskResult(linked, event);
    return result.notice ? result : { ok: true, notice: `已关联万相任务 ${event.taskId.slice(-8)}，完成后自动回传` };
  }

  if (event?.kind === "polled") {
    if (!session.taskId || event.requestedTaskId !== session.taskId) return { ok: true };
    if (event.taskId && event.taskId !== session.taskId) return failTask(session, "万相轮询返回了不同的任务 ID，已停止自动回传");
    if (session.taskState !== "running") return { ok: true };
    return handleTaskResult(session, event);
  }

  if (event?.kind === "downloaded" && session.taskState === "waiting-url" && event.key === session.pendingVideoKey && event.url) {
    return claimVideo(session, { key: event.key, url: event.url });
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const run = async () => {
    if (message?.type === "bridge:save-session") {
      await serializeTaskEvent(() => saveSession(message.session));
      return { ok: true };
    }
    if (message?.type === "bridge:store-chunk") {
      const session = await getSession();
      if (!session || session.sessionId !== message.sessionId) throw new Error("桥接任务已过期");
      await transact("chunks", "readwrite", (store) => store.put({ key: `${message.fileId}:${message.index}`, data: message.data }));
      return { ok: true };
    }
    if (message?.type === "bridge:register-file") {
      const session = await updateSession({ sessionId: message.sessionId, apply: (current) => ({ ...current, files: [...current.files.filter((file) => file.fileId !== message.file.fileId), message.file] }) });
      return { ok: true, files: session.files.length };
    }
    if (message?.type === "bridge:finish-session") {
      await updateSession({ sessionId: message.sessionId, patch: { ready: true } });
      return { ok: true };
    }
    if (message?.type === "bridge:get-session") return { ok: true, session: await getSession() };
    if (message?.type === "wanx:get-options") {
      if (!CANVAS_PATTERNS.some((pattern) => sender.tab?.url?.startsWith(pattern.slice(0, -1)))) throw new Error("只能从本地画布读取万相设置");
      const tabs = await chrome.tabs.query({ url: "https://platform.qianwenai.com/*" });
      const tab = findWanxTab(tabs, sender.tab?.windowId);
      if (!tab?.id) throw new Error("请先在 Edge 打开万相视频生成页面");
      return sendToTabWhenReady(tab.id, { type: "wanx:get-options" });
    }
    if (message?.type === "wanx:arm-task") return serializeTaskEvent(async () => {
      const session = await getSession();
      if (!session?.ready || !session.autoSubmit || session.sessionId !== message.sessionId || !sender.tab?.url?.startsWith("https://platform.qianwenai.com/")) {
        throw new Error("当前万相标签页与画布任务不匹配");
      }
      await updateSession({ sessionId: session.sessionId, patch: { taskState: "awaiting", taskId: "", wanxTabId: sender.tab.id, taskDeadline: Date.now() + 90 * 1000 } });
      return { ok: true };
    });
    if (message?.type === "wanx:task-event") return serializeTaskEvent(() => handleTaskEvent(message.event, sender));
    if (message?.type === "wanx:task-create-timeout") return serializeTaskEvent(async () => {
      const session = await getSession();
      return session?.sessionId === message.sessionId && session.taskState === "awaiting"
        ? failTask(session, "提交后未收到万相任务 ID；请检查是否真的开始生成")
        : { ok: true };
    });
    if (message?.type === "wanx:task-url-timeout") return serializeTaskEvent(async () => {
      const session = await getSession();
      return session?.sessionId === message.sessionId && session.taskState === "waiting-url"
        ? failTask(session, "万相视频地址获取超时，已停止自动回传；请在网页确认结果后手动选择")
        : { ok: true };
    });
    if (message?.type === "bridge:get-chunk") {
      const item = await transact("chunks", "readonly", (store) => store.get(`${message.fileId}:${message.index}`));
      return { ok: true, data: item?.data || null };
    }
    if (message?.type === "canvas:export-complete") return await openWanxAndApply(sender.tab?.windowId);
    if (message?.type === "wanx:import-complete") return await importVideoToCanvas(message.fileId);
    if (message?.type === "wanx:import-failed") {
      const session = await getSession();
      if (message.sessionId && (session?.sessionId !== message.sessionId || session.taskId !== message.taskId)) return { ok: true };
      if (session?.taskState === "importing") await updateSession({ sessionId: session.sessionId, patch: { taskState: "error", taskError: message.error } });
      return await notifyCanvasImportFailure(message.error);
    }
    return { ok: false, error: "不支持的桥接操作" };
  };

  run().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "桥接失败" }));
  return true;
});

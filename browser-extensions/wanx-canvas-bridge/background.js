const DB_NAME = "infinite-canvas-wanx-bridge";
const DB_VERSION = 1;
const SESSION_KEY = "active-session";
const QIANWEN_URL = "https://platform.qianwenai.com/try-ai?scene=video";
const CANVAS_PATTERNS = ["http://localhost:3000/*", "http://127.0.0.1:3000/*"];

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
  await clearChunks();
  await transact("sessions", "readwrite", (store) => store.put({ key: SESSION_KEY, value: { ...session, files: [], ready: false } }));
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
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  throw lastError || new Error("无法连接页面扩展脚本");
}

async function openWanxAndApply() {
  let tabs = await chrome.tabs.query({ url: "https://platform.qianwenai.com/*" });
  let tab = tabs.find((item) => item.url?.includes("/try-ai")) || tabs[0];
  if (tab?.id) {
    tab = await chrome.tabs.update(tab.id, { active: true });
  } else {
    tab = await chrome.tabs.create({ url: QIANWEN_URL, active: true });
  }
  if (!tab?.id) throw new Error("无法打开通义万相页面");
  return sendToTabWhenReady(tab.id, { type: "wanx:apply-context" });
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
    await updateSession({ sessionId: session.sessionId, patch: { ready: false, files: [] } });
  }
  return result;
}

async function notifyCanvasImportFailure(error) {
  const session = await getSession();
  if (!session?.ready || !session.autoSubmit || !session.targetNodeId) return { ok: true };
  const canvasTab = await findCanvasTab(session);
  return sendToTabWhenReady(canvasTab.id, { type: "canvas:import-failed", targetNodeId: session.targetNodeId, error });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const run = async () => {
    if (message?.type === "bridge:save-session") {
      await saveSession(message.session);
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
    if (message?.type === "bridge:get-chunk") {
      const item = await transact("chunks", "readonly", (store) => store.get(`${message.fileId}:${message.index}`));
      return { ok: true, data: item?.data || null };
    }
    if (message?.type === "canvas:export-complete") return await openWanxAndApply();
    if (message?.type === "wanx:import-complete") return await importVideoToCanvas(message.fileId);
    if (message?.type === "wanx:import-failed") return await notifyCanvasImportFailure(message.error);
    return { ok: false, error: "不支持的桥接操作" };
  };

  run().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "桥接失败" }));
  return true;
});

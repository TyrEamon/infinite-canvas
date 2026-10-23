const MESSAGE_CHUNK_BYTES = 192 * 1024;
const MAX_MEDIA_BYTES = 200 * 1024 * 1024;
const PAGE_SOURCE = "infinite-canvas-page";
const EXTENSION_SOURCE = "infinite-canvas-wanx-extension";
const isWanxPage = location.hostname === "platform.qianwenai.com";
const videoCandidateMap = new Map();

function sendRuntime(message) {
  return chrome.runtime.sendMessage(message);
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function storeBlob(sessionId, fileId, blob) {
  if (blob.size > MAX_MEDIA_BYTES) throw new Error("单个参考素材超过 200 MB，暂不支持桥接");
  const totalChunks = Math.ceil(blob.size / MESSAGE_CHUNK_BYTES);
  for (let index = 0; index < totalChunks; index += 1) {
    const bytes = new Uint8Array(await blob.slice(index * MESSAGE_CHUNK_BYTES, (index + 1) * MESSAGE_CHUNK_BYTES).arrayBuffer());
    const result = await sendRuntime({ type: "bridge:store-chunk", sessionId, fileId, index, data: bytesToBase64(bytes) });
    if (!result?.ok) throw new Error(result?.error || "缓存媒体分块失败");
  }
  return totalChunks;
}

async function requestPage(type, payload = {}) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener("message", handleResponse);
      reject(new Error("画布页面没有响应，请刷新画布后重试"));
    }, 120000);
    const handleResponse = (event) => {
      if (event.source !== window || event.origin !== location.origin || event.data?.source !== PAGE_SOURCE || event.data?.type !== "wanx-response" || event.data?.requestId !== requestId) return;
      clearTimeout(timeout);
      window.removeEventListener("message", handleResponse);
      if (event.data.ok) resolve(event.data);
      else reject(new Error(event.data.error || "画布桥接失败"));
    };
    window.addEventListener("message", handleResponse);
    window.postMessage({ source: EXTENSION_SOURCE, type, requestId, ...payload }, location.origin);
  });
}

async function exportCanvasContext({ nodeId, prompt, autoSubmit = false } = {}) {
  const response = await requestPage("get-context", { nodeId, prompt });
  const context = response.context;
  if (!context?.prompt?.trim()) throw new Error("选中节点没有提示词；请先补上提示词再发送");
  const sessionId = crypto.randomUUID();
  const files = (context.files || []).map(({ id, kind, name, mimeType, blob }) => ({ id, kind, name, mimeType, blob }));
  await sendRuntime({
    type: "bridge:save-session",
    session: {
      sessionId,
      prompt: context.prompt,
      sourceNodeIds: context.sourceNodeIds || [],
      targetNodeId: context.targetNodeId,
      canvasUrl: context.canvasUrl,
      autoSubmit,
      files: [],
      ready: false,
    },
  });
  for (const file of files) {
    if (!(file.blob instanceof Blob)) throw new Error(`无法读取参考素材：${file.name}`);
    const fileId = crypto.randomUUID();
    const chunks = await storeBlob(sessionId, fileId, file.blob);
    const result = await sendRuntime({
      type: "bridge:register-file",
      sessionId,
      file: { fileId, id: file.id, kind: file.kind, name: file.name, mimeType: file.mimeType || file.blob.type, size: file.blob.size, chunks },
    });
    if (!result?.ok) throw new Error(result?.error || "登记参考素材失败");
  }
  await sendRuntime({ type: "bridge:finish-session", sessionId });
  const applied = await sendRuntime({ type: "canvas:export-complete" });
  if (!applied?.ok) throw new Error(applied?.error || "万象页面未能接收画布内容");
  return { ok: true, prompt: context.prompt, files: files.length, attached: applied.attached || 0, skipped: applied.skipped || 0, submitted: Boolean(applied.submitted) };
}

async function readFileFromSession(session, file) {
  const chunks = [];
  for (let index = 0; index < file.chunks; index += 1) {
    const response = await sendRuntime({ type: "bridge:get-chunk", sessionId: session.sessionId, fileId: file.fileId, index });
    if (!response?.ok || !response.data) throw new Error(`读取扩展缓存失败：${file.name}`);
    const binary = atob(response.data);
    const bytes = new Uint8Array(binary.length);
    for (let offset = 0; offset < binary.length; offset += 1) bytes[offset] = binary.charCodeAt(offset);
    chunks.push(bytes);
  }
  return new File(chunks, file.name, { type: file.mimeType || "application/octet-stream" });
}

function showStatus(text, error = false) {
  let status = document.getElementById("infinite-canvas-wanx-status");
  if (!status) {
    status = document.createElement("div");
    status.id = "infinite-canvas-wanx-status";
    Object.assign(status.style, {
      position: "fixed", right: "18px", top: "18px", zIndex: "2147483647", maxWidth: "360px",
      padding: "12px 16px", borderRadius: "12px", background: "#24211f", color: "#fff",
      boxShadow: "0 8px 32px #0004", font: "14px/1.5 system-ui, sans-serif",
    });
    document.documentElement.appendChild(status);
  }
  status.style.border = error ? "1px solid #ff7875" : "1px solid #6b8cff";
  status.textContent = text;
  clearTimeout(status._timer);
  status._timer = setTimeout(() => status.remove(), 6000);
}

function visible(element) {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function promptEditor() {
  const selectors = ["textarea:not([disabled])", '[contenteditable="true"]'];
  const candidates = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))).filter(visible);
  return candidates.sort((left, right) => {
    const leftHint = `${left.getAttribute("placeholder") || ""} ${left.getAttribute("aria-label") || ""}`;
    const rightHint = `${right.getAttribute("placeholder") || ""} ${right.getAttribute("aria-label") || ""}`;
    const hintScore = (text) => /提示|描述|prompt|创作|输入/i.test(text) ? 100000 : 0;
    const area = (element) => element.getBoundingClientRect().width * element.getBoundingClientRect().height;
    return hintScore(rightHint) + area(right) - hintScore(leftHint) - area(left);
  })[0];
}

async function waitForPromptEditor() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const editor = promptEditor();
    if (editor) return editor;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return undefined;
}

function setPromptValue(element, value) {
  element.focus();
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
    setter?.call(element, value);
  } else {
    element.textContent = value;
  }
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function findGenerateButton(editor) {
  const controls = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]')).filter((element) =>
    visible(element) && !element.disabled && element.getAttribute("aria-disabled") !== "true",
  );
  const editorRect = editor.getBoundingClientRect();
  const label = (element) => `${element.innerText || element.textContent || ""} ${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""} ${element.getAttribute("data-testid") || ""}`;
  const distance = (element) => {
    const rect = element.getBoundingClientRect();
    return Math.hypot(rect.left + rect.width / 2 - (editorRect.right - 24), rect.top + rect.height / 2 - (editorRect.bottom - 24));
  };
  const explicit = controls.filter((element) => /生成|发送|开始创作|立即创作|创建视频|提交|submit|send/i.test(label(element)) && !/登录|api|历史|下载|删除|取消/i.test(label(element)));
  if (explicit.length) return explicit.sort((left, right) => distance(left) - distance(right))[0];
  const formSubmit = editor.closest("form")?.querySelector('button[type="submit"], input[type="submit"]');
  return formSubmit && visible(formSubmit) && !formSubmit.disabled ? formSubmit : undefined;
}

function fileAccepts(input, file) {
  const accept = input.accept?.trim();
  if (!accept) return true;
  return accept.split(",").some((entry) => {
    const token = entry.trim().toLowerCase();
    return token === file.type.toLowerCase() || (token.endsWith("/*") && file.type.toLowerCase().startsWith(token.slice(0, -1))) || (token.startsWith(".") && file.name.toLowerCase().endsWith(token));
  });
}

async function applyContext() {
  const response = await sendRuntime({ type: "bridge:get-session" });
  const session = response?.session;
  if (!response?.ok || !session?.ready) throw new Error("没有从画布收到提示词，请回到画布选中节点后再发送");
  const editor = await waitForPromptEditor();
  if (!editor) throw new Error("找不到万象提示词输入框；请打开视频生成输入区后重试");
  setPromptValue(editor, session.prompt);

  const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
  const input = inputs
    .map((candidate) => ({ candidate, accepted: session.files.filter((file) => fileAccepts(candidate, { name: file.name, type: file.mimeType })).length }))
    .sort((left, right) => right.accepted - left.accepted || Number(right.candidate.multiple) - Number(left.candidate.multiple))[0]?.candidate;
  let attached = 0;
  let skipped = 0;
  if (session.files.length && !input) throw new Error("提示词已填入，但万象页面没有可用的上传控件；请展开素材上传区后再点一次发送");
  if (session.files.length && input) {
    const acceptedFiles = [];
    for (const metadata of session.files) {
      const file = await readFileFromSession(session, metadata);
      if (fileAccepts(input, file)) acceptedFiles.push(file);
      else skipped += 1;
    }
    const selectedFiles = input.multiple ? acceptedFiles : acceptedFiles.slice(0, 1);
    if (!input.multiple && acceptedFiles.length > 1) skipped += acceptedFiles.length - 1;
    if (selectedFiles.length) {
      const transfer = new DataTransfer();
      selectedFiles.forEach((file) => transfer.items.add(file));
      input.files = transfer.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      attached = selectedFiles.length;
    }
  } else if (session.files.length) {
    skipped = session.files.length;
  }
  const note = skipped ? `；${skipped} 个素材不被当前上传控件接受` : "";
  let submitted = false;
  if (session.autoSubmit) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const button = findGenerateButton(editor);
    if (button) {
      button.click();
      submitted = true;
    }
  }
  showStatus(session.autoSubmit
    ? submitted ? `已填入提示词、挂载 ${attached} 个素材并提交生成${note}` : `已填入提示词和素材，但没识别到生成按钮，请手动点击生成${note}`
    : `已填入提示词，挂载 ${attached} 个参考素材。请检查页面后手动点击生成${note}`);
  return { ok: true, attached, skipped, submitted };
}

function videoCandidates() {
  videoCandidateMap.clear();
  return Array.from(document.querySelectorAll("video"))
    .filter((video) => visible(video) && (video.currentSrc || video.src))
    .slice(-12)
    .map((video) => {
      const candidateId = crypto.randomUUID();
      videoCandidateMap.set(candidateId, video);
      return { candidateId, duration: Number.isFinite(video.duration) ? video.duration : null, width: video.videoWidth || null, height: video.videoHeight || null };
    });
}

async function importVideo(candidateId) {
  const video = videoCandidateMap.get(candidateId);
  if (!video) throw new Error("找不到所选视频，请重新扫描");
  const source = video.currentSrc || video.src;
  let response;
  try {
    response = await fetch(source, { credentials: "include" });
  } catch {
    throw new Error("万象页面未允许扩展读取该视频文件；需要按当前页面的下载入口进一步适配");
  }
  if (!response.ok) throw new Error(`读取视频失败：HTTP ${response.status}`);
  const blob = await response.blob();
  if (!blob.size || blob.size > MAX_MEDIA_BYTES) throw new Error("视频为空或超过 200 MB，暂不支持桥接");
  const mimeType = blob.type.startsWith("video/") ? blob.type : "video/mp4";
  const fileId = crypto.randomUUID();
  const sessionResponse = await sendRuntime({ type: "bridge:get-session" });
  const session = sessionResponse?.session;
  if (!sessionResponse?.ok || !session?.ready) throw new Error("没有待处理的画布上下文，请先从画布发送提示词");
  const totalChunks = await storeBlob(session.sessionId, fileId, blob);
  await sendRuntime({ type: "bridge:register-file", sessionId: session.sessionId, file: { fileId, kind: "video", name: `wanxiang-${Date.now()}.mp4`, mimeType, size: blob.size, chunks: totalChunks } });
  const imported = await sendRuntime({ type: "wanx:import-complete", fileId });
  if (!imported?.ok) throw new Error(imported?.error || "导入画布失败");
  showStatus("万象视频已回到画布并保存为新节点");
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const run = async () => {
    if (!isWanxPage && message?.type === "canvas:export") return await exportCanvasContext();
    if (isWanxPage && message?.type === "wanx:apply-context") return await applyContext();
    if (isWanxPage && message?.type === "wanx:list-videos") return { ok: true, videos: videoCandidates() };
    if (isWanxPage && message?.type === "wanx:import-video") return await importVideo(message.candidateId);
    if (!isWanxPage && message?.type === "canvas:import-failed") return await requestPage("import-error", { targetNodeId: message.targetNodeId, error: message.error });
    if (!isWanxPage && message?.type === "canvas:import-video") {
      const sessionResponse = await sendRuntime({ type: "bridge:get-session" });
      const session = sessionResponse?.session;
      if (!session?.ready || session.sessionId !== message.sessionId) throw new Error("桥接任务已过期，请重新发送");
      const file = session.files.find((item) => item.fileId === message.fileId);
      if (!file) throw new Error("没有找到待导入的视频");
      const result = await readFileFromSession(session, file);
      const blob = new Blob([result], { type: file.mimeType || "video/mp4" });
      const response = await requestPage("import-video", { blob, filename: file.name, mimeType: file.mimeType, sourceNodeIds: session.sourceNodeIds, targetNodeId: session.targetNodeId, prompt: session.prompt, autoSubmit: session.autoSubmit });
      if (!response.ok) throw new Error(response.error || "导入画布失败");
      return { ok: true };
    }
    return { ok: false, error: "当前页面不支持该操作" };
  };

  run().then(sendResponse).catch((error) => {
    const text = error instanceof Error ? error.message : "桥接失败";
    showStatus(text, true);
    if (isWanxPage && message?.type === "wanx:import-video") void sendRuntime({ type: "wanx:import-failed", error: text }).catch(() => {});
    sendResponse({ ok: false, error: text });
  });
  return true;
});

window.addEventListener("message", (event) => {
  const data = event.data;
  if (event.source !== window || event.origin !== location.origin || data?.source !== PAGE_SOURCE || !data.requestId) return;
  if (data.type === "wanx-ping") {
    window.postMessage({ source: EXTENSION_SOURCE, type: "wanx-pong", requestId: data.requestId }, location.origin);
    return;
  }
  if (data.type !== "wanx-generate") return;
  void exportCanvasContext({ nodeId: data.nodeId, prompt: data.prompt, autoSubmit: true }).then((result) => {
    window.postMessage({ source: EXTENSION_SOURCE, type: "wanx-generate-response", requestId: data.requestId, ...result }, location.origin);
  }).catch((error) => {
    const text = error instanceof Error ? error.message : "万象桥接失败";
    showStatus(text, true);
    window.postMessage({ source: EXTENSION_SOURCE, type: "wanx-generate-response", requestId: data.requestId, ok: false, error: text }, location.origin);
  });
});

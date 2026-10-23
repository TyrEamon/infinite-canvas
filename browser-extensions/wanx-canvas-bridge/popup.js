const elements = {
  label: document.getElementById("page-label"),
  canvasActions: document.getElementById("canvas-actions"),
  wanxActions: document.getElementById("wanx-actions"),
  send: document.getElementById("send-to-wanx"),
  scan: document.getElementById("scan-videos"),
  videos: document.getElementById("videos"),
  status: document.getElementById("status"),
};

function showStatus(text, error = false) {
  elements.status.textContent = text;
  elements.status.dataset.error = String(error);
}

async function activeTab() {
  return (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
}

function isCanvasUrl(url = "") {
  return url.startsWith("http://localhost:3000/") || url.startsWith("http://127.0.0.1:3000/");
}

function setBusy(button, busy, text) {
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? text : button.dataset.label;
}

async function sendToWanx() {
  setBusy(elements.send, true, "正在读取画布素材…");
  showStatus("");
  try {
    const tab = await activeTab();
    const response = await chrome.tabs.sendMessage(tab.id, { type: "canvas:export" });
    if (!response?.ok) throw new Error(response?.error || "发送失败");
    const details = response.skipped ? `，成功挂载 ${response.attached}/${response.files} 个素材，${response.skipped} 个需检查` : `，挂载 ${response.attached} 个素材`;
    showStatus(`提示词已发送${details}。请检查页面并手动点击生成。`);
  } catch (error) {
    showStatus(error instanceof Error ? error.message : "发送失败", true);
  } finally {
    setBusy(elements.send, false);
  }
}

async function scanVideos() {
  setBusy(elements.scan, true, "正在扫描…");
  elements.videos.replaceChildren();
  showStatus("");
  try {
    const tab = await activeTab();
    const response = await chrome.tabs.sendMessage(tab.id, { type: "wanx:list-videos" });
    if (!response?.ok) throw new Error(response?.error || "扫描失败");
    if (!response.videos.length) {
      showStatus("页面里还没有可读取的视频");
      return;
    }
    response.videos.forEach((video, index) => {
      const button = document.createElement("button");
      button.className = "video-choice";
      const duration = video.duration ? `${video.duration.toFixed(1)} 秒` : "时长读取中";
      const label = document.createElement("strong");
      const detail = document.createElement("span");
      label.textContent = `视频 ${index + 1}`;
      detail.textContent = duration;
      button.append(label, detail);
      button.addEventListener("click", () => importVideo(video.candidateId, button));
      elements.videos.appendChild(button);
    });
    showStatus(`找到 ${response.videos.length} 个页面视频；选中万相生成的结果回传`);
  } catch (error) {
    showStatus(error instanceof Error ? error.message : "扫描失败", true);
  } finally {
    setBusy(elements.scan, false);
  }
}

async function importVideo(candidateId, button) {
  setBusy(button, true, "正在回传…");
  showStatus("");
  try {
    const tab = await activeTab();
    const response = await chrome.tabs.sendMessage(tab.id, { type: "wanx:import-video", candidateId });
    if (!response?.ok) throw new Error(response?.error || "回传失败");
    showStatus("视频已导入画布并连接参考节点");
  } catch (error) {
    showStatus(error instanceof Error ? error.message : "回传失败", true);
  } finally {
    setBusy(button, false);
  }
}

async function initialize() {
  const tab = await activeTab();
  if (isCanvasUrl(tab?.url)) {
    elements.label.textContent = "本地画布";
    elements.canvasActions.hidden = false;
    elements.send.addEventListener("click", sendToWanx);
    return;
  }
  if (tab?.url?.startsWith("https://platform.qianwenai.com/")) {
    elements.label.textContent = "通义万相";
    elements.wanxActions.hidden = false;
    elements.scan.addEventListener("click", scanVideos);
    return;
  }
  elements.label.textContent = "请切换到本地画布或通义万相";
}

void initialize();

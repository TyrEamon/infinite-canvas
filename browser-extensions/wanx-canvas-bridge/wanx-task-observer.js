(() => {
  if (window.__infiniteCanvasWanxTaskObserver) return;
  window.__infiniteCanvasWanxTaskObserver = true;

  const source = "infinite-canvas-wanx-task-observer";
  const createApi = "zeldaEasy.bmp.modelPredictRpcService.createAsyncPredictTask";
  const pollApi = "zeldaEasy.bmp.modelPredictRpcService.getAsyncPredictTask";
  const downloadApi = "zeldaEasy.bmp.ossRpcService.download";
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  function requestFrom(body) {
    try {
      const params = body instanceof FormData ? body.get("params") : new URLSearchParams(String(body)).get("params");
      const request = JSON.parse(params);
      return [createApi, pollApi, downloadApi].includes(request.Api) ? request : null;
    } catch {
      return null;
    }
  }

  function responseFrom(xhr) {
    try {
      const raw = xhr.responseType === "json" ? xhr.response : xhr.responseText;
      const response = typeof raw === "string" ? JSON.parse(raw) : raw;
      const payload = response?.data?.DataV2?.data;
      return payload?.data ?? payload ?? response;
    } catch {
      return null;
    }
  }

  function videosFrom(card) {
    return (Array.isArray(card?.sentenceList) ? card.sentenceList : [])
      .filter((item) => item?.type?.toLowerCase() === "video")
      .map((item) => ({ key: item.content || "", url: item.contentUrl || (/^(https?:)?\/\//i.test(item.content || "") ? item.content : "") }));
  }

  function reasonFrom(result, card, allowEnvelope) {
    const sentence = (Array.isArray(card?.sentenceList) ? card.sentenceList : [])
      .filter((item) => item?.type?.toLowerCase() !== "video")
      .map((item) => item?.content || item?.text || "").find((value) => typeof value === "string" && value.trim());
    let debug;
    try { debug = JSON.parse(card?.debugInfo?.response || "null"); } catch {}
    const envelopeMessage = result?.error?.message || result?.message || result?.msg;
    const value = card?.error?.message || card?.errorMessage || card?.failReason || card?.message || debug?.output?.message || sentence || (allowEnvelope && !/^(success|ok|成功)$/i.test(String(envelopeMessage || "").trim()) ? envelopeMessage : "") || debug?.output?.code;
    const text = typeof value === "string" ? value.trim() : "";
    return /^(success|ok|成功|请求成功)$/i.test(text) ? "" : text.slice(0, 800);
  }

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__infiniteCanvasWanxUrl = String(url);
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this.__infiniteCanvasWanxUrl?.includes("/data/api.json")) {
      const request = requestFrom(body);
      if (request) this.addEventListener("loadend", () => {
        const result = responseFrom(this);
        if (!result) return;
        const input = request.Data?.predictRequest;
        const card = result.responseCard;
        const status = this.status >= 200 && this.status < 300 ? card?.status || "" : "FAILED";
        const reason = reasonFrom(result, card, /^FAILED$/i.test(status) || !card);
        let event;
        if (request.Api === createApi) {
          event = {
            kind: "created",
            prompt: (Array.isArray(input?.contentList) ? input.contentList : []).filter((item) => item?.type?.toLowerCase() === "text").map((item) => item.content || "").join("\n"),
            taskId: card?.taskId || "",
            status,
            reason,
            videos: videosFrom(card),
          };
        } else if (request.Api === pollApi) {
          event = {
            kind: "polled",
            requestedTaskId: input?.taskId || "",
            taskId: card?.taskId || "",
            status,
            reason,
            videos: videosFrom(card),
          };
        } else if (request.Api === downloadApi) {
          event = { kind: "downloaded", key: request.Data?.fileKey || "", url: result.url || "" };
        }
        if (event) window.postMessage({ source, event }, location.origin);
      }, { once: true });
    }
    return originalSend.call(this, body);
  };
})();

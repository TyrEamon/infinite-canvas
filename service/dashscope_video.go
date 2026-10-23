package service

import (
	"fmt"
	"strings"
)

func isDashScopeWanVideoModel(protocol, modelName string) bool {
	return strings.EqualFold(strings.TrimSpace(protocol), ModelChannelProtocolDashScope) && (modelName == "wan3.0-video" || modelName == "wan3.0-video-prime")
}

const dashScopeWanVideoRule = `{
    POST: {
        url: "services/aigc/video-generation/video-synthesis",
        headers: { "X-DashScope-Async": "enable" },
        body: {
            model,
            input: {
                prompt,
                media: firstFrame || lastFrame
                    ? [firstFrame ? { type: "first_frame", url: firstFrame } : null, lastFrame ? { type: "last_frame", url: lastFrame } : null].filter(Boolean)
                    : images.length || videos.length || audios.length
                        ? [...images.map((url) => ({ type: "reference_image", url })), ...videos.map((url) => ({ type: "reference_video", url })), ...audios.map((url) => ({ type: "reference_audio", url }))]
                        : undefined
            },
            parameters: {
                resolution: String(resolution).toUpperCase().replace(/P$/, "") + "P",
                ratio: aspectRatio === "auto" || !aspectRatio ? "adaptive" : aspectRatio,
                duration: seconds,
                audio: generateAudio,
                watermark,
                prompt_extend: false
            }
        }
    },
    result: "output.video_url",
    error: (value) => value && value.output && value.output.message || value && value.message || value && value.error && value.error.message,
    poll: {
        taskId: "output.task_id",
        GET: { url: "tasks/{taskId}" },
        status: "output.task_status",
        success: ["SUCCEEDED"],
        failure: ["FAILED", "CANCELED", "UNKNOWN"]
    }
}`

var dashScopeWanVideoTranslation = fmt.Sprintf(`{ models: { "wan3.0-video": %s, "wan3.0-video-prime": %s } }`, dashScopeWanVideoRule, dashScopeWanVideoRule)

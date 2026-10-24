"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Bot, ImageIcon, LoaderCircle, Square, Type } from "lucide-react";
import { ModelPicker } from "@/components/model-picker";
import { canvasThemes } from "@/lib/canvas-theme";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeChat, CanvasNodeChatReference } from "../types";

type Props = {
    chat?: CanvasNodeChat;
    references: CanvasNodeChatReference[];
    onSend: (text: string) => void;
    onStop: () => void;
    onModelChange: (model: string, channelId?: string) => void;
    onContextChange: (turns: 4 | 8 | 16) => void;
};

export function CanvasAgentChatNode({ chat, references, onSend, onStop, onModelChange, onContextChange }: Props) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const config = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const [draft, setDraft] = useState("");
    const listRef = useRef<HTMLDivElement>(null);
    const messages = chat?.messages || [];
    const latestMessage = messages[messages.length - 1];
    const running = latestMessage?.status === "pending";
    const contextTurns = chat?.contextTurns || 8;

    useEffect(() => {
        const list = listRef.current;
        if (list) list.scrollTop = list.scrollHeight;
    }, [messages.length, latestMessage?.text]);

    const send = () => {
        const text = draft.trim();
        if (!text || running) return;
        setDraft("");
        onSend(text);
    };

    return (
        <div
            className="flex h-full w-full flex-col select-text"
            style={{ color: theme.node.text, background: theme.node.fill }}
            data-canvas-no-zoom
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheelCapture={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
        >
            <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2" style={{ borderColor: theme.node.stroke }}>
                <Bot className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-xs font-semibold">独立聊天</span>
                <span className="text-[11px]" style={{ color: theme.node.muted }}>最近最多 {contextTurns} 轮</span>
            </div>
            <div className="flex min-h-0 shrink-0 items-center gap-2 border-b px-3 py-2" style={{ borderColor: theme.node.stroke }}>
                <div className="min-w-0 flex-1"><ModelPicker config={config} value={chat?.model || config.textModel || config.model} channelId={chat?.channelId || config.textChannelId} onChange={onModelChange} onMissingConfig={() => openConfigDialog(true)} className="!w-full !min-w-0" /></div>
                <label className="shrink-0 text-[11px]" style={{ color: theme.node.muted }}>
                    <span className="sr-only">上下文长度</span>
                    <select value={contextTurns} onChange={(event) => onContextChange(Number(event.target.value) as 4 | 8 | 16)} className="max-w-24 cursor-pointer rounded-lg border px-1 py-1 text-xs outline-none focus-visible:ring-2" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }} aria-label="上下文长度">
                        <option value={4}>短 · 4 轮</option><option value={8}>标准 · 8 轮</option><option value={16}>长 · 16 轮</option>
                    </select>
                </label>
            </div>
            {references.length ? <div className="flex shrink-0 gap-1 overflow-x-auto border-b px-3 py-2" style={{ borderColor: theme.node.stroke }} title="发送时读取这些连线上的当前素材">
                {references.map((reference) => <span key={reference.nodeId} className="flex max-w-28 shrink-0 items-center gap-1 truncate rounded-md px-2 py-1 text-[11px]" style={{ background: theme.toolbar.panel, color: theme.node.muted }}>{reference.kind === "image" ? <ImageIcon className="size-3 shrink-0" /> : <Type className="size-3 shrink-0" />}<span className="truncate">{reference.title}</span></span>)}
            </div> : null}
            <div ref={listRef} className="thin-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3" aria-live="polite">
                {!messages.length ? <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-xs" style={{ color: theme.node.muted }}><Bot className="size-6 opacity-50" /><span>连接图片或文本，然后在这里提问</span><span>视频请先截帧为图片</span></div> : null}
                {messages.map((item) => <div key={item.id} className={`flex ${item.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className="max-w-[92%] whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-[13px] leading-5" style={{ background: item.role === "user" ? theme.toolbar.activeBg : theme.toolbar.panel, color: item.status === "error" ? theme.node.muted : theme.node.text }}>
                        {item.status === "pending" ? <span className="flex items-center gap-2"><LoaderCircle className="size-3.5 animate-spin" />正在思考…</span> : item.text}
                        {item.references?.length ? <div className="mt-1.5 border-t pt-1.5 text-[11px]" style={{ borderColor: theme.toolbar.border, color: theme.node.muted }}>本轮素材：{item.references.map((reference) => reference.title).join("、")}</div> : null}
                    </div>
                </div>)}
            </div>
            <div className="shrink-0 border-t p-2" style={{ borderColor: theme.node.stroke }}>
                <div className="flex items-end gap-2 rounded-xl border px-2 py-1.5" style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}>
                    <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} rows={2} placeholder="提问或讨论…" aria-label="向 Agent 提问" className="thin-scrollbar min-w-0 flex-1 resize-none bg-transparent text-[13px] leading-5 outline-none placeholder:opacity-50" />
                    <button type="button" onClick={running ? onStop : send} disabled={!running && !draft.trim()} aria-label={running ? "停止回复" : "发送消息"} title={running ? "停止回复" : "发送消息"} className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg transition-colors hover:opacity-70 focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-40" style={{ background: theme.toolbar.activeBg, color: theme.node.text }}>{running ? <Square className="size-3.5" /> : <ArrowUp className="size-4" />}</button>
                </div>
            </div>
        </div>
    );
}

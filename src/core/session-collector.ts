/**
 * ACP 会话事件收集器。
 *
 * 把 ACP 的 `session/update` 通知流整理成两类可消费数据：
 *   - 增量文本（agent_message_chunk / agent_thought_chunk）→ 供 onUpdate 实时推送
 *   - 工具调用（tool_call / tool_call_update）→ 合并成工具调用记录
 *
 * 上游原本只把 update 转发给 heartbeat（仅 worker 会话有效），
 * 非 worker 会话的事件被完全丢弃；这里补上通用消费路径。
 */

import type { SessionUpdate } from "@agentclientprotocol/sdk";

/** 单次工具调用在会话内的合并状态。 */
export interface ToolCallRecord {
	toolCallId: string;
	title: string;
	kind?: string;
	status: "pending" | "in_progress" | "completed" | "failed" | string;
	/** 受影响文件路径，来自 locations 或 rawInput.file_path。 */
	paths: string[];
	/** 命令（kind=execute 时）。 */
	command?: string;
	/** 输出摘要，已截断。 */
	output?: string;
	/** 错误摘要，已截断。 */
	error?: string;
	startedAt: number;
	endedAt?: number;
}

const MAX_FIELD_CHARS = 2000;

function clip(text: unknown, limit = MAX_FIELD_CHARS): string | undefined {
	if (text === undefined || text === null) return undefined;
	const s = typeof text === "string" ? text : JSON.stringify(text);
	if (!s) return undefined;
	return s.length > limit ? `${s.slice(0, limit)}… [截断 ${s.length - limit}]` : s;
}

/** 从 tool_call / tool_call_update 里尽力提取内容文本。 */
function extractContentText(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const rec = item as Record<string, any>;
		if (rec.type === "content" && rec.content?.type === "text" && rec.content.text) {
			parts.push(String(rec.content.text));
		} else if (rec.type === "diff" && typeof rec.newText === "string") {
			parts.push(`[diff] ${rec.newText}`);
		}
	}
	return parts.length ? parts.join("\n") : undefined;
}

function extractPaths(update: Record<string, any>): string[] {
	const out = new Set<string>();
	if (Array.isArray(update.locations)) {
		for (const loc of update.locations) {
			if (loc && typeof loc.path === "string") out.add(loc.path);
		}
	}
	const input = update.rawInput;
	if (input && typeof input === "object") {
		for (const key of ["file_path", "path", "filePath"]) {
			const v = (input as Record<string, unknown>)[key];
			if (typeof v === "string") out.add(v);
		}
	}
	return [...out];
}

/**
 * 把一条 tool_call / tool_call_update 合并进已有记录（无则新建）。
 * client.ts 与 AcpSessionCollector 共用，保证两条路径语义一致。
 */
export function mergeToolCall(
	prev: ToolCallRecord | undefined,
	u: Record<string, any>,
): ToolCallRecord {
	const id = typeof u.toolCallId === "string" ? u.toolCallId : prev?.toolCallId ?? "";
	const rec: ToolCallRecord = prev
		? { ...prev, paths: [...prev.paths] }
		: {
				toolCallId: id,
				title: typeof u.title === "string" ? u.title : "(unknown tool)",
				status: typeof u.status === "string" ? u.status : "pending",
				paths: [],
				startedAt: Date.now(),
			};

	// title 在 update 里可能缺省，只在有值时覆盖
	if (typeof u.title === "string" && u.title) rec.title = u.title;
	if (typeof u.kind === "string" && u.kind) rec.kind = u.kind;
	if (typeof u.status === "string" && u.status) rec.status = u.status;

	const paths = extractPaths(u);
	if (paths.length) rec.paths = [...new Set([...rec.paths, ...paths])];

	const input = u.rawInput;
	if (input && typeof input === "object" && typeof (input as any).command === "string") {
		rec.command = (input as any).command;
	}

	if (u.rawOutput !== undefined && u.rawOutput !== null) {
		const text = extractContentText(u.content) ?? clip(u.rawOutput);
		if (text) rec.output = clip(text);
	} else if (rec.output === undefined) {
		const text = extractContentText(u.content);
		if (text) rec.output = clip(text);
	}

	if (rec.status === "completed" || rec.status === "failed") {
		if (!rec.endedAt) rec.endedAt = Date.now();
		if (rec.status === "failed" && !rec.error) rec.error = clip(u.rawOutput) ?? "failed";
	}

	return rec;
}

export interface AcpSessionCollectorOptions {
	/** 收到文本增量时回调，用于实时推送。 */
	onTextDelta?: (kind: "message" | "thought", text: string) => void;
	/** 工具调用新建或状态变化时回调。 */
	onToolCall?: (record: ToolCallRecord) => void;
}

/**
 * 消费一条 session/update。返回值表示是否被识别。
 * 记录按 toolCallId 合并：tool_call 建立记录，tool_call_update 增量补齐。
 */
export class AcpSessionCollector {
	private toolCalls = new Map<string, ToolCallRecord>();
	/** 消息文本全文（不含思考）。 */
	messageText = "";
	/** 思考文本全文。 */
	thoughtText = "";

	constructor(private readonly opts: AcpSessionCollectorOptions = {}) {}

	consume(update: SessionUpdate | Record<string, any>): boolean {
		const u = update as Record<string, any>;
		const type = u?.sessionUpdate;
		if (typeof type !== "string") return false;

		if (type === "agent_message_chunk" || type === "agent_thought_chunk") {
			const content = u.content;
			if (content?.type === "text" && typeof content.text === "string" && content.text) {
				if (type === "agent_message_chunk") {
					this.messageText += content.text;
					this.opts.onTextDelta?.("message", content.text);
				} else {
					this.thoughtText += content.text;
					this.opts.onTextDelta?.("thought", content.text);
				}
			}
			return true;
		}

		if (type === "tool_call" || type === "tool_call_update") {
			this.applyToolEvent(u);
			return true;
		}

		return false;
	}

	private applyToolEvent(u: Record<string, any>): void {
		const id = typeof u.toolCallId === "string" ? u.toolCallId : "";
		if (!id) return;
		const prev = this.toolCalls.get(id);
		const rec = mergeToolCall(prev, u);
		this.toolCalls.set(id, rec);
		this.opts.onToolCall?.({ ...rec, paths: [...rec.paths] });
	}

	/**
	 * 并入一条由 client 侧生成的工具调用记录（onStream 的 tool_call 事件）。
	 * 以 toolCallId 为键覆盖，保留最新的 status / output。
	 */
	mergeExternalRecord(record: ToolCallRecord): void {
		this.toolCalls.set(record.toolCallId, { ...record, paths: [...record.paths] });
	}

	getToolCalls(): ToolCallRecord[] {
		return [...this.toolCalls.values()].map((r) => ({ ...r, paths: [...r.paths] }));
	}
}

/** 把工具调用记录渲染成紧凑的一行，用于 pi 的流式展示。 */
export function formatToolCallLine(rec: ToolCallRecord, maxTitle = 80): string {
	const icon =
		rec.status === "completed" ? "✓" : rec.status === "failed" ? "✗" : rec.status === "in_progress" ? "▸" : "·";
	const title = rec.title.length > maxTitle ? `${rec.title.slice(0, maxTitle)}…` : rec.title;
	const kind = rec.kind ? ` [${rec.kind}]` : "";
	return `${icon}${kind} ${title}`;
}

/** 把完整的工具调用记录渲染成最终结论用的摘要块。 */
export function formatToolCallsReport(records: ToolCallRecord[], options?: { maxOutputChars?: number }): string {
	if (!records.length) return "";
	const maxOut = options?.maxOutputChars ?? 300;
	const lines: string[] = [];
	for (const rec of records) {
		const status = rec.status === "completed" ? "完成" : rec.status === "failed" ? "失败" : rec.status;
		lines.push(`- ${rec.title}${rec.kind ? ` (${rec.kind})` : ""} — ${status}`);
		if (rec.command) lines.push(`    命令: ${rec.command}`);
		if (rec.paths.length) lines.push(`    文件: ${rec.paths.join(", ")}`);
		if (rec.error) lines.push(`    错误: ${clip(rec.error, maxOut)}`);
		else if (rec.output) {
			const oneLine = rec.output.replace(/\s+/g, " ").trim();
			const short = oneLine.length > maxOut ? `${oneLine.slice(0, maxOut)}…` : oneLine;
			if (short) lines.push(`    输出: ${short}`);
		}
	}
	return lines.join("\n");
}

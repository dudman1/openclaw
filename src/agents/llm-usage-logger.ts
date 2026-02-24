/**
 * Provider-agnostic LLM usage logger.
 *
 * Activated by: LLM_USAGE_DEBUG=1
 * Output file:  ~/.openclaw/logs/llm_usage.ndjson
 *               (overridden by LLM_USAGE_DEBUG_FILE env var)
 *
 * Logs a "input" record before each LLM call (message counts, char totals,
 * estimated token count, loop-detection warnings), and a "usage" record after
 * each call (actual token counts when returned by the API).
 *
 * Loop detection: if the same session emits the same (messageCount, totalChars)
 * tuple 3 times in a row without progress, a LOOP_BREAK warning is logged.
 */
import path from "node:path";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import { getQueuedFileWriter, type QueuedFileWriter } from "./queued-file-writer.js";

// ─── Types ────────────────────────────────────────────────────────────────────

type UsageLogStage = "input" | "usage" | "loop_break";

type UsageLogEvent = {
  ts: string;
  stage: UsageLogStage;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  messageCount: number;
  totalTextChars: number;
  maxMessageTextChars: number;
  estimatedInputTokens: number;
  historyLimitApplied?: boolean;
  loopWarning?: string;
  // "usage" stage only
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  error?: string;
};

// ─── Singleton writer pool ────────────────────────────────────────────────────

const writers = new Map<string, QueuedFileWriter>();
const log = createSubsystemLogger("agent/llm-usage");

// ─── Loop detection state ─────────────────────────────────────────────────────

/**
 * Tracks consecutive identical-context calls per session to detect loops.
 * Key: sessionKey ?? sessionId, Value: { messageCount, totalChars, streak }
 */
const loopTracker = new Map<string, { messageCount: number; totalChars: number; streak: number }>();

const LOOP_STREAK_THRESHOLD = 3;

function checkAndUpdateLoopTracker(
  sessionKey: string,
  messageCount: number,
  totalChars: number,
): string | undefined {
  const entry = loopTracker.get(sessionKey);
  if (entry && entry.messageCount === messageCount && entry.totalChars === totalChars) {
    entry.streak += 1;
    if (entry.streak >= LOOP_STREAK_THRESHOLD) {
      return (
        `LOOP_BREAK: session ${sessionKey} has sent the same context ` +
        `(messages=${messageCount}, chars=${totalChars}) ` +
        `${entry.streak} times consecutively`
      );
    }
  } else {
    loopTracker.set(sessionKey, { messageCount, totalChars, streak: 1 });
  }
  return undefined;
}

// ─── Token estimation ─────────────────────────────────────────────────────────

/** Rough estimate: ~4 chars per token (conservative for English text). */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

// ─── Message size helpers ─────────────────────────────────────────────────────

function countMessageChars(msg: unknown): number {
  const m = msg as { content?: unknown };
  if (typeof m.content === "string") {
    return m.content.length;
  }
  if (!Array.isArray(m.content)) {
    return 0;
  }
  let chars = 0;
  for (const block of m.content) {
    const b = block as { type?: unknown; text?: unknown };
    if (typeof b.text === "string") {
      chars += b.text.length;
    }
  }
  return chars;
}

function analyzeMessages(messages: unknown[]): {
  totalTextChars: number;
  maxMessageTextChars: number;
} {
  let totalTextChars = 0;
  let maxMessageTextChars = 0;
  for (const msg of messages) {
    const chars = countMessageChars(msg);
    totalTextChars += chars;
    if (chars > maxMessageTextChars) {
      maxMessageTextChars = chars;
    }
  }
  return { totalTextChars, maxMessageTextChars };
}

// ─── Config resolution ────────────────────────────────────────────────────────

type LoggerConfig = {
  enabled: boolean;
  filePath: string;
};

function resolveLoggerConfig(env: NodeJS.ProcessEnv): LoggerConfig {
  const enabled = parseBooleanValue(env.LLM_USAGE_DEBUG) ?? false;
  const fileOverride = env.LLM_USAGE_DEBUG_FILE?.trim();
  const filePath = fileOverride
    ? fileOverride
    : path.join(resolveStateDir(env), "logs", "llm_usage.ndjson");
  return { enabled, filePath };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export type LlmUsageLogger = {
  enabled: true;
  wrapStreamFn: (streamFn: StreamFn) => StreamFn;
  recordUsage: (
    messages: unknown[],
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
    },
    error?: unknown,
  ) => void;
};

/**
 * Create an LLM usage logger instance for one agent run.
 * Returns null when LLM_USAGE_DEBUG is not set.
 */
export function createLlmUsageLogger(params: {
  env?: NodeJS.ProcessEnv;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
}): LlmUsageLogger | null {
  const env = params.env ?? process.env;
  const cfg = resolveLoggerConfig(env);
  if (!cfg.enabled) {
    return null;
  }

  const writer = getQueuedFileWriter(writers, cfg.filePath);
  const sessionLabel = params.sessionKey ?? params.sessionId ?? "unknown";

  const base: Omit<
    UsageLogEvent,
    | "ts"
    | "stage"
    | "messageCount"
    | "totalTextChars"
    | "maxMessageTextChars"
    | "estimatedInputTokens"
  > = {
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider,
    modelId: params.modelId,
  };

  const record = (event: UsageLogEvent) => {
    const line = safeJsonStringify(event);
    if (!line) {
      return;
    }
    writer.write(`${line}\n`);
  };

  const wrapStreamFn: LlmUsageLogger["wrapStreamFn"] = (streamFn) => {
    const wrapped: StreamFn = (model, context, options) => {
      const ctx = context as unknown as { messages?: unknown };
      const rawMessages = ctx?.messages;
      const messages: unknown[] = Array.isArray(rawMessages) ? rawMessages : [];

      const { totalTextChars, maxMessageTextChars } = analyzeMessages(messages);
      const estimatedInputTokens = estimateTokens(totalTextChars);
      const messageCount = messages.length;

      // Loop detection
      const loopWarning = checkAndUpdateLoopTracker(sessionLabel, messageCount, totalTextChars);

      const inputEvent: UsageLogEvent = {
        ...base,
        ts: new Date().toISOString(),
        stage: loopWarning ? "loop_break" : "input",
        messageCount,
        totalTextChars,
        maxMessageTextChars,
        estimatedInputTokens,
        loopWarning,
      };
      record(inputEvent);

      if (loopWarning) {
        log.warn(`[llm-usage] ${loopWarning}`);
      } else {
        log.debug(
          `[llm-usage] input session=${sessionLabel} ` +
            `provider=${params.provider}/${params.modelId} ` +
            `messages=${messageCount} chars=${totalTextChars} ` +
            `~tokens=${estimatedInputTokens}`,
        );
      }

      return streamFn(model, context, options);
    };
    return wrapped;
  };

  const recordUsage: LlmUsageLogger["recordUsage"] = (messages, usage, error) => {
    const { totalTextChars, maxMessageTextChars } = analyzeMessages(
      Array.isArray(messages) ? messages : [],
    );
    const errorMessage =
      error instanceof Error ? error.message : typeof error === "string" ? error : undefined;

    const event: UsageLogEvent = {
      ...base,
      ts: new Date().toISOString(),
      stage: "usage",
      messageCount: Array.isArray(messages) ? messages.length : 0,
      totalTextChars,
      maxMessageTextChars,
      estimatedInputTokens: estimateTokens(totalTextChars),
      inputTokens: usage?.input,
      outputTokens: usage?.output,
      cacheReadTokens: usage?.cacheRead,
      cacheWriteTokens: usage?.cacheWrite,
      error: errorMessage,
    };
    record(event);

    if (usage?.input || usage?.output) {
      log.info("[llm-usage] usage", {
        session: sessionLabel,
        provider: params.provider,
        model: params.modelId,
        inputTokens: usage?.input,
        outputTokens: usage?.output,
        cacheRead: usage?.cacheRead,
      });
    }
  };

  log.info("[llm-usage] logger enabled", { filePath: writer.filePath, session: sessionLabel });
  return { enabled: true, wrapStreamFn, recordUsage };
}

// ─── compactMessages (Task E) ─────────────────────────────────────────────────

/**
 * Compact a messages array before sending to an LLM:
 *
 * 1. Dedupe consecutive identical system messages.
 * 2. Truncate any message whose text content exceeds `maxMessageChars`
 *    (default 20 000 chars ≈ 5 000 tokens).
 * 3. Convert large tool-result JSON blobs to a one-line summary if they
 *    exceed `maxToolResultChars` (default 8 000 chars ≈ 2 000 tokens).
 * 4. Drop messages beyond the tail `maxMessages` window (keep system + last N).
 *
 * This is a pre-flight utility — call it on the messages array before passing
 * to an LLM if you want a lighter-weight alternative to full SDK compaction.
 * It never mutates the input array.
 */
export function compactMessages(
  messages: unknown[],
  options: {
    maxMessages?: number;
    maxMessageChars?: number;
    maxToolResultChars?: number;
  } = {},
): unknown[] {
  const maxMessages = options.maxMessages ?? 60;
  const maxMsgChars = options.maxMessageChars ?? 20_000;
  const maxToolChars = options.maxToolResultChars ?? 8_000;

  const TRUNC_SUFFIX = "\n…[truncated — content exceeded context budget]";

  function truncateString(text: string, limit: number): string {
    if (text.length <= limit) {
      return text;
    }
    return text.slice(0, limit - TRUNC_SUFFIX.length) + TRUNC_SUFFIX;
  }

  function compactContent(content: unknown, isToolResult: boolean): unknown {
    if (typeof content === "string") {
      const cap = isToolResult ? maxToolChars : maxMsgChars;
      return truncateString(content, cap);
    }
    if (!Array.isArray(content)) {
      return content;
    }
    return content.map((block: unknown) => {
      if (!block || typeof block !== "object") {
        return block;
      }
      const b = block as { type?: unknown; text?: unknown };
      if (typeof b.text !== "string") {
        return block;
      }
      const cap = isToolResult ? maxToolChars : maxMsgChars;
      if (b.text.length <= cap) {
        return block;
      }
      return { ...b, text: truncateString(b.text, cap) };
    });
  }

  let compacted = messages.map((msg: unknown) => {
    if (!msg || typeof msg !== "object") {
      return msg;
    }
    const m = msg as { role?: unknown; content?: unknown };
    const isToolResult = m.role === "toolResult" || m.role === "tool" || m.role === "function";
    if (m.content === undefined) {
      return msg;
    }
    const newContent = compactContent(m.content, isToolResult);
    if (newContent === m.content) {
      return msg;
    }
    return { ...m, content: newContent };
  });

  // Dedupe consecutive identical system messages
  const seen = new Set<string>();
  compacted = compacted.filter((msg: unknown) => {
    if (!msg || typeof msg !== "object") {
      return true;
    }
    const m = msg as { role?: unknown; content?: unknown };
    if (m.role !== "system") {
      return true;
    }
    const key = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  // Keep system messages + last N non-system messages within window
  if (maxMessages > 0 && compacted.length > maxMessages) {
    const system = compacted.filter(
      (m: unknown) => m && typeof m === "object" && (m as { role?: unknown }).role === "system",
    );
    const nonSystem = compacted.filter(
      (m: unknown) => !m || typeof m !== "object" || (m as { role?: unknown }).role !== "system",
    );
    const tail = nonSystem.slice(-Math.max(0, maxMessages - system.length));
    compacted = [...system, ...tail];
  }

  return compacted;
}

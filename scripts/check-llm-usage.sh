#!/usr/bin/env bash
# check-llm-usage.sh — View and analyse LLM token usage logs.
#
# USAGE
#   Enable logging first:
#     export LLM_USAGE_DEBUG=1
#
#   Optional caps (apply without changing openclaw.json):
#     export LLM_MAX_HISTORY_TURNS=30        # cap per-session turn history
#     export LLM_MAX_TOOL_RESULT_CHARS=20000 # cap per-tool-result size
#
#   Run a workflow as normal, then inspect:
#     bash scripts/check-llm-usage.sh           # summary of top burns
#     bash scripts/check-llm-usage.sh --raw     # raw NDJSON tail
#     bash scripts/check-llm-usage.sh --loops   # loop-break events only
#     bash scripts/check-llm-usage.sh --top N   # top N largest input calls

set -euo pipefail

LOG_FILE="${LLM_USAGE_DEBUG_FILE:-${HOME}/.openclaw/logs/llm_usage.ndjson}"
MODE="summary"
TOP_N=10

while [[ $# -gt 0 ]]; do
  case "$1" in
    --raw)    MODE="raw"; shift ;;
    --loops)  MODE="loops"; shift ;;
    --top)    MODE="top"; TOP_N="${2:-10}"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ ! -f "$LOG_FILE" ]]; then
  echo "Log file not found: $LOG_FILE"
  echo ""
  echo "To enable logging, set LLM_USAGE_DEBUG=1 before running openclaw."
  echo "Example:"
  echo "  export LLM_USAGE_DEBUG=1"
  echo "  export LLM_MAX_HISTORY_TURNS=30"
  echo "  openclaw agent --message 'hello'"
  echo "  bash scripts/check-llm-usage.sh"
  exit 1
fi

LINES=$(wc -l < "$LOG_FILE" | tr -d ' ')
echo "Log file: $LOG_FILE  ($LINES lines)"
echo ""

case "$MODE" in
  raw)
    echo "=== Last 50 raw NDJSON entries ==="
    tail -50 "$LOG_FILE"
    ;;

  loops)
    echo "=== LOOP_BREAK events ==="
    if command -v jq &>/dev/null; then
      jq -c 'select(.stage == "loop_break")' "$LOG_FILE" | jq -r '"[\(.ts)] \(.sessionKey // .sessionId) — \(.loopWarning)"'
    else
      grep '"loop_break"' "$LOG_FILE" || echo "(none found)"
    fi
    ;;

  top)
    echo "=== Top $TOP_N largest estimated input token calls ==="
    if command -v jq &>/dev/null; then
      jq -c 'select(.stage == "input")' "$LOG_FILE" \
        | jq -r '[.ts, (.provider // "?"), (.modelId // "?"), (.sessionKey // .sessionId // "?"), .messageCount, .totalTextChars, .estimatedInputTokens] | @tsv' \
        | sort -t$'\t' -k7 -rn \
        | head -"$TOP_N" \
        | awk 'BEGIN{printf "%-24s %-20s %-30s %-8s %-12s %-14s\n","Timestamp","Provider/Model","Session","MsgCnt","TotalChars","~InputTok"}
               {printf "%-24s %-20s %-30s %-8s %-12s %-14s\n",$1,$2"/"$3,$4,$5,$6,$7}'
    else
      echo "(jq not installed — raw grep fallback)"
      grep '"input"' "$LOG_FILE" | tail -"$TOP_N"
    fi
    ;;

  summary)
    echo "=== LLM Usage Summary ==="
    if command -v jq &>/dev/null; then
      echo ""
      echo "--- Input call totals ---"
      jq -c 'select(.stage == "input")' "$LOG_FILE" | jq -s '
        {
          total_calls: length,
          total_estimated_input_tokens: (map(.estimatedInputTokens) | add // 0),
          total_chars: (map(.totalTextChars) | add // 0),
          avg_messages_per_call: ((map(.messageCount) | add // 0) / (length | if . == 0 then 1 else . end) | floor),
          max_single_call_chars: (map(.totalTextChars) | max // 0),
          max_single_call_est_tokens: (map(.estimatedInputTokens) | max // 0)
        }
      '

      echo ""
      echo "--- Actual usage totals (from API responses) ---"
      jq -c 'select(.stage == "usage")' "$LOG_FILE" | jq -s '
        {
          total_usage_events: length,
          total_input_tokens: (map(.inputTokens // 0) | add // 0),
          total_output_tokens: (map(.outputTokens // 0) | add // 0),
          total_cache_read_tokens: (map(.cacheReadTokens // 0) | add // 0)
        }
      '

      echo ""
      echo "--- Loop-break events ---"
      LOOPS=$(jq -c 'select(.stage == "loop_break")' "$LOG_FILE" | wc -l | tr -d ' ')
      echo "  Loop-break count: $LOOPS"
      if [[ "$LOOPS" -gt 0 ]]; then
        jq -c 'select(.stage == "loop_break")' "$LOG_FILE" \
          | jq -r '"  [\(.ts)] \(.sessionKey // .sessionId // "?"): \(.loopWarning // "loop detected")"'
      fi

      echo ""
      echo "--- Top 5 largest input calls ---"
      jq -c 'select(.stage == "input")' "$LOG_FILE" \
        | jq -r '[.ts, (.provider // "?"), (.modelId // "?"), (.sessionKey // .sessionId // "?"), .messageCount, .totalTextChars, .estimatedInputTokens] | @tsv' \
        | sort -t$'\t' -k7 -rn \
        | head -5 \
        | awk 'BEGIN{printf "  %-24s %-22s %-28s %8s %12s %14s\n","Timestamp","Provider/Model","Session","MsgCnt","TotalChars","~InputTok"}
               {printf "  %-24s %-22s %-28s %8s %12s %14s\n",$1,$2"/"$3,$4,$5,$6,$7}'

      echo ""
      echo "--- Estimated cost (input tokens @ gpt-4o pricing \$2.50/1M) ---"
      jq -c 'select(.stage == "input")' "$LOG_FILE" | jq -s '
        (map(.estimatedInputTokens) | add // 0) as $tok |
        "\($tok) estimated input tokens — ~$\($tok / 1000000 * 2.5 | . * 100 | round / 100)"
      ' -r

    else
      echo "(jq not installed — install jq for rich output)"
      echo ""
      echo "Unique sessions:"
      grep '"input"' "$LOG_FILE" | grep -o '"sessionKey":"[^"]*"' | sort -u | head -20
      echo ""
      echo "Total input entries: $(grep -c '"input"' "$LOG_FILE" || echo 0)"
      echo "Total loop-break events: $(grep -c '"loop_break"' "$LOG_FILE" || echo 0)"
    fi
    ;;
esac

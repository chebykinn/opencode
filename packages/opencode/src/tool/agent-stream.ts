import { Session } from "../session"
import { SessionID } from "../session/schema"
import { SessionStatus } from "../session/status"
import { MessageV2 } from "../session/message-v2"
import { Bus } from "@/bus"
import type { Tool } from "./tool"

export async function resolveSession(sessionId: string): Promise<Session.Info> {
  if (sessionId.startsWith("ses")) {
    try {
      return await Session.get(SessionID.make(sessionId))
    } catch {
      // fall through to slug lookup
    }
  }
  return await Session.getBySlug(sessionId)
}

export function toolTitle(tool: MessageV2.ToolPart): string {
  const state = tool.state
  if (state.status === "completed") return state.title || inputSummary(state.input)
  if (state.status === "error") return inputSummary(state.input)
  if (state.status === "running" && state.title) return state.title
  return inputSummary(state.input)
}

function inputSummary(input: Record<string, any>): string {
  const val = input.command ?? input.filePath ?? input.file_path ?? input.pattern ?? input.description ?? input.query
  if (typeof val === "string") return val.length > 80 ? val.slice(0, 80) + "…" : val
  for (const v of Object.values(input)) {
    if (typeof v === "string" && v.length > 0) return v.length > 80 ? v.slice(0, 80) + "…" : v
  }
  return ""
}

type ToolInfo = { tool: string; title: string; status: string; output?: string; error?: string }

function extractToolInfo(tool: MessageV2.ToolPart): ToolInfo {
  return {
    tool: tool.tool,
    title: toolTitle(tool),
    status: tool.state.status,
    output: tool.state.status === "completed" ? tool.state.output : undefined,
    error: tool.state.status === "error" ? tool.state.error : undefined,
  }
}

export interface StreamResult {
  output: string
  aborted: boolean
  status: SessionStatus.Info
}

/**
 * Stream a subagent's output via bus event subscriptions.
 * Calls `onUpdate` whenever new content is available.
 * Returns when the agent finishes, times out, or the abort signal fires.
 */
export async function streamAgent(input: {
  session: Session.Info
  abort: AbortSignal
  timeout: number
  onUpdate: (output: string) => void
}): Promise<StreamResult> {
  const { session, abort, timeout } = input

  const textParts = new Map<string, string>()
  const toolParts = new Map<string, ToolInfo>()
  let dirty = false

  function rebuild(): string {
    const chunks: string[] = []
    const allKeys = [...new Set([...textParts.keys(), ...toolParts.keys()])].sort()
    for (const key of allKeys) {
      const text = textParts.get(key)
      if (text?.trim()) chunks.push(text)
      const tool = toolParts.get(key)
      if (tool) {
        chunks.push(`**\`${tool.tool}\`** ${tool.title} _(${tool.status})_`)
        if (tool.output?.trim()) chunks.push(tool.output)
        if (tool.error) chunks.push(`_Error: ${tool.error}_`)
      }
    }
    return chunks.join("\n\n")
  }

  // Subscribe to part updates
  const unsubPart = Bus.subscribe(MessageV2.Event.PartUpdated, (evt) => {
    if (evt.properties.part.sessionID !== session.id) return
    const part = evt.properties.part
    const key = part.id as string

    if (part.type === "text") {
      const prev = textParts.get(key)
      if (prev !== (part as MessageV2.TextPart).text) {
        textParts.set(key, (part as MessageV2.TextPart).text)
        dirty = true
      }
    } else if (part.type === "tool") {
      toolParts.set(key, extractToolInfo(part as MessageV2.ToolPart))
      dirty = true
    }
  })

  // Subscribe to streaming text deltas
  const unsubDelta = Bus.subscribe(MessageV2.Event.PartDelta, (evt) => {
    if (evt.properties.sessionID !== session.id) return
    const key = evt.properties.partID as string
    if (evt.properties.field === "text") {
      const prev = textParts.get(key) ?? ""
      textParts.set(key, prev + evt.properties.delta)
      dirty = true
    }
  })

  // Seed with existing messages
  const initialMsgs = await Session.messages({ sessionID: session.id })
  for (const msg of initialMsgs) {
    if (msg.info.role !== "assistant") continue
    for (const p of msg.parts) {
      const key = p.id as string
      if (p.type === "text" && (p as MessageV2.TextPart).text.trim()) {
        textParts.set(key, (p as MessageV2.TextPart).text)
      } else if (p.type === "tool") {
        toolParts.set(key, extractToolInfo(p as MessageV2.ToolPart))
      }
    }
  }
  dirty = true

  const deadline = Date.now() + timeout
  let idleSince = 0
  const IDLE_GRACE_MS = 5000
  const FLUSH_MS = 100

  try {
    while (Date.now() < deadline) {
      if (abort.aborted) break

      if (dirty) {
        dirty = false
        input.onUpdate(rebuild())
      }

      const status = await SessionStatus.get(session.id)
      if (status.type === "idle") {
        if (!idleSince) idleSince = Date.now()
        const hasPendingWork = [...toolParts.values()].some(
          (t) => t.status === "running" || t.status === "pending",
        )
        if (hasPendingWork) {
          idleSince = 0
        } else if (Date.now() - idleSince > IDLE_GRACE_MS) {
          break
        }
      } else {
        idleSince = 0
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, FLUSH_MS)
        abort.addEventListener("abort", () => { clearTimeout(timer); resolve() }, { once: true })
      })
    }
  } finally {
    unsubPart()
    unsubDelta()
  }

  const status = await SessionStatus.get(session.id)
  return { output: rebuild(), aborted: abort.aborted, status }
}

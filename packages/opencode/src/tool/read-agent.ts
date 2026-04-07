import { Tool } from "./tool"
import DESCRIPTION from "./read-agent.txt"
import z from "zod"
import { Session } from "../session"
import { SessionStatus } from "../session/status"
import { MessageV2 } from "../session/message-v2"
import { resolveSession, toolTitle } from "./agent-stream"

const parameters = z.object({
  session_id: z.string().describe("Session ID or slug of the subagent to read"),
  include: z
    .enum(["summary", "output", "messages", "diff"])
    .default("output")
    .describe(
      "What to retrieve: 'output' = full verbatim text from all assistant messages, " +
        "'summary' = title/status/changes metadata, " +
        "'messages' = full conversation transcript (user + assistant + tools), " +
        "'diff' = file changes",
    ),
})

export const ReadAgentTool = Tool.define("read_agent", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx) {
    const session = await resolveSession(params.session_id)
    const status = await SessionStatus.get(session.id)
    const meta = { sessionId: session.id, status: status.type }

    let output: string

    if (params.include === "summary") {
      const lines = [
        `Session: ${session.slug} (${session.id})`,
        `Title: ${session.title}`,
        `Status: ${status.type}`,
        `Created: ${new Date(session.time.created).toISOString()}`,
      ]
      if (session.summary) {
        lines.push(
          `Changes: +${session.summary.additions}/-${session.summary.deletions} (${session.summary.files} files)`,
        )
      }
      if (status.type === "retry") {
        lines.push(`Retry: attempt ${status.attempt}, reason: ${status.message}`)
      }
      output = lines.join("\n")
    } else if (params.include === "output") {
      const msgs = await Session.messages({ sessionID: session.id })
      const chunks: string[] = []
      for (const msg of msgs) {
        if (msg.info.role !== "assistant") continue
        for (const p of msg.parts) {
          if (p.type === "text" && (p as MessageV2.TextPart).text.trim()) {
            chunks.push((p as MessageV2.TextPart).text)
          } else if (p.type === "tool") {
            const tool = p as MessageV2.ToolPart
            const title = toolTitle(tool)
            chunks.push(`**\`${tool.tool}\`** ${title} _(${tool.state.status})_`)
          }
        }
      }
      output = chunks.length > 0 ? chunks.join("\n\n") : "No assistant output yet."
    } else if (params.include === "messages") {
      const msgs = await Session.messages({ sessionID: session.id })
      const lines: string[] = []
      for (const msg of msgs) {
        const role = msg.info.role
        for (const p of msg.parts) {
          if (p.type === "text") {
            const text = (p as MessageV2.TextPart).text
            if (text.trim()) lines.push(`[${role}] ${text}`)
          } else if (p.type === "tool") {
            const tool = p as MessageV2.ToolPart
            const title = toolTitle(tool)
            lines.push(`[tool:${tool.tool}] ${title} (${tool.state.status})`)
            if (tool.state.status === "completed" && "output" in tool.state) {
              const toolOutput = tool.state.output as string
              if (toolOutput.trim()) lines.push(toolOutput)
            }
            if (tool.state.status === "error" && "error" in tool.state) {
              lines.push(`ERROR: ${tool.state.error}`)
            }
          }
        }
      }
      output = lines.join("\n") || "No messages yet."
    } else {
      // diff
      const diffs = await Session.diff(session.id)
      if (!diffs || diffs.length === 0) {
        output = "No file changes."
      } else {
        const lines: string[] = []
        for (const d of diffs) {
          const statusLabel = d.status ? ` (${d.status})` : ""
          lines.push(`--- ${d.file}${statusLabel}`)
          lines.push(`+${d.additions}/-${d.deletions}`)
        }
        output = lines.join("\n")
      }
    }

    return { title: `Agent ${params.include}: ${session.slug}`, metadata: meta, output }
  },
})

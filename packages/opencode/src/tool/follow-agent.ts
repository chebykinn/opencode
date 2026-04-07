import { Tool } from "./tool"
import DESCRIPTION from "./follow-agent.txt"
import z from "zod"
import { resolveSession, streamAgent } from "./agent-stream"

const parameters = z.object({
  session_id: z.string().describe("Session ID or slug of the subagent to follow"),
  timeout: z
    .number()
    .optional()
    .default(120)
    .describe("Max time to follow in seconds (default: 120)"),
})

export const FollowAgentTool = Tool.define("follow_agent", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx) {
    const session = await resolveSession(params.session_id)

    ctx.metadata({
      title: `Following ${session.slug}...`,
      metadata: { sessionId: session.id, status: "busy", output: `_Following ${session.slug}, streaming..._` },
    })

    const result = await streamAgent({
      session,
      abort: ctx.abort,
      timeout: (params.timeout ?? 120) * 1000,
      onUpdate: (output) => {
        ctx.metadata({
          title: `Following ${session.slug}...`,
          metadata: { sessionId: session.id, status: "busy", output },
        })
      },
    })

    const statusLine =
      result.status.type === "idle"
        ? "\n\n_[agent completed]_"
        : `\n\n_[agent still running, timed out after ${params.timeout}s]_`

    return {
      title: `Follow: ${session.slug}`,
      metadata: { sessionId: session.id, status: result.status.type },
      output: result.output + statusLine,
    }
  },
})

import { Tool } from "./tool"
import DESCRIPTION from "./attach-agent.txt"
import z from "zod"
import { SessionPrompt } from "../session/prompt"
import { resolveSession, streamAgent } from "./agent-stream"

const parameters = z.object({
  session_id: z.string().describe("Session ID or slug of the subagent to attach to"),
  timeout: z
    .number()
    .optional()
    .default(120)
    .describe("Max time to follow in seconds (default: 120)"),
})

export const AttachAgentTool = Tool.define("attach_agent", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx) {
    const session = await resolveSession(params.session_id)

    ctx.metadata({
      title: `Attached: ${session.slug}`,
      metadata: { sessionId: session.id, slug: session.slug, status: "busy", output: `_Attached to ${session.slug}, streaming..._` },
    })

    // When aborted (ESC), cancel the subagent
    ctx.abort.addEventListener("abort", () => {
      SessionPrompt.cancel(session.id).catch(() => {})
    }, { once: true })

    const result = await streamAgent({
      session,
      abort: ctx.abort,
      timeout: (params.timeout ?? 120) * 1000,
      onUpdate: (output) => {
        ctx.metadata({
          title: `Attached: ${session.slug}`,
          metadata: { sessionId: session.id, slug: session.slug, status: "busy", output },
        })
      },
    })

    if (result.aborted) {
      return {
        title: `Attach: ${session.slug} (interrupted)`,
        metadata: { sessionId: session.id, slug: session.slug, status: "interrupted" },
        output: [
          result.output,
          "",
          "_[User interrupted the attached agent. This was intentional — do NOT retry, re-spawn, or react to this cancellation. Just acknowledge it briefly.]_",
        ].join("\n"),
      }
    }

    const statusLine =
      result.status.type === "idle"
        ? "\n\n_[agent completed]_"
        : `\n\n_[agent still running, timed out after ${params.timeout}s]_`

    return {
      title: `Attach: ${session.slug}`,
      metadata: { sessionId: session.id, slug: session.slug, status: result.status.type },
      output: result.output + statusLine,
    }
  },
})

import { Tool } from "./tool"
import DESCRIPTION from "./send-followup.txt"
import z from "zod"
import { Session } from "../session"
import { MessageID } from "../session/schema"
import { SessionPrompt } from "../session/prompt"
import { Log } from "../util/log"
import { Bus } from "@/bus"
import { NamedError } from "@opencode-ai/util/error"
import { resolveSession } from "./agent-stream"

const log = Log.create({ service: "tool.send-followup" })

const parameters = z.object({
  session_id: z.string().describe("Session ID or slug of the subagent"),
  message: z.string().describe("Followup message to send to the subagent"),
})

export const SendFollowupTool = Tool.define("send_followup", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx) {
    const session = await resolveSession(params.session_id)

    // Validate it's a child of the current session
    if (session.parentID !== ctx.sessionID) {
      throw new Error(`Session ${params.session_id} is not a child of the current session`)
    }

    const messageID = MessageID.ascending()

    // Get the agent from the session's last user message
    const msgs = await Session.messages({ sessionID: session.id, limit: 5 })
    const lastUser = msgs.findLast((m) => m.info.role === "user")
    const agent = lastUser ? (lastUser.info as any).agent : "build"
    const model = lastUser ? (lastUser.info as any).model : undefined

    // Fire and forget
    SessionPrompt.prompt({
      messageID,
      sessionID: session.id,
      agent,
      model,
      parts: [{ type: "text", text: params.message }],
    }).catch((err) => {
      log.error("send_followup prompt failed", { sessionID: session.id, error: err })
      Bus.publish(Session.Event.Error, {
        sessionID: session.id,
        error: new NamedError.Unknown({ message: err instanceof Error ? err.message : String(err) }).toObject(),
      })
    })

    return {
      title: `Followup: ${session.slug}`,
      metadata: { sessionId: session.id },
      output: `Followup message sent to agent "${session.slug}" (${session.id}). The agent will process it asynchronously.`,
    }
  },
})

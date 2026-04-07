import { Tool } from "./tool"
import DESCRIPTION from "./wait-agents.txt"
import z from "zod"
import { Session } from "../session"
import { SessionStatus } from "../session/status"
import { resolveSession } from "./agent-stream"

const parameters = z.object({
  session_ids: z
    .array(z.string())
    .optional()
    .describe("Session IDs to wait for. If omitted, waits for all child agents."),
  timeout: z
    .number()
    .optional()
    .default(300)
    .describe("Max wait time in seconds (default: 300)"),
})

export const WaitAgentsTool = Tool.define("wait_agents", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx) {
    let targets: Session.Info[]
    if (params.session_ids && params.session_ids.length > 0) {
      targets = await Promise.all(params.session_ids.map(resolveSession))
    } else {
      targets = await Session.children(ctx.sessionID)
    }

    const meta: { count: number; timedOut: boolean } = { count: targets.length, timedOut: false }

    if (targets.length === 0) {
      return { title: "Wait agents", metadata: meta, output: "No subagents to wait for." }
    }

    const timeout = (params.timeout ?? 300) * 1000
    const deadline = Date.now() + timeout

    // Poll loop with exponential backoff
    let delay = 500
    while (Date.now() < deadline) {
      if (ctx.abort.aborted) {
        return { title: "Wait agents (aborted)", metadata: meta, output: "Wait was aborted." }
      }

      const statuses = await Promise.all(
        targets.map(async (t) => ({
          session: t,
          status: await SessionStatus.get(t.id),
        })),
      )

      const allIdle = statuses.every((s) => s.status.type === "idle")
      if (allIdle) {
        // Re-fetch sessions to get updated summaries
        const updated = await Promise.all(targets.map((t) => Session.get(t.id)))
        const lines: string[] = ["All agents completed:", ""]
        for (const session of updated) {
          const summary = session.summary
            ? `+${session.summary.additions}/-${session.summary.deletions} (${session.summary.files} files)`
            : "no changes"
          lines.push(`- ${session.slug}: ${session.title} [${summary}]`)
        }
        return {
          title: `Wait complete (${targets.length} agents)`,
          metadata: meta,
          output: lines.join("\n"),
        }
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(delay, deadline - Date.now()))
        ctx.abort.addEventListener("abort", () => {
          clearTimeout(timer)
          resolve()
        }, { once: true })
      })
      delay = Math.min(delay * 1.5, 5000)
    }

    // Timeout
    const statuses = await Promise.all(
      targets.map(async (t) => ({
        session: t,
        status: await SessionStatus.get(t.id),
      })),
    )
    const lines: string[] = [`Timeout after ${params.timeout}s. Current status:`, ""]
    for (const { session, status } of statuses) {
      lines.push(`- ${session.slug}: ${status.type} - ${session.title}`)
    }
    meta.timedOut = true
    return {
      title: `Wait timeout (${targets.length} agents)`,
      metadata: meta,
      output: lines.join("\n"),
    }
  },
})

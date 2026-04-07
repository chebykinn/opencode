import { Tool } from "./tool"
import DESCRIPTION from "./list-agents.txt"
import z from "zod"
import { Session } from "../session"
import { SessionStatus } from "../session/status"

const parameters = z.object({
  status: z
    .enum(["all", "busy", "idle"])
    .default("all")
    .optional()
    .describe("Filter agents by status"),
})

export const ListAgentsTool = Tool.define("list_agents", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx) {
    const children = await Session.children(ctx.sessionID)

    if (children.length === 0) {
      return {
        title: "List agents",
        metadata: { count: 0 },
        output: "No subagents have been spawned in this session.",
      }
    }

    const rows: string[] = []
    rows.push("| slug | agent | status | title | elapsed | changes |")
    rows.push("|------|-------|--------|-------|---------|---------|")

    for (const child of children) {
      const status = await SessionStatus.get(child.id)
      if (params.status && params.status !== "all") {
        if (params.status === "busy" && status.type !== "busy" && status.type !== "retry") continue
        if (params.status === "idle" && status.type !== "idle") continue
      }

      const elapsed = Math.round((Date.now() - child.time.created) / 1000)
      const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.round(elapsed / 60)}m`
      const summary = child.summary
        ? `+${child.summary.additions}/-${child.summary.deletions} (${child.summary.files} files)`
        : "-"
      const statusStr = status.type === "retry" ? `retry #${status.attempt}` : status.type

      rows.push(
        `| ${child.slug} | ${child.title?.replace(/ \(@\w+ subagent\)/, "") || "-"} | ${statusStr} | ${child.title || "-"} | ${elapsedStr} | ${summary} |`,
      )
    }

    return {
      title: `List agents (${children.length})`,
      metadata: { count: children.length },
      output: rows.join("\n"),
    }
  },
})

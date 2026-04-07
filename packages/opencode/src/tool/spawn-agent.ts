import { Tool } from "./tool"
import DESCRIPTION from "./spawn-agent.txt"
import z from "zod"
import { Session } from "../session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { SessionPrompt } from "../session/prompt"
import { Config } from "../config/config"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { Log } from "../util/log"
import { Bus } from "@/bus"
import { NamedError } from "@opencode-ai/util/error"

const log = Log.create({ service: "tool.spawn-agent" })

const parameters = z.object({
  description: z.string().describe("A short (3-5 word) label for the agent's task"),
  prompt: z.string().describe("Detailed instructions for what the agent should do"),
  agent: z.string().describe("Which agent type to use (e.g., 'build', 'explore', 'general')"),
  mode: z
    .enum(["spawn", "fork"])
    .default("spawn")
    .describe("'spawn' = fresh session (default), 'fork' = inherit current conversation context"),
  task_id: z
    .string()
    .describe("Resume an existing subagent session instead of creating a new one")
    .optional(),
})

export const SpawnAgentTool = Tool.define("spawn_agent", async (ctx) => {
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary" || a.name === "build"))

  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => Permission.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents
  const list = accessibleAgents.toSorted((a, b) => a.name.localeCompare(b.name))

  const description = DESCRIPTION.replace(
    "{agents}",
    list
      .map((a) => `- ${a.name}: ${a.description ?? "No description."}`)
      .join("\n"),
  )

  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const config = await Config.get()

      const agent = await Agent.get(params.agent)
      if (!agent) throw new Error(`Unknown agent type: ${params.agent}`)

      const hasTaskPermission = agent.permission.some((rule) => rule.permission === "task")
      const hasTodoWritePermission = agent.permission.some((rule) => rule.permission === "todowrite")

      // Resolve or create the child session
      let session: Session.Info
      if (params.task_id) {
        const found = await Session.get(SessionID.make(params.task_id)).catch(() => undefined)
        if (found) {
          session = found
        } else {
          throw new Error(`Session not found: ${params.task_id}`)
        }
      } else if (params.mode === "fork") {
        const forked = await Session.fork({ sessionID: ctx.sessionID })
        session = forked
      } else {
        session = await Session.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${agent.name} subagent)`,
          permission: [
            // Allow subagents to ask questions — these get forwarded to
            // the coordinator and surfaced to the user.
            { permission: "question" as const, pattern: "*" as const, action: "allow" as const },
            ...(hasTodoWritePermission
              ? []
              : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
            ...(hasTaskPermission
              ? []
              : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
            ...(config.experimental?.primary_tools?.map((t) => ({
              pattern: "*",
              action: "allow" as const,
              permission: t,
            })) ?? []),
          ],
        })
      }

      // Get model from the current assistant message (same pattern as task tool)
      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

      const model = agent.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: session.id,
          slug: session.slug,
          model,
        },
      })

      const messageID = MessageID.ascending()
      const promptParts = await SessionPrompt.resolvePromptParts(params.prompt)

      const parentSessionID = ctx.sessionID
      const childSlug = session.slug
      const childId = session.id

      // Subscribe to permission and question events from the child session.
      // When the subagent gets blocked, notify the coordinator so it can
      // surface this to the user with context.
      const unsubPermission = Bus.subscribe(Permission.Event.Asked, (event) => {
        if (event.properties.sessionID !== childId) return
        const req = event.properties
        const notification = [
          `<agent-blocked>`,
          `Agent "${childSlug}" (${childId}) needs permission.`,
          `Task: ${params.description}`,
          `Permission: ${req.permission} — ${(req.patterns ?? []).join(", ")}`,
          `Please approve or deny in the permission prompt below.`,
          `</agent-blocked>`,
        ].join("\n")
        SessionPrompt.prompt({
          sessionID: parentSessionID,
          agent: "coordinator",
          parts: [{ type: "text", text: notification, synthetic: true }],
        }).catch((err) => {
          log.error("permission notification failed", { parentSessionID, childId, error: err })
        })
      })

      const unsubQuestion = Bus.subscribe(Question.Event.Asked, (event) => {
        if (event.properties.sessionID !== childId) return
        const req = event.properties
        const questions = req.questions?.map((q) => q.question).join("; ") ?? "See the question prompt below."
        const notification = [
          `<agent-blocked>`,
          `Agent "${childSlug}" (${childId}) is asking a question.`,
          `Task: ${params.description}`,
          `Question: ${questions}`,
          `Please answer in the prompt below.`,
          `</agent-blocked>`,
        ].join("\n")
        SessionPrompt.prompt({
          sessionID: parentSessionID,
          agent: "coordinator",
          parts: [{ type: "text", text: notification, synthetic: true }],
        }).catch((err) => {
          log.error("question notification failed", { parentSessionID, childId, error: err })
        })
      })

      // Fire and forget - do not await.
      // When the subagent finishes, send a completion notification to the
      // parent coordinator session so it can react without polling.
      SessionPrompt.prompt({
        messageID,
        sessionID: session.id,
        model: {
          modelID: model.modelID,
          providerID: model.providerID,
        },
        agent: agent.name,
        tools: {
          // Allow subagents to ask questions — forwarded to user via coordinator
          question: true,
          ...(hasTodoWritePermission ? {} : { todowrite: false }),
          ...(hasTaskPermission ? {} : { task: false }),
          ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((t) => [t, false])),
        },
        parts: promptParts,
      }).then(async (result) => {
        // Clean up event subscriptions
        unsubPermission()
        unsubQuestion()

        // If the last assistant message was interrupted (no finish reason,
        // or finish includes cancel), skip the notification
        const lastAssistant = result.info.role === "assistant" ? result.info : undefined
        if (lastAssistant && !lastAssistant.finish) {
          log.info("spawn_agent: subagent ended without finish reason, likely interrupted", { sessionID: childId })
          return
        }

        const updated = await Session.get(childId).catch(() => undefined)
        const summary = updated?.summary
          ? `+${updated.summary.additions}/-${updated.summary.deletions} (${updated.summary.files} files)`
          : "no file changes"

        const lastText = result.parts.findLast((p) => p.type === "text")
        const output = lastText && "text" in lastText ? (lastText.text as string).slice(0, 2000) : ""

        const notification = [
          `<agent-completed>`,
          `Agent "${childSlug}" (${childId}) has completed.`,
          `Task: ${params.description}`,
          `Changes: ${summary}`,
          output ? `\nAgent output (truncated):\n${output}` : "",
          `</agent-completed>`,
        ]
          .filter(Boolean)
          .join("\n")

        // Restart the coordinator's loop with a synthetic message.
        // synthetic: true means the TUI won't show it as a user message,
        // but the coordinator sees it in its context.
        await SessionPrompt.prompt({
          sessionID: parentSessionID,
          agent: "coordinator",
          parts: [{ type: "text", text: notification, synthetic: true }],
        }).catch((err) => {
          log.error("completion notification failed", { parentSessionID, childId, error: err })
        })
      }).catch((err) => {
        // Clean up event subscriptions
        unsubPermission()
        unsubQuestion()

        const errMsg = err instanceof Error ? err.message : String(err)
        const isInterrupt = errMsg.includes("interrupt") || errMsg.includes("cancel") || errMsg.includes("abort")

        if (isInterrupt) {
          // User interrupted via ESC — don't send an error notification.
          // The coordinator was also interrupted, so sending a notification
          // would just confuse it into retrying.
          log.info("spawn_agent interrupted by user", { sessionID: childId })
          return
        }

        // Genuine error — notify the parent
        const errorNotification = [
          `<agent-error>`,
          `Agent "${childSlug}" (${childId}) failed.`,
          `Task: ${params.description}`,
          `Error: ${errMsg}`,
          `</agent-error>`,
        ].join("\n")

        SessionPrompt.prompt({
          sessionID: parentSessionID,
          agent: "coordinator",
          parts: [{ type: "text", text: errorNotification, synthetic: true }],
        }).catch((notifyErr) => {
          log.error("error notification failed", { parentSessionID, childId, error: notifyErr })
        })

        log.error("spawn_agent prompt failed", { sessionID: childId, error: err })
        Bus.publish(Session.Event.Error, {
          sessionID: childId,
          error: new NamedError.Unknown({ message: errMsg }).toObject(),
        })
      })

      const output = [
        `Spawned agent "${params.description}"`,
        `  slug: ${session.slug}`,
        `  session_id: ${session.id}`,
        `  agent: ${agent.name}`,
        `  mode: ${params.mode}`,
        `  status: busy`,
        "",
        "The agent is running. You will be notified automatically when it completes.",
        "You can also use list_agents to check status or read_agent to inspect results.",
      ].join("\n")

      return {
        title: `Spawn: ${params.description}`,
        metadata: {
          sessionId: session.id,
          slug: session.slug,
          agent: agent.name,
        },
        output,
      }
    },
  }
})

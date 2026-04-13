import z from "zod"
import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import { Log } from "@/util/log"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { AsyncQueue } from "../../util/queue"
import { SseEvent } from "./sse-event"

const log = Log.create({ service: "server" })

type Outgoing = { data: string; id?: string }

export const EventRoutes = () =>
  new Hono().get(
    "/event",
    describeRoute({
      summary: "Subscribe to events",
      description: "Get events. Supports resume via the `Last-Event-ID` header (SSE spec).",
      operationId: "event.subscribe",
      responses: {
        200: {
          description: "Event stream",
          content: {
            "text/event-stream": {
              schema: resolver(
                z.union(BusEvent.payloads()).meta({
                  ref: "Event",
                }),
              ),
            },
          },
        },
      },
    }),
    async (c) => {
      log.info("event connected")
      c.header("Cache-Control", "no-cache, no-transform")
      c.header("X-Accel-Buffering", "no")
      c.header("X-Content-Type-Options", "nosniff")

      const directory = Instance.directory
      const header = c.req.header("Last-Event-ID")
      const parsed = header !== undefined ? Number.parseInt(header, 10) : NaN
      const resumeFrom = Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined

      return streamSSE(c, async (stream) => {
        const q = new AsyncQueue<Outgoing | null>()
        let done = false

        q.push({
          data: JSON.stringify({
            type: "server.connected",
            properties: {},
          }),
        })

        // Install the singleton DB-backed subscriber and buffer events until
        // replay finishes. Doing this BEFORE the since() query avoids missing
        // events that arrive during replay.
        let replayDone = false
        const pending: Array<{ id: number; event: SseEvent.Payload }> = []

        const unsubSse = SseEvent.subscribe(({ id, event }) => {
          if (!replayDone) {
            pending.push({ id, event })
            return
          }
          q.push({ data: JSON.stringify(event), id: String(id) })
          if (event.type === Bus.InstanceDisposed.type) stop()
        })

        // Replay missed events if the client sent Last-Event-ID.
        let lastReplayedId = resumeFrom ?? 0
        if (resumeFrom !== undefined) {
          const oldest = SseEvent.oldestId(directory)
          const gap = oldest === undefined ? resumeFrom > 0 : oldest > resumeFrom + 1
          if (gap) {
            log.info("event resume gap", { resumeFrom, oldest })
            q.push({
              data: JSON.stringify({
                type: "server.reset",
                properties: {},
              }),
            })
          }
          const rows = SseEvent.since(directory, resumeFrom)
          for (const row of rows) {
            q.push({
              data: JSON.stringify({ type: row.type, properties: row.properties }),
              id: String(row.id),
            })
            if (row.id > lastReplayedId) lastReplayedId = row.id
          }
        }

        // Flush anything that arrived during replay, deduping against rows we
        // already emitted from the DB.
        for (const { id, event } of pending) {
          if (id <= lastReplayedId) continue
          q.push({ data: JSON.stringify(event), id: String(id) })
          if (event.type === Bus.InstanceDisposed.type) {
            replayDone = true
            stop()
            break
          }
        }
        pending.length = 0
        replayDone = true

        // Send heartbeat every 10s to prevent stalled proxy streams.
        const heartbeat = setInterval(() => {
          q.push({
            data: JSON.stringify({
              type: "server.heartbeat",
              properties: {},
            }),
          })
        }, 10_000)

        function stop() {
          if (done) return
          done = true
          clearInterval(heartbeat)
          unsubSse()
          q.push(null)
          log.info("event disconnected")
        }

        stream.onAbort(stop)

        try {
          for await (const msg of q) {
            if (msg === null) return
            await stream.writeSSE(msg)
          }
        } finally {
          stop()
        }
      })
    },
  )

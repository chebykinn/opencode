import { EventEmitter } from "events"
import { Database, and, asc, eq, gt, lt } from "@/storage/db"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { SseEventTable } from "./sse-event.sql"

export namespace SseEvent {
  export type Payload = { type: string; properties: Record<string, unknown> }

  export type Row = { id: number; type: string; properties: Record<string, unknown> }

  export const RETENTION_MS = 24 * 60 * 60 * 1000

  function append(directory: string, event: Payload): number {
    return Database.use((db) => {
      const row = db
        .insert(SseEventTable)
        .values({
          directory,
          type: event.type,
          properties: event.properties,
          created_at: Date.now(),
        })
        .returning({ id: SseEventTable.id })
        .get()
      return row!.id
    })
  }

  export function since(directory: string, id: number): Row[] {
    return Database.use((db) =>
      db
        .select({
          id: SseEventTable.id,
          type: SseEventTable.type,
          properties: SseEventTable.properties,
        })
        .from(SseEventTable)
        .where(and(eq(SseEventTable.directory, directory), gt(SseEventTable.id, id)))
        .orderBy(asc(SseEventTable.id))
        .all(),
    )
  }

  export function oldestId(directory: string): number | undefined {
    return Database.use((db) => {
      const row = db
        .select({ id: SseEventTable.id })
        .from(SseEventTable)
        .where(eq(SseEventTable.directory, directory))
        .orderBy(asc(SseEventTable.id))
        .limit(1)
        .get()
      return row?.id
    })
  }

  export function sweep(olderThanMs: number = RETENTION_MS): void {
    const cutoff = Date.now() - olderThanMs
    Database.use((db) => {
      db.delete(SseEventTable).where(lt(SseEventTable.created_at, cutoff)).run()
    })
  }

  type Broadcast = {
    emitter: EventEmitter
    unsub: () => void
    sweeper: ReturnType<typeof setInterval>
  }

  const SWEEP_INTERVAL_MS = 60 * 60 * 1000

  const getBroadcast = Instance.state<Broadcast>(
    () => {
      const directory = Instance.directory
      const emitter = new EventEmitter()
      emitter.setMaxListeners(0)
      const unsub = Bus.subscribeAll((event) => {
        const id = append(directory, event)
        emitter.emit("event", { id, event })
      })
      // Initial sweep + periodic cleanup. Cheap when the table is small.
      try {
        sweep()
      } catch {}
      const sweeper = setInterval(() => {
        try {
          sweep()
        } catch {}
      }, SWEEP_INTERVAL_MS)
      sweeper.unref?.()
      return { emitter, unsub, sweeper }
    },
    async (state) => {
      state.unsub()
      clearInterval(state.sweeper)
      state.emitter.removeAllListeners()
    },
  )

  export function subscribe(callback: (payload: { id: number; event: Payload }) => void) {
    const { emitter } = getBroadcast()
    emitter.on("event", callback)
    return () => emitter.off("event", callback)
  }
}

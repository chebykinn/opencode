import { afterEach, describe, expect, test } from "bun:test"
import z from "zod"
import { Bus } from "../../src/bus"
import { BusEvent } from "../../src/bus/bus-event"
import { Instance } from "../../src/project/instance"
import { SseEvent } from "../../src/server/instance/sse-event"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const TestEvent = BusEvent.define("test.sse-event", z.object({ value: z.number() }))

afterEach(() => Instance.disposeAll())

describe("SseEvent", () => {
  test("persists events with monotonic ids and replays via since()", async () => {
    await using tmp = await tmpdir()
    const received: Array<{ id: number; value: number }> = []

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const unsub = SseEvent.subscribe(({ id, event }) => {
          if (event.type === TestEvent.type) {
            received.push({ id, value: (event.properties as { value: number }).value })
          }
        })
        await Bun.sleep(10)
        await Bus.publish(TestEvent, { value: 1 })
        await Bus.publish(TestEvent, { value: 2 })
        await Bus.publish(TestEvent, { value: 3 })
        await Bun.sleep(20)

        expect(received.map((r) => r.value)).toEqual([1, 2, 3])
        expect(received[1].id).toBeGreaterThan(received[0].id)
        expect(received[2].id).toBeGreaterThan(received[1].id)

        const sinceStart = SseEvent.since(tmp.path, 0).filter((r) => r.type === TestEvent.type)
        expect(sinceStart.map((r) => (r.properties as { value: number }).value)).toEqual([1, 2, 3])

        const afterFirst = SseEvent.since(tmp.path, received[0].id).filter((r) => r.type === TestEvent.type)
        expect(afterFirst.map((r) => (r.properties as { value: number }).value)).toEqual([2, 3])

        unsub()
      },
    })
  })

  test("isolates events by directory", async () => {
    await using tmpA = await tmpdir()
    await using tmpB = await tmpdir()

    await Instance.provide({
      directory: tmpA.path,
      fn: async () => {
        SseEvent.subscribe(() => {})
        await Bun.sleep(10)
        await Bus.publish(TestEvent, { value: 100 })
        await Bun.sleep(10)
      },
    })

    await Instance.provide({
      directory: tmpB.path,
      fn: async () => {
        SseEvent.subscribe(() => {})
        await Bun.sleep(10)
        await Bus.publish(TestEvent, { value: 200 })
        await Bun.sleep(10)
      },
    })

    const aEvents = SseEvent.since(tmpA.path, 0).filter((r) => r.type === TestEvent.type)
    const bEvents = SseEvent.since(tmpB.path, 0).filter((r) => r.type === TestEvent.type)

    expect(aEvents.map((r) => (r.properties as { value: number }).value)).toEqual([100])
    expect(bEvents.map((r) => (r.properties as { value: number }).value)).toEqual([200])
  })

  test("oldestId detects gap after sweep", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        SseEvent.subscribe(() => {})
        await Bun.sleep(10)
        await Bus.publish(TestEvent, { value: 1 })
        await Bus.publish(TestEvent, { value: 2 })
        await Bun.sleep(10)

        const rows = SseEvent.since(tmp.path, 0).filter((r) => r.type === TestEvent.type)
        expect(rows.length).toBe(2)

        const oldest = SseEvent.oldestId(tmp.path)
        expect(oldest).toBe(rows[0].id)

        // Simulate retention evicting everything.
        SseEvent.sweep(-1)

        expect(SseEvent.oldestId(tmp.path)).toBeUndefined()
        expect(SseEvent.since(tmp.path, 0)).toEqual([])
      },
    })
  })
})

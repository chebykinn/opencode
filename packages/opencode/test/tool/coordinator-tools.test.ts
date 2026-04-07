import { afterEach, test, expect } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { ToolRegistry } from "../../src/tool/registry"
import { Permission } from "../../src/permission"
import { ProviderID, ModelID } from "../../src/provider/schema"

const COORDINATOR_TOOLS = ["spawn_agent", "list_agents", "read_agent", "send_followup", "wait_agents", "follow_agent", "attach_agent"]

// Dummy model for tool resolution
const model = {
  providerID: ProviderID.make("anthropic"),
  modelID: ModelID.make("claude-sonnet-4-20250514"),
}

afterEach(async () => {
  await Instance.disposeAll()
})

test("coordinator agent exists and is primary", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const coordinator = await Agent.get("coordinator")
      expect(coordinator).toBeDefined()
      expect(coordinator?.mode).toBe("primary")
      expect(coordinator?.native).toBe(true)
    },
  })
})

test("coordinator agent has explicit permissions for coordinator tools", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const coordinator = await Agent.get("coordinator")
      expect(coordinator).toBeDefined()
      for (const tool of COORDINATOR_TOOLS) {
        const result = Permission.evaluate(tool, "*", coordinator!.permission)
        expect(result.action).toBe("allow")
      }
    },
  })
})

test("coordinator agent denies direct file editing tools", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const coordinator = await Agent.get("coordinator")
      expect(coordinator).toBeDefined()
      // Coordinator should deny edit/write/bash via the "*": "deny" rule
      expect(Permission.evaluate("edit", "*", coordinator!.permission).action).toBe("deny")
      expect(Permission.evaluate("bash", "*", coordinator!.permission).action).toBe("deny")
    },
  })
})

test("coordinator agent allows read-only tools", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const coordinator = await Agent.get("coordinator")
      expect(coordinator).toBeDefined()
      expect(Permission.evaluate("read", "*", coordinator!.permission).action).toBe("allow")
      expect(Permission.evaluate("glob", "*", coordinator!.permission).action).toBe("allow")
      expect(Permission.evaluate("grep", "*", coordinator!.permission).action).toBe("allow")
      expect(Permission.evaluate("question", "*", coordinator!.permission).action).toBe("allow")
    },
  })
})

test("coordinator tools are included in tool list for coordinator agent", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const coordinator = await Agent.get("coordinator")
      expect(coordinator).toBeDefined()
      const tools = await ToolRegistry.tools(model, coordinator!)
      const toolIds = tools.map((t) => t.id)
      for (const tool of COORDINATOR_TOOLS) {
        expect(toolIds).toContain(tool)
      }
    },
  })
})

test("coordinator tools are NOT included in tool list for build agent", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(build).toBeDefined()
      const tools = await ToolRegistry.tools(model, build!)
      const toolIds = tools.map((t) => t.id)
      for (const tool of COORDINATOR_TOOLS) {
        expect(toolIds).not.toContain(tool)
      }
    },
  })
})

test("coordinator tools are NOT included in tool list for general agent", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const general = await Agent.get("general")
      expect(general).toBeDefined()
      const tools = await ToolRegistry.tools(model, general!)
      const toolIds = tools.map((t) => t.id)
      for (const tool of COORDINATOR_TOOLS) {
        expect(toolIds).not.toContain(tool)
      }
    },
  })
})

test("coordinator tools are NOT included when no agent specified", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const tools = await ToolRegistry.tools(model)
      const toolIds = tools.map((t) => t.id)
      for (const tool of COORDINATOR_TOOLS) {
        expect(toolIds).not.toContain(tool)
      }
    },
  })
})

test("coordinator is in agent list", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agents = await Agent.list()
      const names = agents.map((a) => a.name)
      expect(names).toContain("coordinator")
    },
  })
})

test("build agent tool list includes standard tools but not coordinator tools", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      const tools = await ToolRegistry.tools(model, build!)
      const toolIds = tools.map((t) => t.id)
      // Standard tools should be present
      expect(toolIds).toContain("bash")
      expect(toolIds).toContain("read")
      expect(toolIds).toContain("edit")
      expect(toolIds).toContain("task")
      // Coordinator tools should NOT be present
      expect(toolIds).not.toContain("spawn_agent")
      expect(toolIds).not.toContain("list_agents")
    },
  })
})

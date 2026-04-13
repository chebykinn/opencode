import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

export const SseEventTable = sqliteTable(
  "sse_event",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    directory: text().notNull(),
    type: text().notNull(),
    properties: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    index("sse_event_directory_id_idx").on(table.directory, table.id),
    index("sse_event_created_at_idx").on(table.created_at),
  ],
)

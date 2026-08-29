import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS automation_events (
      event_id TEXT PRIMARY KEY,
      received_at TEXT NOT NULL,
      outcome TEXT NOT NULL,
      http_status INTEGER NOT NULL,
      mode TEXT,
      task_id TEXT,
      project_id TEXT,
      thread_id TEXT,
      fire_key TEXT,
      key_subject TEXT NOT NULL,
      key_session_id TEXT NOT NULL,
      error_code TEXT,
      error_message TEXT,
      event_json TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automation_events_received
    ON automation_events(received_at DESC)
  `;
});

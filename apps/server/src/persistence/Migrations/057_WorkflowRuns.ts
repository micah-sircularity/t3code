import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      run_key TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      work_id TEXT NOT NULL,
      agent_index INTEGER NOT NULL,
      status TEXT NOT NULL,
      thread_id TEXT,
      last_delivery_id TEXT,
      detail TEXT,
      route_label TEXT,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_task
    ON workflow_runs(task_id, updated_at)
  `;
});

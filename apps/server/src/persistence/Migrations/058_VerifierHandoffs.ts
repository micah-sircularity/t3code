import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE workflow_runs ADD COLUMN worktree_path TEXT
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS verifier_handoffs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL,
      branch TEXT,
      base_ref TEXT,
      patch TEXT,
      detail TEXT,
      target_label TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_verifier_handoffs_status
    ON verifier_handoffs(status, updated_at)
  `;
});

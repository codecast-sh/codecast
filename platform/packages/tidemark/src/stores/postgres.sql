-- tidemark history and memory tables. Apply with your own migrator.
-- Activities and blocks are append-only. "at" keeps microseconds; cursors are
-- its exact text and are only ever compared inside the database.

CREATE TABLE IF NOT EXISTS tidemark_activities (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  partition_key text NOT NULL DEFAULT 'default',
  scope_type text NOT NULL,
  scope_id text NOT NULL,
  kind text NOT NULL,
  summary text NOT NULL,
  data jsonb,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor jsonb,
  ref_table text,
  ref_id text,
  tasks jsonb,
  focused_task_id text
);
CREATE INDEX IF NOT EXISTS tidemark_activities_scope_at ON tidemark_activities (partition_key, scope_type, scope_id, at, id);
CREATE INDEX IF NOT EXISTS tidemark_activities_partition_at ON tidemark_activities (partition_key, at, id);

-- level 0 = leaf (a summary of raw activities). A merged block at
-- (level, block_index) covers leaves [index * 2^level, (index + 1) * 2^level).
-- The unique slot index is what makes a duplicate block impossible; a legacy
-- leaf with no position has a NULL index and is outside it.
CREATE TABLE IF NOT EXISTS tidemark_blocks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  partition_key text NOT NULL DEFAULT 'default',
  scope_type text NOT NULL,
  scope_id text NOT NULL,
  level integer NOT NULL DEFAULT 0 CHECK (level >= 0),
  block_index bigint CHECK (block_index >= 0),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  content text NOT NULL,
  activity_count integer NOT NULL,
  kinds jsonb,
  tasks jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (level = 0 OR block_index IS NOT NULL),
  CHECK (start_at <= end_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS tidemark_blocks_slot ON tidemark_blocks (partition_key, scope_type, scope_id, level, block_index);
CREATE INDEX IF NOT EXISTS tidemark_blocks_scope_end ON tidemark_blocks (partition_key, scope_type, scope_id, level, end_at);
CREATE INDEX IF NOT EXISTS tidemark_blocks_leaf_end ON tidemark_blocks (partition_key, level, end_at);

CREATE TABLE IF NOT EXISTS tidemark_memories (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id text NOT NULL,
  partition_key text NOT NULL DEFAULT 'default',
  scope_type text NOT NULL,
  scope_id text NOT NULL,
  seq integer NOT NULL,
  header text NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz,
  archived boolean NOT NULL DEFAULT false,
  UNIQUE (agent_id, partition_key, scope_type, scope_id, seq)
);

-- Trothen on Postgres (v108).
--
-- One table holds every record. Each record is kept whole, exactly as the
-- app wrote it, in the "data" column. That is the same shape the JSON-file
-- store keeps on disk, so the two can never drift apart: a new field added
-- to the app is simply stored, with nothing here to update.
--
-- The earlier Postgres layout had one table per kind of record, with a
-- fixed list of columns. Any field the app gained after that list was
-- written was silently dropped on save. That is what "out of date" meant.
-- If those old tables are still in this database, db-postgres.js copies
-- their rows into this table once, at start-up, and leaves them as they are.
--
-- Safe to run again and again: it only creates what is missing.
--
-- The column type is JSON, not JSONB, on purpose: JSON keeps the fields of
-- a record in the order the app wrote them, as a file does.
--
--   collection  which kind of record: users, contracts, storeGoods ...
--   id          the record's own id (the same "id" that is inside data)
--   pos         the order records were added in. The app reads them back in
--               this order, as it does from a JSON file.
CREATE TABLE IF NOT EXISTS trothen_records (
  pos        BIGSERIAL PRIMARY KEY,
  collection TEXT NOT NULL,
  id         TEXT,
  data       JSON NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trothen_records_collection_pos ON trothen_records (collection, pos);
CREATE INDEX IF NOT EXISTS trothen_records_collection_id ON trothen_records (collection, id);

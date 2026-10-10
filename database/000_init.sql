-- 000_init: extensions and shared helpers.
-- (schema_migrations is created by migrate.sh itself, since it must exist before any file runs.)

-- citext is a "trusted" extension on PG13+, so the database owner can create it on RDS.
CREATE EXTENSION IF NOT EXISTS citext;

-- Keeps updated_at current. Attach with:
--   CREATE TRIGGER <table>_set_updated_at BEFORE UPDATE ON <table>
--   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- 006_activity_log: append-only audit trail. See README.md for the event catalog.
-- project_id / actor_user_id use SET NULL (not CASCADE) so history survives purges;
-- metadata should snapshot names/emails so entries stay readable afterwards.
-- Never put tokens, passwords or Terraform plan values in metadata.

CREATE TABLE activity_log (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id    uuid        REFERENCES projects (id) ON DELETE SET NULL, -- NULL for account-level events
  actor_user_id uuid        REFERENCES users (id)    ON DELETE SET NULL, -- NULL for system actions
  action        text        NOT NULL CHECK (action ~ '^[a-z_]+(\.[a-z_]+)+$'), -- e.g. member.role_changed
  target_type   text,       -- e.g. 'user', 'invite', 'analysis_run'
  target_id     uuid,
  metadata      jsonb       NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX activity_log_project_idx ON activity_log (project_id, created_at DESC);
CREATE INDEX activity_log_actor_idx   ON activity_log (actor_user_id, created_at DESC);
CREATE INDEX activity_log_target_idx  ON activity_log (target_type, target_id);

-- Entries are immutable. The one permitted change is the FK ON DELETE SET NULL on
-- project_id / actor_user_id, which Postgres performs as an UPDATE. (DELETE stays possible
-- for a future retention job.)
CREATE FUNCTION activity_log_reject_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.action, NEW.target_type, NEW.target_id, NEW.metadata, NEW.created_at)
       IS NOT DISTINCT FROM (OLD.id, OLD.action, OLD.target_type, OLD.target_id, OLD.metadata, OLD.created_at)
     AND (NEW.project_id IS NULL OR NEW.project_id = OLD.project_id)
     AND (NEW.actor_user_id IS NULL OR NEW.actor_user_id = OLD.actor_user_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'activity_log is append-only';
END;
$$;

CREATE TRIGGER activity_log_no_update BEFORE UPDATE ON activity_log
  FOR EACH ROW EXECUTE FUNCTION activity_log_reject_update();

-- Smoke test for the schema. Everything runs in one transaction and is rolled back, so it
-- is safe to run against a migrated dev database:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f smoke_test.sql
-- Any failed assertion raises an exception and aborts the run.
BEGIN;

DO $$
DECLARE
  alice uuid; bob uuid;
  conn1 uuid; conn2 uuid;
  repo uuid; proj uuid; run uuid;
  n_fn uuid; n_tbl uuid;
  cnt integer;
  failed boolean;
BEGIN
  -- users: username, email and password are all required
  INSERT INTO users (username, email, password_hash) VALUES ('alice', 'alice@example.com', 'hash') RETURNING id INTO alice;
  INSERT INTO users (username, email, password_hash) VALUES ('bob',   'bob@example.com',   'hash') RETURNING id INTO bob;

  failed := false;
  BEGIN INSERT INTO users (username, email) VALUES ('nopass', 'nopass@example.com');
  EXCEPTION WHEN not_null_violation THEN failed := true; END;
  ASSERT failed, 'password_hash must be required';

  failed := false;
  BEGIN INSERT INTO users (username, password_hash) VALUES ('noemail', 'hash');
  EXCEPTION WHEN not_null_violation THEN failed := true; END;
  ASSERT failed, 'email must be required';

  failed := false;
  BEGIN INSERT INTO users (email, password_hash) VALUES ('nouser@example.com', 'hash');
  EXCEPTION WHEN not_null_violation THEN failed := true; END;
  ASSERT failed, 'username must be required';

  failed := false;
  BEGIN INSERT INTO users (username, email, password_hash) VALUES ('ALICE', 'other@example.com', 'hash');
  EXCEPTION WHEN unique_violation THEN failed := true; END;
  ASSERT failed, 'username must be case-insensitively unique';

  -- one user can link several GitHub accounts; one GitHub account links to one user only
  INSERT INTO github_connections (user_id, github_user_id, github_login, access_token_ciphertext)
    VALUES (alice, 1001, 'alice-gh', '\x00') RETURNING id INTO conn1;
  INSERT INTO github_connections (user_id, github_user_id, github_login, access_token_ciphertext)
    VALUES (alice, 1002, 'alice-work', '\x00') RETURNING id INTO conn2;
  failed := false;
  BEGIN
    INSERT INTO github_connections (user_id, github_user_id, github_login, access_token_ciphertext)
      VALUES (bob, 1001, 'alice-gh', '\x00');
  EXCEPTION WHEN unique_violation THEN failed := true; END;
  ASSERT failed, 'a GitHub account must not link to two users';

  -- projects and sharing
  INSERT INTO repositories (github_id, full_name, html_url) VALUES (5000, 'alice/demo', 'https://github.com/alice/demo') RETURNING id INTO repo;
  INSERT INTO projects (name, created_by) VALUES ('Demo', alice) RETURNING id INTO proj;
  INSERT INTO project_members (project_id, user_id, role) VALUES (proj, alice, 'owner');
  INSERT INTO project_members (project_id, user_id, role) VALUES (proj, bob, 'viewer');
  INSERT INTO project_repositories (project_id, repository_id, branch, linked_by_connection_id) VALUES (proj, repo, 'main', conn1);

  failed := false;
  BEGIN UPDATE project_members SET role = 'owner' WHERE project_id = proj AND user_id = bob;
  EXCEPTION WHEN unique_violation THEN failed := true; END;
  ASSERT failed, 'a second owner must be rejected';

  -- ownership transfer: demote, then promote
  UPDATE project_members SET role = 'editor' WHERE project_id = proj AND user_id = alice;
  UPDATE project_members SET role = 'owner'  WHERE project_id = proj AND user_id = bob;

  failed := false;
  BEGIN UPDATE projects SET visibility = 'link_view' WHERE id = proj;
  EXCEPTION WHEN check_violation THEN failed := true; END;
  ASSERT failed, 'link_view requires a share_token';

  -- resource catalog seeded
  SELECT count(*) INTO cnt FROM resource_types WHERE terraform_type IN ('aws_lambda_function', 'aws_dynamodb_table', 'aws_s3_bucket');
  ASSERT cnt = 3, 'resource_types seed missing';

  -- analysis graph pinned to a commit
  INSERT INTO analysis_runs (project_id, repository_id, commit_sha, branch, status, parser_version, started_by)
    VALUES (proj, repo, repeat('a', 40), 'main', 'succeeded', '0.1.0', bob) RETURNING id INTO run;
  UPDATE projects SET current_run_id = run WHERE id = proj;
  INSERT INTO graph_nodes (run_id, kind, address, name, terraform_type) VALUES (run, 'resource', 'aws_lambda_function.api', 'api', 'aws_lambda_function') RETURNING id INTO n_fn;
  INSERT INTO graph_nodes (run_id, kind, address, name, terraform_type) VALUES (run, 'resource', 'aws_dynamodb_table.orders', 'orders', 'aws_dynamodb_table') RETURNING id INTO n_tbl;
  INSERT INTO graph_edges (run_id, source_id, target_id, relation, link_method, confidence)
    VALUES (run, n_fn, n_tbl, 'reads', 'env_var', 'high');

  failed := false;
  BEGIN INSERT INTO graph_edges (run_id, source_id, target_id, relation, link_method, confidence)
    VALUES (run, n_tbl, n_fn, 'writes', 'declared_reference', 'high');
  EXCEPTION WHEN check_violation THEN failed := true; END;
  ASSERT failed, 'confidence must match the link method';

  -- recursive traversal works in both directions
  WITH RECURSIVE down AS (
    SELECT target_id AS id FROM graph_edges WHERE run_id = run AND source_id = n_fn
    UNION SELECT e.target_id FROM graph_edges e JOIN down d ON e.source_id = d.id WHERE e.run_id = run
  ) SELECT count(*) INTO cnt FROM down WHERE id = n_tbl;
  ASSERT cnt = 1, 'forward traversal failed';
  WITH RECURSIVE up AS (
    SELECT source_id AS id FROM graph_edges WHERE run_id = run AND target_id = n_tbl
    UNION SELECT e.source_id FROM graph_edges e JOIN up u ON e.target_id = u.id WHERE e.run_id = run
  ) SELECT count(*) INTO cnt FROM up WHERE id = n_fn;
  ASSERT cnt = 1, 'reverse traversal failed';

  -- plans: downstream nodes must be no-ops
  INSERT INTO plan_analyses (project_id, run_id, created_by) VALUES (proj, run, bob);
  failed := false;
  BEGIN INSERT INTO plan_changes (plan_id, address, action, impact)
    SELECT id, 'aws_lambda_function.api', 'update', 'downstream' FROM plan_analyses WHERE run_id = run;
  EXCEPTION WHEN check_violation THEN failed := true; END;
  ASSERT failed, 'downstream plan_changes must be noop';

  -- activity log: immutable, and survives project deletion
  INSERT INTO activity_log (project_id, actor_user_id, action, metadata)
    VALUES (proj, bob, 'member.role_changed', '{"from":"viewer","to":"owner"}');
  failed := false;
  BEGIN UPDATE activity_log SET action = 'member.removed';
  EXCEPTION WHEN raise_exception THEN failed := true; END;
  ASSERT failed, 'activity_log must reject updates';

  failed := false;
  BEGIN INSERT INTO activity_log (action) VALUES ('Not Valid');
  EXCEPTION WHEN check_violation THEN failed := true; END;
  ASSERT failed, 'activity_log.action must be dot-namespaced';

  -- hard purge cascades, log keeps its rows with project_id NULL
  DELETE FROM projects WHERE id = proj;
  SELECT count(*) INTO cnt FROM analysis_runs WHERE project_id = proj;
  ASSERT cnt = 0, 'project delete must cascade to runs';
  SELECT count(*) INTO cnt FROM graph_nodes WHERE run_id = run;
  ASSERT cnt = 0, 'project delete must cascade to graph nodes';
  SELECT count(*) INTO cnt FROM activity_log WHERE action = 'member.role_changed' AND project_id IS NULL;
  ASSERT cnt = 1, 'activity_log must survive project deletion';

  RAISE NOTICE 'smoke test passed';
END;
$$;

ROLLBACK;

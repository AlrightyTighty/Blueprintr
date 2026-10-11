-- 008_session_revocation: lets a password change or reset end every sign-in that already exists.
-- A login token carries the time it was issued; one issued before this moment is refused.
-- NULL means no session has ever been revoked.

ALTER TABLE users ADD COLUMN sessions_valid_after timestamptz;

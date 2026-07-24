-- Control-plane fixtures only. Mail content is seeded into each mailbox Durable
-- Object on mock login, because D1 no longer owns message state.
INSERT OR IGNORE INTO users (id, name, avatar_url, role, status, created_at, updated_at)
VALUES
  ('usr_demo_admin', 'Ilya Morozov', NULL, 'admin', 'active', unixepoch() * 1000 - 864000000, unixepoch() * 1000),
  ('usr_demo_member', 'Maya Chen', NULL, 'member', 'active', unixepoch() * 1000 - 604800000, unixepoch() * 1000),
  ('usr_demo_invited', 'Alex Rivera', NULL, 'member', 'invited', unixepoch() * 1000 - 86400000, unixepoch() * 1000);

INSERT OR IGNORE INTO installations (id, domain, owner_user_id, created_at)
VALUES ('primary', 'demo.example', 'usr_demo_admin', unixepoch() * 1000 - 864000000);

INSERT OR IGNORE INTO mailboxes (id, address, display_name, kind, personal_owner_id, created_by_user_id, created_at, updated_at)
VALUES
  ('mbx_demo_personal', 'ilya@demo.example', 'Ilya Morozov', 'personal', 'usr_demo_admin', 'usr_demo_admin', unixepoch() * 1000 - 864000000, unixepoch() * 1000),
  ('mbx_demo_maya', 'maya@demo.example', 'Maya Chen', 'personal', 'usr_demo_member', 'usr_demo_admin', unixepoch() * 1000 - 604800000, unixepoch() * 1000),
  ('mbx_demo_alex', 'alex@demo.example', 'Alex Rivera', 'personal', 'usr_demo_invited', 'usr_demo_admin', unixepoch() * 1000 - 86400000, unixepoch() * 1000),
  ('mbx_demo_support', 'support@demo.example', 'Customer care', 'shared', NULL, 'usr_demo_admin', unixepoch() * 1000 - 691200000, unixepoch() * 1000);

INSERT OR IGNORE INTO mailbox_members (mailbox_id, user_id, can_send, created_at)
VALUES
  ('mbx_demo_personal', 'usr_demo_admin', 1, unixepoch() * 1000 - 864000000),
  ('mbx_demo_maya', 'usr_demo_member', 1, unixepoch() * 1000 - 604800000),
  ('mbx_demo_alex', 'usr_demo_invited', 1, unixepoch() * 1000 - 86400000),
  ('mbx_demo_support', 'usr_demo_admin', 1, unixepoch() * 1000 - 691200000),
  ('mbx_demo_support', 'usr_demo_member', 1, unixepoch() * 1000 - 604800000),
  ('mbx_demo_support', 'usr_demo_invited', 0, unixepoch() * 1000 - 86400000);

INSERT OR IGNORE INTO access_links (
  id, kind, user_id, token_hash, created_by_user_id, expires_at, consumed_at, created_at
)
VALUES
  ('lnk_demo_alex_invite', 'invitation', 'usr_demo_invited', '9Uxgs6WM6Ia5Ml4db_j6sZGjtsDbFKQ9Jj3TO6ESrRY', 'usr_demo_admin', unixepoch() * 1000 + 604800000, NULL, unixepoch() * 1000 - 86400000),
  ('lnk_demo_maya_recovery', 'recovery', 'usr_demo_member', 'hW5ljdTB4inQJ655_9Mhv174535vPrClCAFdgi5o5V8', 'usr_demo_admin', unixepoch() * 1000 + 3600000, NULL, unixepoch() * 1000);

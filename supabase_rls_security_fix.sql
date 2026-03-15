-- ============================================================================
-- VOYD RLS Security Fix Migration
-- Generated: 2026-03-13
-- Fixes: All Critical and High severity findings from security audit
-- ============================================================================
-- CONFIRMED: users.id = auth.uid() for all users (auth_id = id)
-- All policies use auth.uid() directly — no helper function needed.
--
-- IMPORTANT: Test in staging before applying to production.
--            Take a backup before running.
-- ============================================================================

BEGIN;

-- ============================================================================
-- STEP 0: Performance indexes for RLS policy subqueries
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_users_auth_id ON public.users (auth_id);
CREATE INDEX IF NOT EXISTS idx_server_members_user_id ON public.server_members (user_id);
CREATE INDEX IF NOT EXISTS idx_server_members_user_id_role ON public.server_members (user_id, role);
CREATE INDEX IF NOT EXISTS idx_dm_messages_dm_id ON public.dm_messages (dm_id);
CREATE INDEX IF NOT EXISTS idx_dm_messages_sender_id ON public.dm_messages (sender_id);
CREATE INDEX IF NOT EXISTS idx_channels_server_id ON public.channels (server_id);
CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON public.messages (channel_id);
CREATE INDEX IF NOT EXISTS idx_attachments_uploaded_by ON public.attachments (uploaded_by);
CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON public.attachments (message_id);
CREATE INDEX IF NOT EXISTS idx_direct_messages_user1_id ON public.direct_messages (user1_id);
CREATE INDEX IF NOT EXISTS idx_direct_messages_user2_id ON public.direct_messages (user2_id);


-- ============================================================================
-- CRITICAL FIX 1: Lock down notifications INSERT
-- Was: two duplicate policies with with_check "true" on {public}
-- Anyone (including unauthenticated) could inject fake notifications
-- ============================================================================

DROP POLICY IF EXISTS "Users can create notifications" ON notifications;
DROP POLICY IF EXISTS "System can create notifications" ON notifications;

CREATE POLICY "Authenticated users create notifications" ON notifications
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() IS NOT NULL
  );

-- NOTE: If backend/system processes need to create notifications for
-- arbitrary users, use a SECURITY DEFINER function via service_role
-- instead of an open RLS policy.


-- ============================================================================
-- CRITICAL FIX 2: Lock down mentions INSERT
-- Was: with_check "true" on {public} — anyone could create fake @mentions
-- ============================================================================

DROP POLICY IF EXISTS "Users can create mentions" ON mentions;

CREATE POLICY "Users create mentions for own messages" ON mentions
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM messages
      WHERE messages.id = mentions.message_id
        AND messages.user_id = auth.uid()
    )
  );


-- ============================================================================
-- CRITICAL FIX 3: Lock down contact_submissions INSERT
-- Was: with_check "true" on {public} — open to unauthenticated spam
-- ============================================================================

DROP POLICY IF EXISTS "Anyone can submit contact" ON contact_submissions;

CREATE POLICY "Authenticated users submit contact" ON contact_submissions
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() IS NOT NULL
  );

-- NOTE: If you need anonymous contact submissions, implement a rate-limited
-- SECURITY DEFINER function instead of an open RLS policy.


-- ============================================================================
-- CRITICAL FIX 4: Shadow admin policies — restrict to authenticated role
-- Was: roles {public} — could theoretically be exploited by anon if
-- is_current_user_shadow_admin() mishandles NULL auth.uid()
-- ============================================================================

DROP POLICY IF EXISTS "Shadow admins full access on admin_roles" ON admin_roles;

CREATE POLICY "Shadow admins full access on admin_roles" ON admin_roles
  FOR ALL TO authenticated
  USING (
    auth.uid() IS NOT NULL
    AND is_current_user_shadow_admin() = true
  )
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND is_current_user_shadow_admin() = true
  );


-- ============================================================================
-- CRITICAL FIX 5: Consolidate attachments policies
-- Was: 2x DELETE, 2x INSERT, 2x SELECT with mismatched ID patterns
-- Since users.id = auth.uid(), the subquery variants were redundant.
-- Consolidated to 3 clean policies.
-- ============================================================================

DROP POLICY IF EXISTS "Users can delete own attachments" ON attachments;
DROP POLICY IF EXISTS "Delete own or mod attachments" ON attachments;
DROP POLICY IF EXISTS "Upload attachments" ON attachments;
DROP POLICY IF EXISTS "Users can insert own attachments" ON attachments;
DROP POLICY IF EXISTS "Users can read attachments in their servers" ON attachments;
DROP POLICY IF EXISTS "View attachments in own context" ON attachments;

CREATE POLICY "View attachments in own context" ON attachments
  FOR SELECT TO authenticated
  USING (
    (server_id IS NOT NULL AND server_id IN (SELECT user_server_ids(auth.uid())))
    OR (dm_id IS NOT NULL AND dm_id IN (
      SELECT id FROM direct_messages
      WHERE user1_id = auth.uid() OR user2_id = auth.uid()
    ))
    OR (group_dm_id IS NOT NULL AND group_dm_id IN (
      SELECT user_group_dm_ids(auth.uid())
    ))
    OR is_shadow_admin(auth.uid()) = true
  );

CREATE POLICY "Upload own attachments" ON attachments
  FOR INSERT TO authenticated
  WITH CHECK (
    uploaded_by = auth.uid()
  );

CREATE POLICY "Delete own or mod attachments" ON attachments
  FOR DELETE TO authenticated
  USING (
    uploaded_by = auth.uid()
    OR (
      server_id IS NOT NULL
      AND server_id IN (
        SELECT sm.server_id FROM server_members sm
        WHERE sm.user_id = auth.uid()
          AND sm.role IN ('owner', 'admin', 'moderator')
      )
    )
  );


-- ============================================================================
-- HIGH FIX 1: Message deletion — allow moderators to actually delete
-- Was: qual only checked user_id = auth.uid(), despite policy name
-- saying "or mods". Moderators could NOT delete messages.
-- ============================================================================

DROP POLICY IF EXISTS "Users or mods can delete messages" ON messages;

CREATE POLICY "Users or mods can delete messages" ON messages
  FOR DELETE TO authenticated
  USING (
    user_id = auth.uid()
    OR (
      channel_id IN (
        SELECT c.id FROM channels c
        JOIN server_members sm ON sm.server_id = c.server_id
        WHERE sm.user_id = auth.uid()
          AND sm.role IN ('owner', 'admin', 'moderator')
      )
    )
    OR is_shadow_admin(auth.uid()) = true
  );


-- ============================================================================
-- HIGH FIX 2: DM message UPDATE — add with_check to prevent impersonation
-- Was: no with_check — users could change sender_id, content, or dm_id
-- of any message in their DMs, enabling impersonation
-- ============================================================================

DROP POLICY IF EXISTS "Users can update own DM messages" ON dm_messages;
DROP POLICY IF EXISTS "Users update DM messages read status" ON dm_messages;

-- Users can edit their own messages, cannot reassign sender
CREATE POLICY "Users update own DM messages" ON dm_messages
  FOR UPDATE TO authenticated
  USING (sender_id = auth.uid())
  WITH CHECK (sender_id = auth.uid());

-- Participants can update read status, but cannot change sender or move message
CREATE POLICY "Participants update DM read status" ON dm_messages
  FOR UPDATE TO authenticated
  USING (
    dm_id IN (
      SELECT id FROM direct_messages
      WHERE user1_id = auth.uid() OR user2_id = auth.uid()
    )
  )
  WITH CHECK (
    sender_id = (SELECT sender_id FROM dm_messages dm2 WHERE dm2.id = dm_messages.id)
    AND dm_id = (SELECT dm_id FROM dm_messages dm2 WHERE dm2.id = dm_messages.id)
  );


-- ============================================================================
-- HIGH FIX 3: Group DM self-injection
-- Was: OR (user_id = auth.uid()) let any user add themselves to any
-- group DM they know the ID of, bypassing invitations
-- ============================================================================

DROP POLICY IF EXISTS "Users can add group dm members" ON group_dm_members;

CREATE POLICY "Group DM owners add members" ON group_dm_members
  FOR INSERT TO authenticated
  WITH CHECK (
    group_dm_id IN (
      SELECT id FROM group_dms WHERE owner_id = auth.uid()
    )
  );


-- ============================================================================
-- HIGH FIX 4: Friendship creation — prevent direction forgery
-- Was: (user_id = auth.uid() OR friend_id = auth.uid()) let users
-- forge who initiated the friendship
-- ============================================================================

DROP POLICY IF EXISTS "Allow friendship creation" ON friendships;

CREATE POLICY "Users create friendships" ON friendships
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND friend_id != auth.uid()
  );


-- ============================================================================
-- HIGH FIX 5: Channel creation — restrict to admins/owners
-- Was: any server member could create channels (no role check)
-- ============================================================================

DROP POLICY IF EXISTS "Channels can be created by server members" ON channels;

CREATE POLICY "Admins can create channels" ON channels
  FOR INSERT TO authenticated
  WITH CHECK (
    server_id IN (
      SELECT sm.server_id FROM server_members sm
      WHERE sm.user_id = auth.uid()
        AND sm.role IN ('owner', 'admin')
    )
  );


-- ============================================================================
-- HIGH FIX 6: System message spoofing
-- Was: any server member could insert type='system' messages,
-- impersonating platform announcements
-- ============================================================================

DROP POLICY IF EXISTS "Server members can send system messages" ON messages;

-- System messages should be created via service_role from backend only.
-- If client-side system messages are needed, use a SECURITY DEFINER function:
--
-- CREATE OR REPLACE FUNCTION send_system_message(p_channel_id uuid, p_content text)
-- RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
-- BEGIN
--   INSERT INTO messages (type, user_id, channel_id, content)
--   VALUES ('system', NULL, p_channel_id, p_content);
-- END;
-- $$;


-- ============================================================================
-- HIGH FIX 7: Direct messages UPDATE — add with_check
-- Was: participants could change user1_id/user2_id, hijacking conversations
-- ============================================================================

DROP POLICY IF EXISTS "Participants can update direct messages" ON direct_messages;

CREATE POLICY "Participants update direct messages" ON direct_messages
  FOR UPDATE TO authenticated
  USING (
    user1_id = auth.uid() OR user2_id = auth.uid()
  )
  WITH CHECK (
    user1_id = (SELECT user1_id FROM direct_messages dm2 WHERE dm2.id = direct_messages.id)
    AND user2_id = (SELECT user2_id FROM direct_messages dm2 WHERE dm2.id = direct_messages.id)
  );


-- ============================================================================
-- HIGH FIX 8: Bots — add with_check to prevent ownership transfer
-- Was: no with_check on ALL policy — owner could set owner_id to another user
-- ============================================================================

DROP POLICY IF EXISTS "Bot owners can manage bots" ON bots;

CREATE POLICY "Bot owners can manage bots" ON bots
  FOR ALL TO authenticated
  USING (
    owner_id = auth.uid()
    OR is_shadow_admin(auth.uid()) = true
  )
  WITH CHECK (
    owner_id = auth.uid()
    OR is_shadow_admin(auth.uid()) = true
  );


-- ============================================================================
-- HIGH FIX 9: connected_accounts — standardize + add with_check
-- Was: SELECT used subquery to users.id, but UPDATE/DELETE/INSERT used
-- auth.uid() directly. Inconsistent pattern, missing with_check on UPDATE.
-- ============================================================================

DROP POLICY IF EXISTS "Users can view own connected accounts" ON connected_accounts;
DROP POLICY IF EXISTS "Users update own connected accounts" ON connected_accounts;
DROP POLICY IF EXISTS "Users delete own connected accounts" ON connected_accounts;
DROP POLICY IF EXISTS "Users manage own connected accounts" ON connected_accounts;

CREATE POLICY "Users view own connected accounts" ON connected_accounts
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users insert own connected accounts" ON connected_accounts
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users update own connected accounts" ON connected_accounts
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users delete own connected accounts" ON connected_accounts
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());


-- ============================================================================
-- HIGH FIX 10: Admin ALL policies — add with_check constraints
-- Was: no with_check — admins could reassign resources to servers they
-- don't own via UPDATE
-- ============================================================================

DROP POLICY IF EXISTS "Admins manage category permissions" ON category_role_permissions;

CREATE POLICY "Admins manage category permissions" ON category_role_permissions
  FOR ALL TO authenticated
  USING (
    category_id IN (
      SELECT cc.id FROM channel_categories cc
      WHERE cc.server_id IN (
        SELECT server_id FROM server_members
        WHERE user_id = auth.uid()
          AND role IN ('owner', 'admin')
      )
    )
  )
  WITH CHECK (
    category_id IN (
      SELECT cc.id FROM channel_categories cc
      WHERE cc.server_id IN (
        SELECT server_id FROM server_members
        WHERE user_id = auth.uid()
          AND role IN ('owner', 'admin')
      )
    )
  );


DROP POLICY IF EXISTS "Admins can manage categories" ON channel_categories;

CREATE POLICY "Admins can manage categories" ON channel_categories
  FOR ALL TO authenticated
  USING (
    server_id IN (
      SELECT server_id FROM server_members
      WHERE user_id = auth.uid()
        AND role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    server_id IN (
      SELECT server_id FROM server_members
      WHERE user_id = auth.uid()
        AND role IN ('owner', 'admin')
    )
  );


DROP POLICY IF EXISTS "Admins manage channel permissions" ON channel_permissions;

CREATE POLICY "Admins manage channel permissions" ON channel_permissions
  FOR ALL TO authenticated
  USING (
    channel_id IN (
      SELECT c.id FROM channels c
      WHERE c.server_id IN (
        SELECT server_id FROM server_members
        WHERE user_id = auth.uid()
          AND role IN ('owner', 'admin')
      )
    )
  )
  WITH CHECK (
    channel_id IN (
      SELECT c.id FROM channels c
      WHERE c.server_id IN (
        SELECT server_id FROM server_members
        WHERE user_id = auth.uid()
          AND role IN ('owner', 'admin')
      )
    )
  );


COMMIT;


-- ============================================================================
-- POST-MIGRATION VERIFICATION
-- Run these queries after applying to verify the migration worked:
-- ============================================================================

-- 1. Confirm no policies still use with_check = 'true':
SELECT tablename, policyname FROM pg_policies
WHERE schemaname = 'public' AND with_check = 'true';

-- 2. Confirm critical tables no longer use {public} role:
SELECT tablename, policyname, roles FROM pg_policies
WHERE schemaname = 'public'
  AND roles = '{public}'
  AND tablename IN ('admin_roles', 'notifications', 'mentions', 'contact_submissions');

-- 3. Check for unexpected duplicate policies (more than 2 per table+command):
SELECT tablename, cmd, COUNT(*) AS policy_count FROM pg_policies
WHERE schemaname = 'public'
GROUP BY tablename, cmd
HAVING COUNT(*) > 2
ORDER BY COUNT(*) DESC;

-- 4. List all updated policies to review:
SELECT tablename, policyname, permissive, roles, cmd
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, cmd;

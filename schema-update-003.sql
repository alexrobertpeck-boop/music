-- ============================================================================
--  Schema update 003 — fix recursive RLS on household_members
--
--  The original SELECT policy used "exists (select 1 from household_members
--  where user_id = auth.uid())" — which triggers infinite recursion because
--  Postgres re-checks the same policy to evaluate the inner query. The
--  Album Club tab is the first surface that reads household_members from
--  the frontend (with the RLS-bound publishable key), so this only just
--  surfaced.
--
--  Fix: use the existing SECURITY DEFINER function is_household_member().
--  Inside that function, the inner select bypasses RLS, so no recursion.
-- ============================================================================

drop policy if exists "members can read household" on public.household_members;

create policy "members can read household"
  on public.household_members for select
  using (public.is_household_member());

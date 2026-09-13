-- Pak Health — pilot schema
--
-- Replaces the kv_store JSON-blob accounts (see CLAUDE.md "Storage") with real
-- Supabase Auth identities + relational tables, and RLS policies that enforce the
-- access-grant model in the database instead of trusting the client. See
-- ACCESS-MODEL.md for the design this implements, and the plan this was built from
-- for the full rationale.
--
-- Run this once, in order, against a FRESH Supabase project (SQL editor: paste the
-- whole file and run). Idempotent-ish via `if not exists` / `create or replace`
-- where practical, but this is meant to be run once on a clean project, not
-- repeatedly against a project with existing data in a different shape.

create extension if not exists pgcrypto;

-- ============================================================================
-- Tables
-- ============================================================================

-- One row per patient, keyed by their Supabase Auth user id. `code` is the
-- existing 8-digit human-facing identifier (shown as the health card's live-code
-- basis and used for sign-in-by-code backward compatibility) — generated server-side
-- by handle_new_user() below, never client-chosen.
create table public.patients (
  id uuid primary key references auth.users(id) on delete cascade,
  code text not null unique,
  name text not null default '',
  dob date,
  gender text not null default '',
  phone text not null default '',
  photo_url text not null default '',
  blood_type text not null default '',
  emergency_contact text not null default '',
  allergies text not null default '',
  conditions text not null default '',
  medications text not null default '',
  consent_at timestamptz,
  created_at timestamptz not null default now()
);

-- One row per doctor. `doctor_code` is the existing DR-XXXXXX display id.
-- `verified` mirrors isDoctorVerified() in app.js (email + phone + license all
-- present) — recomputed and stored on every profile save, same as today.
create table public.doctors (
  id uuid primary key references auth.users(id) on delete cascade,
  doctor_code text not null unique,
  name text not null default '',
  dob date,
  gender text not null default '',
  phone text not null default '',
  photo_url text not null default '',
  license text not null default '',
  specialty text not null default '',
  education text not null default '',
  about text not null default '',
  verified boolean not null default false,
  -- Each element is {"name": "...", "address": "..."} — app.js normalizes a
  -- bare string element (the original shape, before addresses were added) to
  -- {name: that string, address: ''} on read, so old rows never needed a
  -- migration when this changed.
  clinics jsonb not null default '[]'::jsonb,
  current_clinic text not null default '',
  created_at timestamptz not null default now()
);

-- Visits and tests carry the three access-model columns from ACCESS-MODEL.md §13:
-- authored_by_doctor_id (who wrote it), written_via_grant_id (which grant
-- authorized the write, for a future audit-history screen), and unverified (a
-- snapshot of the writing doctor's verification status at write time — not a live
-- lookup, see CLAUDE.md's "Data model" section for why). doctor_name/clinic_name
-- stay as text snapshots (not FKs) deliberately — a medical record should show who
-- wrote it *at the time*, unaffected by the doctor later renaming their profile.
create table public.visits (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  authored_by_doctor_id uuid references public.doctors(id),
  written_via_grant_id uuid,
  doctor_name text not null default '',
  clinic_name text not null default '',
  date date,
  time text not null default '',
  symptoms text not null default '',
  diagnosis text not null default '',
  prescription text not null default '',
  notes text not null default '',
  unverified boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.tests (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  authored_by_doctor_id uuid references public.doctors(id),
  written_via_grant_id uuid,
  doctor_name text not null default '',
  name text not null default '',
  date date,
  result_summary text not null default '',
  unverified boolean not null default false,
  created_at timestamptz not null default now()
);

-- Patient-only data — doctors never read or write these (see CLAUDE.md "My Eyes").
create table public.eye_entries (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  date date,
  sph_l text not null default '',
  cyl_l text not null default '',
  axis_l text not null default '',
  sph_r text not null default '',
  cyl_r text not null default '',
  axis_r text not null default '',
  created_at timestamptz not null default now()
);

-- Booked by a patient against a real doctor account (see CLAUDE.md
-- "Appointments") — doctor_id is nullable so it stays populated for real
-- bookings while never breaking on a null. doctor_name/clinic_name stay as
-- text snapshots, same reasoning as visits/tests: what the patient booked
-- against at the time, unaffected by the doctor later editing their profile.
-- Booking auto-creates a trust grant (see createTrustGrant() in app.js), so no
-- separate doctor-facing insert/update policy is needed here — read-only.
create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  doctor_id uuid references public.doctors(id) on delete set null,
  doctor_name text not null default '',
  clinic_name text not null default '',
  clinic_address text not null default '',
  date date,
  time text not null default '',
  reason text not null default '',
  created_at timestamptz not null default now(),
  -- Belt-and-suspenders against two patients grabbing the same slot — the client
  -- already filters out taken slots before showing them (see generateSlots() /
  -- bookApptTakenTimes in app.js), but this is the real backstop since that check
  -- and the insert aren't atomic. NULL doctor_id (old manual entries, if any) never
  -- collides with itself since Postgres treats NULLs as distinct in a unique index.
  constraint appointments_doctor_slot_unique unique (doctor_id, date, time)
);

-- A doctor's standing weekly bookable hours at one clinic (see CLAUDE.md
-- "Appointments"/"Doctor clinics") — day_of_week follows JS Date.getDay() (0=Sun),
-- so app.js never has to translate between two conventions. slot_minutes is the
-- average time per patient the doctor sets for that block; app.js slices
-- start_time..end_time into slots of that length for patients to book, and the
-- same rows drive the doctor dashboard's "Currently seeing patients at"
-- auto-select (see CLAUDE.md). Recurring, not per-date, by deliberate scope
-- choice — simpler for a small pilot than a full calendar-with-exceptions model.
create table public.doctor_availability (
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid not null references public.doctors(id) on delete cascade,
  clinic_name text not null,
  day_of_week smallint not null check (day_of_week between 0 and 6),
  start_time time not null,
  end_time time not null,
  slot_minutes smallint not null default 15 check (slot_minutes > 0),
  -- How far out this block is bookable — the doctor picks a repeat length (in
  -- weeks) in the "Manage bookings" grid, app.js clamps it to a 4-week/28-day
  -- hard cap for every doctor (not just enforced in the UI — generateBookableDates()
  -- in app.js never looks past today+28 regardless of what's stored here) and
  -- writes today + that many weeks as this column. A whole clinic's schedule is
  -- replaced (delete + re-insert) on every save rather than edited row-by-row, so
  -- every row from one save always shares the same valid_until.
  valid_until date,
  created_at timestamptz not null default now()
);
create index doctor_availability_doctor_idx on public.doctor_availability(doctor_id);

-- The ephemeral, single-use, short-lived live code (see ACCESS-MODEL.md §5).
-- Only ever read/written directly by its owning patient; a doctor redeems one
-- exclusively through redeem_access_code() below, never by querying this table.
create table public.access_codes (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  code text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  redeemed_at timestamptz,
  redeemed_by_doctor_id uuid references public.doctors(id)
);
create index access_codes_patient_idx on public.access_codes(patient_id, created_at desc);
create index access_codes_code_idx on public.access_codes(code);

-- The authorization ledger — the single source of truth every access check reads
-- (ACCESS-MODEL.md §13's "core query"). A trust grant has expires_at = null; a
-- code-redemption grant has expires_at = granted_at + 1 hour.
create table public.access_grants (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  doctor_id uuid not null references public.doctors(id) on delete cascade,
  granted_via text not null check (granted_via in ('code','trust')),
  source_code_id uuid references public.access_codes(id),
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz
);
create index access_grants_lookup_idx on public.access_grants(patient_id, doctor_id);
create index access_grants_doctor_idx on public.access_grants(doctor_id) where revoked_at is null;

-- ============================================================================
-- Helper: the one predicate every grant-based access check uses
-- ============================================================================
-- Deliberately NOT security definer — it reads access_grants as the calling user,
-- which works because a doctor is always allowed to see grants naming them (the
-- access_grants select policy below), so this never needs elevated privileges.
create or replace function public.has_active_grant(p_patient_id uuid, p_doctor_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from public.access_grants g
    where g.patient_id = p_patient_id
      and g.doctor_id = p_doctor_id
      and g.revoked_at is null
      and (g.expires_at is null or g.expires_at > now())
  );
$$;

-- ============================================================================
-- RLS
-- ============================================================================

alter table public.patients enable row level security;
alter table public.doctors enable row level security;
alter table public.visits enable row level security;
alter table public.tests enable row level security;
alter table public.eye_entries enable row level security;
alter table public.appointments enable row level security;
alter table public.doctor_availability enable row level security;
alter table public.access_codes enable row level security;
alter table public.access_grants enable row level security;

-- patients: own row, or a doctor holding an active grant. No client-side insert
-- policy — rows are created exclusively by handle_new_user() below.
create policy "patients_select" on public.patients
  for select using (auth.uid() = id or public.has_active_grant(id, auth.uid()));
create policy "patients_update_own" on public.patients
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- doctors: professional info isn't sensitive the way patient health data is, so
-- any authenticated user can look one up (needed for a patient to trust-grant a
-- doctor by ID, and for the "my patients" roster). Only the doctor can edit their
-- own row. No client-side insert policy — same reasoning as patients.
create policy "doctors_select_authenticated" on public.doctors
  for select using (auth.role() = 'authenticated');
create policy "doctors_update_own" on public.doctors
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- visits / tests: read by the owning patient or a doctor with an active grant;
-- written only by a doctor with an active grant for that patient, and only ever
-- attributed to themselves (can't write a note and attribute it to another doctor).
create policy "visits_select" on public.visits
  for select using (auth.uid() = patient_id or public.has_active_grant(patient_id, auth.uid()));
create policy "visits_insert" on public.visits
  for insert with check (authored_by_doctor_id = auth.uid() and public.has_active_grant(patient_id, auth.uid()));

create policy "tests_select" on public.tests
  for select using (auth.uid() = patient_id or public.has_active_grant(patient_id, auth.uid()));
create policy "tests_insert" on public.tests
  for insert with check (authored_by_doctor_id = auth.uid() and public.has_active_grant(patient_id, auth.uid()));

-- eye_entries: patient-owned only, no doctor access at all (see CLAUDE.md).
create policy "eye_entries_own" on public.eye_entries
  for all using (auth.uid() = patient_id) with check (auth.uid() = patient_id);

-- appointments: full CRUD for the owning patient (booking flow both inserts
-- and updates the calendar/list, same as before); the named doctor gets
-- read-only access to appointments booked against them, so their dashboard
-- can list upcoming bookings without needing a separate access grant check —
-- the booking itself already created one via createTrustGrant().
create policy "appointments_own" on public.appointments
  for all using (auth.uid() = patient_id) with check (auth.uid() = patient_id);
create policy "appointments_select_doctor" on public.appointments
  for select using (auth.uid() = doctor_id);

-- doctor_availability: readable by any signed-in user (a patient has to see a
-- doctor's bookable hours before they've booked anything, same reasoning as
-- doctors_select_authenticated below); only the owning doctor can add or remove
-- their own blocks. No update policy — same add/remove-only pattern as clinics.
create policy "doctor_availability_select_authenticated" on public.doctor_availability
  for select using (auth.role() = 'authenticated');
create policy "doctor_availability_insert_own" on public.doctor_availability
  for insert with check (auth.uid() = doctor_id);
create policy "doctor_availability_delete_own" on public.doctor_availability
  for delete using (auth.uid() = doctor_id);

-- access_codes: only the owning patient can see or create their own live codes.
-- Deliberately no doctor-facing select policy at all — see redeem_access_code()
-- below for why redemption has to go through a function instead of a table read.
create policy "access_codes_patient_own" on public.access_codes
  for all using (auth.uid() = patient_id) with check (auth.uid() = patient_id);

-- access_grants: both sides of a grant can see it. A patient may directly insert
-- only a *trust* grant naming themselves (code-based grants are only ever created
-- by redeem_access_code(), which bypasses RLS as security definer) and may revoke
-- (update) only their own grants — a doctor can never revoke or self-grant.
create policy "access_grants_select" on public.access_grants
  for select using (auth.uid() = patient_id or auth.uid() = doctor_id);
create policy "access_grants_patient_insert_trust" on public.access_grants
  for insert with check (auth.uid() = patient_id and granted_via = 'trust');
create policy "access_grants_patient_revoke" on public.access_grants
  for update using (auth.uid() = patient_id) with check (auth.uid() = patient_id);

-- ============================================================================
-- Account creation: a trigger, not a second client-side write
-- ============================================================================
-- Signing up calls supabase.auth.signUp({ email, password, options: { data: {
-- role, name, dob, gender, license } } }); this trigger reads that metadata and
-- creates the matching patients/doctors row (with a freshly generated display
-- code) in the same transaction as the auth.users insert, so a profile row is
-- guaranteed to exist the instant an account does — no separate client write that
-- could fail, race, or be skipped.

create or replace function public.generate_unique_patient_code()
returns text language plpgsql as $$
declare
  v_code text;
begin
  loop
    v_code := lpad(floor(random() * 100000000)::text, 8, '0');
    exit when not exists (select 1 from public.patients where code = v_code);
  end loop;
  return v_code;
end;
$$;

create or replace function public.generate_unique_doctor_code()
returns text language plpgsql as $$
declare
  v_code text;
begin
  loop
    v_code := 'DR-' || lpad(floor(random() * 1000000)::text, 6, '0');
    exit when not exists (select 1 from public.doctors where doctor_code = v_code);
  end loop;
  return v_code;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := new.raw_user_meta_data->>'role';
begin
  if v_role = 'doctor' then
    insert into public.doctors (id, doctor_code, name, dob, gender, license)
    values (
      new.id,
      public.generate_unique_doctor_code(),
      coalesce(new.raw_user_meta_data->>'name', ''),
      nullif(new.raw_user_meta_data->>'dob', '')::date,
      coalesce(new.raw_user_meta_data->>'gender', ''),
      coalesce(new.raw_user_meta_data->>'license', '')
    );
  else
    insert into public.patients (id, code, name, dob, gender)
    values (
      new.id,
      public.generate_unique_patient_code(),
      coalesce(new.raw_user_meta_data->>'name', ''),
      nullif(new.raw_user_meta_data->>'dob', '')::date,
      coalesce(new.raw_user_meta_data->>'gender', '')
    );
  end if;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================================
-- Code redemption: server-enforced, not client-trusted
-- ============================================================================
-- Mirrors redeemAccessCode() in app.js exactly (find the latest code row for
-- whatever patient the code belongs to, confirm it's still the current/
-- unexpired/unredeemed one, mark it redeemed, reuse or create a grant) — just
-- moved server-side so a doctor's browser never needs raw read access to
-- access_codes. security definer is what makes that safe: the function's own
-- logic is fixed and audited, unlike a broad table grant would be.
create or replace function public.redeem_access_code(p_code text)
returns table(patient_id uuid, patient_name text, granted_via text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.access_codes%rowtype;
  v_latest public.access_codes%rowtype;
  v_doctor_id uuid := auth.uid();
  v_existing_grant public.access_grants%rowtype;
begin
  if v_doctor_id is null then
    raise exception 'not_authenticated';
  end if;

  select * into v_row from public.access_codes
    where code = p_code order by created_at desc limit 1;
  if v_row.id is null then
    raise exception 'code_not_found';
  end if;

  -- only the most recently issued code for that patient is ever valid
  -- (ac.patient_id qualified — this function's own `returns table(patient_id
  -- uuid, ...)` makes bare `patient_id` ambiguous between that output
  -- parameter and the table column: Postgres error 42702, "column reference
  -- ... is ambiguous ... could refer to either a PL/pgSQL variable or a table
  -- column." A real, previously-undetected bug — every past redemption test
  -- that reached this line would have hit it; alias-qualifying is the minimal
  -- fix, since renaming the output parameter would change the shape the
  -- client already destructures.)
  select * into v_latest from public.access_codes ac
    where ac.patient_id = v_row.patient_id order by created_at desc limit 1;
  if v_latest.id is distinct from v_row.id then
    raise exception 'code_not_found';
  end if;

  if v_row.redeemed_at is not null then
    raise exception 'code_redeemed';
  end if;
  if v_row.expires_at <= now() then
    raise exception 'code_expired';
  end if;

  update public.access_codes set redeemed_at = now(), redeemed_by_doctor_id = v_doctor_id
    where id = v_row.id;

  -- ag.patient_id qualified — same ambiguity risk as above (though
  -- access_grants isn't this function's own return-shape table, patient_id
  -- still collides with the returns table(patient_id, ...) output parameter).
  select * into v_existing_grant from public.access_grants ag
    where ag.patient_id = v_row.patient_id and ag.doctor_id = v_doctor_id
      and ag.granted_via = 'trust' and ag.revoked_at is null;

  if v_existing_grant.id is not null then
    -- a trusted doctor redeeming a code is pure navigation — don't shadow the
    -- standing grant with a separate one-hour one
    return query select v_row.patient_id, p.name, 'trust'::text
      from public.patients p where p.id = v_row.patient_id;
    return;
  end if;

  insert into public.access_grants (patient_id, doctor_id, granted_via, source_code_id, expires_at)
    values (v_row.patient_id, v_doctor_id, 'code', v_row.id, now() + interval '1 hour');

  return query select v_row.patient_id, p.name, 'code'::text
    from public.patients p where p.id = v_row.patient_id;
end;
$$;

grant execute on function public.redeem_access_code(text) to authenticated;

-- ============================================================================
-- Migration: family member (dependent) profiles
-- ============================================================================
-- Everything below was added after the initial schema above — it's a migration
-- against the *existing* live project (hence alter table / drop policy + create
-- policy rather than rewriting the original create table statements), not part
-- of a from-scratch run. See CLAUDE.md's "Family member (dependent) profiles"
-- section for the full design.
--
-- A "dependent" is a patients row for someone who will never run their own
-- account — a child, or an adult (an elderly parent, say) who simply won't
-- manage a login/trust-grant flow themselves. Deliberately not age-gated: the
-- mechanism is identical either way. A dependent is fully owned/managed by one
-- or more "guardians" (real patient accounts) via dependent_guardians below;
-- doctor-side access (visits/tests/access_grants/has_active_grant()) needs zero
-- changes, since once a grant exists a dependent's row is indistinguishable
-- from any other patient's.

-- A dependent has no auth.users row, so the original hard FK can't hold for
-- every row any more. Tradeoff: deleting an auth.users row (e.g. from the
-- Supabase dashboard) no longer cascade-deletes that patient row on its own —
-- acceptable at this pilot's scale, flagged here and in CLAUDE.md rather than
-- silently dropped.
alter table public.patients drop constraint if exists patients_id_fkey;
alter table public.patients add column if not exists is_dependent boolean not null default false;

-- Multiple guardians per dependent (both parents, etc.) — a join table, not a
-- single managed_by column. No insert/delete policy: both go exclusively
-- through create_dependent()/remove_dependent() below, same reasoning as
-- everywhere else in this file that a security-definer function's fixed,
-- audited logic is safer than a broad table grant.
create table if not exists public.dependent_guardians (
  dependent_id uuid not null references public.patients(id) on delete cascade,
  guardian_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (dependent_id, guardian_id)
);
create index if not exists dependent_guardians_guardian_idx on public.dependent_guardians(guardian_id);

-- Unlike has_active_grant() (deliberately NOT security definer, since
-- access_grants_select's own policy never calls it back), this one DOES need
-- security definer: dependent_guardians_select's policy (below) calls
-- is_guardian_of() to decide what's visible, and if this function weren't
-- security definer it would evaluate its own internal query against
-- dependent_guardians *under that same RLS policy* — which calls
-- is_guardian_of() again to check *that* row, which checks again... infinite
-- recursion, surfaced live as Postgres error 54001 "stack depth limit
-- exceeded" the first time this was tried without security definer here.
-- security definer breaks the cycle by letting this function's own internal
-- select bypass dependent_guardians' RLS, the same way redeem_access_code()
-- bypasses access_codes' RLS for a different reason (there, no doctor-facing
-- select policy exists at all; here, the select policy exists but would
-- recurse into itself). Defined here, before any policy references it —
-- Postgres resolves function references in a CREATE POLICY ... USING (...)
-- clause immediately, not lazily, so this has to exist first.
create or replace function public.is_guardian_of(p_dependent_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.dependent_guardians dg
    where dg.dependent_id = p_dependent_id and dg.guardian_id = auth.uid()
  );
$$;

alter table public.dependent_guardians enable row level security;
drop policy if exists "dependent_guardians_select" on public.dependent_guardians;
create policy "dependent_guardians_select" on public.dependent_guardians
  for select using (public.is_guardian_of(dependent_id));

-- Extend every existing "is this the patient themselves" policy with "...or
-- their guardian." Doctor-facing policies (doctors_select_authenticated,
-- visits_insert, tests_insert, appointments_select_doctor) are untouched.
drop policy if exists "patients_select" on public.patients;
create policy "patients_select" on public.patients
  for select using (auth.uid() = id or public.has_active_grant(id, auth.uid()) or public.is_guardian_of(id));
drop policy if exists "patients_update_own" on public.patients;
create policy "patients_update_own" on public.patients
  for update using (auth.uid() = id or public.is_guardian_of(id)) with check (auth.uid() = id or public.is_guardian_of(id));

drop policy if exists "visits_select" on public.visits;
create policy "visits_select" on public.visits
  for select using (auth.uid() = patient_id or public.has_active_grant(patient_id, auth.uid()) or public.is_guardian_of(patient_id));

drop policy if exists "tests_select" on public.tests;
create policy "tests_select" on public.tests
  for select using (auth.uid() = patient_id or public.has_active_grant(patient_id, auth.uid()) or public.is_guardian_of(patient_id));

drop policy if exists "eye_entries_own" on public.eye_entries;
create policy "eye_entries_own" on public.eye_entries
  for all using (auth.uid() = patient_id or public.is_guardian_of(patient_id)) with check (auth.uid() = patient_id or public.is_guardian_of(patient_id));

drop policy if exists "appointments_own" on public.appointments;
create policy "appointments_own" on public.appointments
  for all using (auth.uid() = patient_id or public.is_guardian_of(patient_id)) with check (auth.uid() = patient_id or public.is_guardian_of(patient_id));

drop policy if exists "access_codes_patient_own" on public.access_codes;
create policy "access_codes_patient_own" on public.access_codes
  for all using (auth.uid() = patient_id or public.is_guardian_of(patient_id)) with check (auth.uid() = patient_id or public.is_guardian_of(patient_id));

drop policy if exists "access_grants_select" on public.access_grants;
create policy "access_grants_select" on public.access_grants
  for select using (auth.uid() = patient_id or auth.uid() = doctor_id or public.is_guardian_of(patient_id));
drop policy if exists "access_grants_patient_insert_trust" on public.access_grants;
create policy "access_grants_patient_insert_trust" on public.access_grants
  for insert with check ((auth.uid() = patient_id or public.is_guardian_of(patient_id)) and granted_via = 'trust');
drop policy if exists "access_grants_patient_revoke" on public.access_grants;
create policy "access_grants_patient_revoke" on public.access_grants
  for update using (auth.uid() = patient_id or public.is_guardian_of(patient_id)) with check (auth.uid() = patient_id or public.is_guardian_of(patient_id));

-- Creating a dependent: security definer for the same reason handle_new_user()
-- is — there's still no plain client-side insert policy on patients, by
-- design, so this is the only way a new patients row (with no matching
-- auth.users row at all, in this case) ever gets created.
create or replace function public.create_dependent(p_name text, p_dob date, p_gender text)
returns table(id uuid, code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := gen_random_uuid();
  v_code text := public.generate_unique_patient_code();
  v_guardian uuid := auth.uid();
begin
  if v_guardian is null then
    raise exception 'not_authenticated';
  end if;

  insert into public.patients (id, code, name, dob, gender, is_dependent)
    values (v_id, v_code, coalesce(p_name, ''), p_dob, coalesce(p_gender, ''), true);
  insert into public.dependent_guardians (dependent_id, guardian_id) values (v_id, v_guardian);

  return query select v_id, v_code;
end;
$$;

grant execute on function public.create_dependent(text, date, text) to authenticated;

-- The ephemeral, 1-minute code a second guardian redeems to link themselves to
-- an existing dependent — same shape as access_codes, kept as a separate table
-- since the redemption semantics differ (creates a guardian link, not an
-- access grant). Generation is a plain RLS insert (an existing guardian
-- creating a code for a dependent they already control — a same-user
-- operation, no RPC needed, same reasoning as access_codes_patient_own);
-- only *redemption* needs security definer, below, since the redeeming user
-- has no rights to that dependent yet.
create table if not exists public.guardian_link_codes (
  id uuid primary key default gen_random_uuid(),
  dependent_id uuid not null references public.patients(id) on delete cascade,
  code text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  redeemed_at timestamptz,
  redeemed_by uuid references auth.users(id)
);
create index if not exists guardian_link_codes_dependent_idx on public.guardian_link_codes(dependent_id, created_at desc);

alter table public.guardian_link_codes enable row level security;
drop policy if exists "guardian_link_codes_own" on public.guardian_link_codes;
create policy "guardian_link_codes_own" on public.guardian_link_codes
  for all using (public.is_guardian_of(dependent_id)) with check (public.is_guardian_of(dependent_id));

-- Redeeming a guardian-link code: structurally identical to
-- redeem_access_code() above (find the latest code for its dependent, confirm
-- it's still the current/unexpired/unredeemed one, mark it redeemed, insert
-- the link) — see that function's comment for the full rationale.
create or replace function public.join_as_guardian(p_code text)
returns table(dependent_id uuid, dependent_name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.guardian_link_codes%rowtype;
  v_latest public.guardian_link_codes%rowtype;
  v_guardian uuid := auth.uid();
begin
  if v_guardian is null then
    raise exception 'not_authenticated';
  end if;

  select * into v_row from public.guardian_link_codes
    where code = p_code order by created_at desc limit 1;
  if v_row.id is null then
    raise exception 'code_not_found';
  end if;

  -- glc.dependent_id qualified — same ambiguity bug as redeem_access_code()
  -- above (this function's own `returns table(dependent_id uuid, ...)` makes
  -- bare `dependent_id` ambiguous with the table column otherwise).
  select * into v_latest from public.guardian_link_codes glc
    where glc.dependent_id = v_row.dependent_id order by created_at desc limit 1;
  if v_latest.id is distinct from v_row.id then
    raise exception 'code_not_found';
  end if;

  if v_row.redeemed_at is not null then
    raise exception 'code_redeemed';
  end if;
  if v_row.expires_at <= now() then
    raise exception 'code_expired';
  end if;

  update public.guardian_link_codes set redeemed_at = now(), redeemed_by = v_guardian
    where id = v_row.id;

  insert into public.dependent_guardians (dependent_id, guardian_id)
    values (v_row.dependent_id, v_guardian)
    on conflict do nothing;

  return query select v_row.dependent_id, p.name
    from public.patients p where p.id = v_row.dependent_id;
end;
$$;

grant execute on function public.join_as_guardian(text) to authenticated;

-- Removing a dependent: "same button, smarter behavior." Normally just unlinks
-- the calling guardian — the profile and all its history stay intact for any
-- remaining guardian. If they're the *last* guardian, the same call cascades
-- into a full, permanent delete (nothing and no one could ever reach that row
-- again otherwise). Security definer because the conditional cascade needs to
-- delete a patients row, which guardians have no generic delete rights to.
create or replace function public.remove_dependent(p_dependent_id uuid)
returns boolean -- true if this call fully deleted the dependent, false if it just unlinked the caller
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_remaining int;
begin
  if not public.is_guardian_of(p_dependent_id) then
    raise exception 'not_a_guardian';
  end if;

  delete from public.dependent_guardians
    where dependent_id = p_dependent_id and guardian_id = v_caller;

  select count(*) into v_remaining from public.dependent_guardians where dependent_id = p_dependent_id;

  if v_remaining = 0 then
    -- cascades to visits/tests/eye_entries/appointments/access_codes/
    -- access_grants/guardian_link_codes via their own on-delete-cascade FKs
    delete from public.patients where id = p_dependent_id;
    return true;
  end if;

  return false;
end;
$$;

grant execute on function public.remove_dependent(uuid) to authenticated;

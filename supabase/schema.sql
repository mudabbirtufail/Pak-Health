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

-- Display-only for now (see CLAUDE.md "Appointments" — booking mechanism isn't
-- built yet), so patient-owned only, same as eye_entries.
create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  doctor_name text not null default '',
  clinic_name text not null default '',
  date date,
  time text not null default '',
  reason text not null default '',
  created_at timestamptz not null default now()
);

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

-- eye_entries / appointments: patient-owned only, no doctor access at all —
-- matches today's behavior exactly (see CLAUDE.md).
create policy "eye_entries_own" on public.eye_entries
  for all using (auth.uid() = patient_id) with check (auth.uid() = patient_id);
create policy "appointments_own" on public.appointments
  for all using (auth.uid() = patient_id) with check (auth.uid() = patient_id);

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
  select * into v_latest from public.access_codes
    where patient_id = v_row.patient_id order by created_at desc limit 1;
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

  select * into v_existing_grant from public.access_grants
    where patient_id = v_row.patient_id and doctor_id = v_doctor_id
      and granted_via = 'trust' and revoked_at is null;

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

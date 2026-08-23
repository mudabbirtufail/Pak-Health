# Pak Health

A patient records platform prototype. Two user roles — **individuals** (patients) and
**doctors** — with a grant-based access model: a patient's permanent 8-digit account ID
identifies their record but no longer grants access on its own. A doctor gets in either
by redeeming a single-use, 3-minute live code the patient generates and shows them in
person (good for one hour from redemption), or through a standing "Trusted" grant the
patient creates and can revoke at any time. See "Access model" below.

## Current state

This is a **single-file HTML/CSS/JS prototype**: `pakHealth.html`. No build step —
open it directly in a browser. All styling and logic live in that one file (inline
`<style>` and `<script>` tags), plus one CDN script tag for the Supabase JS client
(see Storage below).

**This is a demo, not a real product.** It should never hold real patient data. See
"Known limitations" below for why.

## Architecture

- **No framework** — vanilla JS, `document.getElementById`, manual DOM updates.
- **View switching**: every top-level screen (landing, doctor auth, patient auth,
  doctor dashboard, patient dashboard) is a `<div class="view">`. `showView(id)` hides
  all of them and un-hides one. Tabs within a page use the same hide/show pattern one
  level deeper (e.g. Visits vs. Tests).
- **Storage**: three tiers, tried in order, all behind the same `storeGet`/`storeSet`
  interface so the rest of the app never branches on which one is active. (1)
  `window.storage` (Claude.ai artifact persistent storage API) when running inside
  the Claude.ai artifact viewer. (2) **Supabase**, if `SUPABASE_URL` /
  `SUPABASE_ANON_KEY` near the top of the `<script>` are filled in with a real
  project's values — a single `kv_store` table (`key text primary key, value text`)
  mirrors the get/set-by-key shape exactly, so this is real persistence for a live
  deploy. (3) An **in-memory JS object fallback** if neither is available/configured
  — resets on every page reload, doesn't sync across devices. Until Supabase
  credentials are filled in, the app silently runs on tier (3) exactly as before.
- **Data keys**: `patient:<8-digit-code>` and `doctor:<DR-XXXXXX>`, stored as JSON
  strings, `shared: true` so a doctor's browser can look up a patient's record by code.
  A third key shape, `patient-email:<lowercased-email>`, stores just the plain-text
  code as its value — a secondary index so a patient can sign in with their email
  instead of their code. Written at signup and re-written whenever a patient saves a
  new email in Account settings; the old key isn't cleaned up if the email changes
  (harmless — it would just also resolve to the same patient), so this can drift into
  a few orphaned rows over time.
- **Access grants** (see "Access model" below) live in two real Postgres tables,
  `access_codes` and `access_grants`, separate from `kv_store` — this is structured,
  queryable data (expiry, redemption, revocation), not a fit for the JSON-blob shape
  everything else uses. Same fallback pattern as the rest of storage: if these tables
  aren't there yet, grant helpers fall back to in-memory arrays for that browser tab's
  session only.
- **Auth**: password is optional at signup (deliberately, to keep trying the app
  frictionless). If set, it's SHA-256 hashed client-side via `crypto.subtle` (no salt —
  not real security, just better than plaintext) with a non-cryptographic fallback hash
  if `SubtleCrypto` is unavailable. Accounts with no password sign in with code/ID alone
  — mirrors how the "Continue with Google" demo accounts work (no password stored at
  all, matching real OAuth behavior).

## Data model (informal)

```
patient: {
  code, name, email, phone, photoUrl, passwordHash,  // no "verified" — that's a doctor-only concept, see below
  bloodType, emergencyContact, allergies, conditions, medications,  // no longer editable in UI, kept for compat
  visits: [{ doctorName, clinicName, date, time, symptoms, diagnosis, prescription, notes,
             writtenViaGrantId, unverified }],  // last two added with the access model, see below
  tests:  [{ name, date, doctorName, resultSummary, writtenViaGrantId, unverified }],
  eyeEntries: [{ date, sphL, cylL, axisL, sphR, cylR, axisR }]  // self-entered, patient-only, see "My Eyes" below
}

doctor: {
  doctorId, name, email, phone, photoUrl, passwordHash, verified,
  license, specialty, education, about,
  clinics: [string],       // clinics/hospitals this doctor has added, managed in account settings
  currentClinic: string,   // which one of `clinics` they're currently at; stamped onto new visits as clinicName
  visitLog: [{ patientCode, patientName, date }]  // one entry per visit note this doctor has added, used for stats
}

// Postgres tables, not part of the patient/doctor JSON blobs — see "Access model" below.
access_codes:  { id, patient_id, code, created_at, expires_at, redeemed_at, redeemed_by_doctor_id }
access_grants: { id, patient_id, doctor_id, granted_via: 'code'|'trust', source_code_id,
                  granted_at, expires_at, revoked_at }
```

`writtenViaGrantId` on a visit/test entry is the `access_grants.id` that authorized the
write — no audit-log UI reads it yet, but it's captured at write time so nothing has to
be reconstructed later. `unverified` is a **snapshot** of the writing doctor's
verification status at that moment (not a live lookup) — if it were live, an entry
written while unverified would silently lose its tag the moment that doctor later got
verified, which would defeat the point of having the tag at all.

## Key flows already built

- Landing page → doctor / individual choice → sign up (name, phone, email, optional
  password) or sign in → dashboard. Doctors sign in with their doctor ID; patients can
  sign in with either their 8-digit code **or** their email (detected by whether the
  input contains `@`), both plus a password if one was set. "Continue with Google" is
  a **demo only** (asks for name/email inline, no real OAuth).
- Both roles get an ID-card-style visual (health card / doctor card) with a real card
  aspect ratio and a photo upload (stored as base64 `photoUrl`). Only the doctor card
  carries a verified badge (email + phone + license) — patients aren't a verification
  concept in this app, so their card has no badge at all. The patient card shows
  avatar + name + their **live access code** (see "Access model" below), not their
  permanent account ID — the account ID still exists (it's the storage key and
  sign-in identifier) but is deliberately not the thing shown front-and-center,
  since it isn't what grants a doctor access anymore. It's still visible in Account
  settings for the patient's own reference. The doctor card still shows brand text +
  doctor ID, unchanged.
- **Access model** (see [`ACCESS-MODEL.md`](ACCESS-MODEL.md) for the full design — this
  is Phase 1 of it, the core grant mechanism, built directly into this file): the
  moment a patient reaches their dashboard, a 6-digit live code is generated
  automatically — no button — good for 3 minutes and one redemption, shown right on
  the health card next to a small circular countdown ring (sized to match the live-code
  text) and a "Reset" button that manually mints a fresh code and restarts the ring
  early. When the ring runs out on its own (or a fresh dashboard load happens), a new
  code is silently minted so there's always a live one on screen; the previous one
  stops being valid the instant a newer one exists. A doctor redeems it in "Find a
  patient → Enter a code," which creates a
  one-hour `access_grants` row instead of handing over standing access. Separately, a
  patient's "Manage access" modal lets them trust a doctor by ID for standing,
  revocable access (patient-initiated only — a doctor can never request it), shown in
  that doctor's "Find a patient → My patients" roster with no code needed. Revoking
  takes effect on the next load, not mid-session, because every lookup and every
  visit/test save re-checks grant validity rather than caching it. Auth itself is
  unchanged (see Known limitations) — grants are enforced in app code against the
  existing doctorId/patientCode session, not via Postgres RLS.
- Doctor dashboard: redeem a patient's live code (or pick them from the roster) → the
  find-a-patient box is replaced by the patient's name, an access note (standing
  trust vs. one-time code with its remaining time), a "Search a different patient"
  link, and **Visits / Tests tabs** — same list-and-detail-modal pattern as the
  patient's own dashboard. "Add visit note" and "Add test / report" buttons sit above
  each list and open a form modal; saving re-validates the grant, stamps
  `writtenViaGrantId` and an `unverified` snapshot, then writes directly into that
  patient's record, so the patient sees it immediately next time they sign in. This is
  the core loop of the app.
- Patient dashboard: health card (avatar + name + live code) and, in the center
  column, a **record list** — Visits, Lab Results, My Prescriptions, My Eyes — each a
  wide rectangular row with a flat-illustration icon on the left (fading into white
  where the title sits) and a chevron on the right. Tapping one navigates to a real
  full-screen page (its own `<div class="view">`, shown via the same `showView()`
  top-level view-switching the rest of the app already uses, with a "← Back to
  dashboard" link in its topbar) rather than opening a modal — these were promoted to
  pages specifically because they're primary destinations now, unlike incidental
  detail popups (Account settings, Stats, Manage access) which stay modals. Within
  each page, clicking a row still opens the existing detail modal (visit/test/eye
  entry) on top of the page. **My Prescriptions is derived, not stored separately** —
  it scans every visit for a non-empty, non-"None" `prescription` field and lists
  those, clicking through to the same visit-detail modal. An "Account settings" modal
  (name, email, phone) mirrors the doctor's — this is what lets a patient add or fix
  their email/phone *after* signup; before this existed there was no way to edit those
  fields post-signup at all. A checklist on the health card shows the actual
  email/phone value once provided (not just a static "Email address" label) as a
  profile-completeness nudge — there's no "verified" concept for patients, only for
  doctors (license verification). The dashboard also has its own "My statistics" modal
  (total visits, unique doctors seen).

  Note: since the app has no client-side URL routing (`showView()` just toggles a
  `hidden` class, there's no `history.pushState`/hash routing anywhere), the browser's
  own back/forward buttons don't know about any in-app view change — that's true of
  every screen in this app, not just the new record pages, and is why every screen
  needs its own explicit back/close control instead of relying on browser history.
- Patient "My Eyes" page: self-entered eyeglass prescription tracking — SPH, CYL, and
  axis for each eye, one entry per date, newest first, click a row for the full
  detail. Two hand-drawn inline SVG line charts (same no-dependency approach as the
  doctor's trend chart) plot SPH-over-time and CYL-over-time, each with a teal line
  for the left eye and a red line for the right eye plotted together so trends are
  easy to compare at a glance; hover a point for the exact date and value. Doctors
  have no visibility into this — it's entirely patient-owned data, unlike visits/tests
  which doctors write.
- Doctor clinics: a "Currently seeing patients at" dropdown on the doctor dashboard,
  fed by a `clinics` list the doctor builds in Account settings (add/remove chips).
  Whichever clinic is selected as `currentClinic` is stamped onto every new visit note
  as `clinicName`, and shown to the patient (and the doctor) in the visit list and
  detail modal — this is the only place clinic data flows from.
- Doctor statistics: a "My statistics" modal on the doctor dashboard showing total
  unique patients seen, total visits logged, and unique patients seen today / this
  calendar month / this calendar year (actual counts against real calendar
  boundaries, not an averaged rate), plus a "Patients attended per day" trend chart
  (hand-drawn inline SVG line/area chart, no charting library — consistent with the
  no-dependency prototype and the same approach as the pulse motif). The chart plots
  every calendar day from the doctor's first-ever visit note to today (gaps filled
  with 0), so a doctor can see at a glance whether they're trending up or down over
  time; hover a point (native SVG `<title>`) for the exact date and count. Backed by
  `doctor.visitLog`, appended every time that doctor saves a visit note (not tests) —
  there's no cross-patient index otherwise, since storage is plain key/value keyed by
  patient code.

## Known limitations (the honest list)

1. **Backend is now connected.** `SUPABASE_URL` / `SUPABASE_ANON_KEY` in the `<script>`
   point at a live Supabase project (`kv_store`, `access_codes`, and `access_grants`
   tables + RLS policies created per "Going live" below), and a real cross-reload
   signup/sign-in round trip has been verified against it. `window.storage` (Claude.ai
   viewer) and the in-memory object are still there as fallbacks, tried in that order,
   only if Supabase is unreachable. Remaining caveat: the anon-key RLS policies
   intentionally allow anyone to read/write any row (matching the app's existing trust
   model) — there's no rate limiting on code lookups, so this should stay a testing
   deploy, not a public production one, until that's addressed.
2. **No real authentication, so access grants aren't database-enforced either.**
   Password hashing is client-side SHA-256, no salt, no rate limiting, no session
   tokens. The access model (live codes, trust, revocation — see "Access model" above)
   is real in the sense that the app won't show or write a record without a valid
   grant, but that check happens in app code against the existing doctorId/patientCode
   session, not in Postgres RLS keyed to a real identity — because there isn't one yet.
   Fine for a demo of the *mechanism*; someone bypassing the app entirely and hitting
   Supabase directly with the anon key still isn't stopped by anything but the same
   trust model `kv_store` already has. Real Supabase Auth (see Next version) is what
   would let RLS enforce this instead of the client.
3. **No delete/edit** on visits or tests once added.
4. **Test "reports"** are just a name/date/short text summary — no file upload, no
   structured lab-value data. Deliberately deferred.
5. **Clinics are per-doctor free text**, not a shared directory — two doctors typing
   "City General Hospital" slightly differently produce two unrelated entries. Fine for
   a demo; would need a shared `clinic:<id>` record (like patients/doctors) to dedupe
   for real.
6. **No access-history log yet.** `writtenViaGrantId` is captured on every visit/test so
   nothing has to be reconstructed later, but there's no UI that reads it — matches
   ACCESS-MODEL.md's own deferred list (§7/§10).
7. **Race condition on rapid-fire saves.** Adding a visit or test does load record →
   modify → save, not an atomic append. Confirmed by reproduction: scripting six visit
   adds back-to-back lost five of them, because overlapping saves can complete
   out of order and the last write wins, silently discarding whichever save's data
   didn't make it into that snapshot — no error is shown either time. Unlikely to bite
   during normal one-at-a-time human use, but a real gap if two doctors ever save to
   the same patient close together, or a slow connection causes a double-submit. Real
   fix needs either a per-record write queue client-side or moving visits/tests to
   proper relational rows with atomic inserts instead of one big JSON blob per patient.
   Noted, not yet fixed — deliberately deferred.

## Going live (Supabase + static hosting)

Steps 1–4 are **done**. The app is live at
https://mudabbirtufail.github.io/Pak-Health/pakHealth.html, connected to a real
Supabase project, served from the `mudabbirtufail/Pak-Health` GitHub repo (branch
`main`) via GitHub Pages. A real cross-device signup/sign-in round trip has been
verified against the deployed URL itself, not just locally. Step 3b (the access-model
migration) is a newer addition — confirm it's been run against the live project before
relying on cross-device grant persistence there.

1. **Create a free Supabase project** at supabase.com (no credit card needed for the
   free tier). Once it's provisioned, go to Settings → API and copy the **Project
   URL** and the **`anon` `public` key**.
2. **Run this in the Supabase SQL editor** to create the storage table and open it up
   to the anon key (matches the app's existing "anyone with the code" trust model —
   see the caveat in Known limitations above):
   ```sql
   create table if not exists public.kv_store (
     key text primary key,
     value text not null,
     updated_at timestamptz not null default now()
   );
   alter table public.kv_store enable row level security;
   create policy "anon read" on public.kv_store for select using (true);
   create policy "anon insert" on public.kv_store for insert with check (true);
   create policy "anon update" on public.kv_store for update using (true) with check (true);
   ```
3. **Paste the Project URL and anon key** into `SUPABASE_URL` / `SUPABASE_ANON_KEY`
   near the top of the `<script>` in `pakHealth.html` (replacing the `YOUR_...`
   placeholders). The app picks this up automatically — no other code changes needed.
3b. **Access-model migration** — run this in the same SQL editor to add the two tables
    the access model (above) needs. If this hasn't been run yet in the live project,
    the app still works, it just falls back to in-memory grants for that browser tab
    (no persistence, no cross-device redemption) until it is:
    ```sql
    create table if not exists public.access_codes (
      id uuid primary key default gen_random_uuid(),
      patient_id text not null,
      code text not null,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      redeemed_at timestamptz,
      redeemed_by_doctor_id text
    );
    create index if not exists access_codes_patient_idx on public.access_codes(patient_id, created_at desc);
    alter table public.access_codes enable row level security;
    create policy "anon all access_codes" on public.access_codes for all using (true) with check (true);

    create table if not exists public.access_grants (
      id uuid primary key default gen_random_uuid(),
      patient_id text not null,
      doctor_id text not null,
      granted_via text not null check (granted_via in ('code','trust')),
      source_code_id uuid references public.access_codes(id),
      granted_at timestamptz not null default now(),
      expires_at timestamptz,
      revoked_at timestamptz
    );
    create index if not exists access_grants_lookup_idx on public.access_grants(patient_id, doctor_id);
    create index if not exists access_grants_doctor_idx on public.access_grants(doctor_id) where revoked_at is null;
    alter table public.access_grants enable row level security;
    create policy "anon all access_grants" on public.access_grants for all using (true) with check (true);
    ```
4. **Host the static file** — since it's still just one HTML file, any static host
   works: GitHub Pages, Netlify, Vercel, or Cloudflare Pages all have free tiers that
   deploy a repo (or a drag-and-dropped file) in a couple of minutes.
5. Before wider rollout (not required just to let a few testers try it): add rate
   limiting on code redemption, since the 6-digit live code isn't currently
   brute-force protected (the 3-minute expiry and single-use narrow the window, but
   don't replace real rate limiting).

## Next version: a real access model

[`ACCESS-MODEL.md`](ACCESS-MODEL.md) is the full design doc for a real access-control
redesign: real per-user auth, a single-use 3-minute access code for ad-hoc visits, a
"Trusted" doctor tier for standing relationships, patient-controlled revocation, and an
access-history log. **Its core mechanism (§1, §5, §6 — single-use codes, trust grants,
revocation) is now built**, described above in "Access model" and "Data model." What's
still not built, matching the doc's own scope and deferred list:

- **Real Supabase Auth / Google OAuth.** Grants are checked in app code against the
  existing custom session, not enforced by Postgres RLS keyed to a real identity — see
  Known limitations.
- **The mobile-only PIN lock.** There's no separate mobile app in this repo, so the
  live-code and manage-access screens live in the web patient dashboard instead — a
  deliberate scope call for this phase, not what the doc originally describes.
  Revisit if a real mobile app ever gets built.
- **Access-history log** — deferred in the doc itself (§7/§10); `writtenViaGrantId` is
  captured so it can be added later without a data migration.
- **CNIC-linked emergency access, verification review queue, doctor MFA, appointment
  booking** — all explicitly deferred in the doc (§10/§11).

## Natural next steps (in rough priority order)

1. Real auth via Supabase (email/password *and* real Google OAuth, so the current
   fake Google button becomes real) instead of the current custom SHA-256 password
   flow — the Supabase storage tier above only replaces persistence, not auth. This is
   also what would let access grants move from app-code-enforced to RLS-enforced.
2. Edit/delete for visits and tests.
3. Access-history log UI, now that `writtenViaGrantId` is already being captured.
4. Mobile pass — responsive breakpoints exist but haven't been stress-tested on an
   actual phone.
5. Real file upload for test reports (once there's a real backend with file storage).

## Design system (for consistency if extending the UI)

- **Palette**: CSS custom properties in `:root` — `--teal` (#1F6F63, primary action
  color), `--red` (#A22D3B, used sparingly for the pulse/heartbeat motif and errors),
  `--ink` / `--ink-soft` / `--muted` for text, `--bg` / `--paper` / `--line` for
  surfaces and borders.
- **Fonts**: Spectral (serif, headings), IBM Plex Sans (body/UI), IBM Plex Mono
  (codes, IDs, eyebrow labels) — loaded via Google Fonts `<link>` in `<head>`.
- **Signature motif**: a hand-drawn SVG "pulse line" (heartbeat) used as a divider,
  animates drawing itself in on the landing page (`stroke-dasharray`/`dashoffset`).
- **Card pattern**: `.health-card` / doctor card use a real ID-card aspect ratio
  (1.586:1), teal gradient background, white text, avatar circle with photo-upload,
  used identically for both patient and doctor.
- **Reusable UI patterns**: `.modal-overlay` / `.modal-card` for all modals, `.tabs` /
  `.tab` for in-page tab switching, `.list-item` for clickable list rows (visits/tests),
  `.btn-primary` (teal, filled) / `.btn-secondary` (white, outlined) / `.btn-block`
  (full width), `.badge.verified` / `.badge.unverified` for status pills.

## How this file came to be

Built iteratively in a chat with Claude (claude.ai), one feature at a time, starting
from "two buttons on a landing page" through to the current doctor/patient visit-and-
test loop. No prior spec doc existed before this file — it's a snapshot of everything
discussed, written so a fresh Claude Code session (or a human) can pick up the project
without re-reading that whole conversation.

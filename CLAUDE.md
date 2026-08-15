# Pak Health

A patient records platform prototype. Two user roles — **individuals** (patients) and
**doctors** — with a code-based access model: patients get an 8-digit code, doctors
enter that code to look up a patient's record.

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
- **Auth**: password is optional at signup (deliberately, to keep trying the app
  frictionless). If set, it's SHA-256 hashed client-side via `crypto.subtle` (no salt —
  not real security, just better than plaintext) with a non-cryptographic fallback hash
  if `SubtleCrypto` is unavailable. Accounts with no password sign in with code/ID alone
  — mirrors how the "Continue with Google" demo accounts work (no password stored at
  all, matching real OAuth behavior).

## Data model (informal)

```
patient: {
  code, name, email, phone, photoUrl, passwordHash, verified,
  bloodType, emergencyContact, allergies, conditions, medications,  // no longer editable in UI, kept for compat
  visits: [{ doctorName, clinicName, date, time, symptoms, diagnosis, prescription, notes }],
  tests:  [{ name, date, doctorName, resultSummary }]
}

doctor: {
  doctorId, name, email, phone, photoUrl, passwordHash, verified,
  license, specialty, education, about,
  clinics: [string],       // clinics/hospitals this doctor has added, managed in account settings
  currentClinic: string,   // which one of `clinics` they're currently at; stamped onto new visits as clinicName
  visitLog: [{ patientCode, patientName, date }]  // one entry per visit note this doctor has added, used for stats
}
```

## Key flows already built

- Landing page → doctor / individual choice → sign up (name, phone, email, optional
  password) or sign in (code/ID + password if one was set) → dashboard. "Continue with
  Google" is a **demo only** (asks for name/email inline, no real OAuth).
- Both roles get an ID-card-style visual (health card / doctor card) with a real
  card aspect ratio, a photo upload (stored as base64 `photoUrl`), and a verified badge
  (patient: email + phone; doctor: email + phone + license).
- Doctor dashboard: enter a patient's code → their code-entry box disappears and is
  replaced by the patient's name/badge, a "Search a different patient" link, and
  **Visits / Tests tabs** — same list-and-detail-modal pattern as the patient's own
  dashboard. "Add visit note" and "Add test / report" buttons sit above each list and
  open a form modal; saving writes directly into that patient's record, so the patient
  sees it immediately next time they sign in. This is the core loop of the app.
- Patient dashboard: health card, Visits tab, Tests tab (both seeded with sample data
  on first load if empty, so the UI never looks broken/empty during a demo).
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
   point at a live Supabase project (`kv_store` table + RLS policies created per
   "Going live" below), and a real cross-reload signup/sign-in round trip has been
   verified against it. `window.storage` (Claude.ai viewer) and the in-memory object
   are still there as fallbacks, tried in that order, only if Supabase is unreachable.
   Remaining caveat: the anon-key RLS policies intentionally allow anyone to read/write
   any row (matching the app's existing "anyone with the code" trust model) — there's
   no rate limiting on 8-digit code lookups, so this should stay a testing deploy, not
   a public production one, until that's addressed.
2. **No real authentication.** Password hashing is client-side SHA-256, no salt, no
   rate limiting, no session tokens. Fine for a demo, not remotely production-grade.
3. **No delete/edit** on visits or tests once added.
4. **Test "reports"** are just a name/date/short text summary — no file upload, no
   structured lab-value data. Deliberately deferred.
5. **No doctor-facing patient list** — doctors can only find patients by already
   having their code; `visitLog` (added for stats) has the raw data for a "patients
   I've seen" view, but there's no UI for it yet.
6. **Clinics are per-doctor free text**, not a shared directory — two doctors typing
   "City General Hospital" slightly differently produce two unrelated entries. Fine for
   a demo; would need a shared `clinic:<id>` record (like patients/doctors) to dedupe
   for real.

## Going live (Supabase + static hosting)

Steps 1–3 (Supabase project, `kv_store` table + RLS, credentials in `pakHealth.html`)
are **done** — the app is live-connected to a real Supabase project. What's left is
hosting (step 4) so testers can reach it at a URL instead of a local file.

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
4. **Host the static file** — since it's still just one HTML file, any static host
   works: GitHub Pages, Netlify, Vercel, or Cloudflare Pages all have free tiers that
   deploy a repo (or a drag-and-dropped file) in a couple of minutes.
5. Before wider rollout (not required just to let a few testers try it): add rate
   limiting on code lookups, since 8-digit codes aren't currently brute-force
   protected.

## Natural next steps (in rough priority order)

1. Real auth via Supabase (email/password *and* real Google OAuth, so the current
   fake Google button becomes real) instead of the current custom SHA-256 password
   flow — the Supabase storage tier above only replaces persistence, not auth.
2. Edit/delete for visits and tests.
3. A doctor-facing "recent patients" list instead of only code lookup.
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

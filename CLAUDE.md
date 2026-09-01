# Pak Health

A patient records platform prototype. Two user roles — **individuals** (patients) and
**doctors** — with a grant-based access model: a patient's permanent 8-digit account ID
identifies their record but no longer grants access on its own. A doctor gets in either
by redeeming a single-use, 2-minute live code the patient generates and shows them in
person (good for one hour from redemption), or through a standing "Trusted" grant the
patient creates and can revoke at any time. See "Access model" below.

## Current state

The frontend is still a **single-file HTML/CSS/JS app**: `pakHealth.html` (plus
`style.css`/`app.js`, split out from it). No build step — open it directly in a
browser. The backend, however, is now a **real Supabase project** — real Supabase
Auth accounts (not a hand-rolled password scheme) and a relational schema with RLS
policies that enforce the access-grant model in the database itself, not just in
client-side JS. See [`supabase/schema.sql`](supabase/schema.sql) for the source of
truth, and "Storage" / "Auth" below for how the client talks to it.

**This is now aimed at a small, real, supervised pilot** — a handful of consenting
clinics/patients, not a national rollout (see [`ACCESS-MODEL.md`](ACCESS-MODEL.md)'s
own scope note: "a doctor–patient product, not a national system"). The security
foundation for that (real auth, database-enforced access control, no fake seeded
data) is in place; what's *not* yet done before real patients should touch it is
tracked in "Known limitations" and "Natural next steps" below — most importantly a
real SMTP sender for verification email, a real consent flow, and a Supabase Pro
upgrade with backups.

## Architecture

- **No framework** — vanilla JS, `document.getElementById`, manual DOM updates.
- **View switching**: every top-level screen (landing, doctor auth, patient auth,
  doctor/patient dashboards, and the patient's record pages — Visits, Lab Results, My
  Prescriptions, My Eyes) is a `<div class="view">`. `showView(id)` hides all of them
  and un-hides one. Tabs within a page use the same hide/show pattern one level deeper
  (e.g. doctor-side Visits vs. Tests).
- **Real browser back/forward**: `showView(id)` also mirrors each switch into history
  (`pushState`/`replaceState` with `#view-id` as the hash — no server routes, it's
  just used as a state label) so the actual browser back/forward buttons move between
  views instead of leaving the app, which they'd otherwise do since none of this is
  real navigation. A `popstate` listener re-applies the view without re-pushing, and
  redirects to `view-landing` if the target needs a session (`PATIENT_ONLY_VIEWS` /
  `DOCTOR_ONLY_VIEWS`) that no longer exists — e.g. pressing back after signing out.
  A real page reload no longer restarts at landing — see "Auth" below for how the
  Supabase session bootstrap handles that now — but deep-linking into a specific
  *sub*-view (e.g. reloading straight into `#view-record-visits`) still isn't
  attempted; reload always lands on the role's main dashboard.
- **Storage**: real Supabase Postgres, no fallback tiers. `SUPABASE_URL` /
  `SUPABASE_ANON_KEY` near the top of `app.js` point at the pilot's Supabase project.
  There is deliberately no `window.storage`/in-memory fallback the way the original
  demo had — this app now holds real pilot data (once real users are onboarded), so a
  failed connection shows a real "can't connect" error on load instead of silently
  pretending to work on a fallback that would just lose the user's data on reload. See
  [`supabase/schema.sql`](supabase/schema.sql) for every table, RLS policy, and RPC
  function — that file is the source of truth, not this doc.
- **Schema, in brief**: `patients` and `doctors` are real tables keyed by the
  Supabase Auth user id (`auth.users.id`), each carrying a human-facing display code
  (`code` / `doctor_code`) generated server-side. `visits`, `tests`, `eye_entries`,
  and `appointments` are one row per entry (not a JSON array on the patient row) —
  besides being the correct shape for RLS, this also fixed a real bug the old
  JSON-blob design had: concurrent read-modify-write saves could silently drop
  entries (see the old "race condition" known limitation, now resolved). `visits`/
  `tests` carry `authored_by_doctor_id`, `written_via_grant_id`, and `unverified` —
  exactly the three columns ACCESS-MODEL.md §13 specifies.
- **Access grants** (see "Access model" below) live in `access_codes` and
  `access_grants`, same shape as before but with `patient_id`/`doctor_id` now typed
  as `uuid references auth.users(id)` instead of free-text codes, so RLS policies can
  compare directly against `auth.uid()`. A doctor's browser has **no direct read
  access to `access_codes` at all** — redeeming a live code goes through
  `redeem_access_code()`, a `security definer` Postgres function, so the server (not
  the client) is what confirms a code is current/unexpired/unredeemed and mints the
  grant.
- **Auth**: real Supabase Auth (`supabase.auth.signUp`/`signInWithPassword`/
  `signOut`), not a hand-rolled password scheme — no more client-side SHA-256
  hashing, no more `passwordHash` column. A Postgres trigger (`handle_new_user()`,
  the standard Supabase pattern) creates the matching `patients`/`doctors` row the
  instant an `auth.users` row is inserted, reading `role`/`name`/`dob`/`gender`/
  `license` out of the signup call's `options.data` — this guarantees a profile row
  always exists alongside the auth user, with no separate client-side write that
  could fail or race. Sign-in is **email-only for both roles now** — the old
  `patient-email:`/`doctor-email:` lookup-index tables and the doctor-ID/8-digit-code
  sign-in fallbacks were dropped, since Supabase Auth's own user table already is the
  email index (see git history for the earlier session's kv_store-based version if
  that fallback is ever wanted back). The Supabase JS client persists its session in
  `localStorage` on its own, so a page reload now bootstraps straight into the right
  dashboard instead of always restarting at landing (see the `bootstrap()` IIFE at
  the bottom of `app.js`) — this also handles a clicked email-confirmation link
  correctly, since the client consumes the link's `#access_token=...` fragment
  before the app's own hash-based view router runs.

## Data model

The real schema is [`supabase/schema.sql`](supabase/schema.sql) — that's the source
of truth (tables, RLS policies, the signup trigger, the redemption RPC), not this
doc. In short: `patients` / `doctors` (one row per account, keyed by
`auth.users.id`), `visits` / `tests` / `eye_entries` / `appointments` (one row per
entry, `patient_id`-scoped), `access_codes` / `access_grants` (the grant ledger — see
"Access model" below).

`app.js` maps each table's snake_case columns to the camelCase shape the UI-rendering
code already expects (`mapPatientRow`, `mapVisitRow`, etc., near the top of the
file) — that mapping layer is what let most of the rendering code (list/modal
renderers, chart builders, stats) stay unchanged across the move from JSON blobs to
real tables; only the load/save functions themselves changed.

`written_via_grant_id` on a visit/test row is the `access_grants.id` that authorized
the write — no audit-log UI reads it yet, but it's captured at write time so nothing
has to be reconstructed later. `unverified` is a **snapshot** of the writing doctor's
verification status at that moment (not a live lookup) — if it were live, an entry
written while unverified would silently lose its tag the moment that doctor later got
verified, which would defeat the point of having the tag at all.

## Key flows already built

- Landing page → doctor / individual choice → a Facebook-style auth card: a sign-in
  pane (email + password, "Forgot password?", a "Create new account" button) is the
  default view, with a separate sign-up pane behind that button (first/middle/last
  name, date of birth, gender, email, password — doctors get an extra optional
  medical license field). First/middle/last are joined into the single `name` field
  the rest of the app already displays everywhere, not stored separately, since
  nothing reads them individually. Signup calls `supabase.auth.signUp()` directly —
  Supabase itself rejects an already-registered email (detected via
  `user.identities.length === 0` in the response) rather than this app maintaining
  its own uniqueness index. If the project requires email confirmation (Authentication
  → Providers → Email → "Confirm email" in the Supabase dashboard — currently **on**
  for the pilot project), signup shows a "check your email" notice instead of
  dropping straight into the dashboard, and sign-in with an unconfirmed account shows
  a clear "please confirm your email" error rather than a generic failure.
  "Forgot password?" still opens a modal that's honest about not being wired up yet
  — real Supabase Auth makes `resetPasswordForEmail()` straightforward to add, but
  it wasn't part of this pass; noted in "Natural next steps."
- **Email verification**: real now, via Supabase Auth's own confirmation email —
  `email_confirmed_at` on the auth user is the actual flag, not a hand-rolled
  boolean. The amber dashboard banner shows whenever a signed-in user's email isn't
  confirmed yet, with a "Resend email" button calling `supabase.auth.resend()`. A
  doctor's "Verified" badge now additionally requires a confirmed email (on top of
  phone + license) — `enterDoctorDash()` self-heals this on every load, recomputing
  and re-saving `verified` in case it just changed (e.g. the doctor clicked their
  confirmation link since the last visit). **Still needed before real pilot users**:
  the project currently uses Supabase's own limited default email sender, fine for
  testing but not for real volume — a real SMTP provider (Resend, Postmark, etc.)
  needs to be connected in Authentication → SMTP Settings first.
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
  automatically — no button — good for 2 minutes and one redemption, shown right on
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
  visit/test save re-checks grant validity rather than caching it. **This is now
  enforced by Postgres RLS**, not just app code — the `has_active_grant()` predicate
  in `supabase/schema.sql` gates the actual `select`/`insert` policies on `patients`/
  `visits`/`tests`, so a revoked doctor is blocked at the database level the moment
  their grant row's `revoked_at` is set, verified by direct testing (revoke, then
  confirm the doctor's own roster query — RLS-scoped to `auth.uid()` — no longer
  returns that patient at all).
- Doctor dashboard: redeem a patient's live code (or pick them from the roster) → the
  find-a-patient box is replaced by the patient's name, an access note (standing
  trust vs. one-time code with its remaining time), a "Search a different patient"
  link, and two **Visits / Tests tiles** (`.record-row`, the same photo-banner style
  and even the same two photos as the patient's own record list) that navigate to
  dedicated full-screen pages (`view-doctor-record-visits` / `view-doctor-record-tests`,
  each with a "← Back to dashboard" link) rather than switching an in-page tab — this
  mirrors the patient side's own tabs-to-pages promotion (see below) so a doctor's
  patient-record view works the same way. "Add visit note" and "Add test / report"
  buttons sit above each list, inside its page, and open a form modal — that modal's
  HTML lives as a top-level sibling of every `.view` div (not nested inside
  `view-doctor-dash`), which matters: a modal nested inside a *different, currently
  hidden* view is unreachable, since `display:none` on the ancestor collapses it
  regardless of the modal's own hidden state. This was a real bug found and fixed
  during the RLS migration's browser verification (the four doctor record-detail/
  add modals had been left inside `view-doctor-dash` since whenever the Visits/Tests
  tiles were promoted to their own pages) — the patient-side equivalents were already
  correctly placed as top-level siblings, so only the doctor side needed the fix.
  Saving
  re-validates the grant, stamps `writtenViaGrantId` and an `unverified` snapshot,
  then writes directly into that patient's record, so the patient sees it immediately
  next time they sign in. Clicking a row still opens the same detail modal as before
  — only the category-level navigation (Visits vs. Tests) changed, not the individual
  entry view. Going back to the dashboard doesn't lose the looked-up patient — nothing
  resets `currentLookupCode`/`currentLookupData`, so `#patient-result` just shows the
  same patient again, exactly like the patient side's own record pages don't reset
  `currentPatientData`. This is the core loop of the app. The doctor card's own
  checklist only lists "Medical
  license number" now — email and phone were dropped from it (the "Verified" badge
  itself still requires all three via `isDoctorVerified()`, which is unaffected; only
  the checklist's display was trimmed, matching the patient side no longer echoing
  its own email/phone back on the dashboard either).
- Patient dashboard: a **sidebar** (`.sidebar`, `position: sticky` — stays in place
  while the record list scrolls past it, disabled below the 860px breakpoint where
  the layout stacks to one column) with the health card (avatar + name + live code)
  and, in the center column, a **record list** — Visits, Lab Results, My
  Prescriptions, My Eyes — each a tall rectangular row with a real photo spanning the
  full width on top (fading to white top-to-bottom where the title sits below) and a
  chevron on the right. The four photos are real images the user supplied, cropped to
  a wide banner ratio and compressed with Pillow (a one-off local processing step, not
  something the running app does), and live as plain files in `images/`
  (`<img src="images/visits.jpg">` etc.) — unlike avatar `photoUrl`s, which really do
  need to be base64 since they're arbitrary user uploads handled entirely at runtime
  with no server to write a file to. `images/` is the one exception so far to the
  otherwise-single-file app; inlining these as base64 was tried first and reverted —
  four photos' worth of base64 roughly tripled the file size and made the source
  unreadable for no real benefit once the app is deployed as a repo rather than
  handed around as a lone file.
  The dashboard's outer container is intentionally left-aligned rather than centered
  (`#view-patient-dash .dash-main-wide`) so extra width on wide screens shows up as
  space to the right instead of being split evenly on both sides — that space now
  holds the calendar/appointments column described below, rather than sitting empty.
  Tapping a row
  navigates to a real full-screen page (its own `<div class="view">`, shown via the
  same `showView()` top-level view-switching the rest of the app already uses, with a
  "← Back to dashboard" link in its topbar) rather than opening a modal — these were
  promoted to pages specifically because they're primary destinations now. Within
  each page, clicking a row still opens the existing detail modal (visit/test/eye
  entry) on top of the page — that stays a modal since it's an incidental detail
  popup, not a destination of its own. "Manage access" is the same kind of incidental
  popup and also stays a modal. "Account settings" and "My statistics" *were*
  modals too but are now pages as well (see the Account dropdown menu, below) — the
  distinction that decides page vs. modal ended up being less about primary-vs-
  incidental and more about whether the content wants real screen width/room to
  scroll, which settings forms and stat grids both do. **My Prescriptions is derived,
  not stored separately** — it scans every visit for a non-empty, non-"None"
  `prescription` field and lists those, clicking through to the same visit-detail
  modal. "How it works," "My profile," "Account settings," "Manage access," and "My
  statistics" all live in an "Account" dropdown menu in the topbar (next to "Sign
  out") — nothing settings-related sits as a standalone sidebar button anymore. The
  dropdown reuses `.dropdown-wrap`/`.dropdown-trigger`/`.dropdown-menu`, CSS that
  already existed in the stylesheet but had no markup using it until this was built.
  The doctor dashboard has the equivalent dropdown minus "Manage access" (no doctor
  equivalent exists), so the doctor's sidebar panel below the card ends up holding
  just the clinic picker; the patient's sidebar panel below the card ends up holding
  no buttons at all, just the copy-note and privacy-note text.

  "My profile," "Account settings," and "My statistics" are full pages
  (`view-pat-profile`/`view-pat-account-settings`/`view-pat-stats`, and the `doc-`
  equivalents), not modals — same "← Back to dashboard" pattern as the record pages,
  chosen because settings forms and stat grids want real screen width rather than a
  ~440px modal card. **Every field lives on exactly one of the two pages, never
  both** — earlier drafts had "My profile" as a read-only mirror of everything
  "Account settings" already edited, which was confusing (two pages, identical
  content, unclear why either existed) rather than useful, so the fields were split
  by what they represent instead: "My profile" holds identity/bio fields (patient:
  just name; doctor: name, specialty, education, about — the fields a patient might
  eventually see), "Account settings" holds contact/access fields (patient: email,
  phone; doctor: email, phone, license, plus the doctor ID display and clinics
  management). Both pages are independently editable with their own save button
  (`pat-profile-save-btn` / `pat-save-btn`, `doc-profile-save-btn` / `doc-save-btn`)
  that only writes the fields it owns — e.g. saving Account settings never touches
  `name`, so it can't accidentally stomp on an unsaved edit sitting in the profile
  page's field. The patient's permanent 8-digit account code used to be shown at the
  top of Account settings ("Access code") but was deliberately removed and not
  relocated anywhere else in the UI — it's purely an internal identifier now (the
  sign-in field still accepts it, since existing patients only ever knew this code
  before email sign-in existed, but nothing surfaces it back to a signed-in patient
  post-signup). "How it works" opens a centered, taller-than-usual modal
  (`#pat-howitworks-modal`/`#doc-howitworks-modal` override `.modal-overlay`'s default
  top-aligned position just for themselves — most modals stay top-aligned so long
  content like Account settings doesn't get cut off) explaining the live-code/
  trust-grant flow from that role's side, one step at a time. The four steps are
  static slides sitting side-by-side in a flex track (`.stepper-track` /
  `.stepper-slide`); stepping just translates the track (`makeStepperModal()` in
  app.js, shared by both roles with different step markup and DOM ids) rather than
  swapping injected text, which is what makes the slide animation possible. Back/Next
  are icon-only circular arrow buttons, not labeled buttons; Back is disabled (not
  hidden) on the first step, and Next becomes a checkmark that closes the modal on
  the last step. The step content is the same copy originally drafted for a
  landing-page "how it works" section and then not used there. There's no
  "verified" concept for patients (only for
  doctors, via license verification), and no on-dashboard display of the email/phone
  values themselves — Account settings is the only place they're shown, on the
  assumption a patient already knows their own contact info and doesn't need it
  echoed back on every visit. The dashboard also has its own "My statistics" modal
  (total visits, unique doctors seen).

  Both the patient's and doctor's health cards sit directly on their sidebar with no
  `.panel` wrapper around them — the rest of each sidebar (buttons, notes, and for the
  doctor the clinic picker) is a separate `.panel` box below, so the card reads as its
  own object on the page rather than a bordered white box containing a bordered teal
  box. `#view-patient-dash .health-card, #view-doctor-dash .health-card` carries the
  `margin-bottom` that `.panel`'s own spacing used to provide, scoped per-view since
  `.health-card` is a shared class with no wrapper of its own to hang it on.

  Note: since the app has no client-side URL routing (`showView()` just toggles a
  `hidden` class, there's no `history.pushState`/hash routing anywhere), the browser's
  own back/forward buttons don't know about any in-app view change — that's true of
  every screen in this app, not just the new record pages, and is why every screen
  needs its own explicit back/close control instead of relying on browser history.
- Patient dashboard "Appointments" column: fills the third `.dash-grid` track (the
  space to the right of the record list on wide screens — see above) with a
  hand-rolled month-view calendar (`renderAppointmentsCalendar`, no charting/date
  library, consistent with the rest of the app) and an "Upcoming appointments" panel
  below it. The calendar has prev/next month navigation and marks the current day plus
  any day with an appointment (a small dot) using a 42-cell grid that always shows
  complete leading/trailing weeks from adjacent months, so an appointment just past a
  month boundary still shows a dot on the dimmed "outside" days. The panel below lists
  every appointment with `date >= today`, soonest first, non-clickable (`.list-item
  static` — same visual as visits/tests rows but without the pointer/hover affordance,
  since there's no detail to open yet), with an empty state when there are none. A
  "Book new appointment" button opens a modal that's honest about scope: it explains
  online booking isn't wired up yet rather than pretending to submit a request. Backed
  by the `appointments` table (see "Data model" above) — new accounts start with
  **no** entries and the empty-state copy handles that; the earlier demo's
  fake-sample-data seeding at signup (`sampleVisits()`/`sampleTests()`/
  `sampleAppointments()`) was deliberately removed when this moved to real Supabase
  Auth accounts, since fabricating visit/test/appointment history into what's now a
  potentially real patient's chart would be actively misleading, not just a demo
  nicety. **The booking mechanism itself (who it notifies, whether a doctor confirms
  it, how it writes into `appointments`) is deliberately not built** — this is
  UI-only, waiting on that design decision.
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
  a `select patient_id, date from visits where authored_by_doctor_id = X` query
  (`loadDoctorVisitLog()`) run fresh on every dashboard load — there's no stored
  `visitLog` field anymore now that visits are real rows; this replaced the old
  demo's `doctor.visitLog` JSON array that got appended to on every visit save.

## Known limitations (the honest list)

1. **RESOLVED — real auth, database-enforced access.** Accounts are real Supabase
   Auth identities; the access-grant model (live codes, trust, revocation) is
   enforced by Postgres RLS, not just app code — verified directly (a revoked
   doctor's own roster query, RLS-scoped to `auth.uid()`, stops returning that
   patient). Someone bypassing the app entirely and hitting Supabase with the anon
   key is now actually stopped by RLS, not just by the app choosing not to show them
   anything.
2. **RESOLVED — race condition on rapid-fire saves.** The old demo's read-modify-
   write-a-JSON-blob save pattern could silently drop entries under concurrent
   writes. Visits/tests/etc. are now real per-row inserts, which are atomic — this
   class of bug can't happen anymore.
3. **Rate limiting on live-code redemption is still only partial.** The code's
   2-minute expiry + single-use narrows the window, and `redeem_access_code()` being
   server-side (RPC, not a raw table the client can hammer) helps, but there's no
   dedicated brute-force throttle on redemption attempts yet. Low risk for a small
   supervised pilot; worth real rate limiting before wider rollout.
4. **Email delivery is still on Supabase's limited default sender.** Fine for testing
   (confirmation/resend emails work), not appropriate for real pilot volume — needs a
   real SMTP provider connected before onboarding real users (see "Email
   verification" above).
5. **No delete/edit** on visits or tests once added.
6. **Test "reports"** are just a name/date/short text summary — no file upload, no
   structured lab-value data. Deliberately deferred.
7. **Clinics are per-doctor free text**, not a shared directory — two doctors typing
   "City General Hospital" slightly differently produce two unrelated entries. Fine
   for a pilot; would need a shared `clinics` table (like patients/doctors) to dedupe
   for real.
8. **No access-history log yet.** `written_via_grant_id` is captured on every
   visit/test so nothing has to be reconstructed later, but there's no UI that reads
   it — matches ACCESS-MODEL.md's own deferred list (§7/§10).
9. **No consent flow, no legal/compliance review.** A real pilot with real patients
   needs an actual informed-consent step at signup and a real privacy/data-handling
   review (health data is heavily regulated) — neither exists yet; flagged, not
   built, since consent copy needs the project owner's (or counsel's) review, not
   invented text.
10. **Free-tier Supabase project.** No automated backups, subject to auto-pausing on
    inactivity. Upgrade to Pro before any real patient data goes in.

## Going live (Supabase + static hosting)

**The deployed GitHub Pages site (`mudabbirtufail.github.io/Pak-Health/pakHealth.html`,
`mudabbirtufail/Pak-Health` repo) has not been updated to this pilot-auth version yet**
— it's still serving whatever was last committed/pushed, which predates the Supabase
Auth + RLS migration described in this doc. The working directory here (uncommitted
as of this migration) points `app.js` at a **separate, fresh Supabase project**
created specifically for this migration — deliberately not the same project the old
demo used, so the public demo keeps working untouched while this was built and
verified. Commit + push + a matching Supabase project decision (reuse this fresh one,
or provision another) are still needed before the *pilot* version is actually live
anywhere.

1. **Create a Supabase project** at supabase.com. Go to Settings → API and copy the
   **Project URL** and the **`anon` `public` key**.
2. **Run [`supabase/schema.sql`](supabase/schema.sql)** in that project's SQL editor
   — paste the whole file, run it once. It creates every table, RLS policy, the
   signup trigger, and the `redeem_access_code()` function in one pass. This
   replaces the old inline `kv_store`/`access_codes`/`access_grants` SQL that used to
   live in this doc — `supabase/schema.sql` is the only source of truth for schema
   now.
3. **Paste the Project URL and anon key** into `SUPABASE_URL` / `SUPABASE_ANON_KEY`
   near the top of `app.js`.
4. **Configure Supabase Auth** (Authentication → Providers → Email in the dashboard):
   decide whether "Confirm email" should be on (currently **on** for the pilot
   project — blocks sign-in until the confirmation link is clicked) or off (lets a
   new account use the app immediately, with just the dashboard banner nudging them
   to verify). Either way, connect a real SMTP provider (Authentication → SMTP
   Settings) before real pilot users sign up — Supabase's own default sender is
   rate-limited and meant for testing only.
5. **Host the static file** — GitHub Pages, Netlify, Vercel, or Cloudflare Pages all
   work.
6. Before wider rollout: upgrade the Supabase project to Pro (automated backups, no
   auto-pausing) and add a real consent step at signup — see "Known limitations."

## Next version: a real access model

[`ACCESS-MODEL.md`](ACCESS-MODEL.md) is the full design doc for a real access-control
redesign: real per-user auth, a single-use 2-minute access code for ad-hoc visits, a
"Trusted" doctor tier for standing relationships, patient-controlled revocation, and an
access-history log. **Its core mechanism (§1, §5, §6 — single-use codes, trust grants,
revocation) and its auth provider choice (§4 — Supabase Auth, specifically so RLS can
enforce grants) are both now built**, described above in "Access model," "Storage,"
and "Auth." What's still not built, matching the doc's own scope and deferred list:

- **The mobile-only PIN lock.** There's no separate mobile app in this repo, so the
  live-code and manage-access screens live in the web patient dashboard instead — a
  deliberate scope call for this phase, not what the doc originally describes.
  Revisit if a real mobile app ever gets built.
- **Access-history log** — deferred in the doc itself (§7/§10); `written_via_grant_id`
  is captured so it can be added later without a data migration.
- **CNIC-linked emergency access, verification review queue, doctor MFA, appointment
  booking** — all explicitly deferred in the doc (§10/§11).

## Natural next steps (in rough priority order)

1. Real SMTP provider + a real consent flow — the two concrete blockers before real
   pilot users sign up, per "Known limitations" above.
2. Real password reset (`supabase.auth.resetPasswordForEmail()`) — the "Forgot
   password?" modal still just explains it isn't built yet; straightforward to add
   now that real Auth exists, just not part of this migration.
3. Edit/delete for visits and tests.
4. Access-history log UI, now that `written_via_grant_id` is already being captured.
5. Real rate limiting on live-code redemption attempts.
6. Mobile pass — responsive breakpoints exist but haven't been stress-tested on an
   actual phone.
7. Real file upload for test reports (once there's file storage wired up — Supabase
   Storage is a natural fit given everything else is already on Supabase).
8. Appointment booking mechanism — the "Book new appointment" button on the patient
   dashboard currently just explains it's not wired up yet (see "Appointments" above).
   Needs a design decision: does a doctor confirm/reject a request, does it write
   straight into `appointments`, does it notify the doctor at all given there's
   no notification system yet.

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

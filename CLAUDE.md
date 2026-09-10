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
data, real SMTP for verification email) is in place; what's *not* yet done before
real patients should touch it is tracked in "Known limitations" and "Natural next
steps" below — most importantly a verified sending domain (SMTP works but is
currently sandbox-restricted to the account owner's own email), a real consent
flow, and a Supabase Pro upgrade with backups.

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
  confirmation link since the last visit). **Custom SMTP (Resend) is now connected**
  (Authentication → SMTP page, `smtp.resend.com`, verified working 2026-09-01 by
  triggering a real password-recovery email and confirming delivery) — the pilot
  project no longer relies on Supabase's rate-limited default sender. One remaining
  restriction: Resend's sandbox only delivers to the account owner's own email
  until a sending domain is verified (Resend → Domains) — real pilot users need that
  domain verification done first, which naturally lines up with once
  `pakhealth.com.pk` exists (see "Going live").
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
  doctor is navigated to a real full-screen page, `view-doctor-record` (same
  `showView()`/"← Back to dashboard" pattern as every other primary destination in
  this app), rather than swapping content in place inside the dashboard — looking up
  a patient is a primary destination now, not an incidental panel change. The page
  shows the patient's name, a "Search a different patient" link (`resetLookup()`,
  routes back to `view-doctor-dash`), then an **"Add visit note" button sitting
  directly above the tab row**, then the **Visits / Lab results / Prescriptions tab
  row** (`.tabs`/`.tab`, same pattern as the "Enter a code" vs. "My patients" tabs one
  level up), then the tab panes themselves. There is deliberately no "Access:
  standing trust / one-time code" note anywhere on this page any more — it was
  removed outright rather than relocated. Prescriptions is derived the same way as
  the patient's own My Prescriptions page — scans that patient's visits for a
  non-empty, non-"None" `prescription` field (`renderDocPrescriptionsList()`,
  `isMeaningfulPrescription()` shared with the patient-side function) — read-only, no
  add button, since a prescription is written as part of a visit note, not as its own
  entry. "Add test / report" is the same pattern as "Add visit note" but appears above
  the Lab results pane instead — `switchPatientResultTab()` toggles which of
  `#doc-pt-add-visit-section` / `#doc-pt-add-test-section` is shown (visits ↔ lab;
  neither on the read-only Prescriptions tab) alongside which of
  `#doc-pt-pane-visits` / `#doc-pt-pane-lab` / `#doc-pt-pane-rx` is visible.
  **Clicking either add button expands a plain field section in place
  (`#add-visit-fields`/`#add-test-fields`, toggled via
  `expandAddVisitFields()`/`collapseAddVisitFields()` and their test-side
  equivalents) directly underneath that same button — not a modal popup.** This
  replaced an earlier modal-based version (`#add-visit-modal`/`#add-test-modal`) that
  opened a form as an overlay; expanding inline reads better once the add button
  already lives on the page itself rather than floating over dashboard content. The
  three doctor-side *detail* modals (`#doc-visit-modal`/`#doc-test-modal`/
  `#doc-prescription-modal`, opened by clicking an existing list row) still are real
  modals — only the *add* forms moved off the modal pattern — and, since they're only
  ever opened while `view-doctor-record` is the active view, they're nested directly
  inside that view's markup rather than living as top-level siblings of every `.view`
  div the way the old five doctor-side modals used to; a modal nested inside a
  *different, currently hidden* view is unreachable, since `display:none` on the
  ancestor collapses it regardless of the modal's own hidden state — a real bug found
  and fixed once already during the RLS migration's browser verification, so this
  nesting is safe specifically because these three modals have exactly one view they
  can ever be opened from. **The visit note's date and time are not manually entered
  at all** — there's no date/time field in `#add-visit-fields` any more; saving stamps
  `date`/`time` with the current moment automatically (`new
  Date().toISOString().slice(0, 10)` and `formatCurrentTime()`, a small `h:mm AM/PM`
  formatter next to `formatHourLabel`), on the assumption a doctor is logging a note
  for the visit happening right now, not backdating one — no reason to make them type
  today's date. Test entries keep a manual date field, since a test result is
  routinely added after the fact (or shows "Pending" before results are back), so
  today's date isn't a safe assumption there the way it is for a visit note. Saving
  a visit or test re-validates the grant, stamps
  `writtenViaGrantId` and an `unverified` snapshot, then writes directly into that
  patient's record, so the patient sees it immediately next time they sign in; a
  newly added visit's prescription also re-renders the Prescriptions pane
  immediately, not just the Visits pane, and the field section collapses back down
  on a successful save. Clicking an existing row still opens the same detail modal as
  before — only the category-level switch (Visits vs. Lab results vs. Prescriptions)
  changed, not the individual entry view. Going back to the dashboard doesn't lose the
  looked-up patient — nothing resets `currentLookupCode`/`currentLookupData`, so
  re-entering `view-doctor-record` (e.g. via a day-grid block click, see
  "Appointments" below) just shows the same patient again (defaulting back to the
  Visits tab), exactly like the patient side's own record pages don't reset
  `currentPatientData`. This is the core loop of the app. The doctor card's own
  checklist only lists "Medical license number" now — email and phone were dropped
  from it (the "Verified" badge itself still requires all three via
  `isDoctorVerified()`, which is unaffected; only the checklist's display was
  trimmed, matching the patient side no longer echoing its own email/phone back on
  the dashboard either).
- Doctor dashboard layout: retrofitted into the same `.dash-grid` 3-column pattern the
  patient dashboard already used (`.sidebar` / `.center-col` / `.right-col`, each
  wrapped in `.sticky-inner`) rather than needing new CSS — the doctor dashboard's
  "right" track was simply unused before this. Sidebar holds the doctor card and the
  license-checklist/clinic-picker panel; center holds "Find a patient" (code entry +
  roster, no result content in-page any more now that a lookup navigates away — see
  above); right holds a **Google-Calendar-style single-day appointment grid**
  (`renderDoctorDayGrid()` in `app.js`) under the same "Upcoming appointments" heading
  the old list-based panel used (`.eyebrow`+`<h3>`, same markup pattern as the
  patient-side "Upcoming appointments" panel) — only what's rendered under that
  heading changed, not the heading itself. Hour rows run
  a fixed `DAYGRID_START_HOUR`–`DAYGRID_END_HOUR` (7am–9pm) range at a fixed
  `DAYGRID_ROW_H = 56` px each. **There's no separate left-hand time column** — an
  earlier version had one (like a plain spreadsheet gutter), but it was replaced with
  a `.daygrid-hour-label` floated at the top-right of each `.daygrid-hourline`
  (`position:absolute; right:6px; transform:translateY(-100%)`, same row-index math
  as the lines themselves) so appointment blocks could stretch the full width of the
  grid — from the left edge (`left:2px`) instead of starting after a gutter — rather
  than losing ~46px of block width to labels that only need to mark the line, not
  occupy their own column. Appointment blocks (`.daygrid-block`) are absolutely
  positioned by parsed start time and sized by duration — duration comes from
  matching the appointment's time against that doctor's `doctor_availability`
  `slot_minutes` for the same clinic/weekday (falling back to 20 minutes if no match),
  since `appointments` itself doesn't store a duration. **A block's text is one
  single line** — patient name (bold, `.daygrid-block-title`) followed by `" - "` and
  the `reason` if there is one, all in one `white-space:nowrap; overflow:hidden;
  text-overflow:ellipsis` div, so as much of the reason shows as actually fits the
  block's width rather than a fixed word count truncated in JS (an earlier version
  hard-truncated to the reason's first 1-2 words on a second line; this reads more of
  the reason on a wide sidebar and less on a narrow one, instead of a constant
  regardless of space); the block's native
  `title` attribute still carries the full `"name — reason"` text so hovering reveals
  whatever the ellipsis cut off. Clicking a block
  looks up that appointment's `patientId` (`mapAppointmentRow` now carries
  `patientId` off `appointments.patient_id` for exactly this) via `getActiveGrant()` +
  `loadPatientRecordForDoctor()` and calls `showLookupResult()` — the same function
  the code-redemption and roster-click paths already call — so clicking a calendar
  block lands on the identical `view-doctor-record` page described above. Prev/next
  day buttons (`#doc-daygrid-prev`/`#doc-daygrid-next`) hold the currently-viewed date
  in a module-level `doctorDayGridDate` variable (`null` means "today"); navigation
  wasn't scoped to today-only since letting the doctor look ahead or back only adds
  capability, not complexity, over a today-only view — **there's no bound on how far
  back or forward it can go**, unlike the patient's booking calendar, which is capped
  at `BOOKING_HORIZON_DAYS = 28` out (see "Appointments" below) since that cap exists
  to stop a patient booking into a doctor's stale/unconfirmed future schedule, a
  concern that doesn't apply to a doctor just paging through their own already-booked
  history or future. An empty state shows when the
  selected day has no appointments. **The calendar re-fetches this doctor's
  appointments every time they land back on `view-doctor-dash`** — `showView()`
  itself calls `refreshDoctorAppointments()` whenever its target is
  `'view-doctor-dash'` (before the early-return that would otherwise skip it during
  a suppressed/`popstate` navigation, so this fires for the topbar "← Back to
  dashboard" link, "Search a different patient," and the browser's own back/forward
  buttons alike, not just one specific button). This app has no realtime
  subscription anywhere — everything is fetch-on-load/fetch-on-action, consistent
  with the rest of it — so without this, an appointment a patient books while the
  doctor is already mid-session (sitting on the dashboard, or inside a patient's
  record) wouldn't show up until a full page reload or re-sign-in; re-querying
  specifically on return-to-dashboard closes that gap cheaply at this pilot's scale
  without needing a poll or a websocket. One accepted tradeoff: `enterDoctorDash()`
  already loads fresh appointments itself (as part of its own `Promise.all`) and
  then calls `showView('view-doctor-dash')` at the end, so every sign-in/reload
  re-fetches appointments twice in a row — a harmless redundant query, not worth the
  extra complexity of suppressing it just for that one path.
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
  equivalent exists) plus one extra item, **"Manage clinics"** (`view-doc-clinics`,
  `doc-clinics-btn`) — the Clinics section (list, "+ Add a clinic", the "Manage"
  modal and its delete-confirm popup) used to live at the bottom of "Account
  settings" and was pulled out into its own page, since it's a big enough
  chunk of doctor-only functionality to deserve its own dropdown entry rather
  than being buried under contact-info fields it has nothing to do with; see
  "Doctor clinics" below for what that page actually contains now. The
  doctor's sidebar panel below the card ends up holding
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
  every appointment with `date >= today`, soonest first — no panel-sub caption above
  the list any more (removed as redundant under the "Upcoming appointments" heading),
  clickable rows opening the detail/cancel popup described further down, with an
  empty state when there are none. A
  "Book new appointment" button opens a real booking flow now: a full-screen page
  (`view-pat-book-appt`, same "← Back to dashboard" pattern as the other patient
  sub-pages — promoted from an earlier modal version since searching a doctor
  directory wants real screen room, not a ~440px card) with a search step first
  (`#book-appt-search-step`, a directory of every registered doctor, filtered
  client-side as the patient types against name, current clinic, and the full
  `clinics` array — no server-side search, consistent with the rest of the app's
  small-pilot scale). Clicking a doctor doesn't navigate anywhere — it expands
  a **clinics sub-list right under that row** (`toggleDoctorClinics()`,
  `.book-doctor-clinics`), accordion-style: same `.list-item` markup as the
  doctor row itself, just indented and on a faint `--bg` tint so the nesting
  reads clearly without inventing a second visual style, and opening one
  doctor's sub-list collapses whichever else was open. This replaced an
  earlier version with a separate clinic-selection step (a whole page transition
  just to pick a clinic, plus a native `<select>` that looked nothing like the
  rest of the list-driven UI) — expanding in place is fewer clicks and stays
  visually consistent with how the doctor list itself already looks. The
  sub-list is populated by `distinctBookableClinics()`, which only offers
  clinics that still have at least one non-expired `doctor_availability` block
  today — a clinic whose schedule has fully lapsed just doesn't appear, rather
  than offering a dead end; no bookable clinics at all shows a plain inline
  message instead of a list. Picking a clinic row is what actually advances to
  the date/time **form step** (`#book-appt-form-step`) — a clinic always has to
  be chosen before any date or time shows up, since availability is per-clinic.
  "Choose a different doctor or clinic" (form step) goes back to the search
  step with its doctor list collapsed, not to a separate clinic step (there
  isn't one anymore). Once a clinic is chosen (`bookApptSelectedClinic`), the
  form step shows a row of
  **date tabs** first, then **available time slots** below them; no free-text
  date or time field anywhere in the flow. `generateBookableDates()` walks every
  date from today out to a hard `BOOKING_HORIZON_DAYS = 28` cap and keeps only
  the ones some block *for that clinic* actually covers (right weekday, not past
  its `valid_until`), so the tab row only ever shows days the doctor is really
  at that specific clinic, never a dead day the patient would tap into an empty
  grid. Each tab shows weekday, day number, and month abbreviation
  (`.dow`/`.dnum`/`.dmon`) since the 28-day window can span a month boundary and
  a bare day number alone would be ambiguous. The first date tab auto-selects
  itself once the row renders. Picking a date (`.date-tab-btn`, styled like
  `.slot-btn`'s pill but for dates) looks up that weekday's blocks *for the
  already-chosen clinic*, slices each into slots of its own `slot_minutes`
  length (`generateSlotTimes()` in app.js), queries and filters out
  already-booked times for that doctor+date, and merges every block's remaining
  times into one flat `.slot-grid` — no more grouping/labelling by clinic within
  the slot grid itself, since the clinic was already fixed a step earlier; a
  split-shift day (two blocks, same clinic) just contributes two ranges of times
  into the same grid. A date whose only slots are already taken shows a plain
  message instead of an empty grid — this can only happen from a fully-booked
  day now, since a day with no coverage at all never gets a tab in the first
  place. The chosen slot's clinic is simply `bookApptSelectedClinic` (no longer
  read off the slot button itself, now that it's fixed for the whole form step).
  The form step header shows the doctor's name, clinic name, address, phone
  number, and phone-hours note as visually distinct lines
  (`.book-appt-doctor-name` / `.book-appt-clinic-name` / `.book-appt-clinic-address`
  — enlarged and serif for the doctor's name, teal-dark for the clinic, and the
  `.book-appt-clinic-address` muted-small-text style reused as-is for the phone
  and note lines too via `#book-appt-clinic-phone`/`#book-appt-clinic-note`,
  each prefixed "Phone: "/"Phone hours: " for context and hidden entirely when
  that clinic has nothing on file for it) rather than one small
  inline `"Dr. X · Clinic Y"` string — the form step itself carries no access-grant
  disclosure text any more (that used to sit here too, duplicating the confirm
  modal's own wording; removed as redundant once the confirm step existed).
  Clicking "Book appointment" doesn't insert right away — it opens a **confirm
  modal** (`#book-appt-confirm-modal`) summarizing what's about to be booked,
  styled to match the form step's own header rather than a generic `.kv`
  label/value table: the same `.book-appt-doctor-name`/`.book-appt-clinic-name`/
  `.book-appt-clinic-address` stack, then **date and time as two separate
  `.appt-datetime` lines** (date first, time directly below — not one combined
  line) at roughly double the size of the name/clinic text above them, then the
  access-grant disclosure as plain text ("Confirming this appointment gives the
  doctor standing access to your health record") below that. **The whole modal
  is center-aligned** (`#book-appt-confirm-modal .modal-card{text-align:center}`,
  plus `.save-row{justify-content:center}` so the buttons center too, scoped by
  id rather than touching `.modal-card`/`.save-row` generally since every other
  modal in the app stays left-aligned) — one continuous centered read top to
  bottom instead of a table to scan. **The `save-row` holds only the hold-to-confirm
  button now, no separate "Cancel" next to it** — the modal's own × close (top
  right) already dismisses it without booking anything, so a second, redundant
  dismiss control next to the one-and-only real action wasn't adding anything.
  Only that modal's own hold-to-confirm
  button actually writes the row; "Book appointment" itself just validates a
  date and slot are picked and hands off. The address shown at both the
  accordion clinic-picker step and this confirm
  step, and the `clinic_address` snapshotted onto the appointment row itself
  (new `appointments.clinic_address text` column, same snapshot reasoning as
  `doctor_name`/`clinic_name`), all come from the same `{name, address}` clinic
  object — see "Doctor clinics" above for where that address is set. `appointments`
  also carries a `unique(doctor_id, date, time)` constraint as the real backstop
  against two patients grabbing the same slot — the client-side filter is what a
  patient sees, the constraint is what actually stops a race; a `23505` on
  insert closes the confirm modal, re-renders the slot list, and tells the
  patient to pick another. Booking is **auto-confirmed and auto-grants
  access** — there's no doctor review step, and the insert immediately
  calls `createTrustGrant()` (the same function "Manage access" already used for a
  patient-initiated trust grant), so the doctor gets standing access to the
  patient's record the moment the appointment is booked, not just visibility into
  the booking itself — the confirm modal (above) is where this gets disclosed now,
  a single place rather than two. This was a deliberate scope choice over a
  pending/confirm flow — simpler for a small supervised pilot, revisit if real
  doctors want review-before-booking.
  **Upcoming appointments are now manageable, not just a static list** — the
  patient dashboard's "Upcoming appointments" rows are clickable (`.list-item`,
  not `.list-item.static` any more — no chevron on these rows though, unlike
  every other clickable list in the app; deliberately plain since the row
  itself already reads as tappable without one), opening
  `#pat-appt-detail-modal`. That modal uses the same center-aligned, stacked
  layout as the booking confirm modal — doctor/clinic/address, then date and
  time as two separate large `.appt-datetime` lines, then reason as a small muted note (hidden
  entirely when there isn't one) — plus a "Hold to cancel appointment" button
  that deletes the row outright. **Both this button and "Hold to confirm
  booking" on the confirm modal are press-and-hold, not click** —
  `makeHoldButton(el, 2000, onComplete)` (a shared helper near `showError`/
  `clearError`) wires `mousedown`/`touchstart` to sweep a `.hold-fill` overlay
  across the button over exactly `holdMs` via a plain CSS `width` transition,
  and only calls `onComplete` (the actual delete/insert) if the press survives
  the full duration; `mouseup`/`mouseleave`/`touchend`/`touchcancel` before then
  snaps the fill back to 0 over a quick 0.2s and does nothing else — a plain
  click is a harmless blip, not an accidental confirm/cancel. `.hold-label`
  text goes white once `.holding` is added so it stays legible against the
  sweeping fill. Two real bugs surfaced building this, both fixed: (1) `.btn-primary`
  already has its own `:hover{background:var(--teal-dark)}`, the exact color
  the fill sweeps in — on the confirm button (primary) the hovering mouse
  meant the whole button was already painted the fill's color before the fill
  even started, so the sweep was invisible against itself; fixed with
  `.btn-primary.hold-btn:hover{background:var(--teal)}` to pin hover back to
  the resting color just for hold-buttons. (2) The fill wasn't animating at
  all at first, snapping straight to 100% — setting `fillEl.style.transition`
  and the new `width` in the same synchronous tick let the browser coalesce
  both into one frame with no committed "before" state to transition from;
  fixed by explicitly resetting to `width:0%` with `transition:none` and
  forcing a reflow (`void fillEl.offsetWidth`) before turning the transition
  back on and setting `width:100%` — the standard fix for "set transition +
  value together" not animating. This exists specifically because both actions are
  one-click-irreversible (an appointment genuinely gone, a real booking with a
  real access grant) and this app has no separate "are you sure?" dialog
  pattern elsewhere to reuse — the hold itself *is* the confirmation, instead
  of stacking a second modal on top of the one already asking. Cancelling only removes the appointment — it does
  *not* revoke the trust grant booking created; that stays a separate,
  patient-initiated action in "Manage access", consistent with the rest of the
  access model never letting one action silently imply another. No
  reschedule yet, only cancel. The doctor side gets the day-grid calendar described
  under "Doctor dashboard layout" above as its view into these same rows (an earlier
  version had a plain read-only "Upcoming appointments" list here instead — replaced
  by the day-grid), backed by a new `appointments_select_doctor`
  RLS policy (`doctor_id = auth.uid()`) — the doctor never gets write access to
  appointments, only to the patient record via the grant the booking already created.
  Backed by the `appointments` table (see "Data model" above), which gained a
  nullable `doctor_id uuid references doctors(id)` column for this — nullable so it
  never breaks on old rows that predate real booking (`doctor_name`/`clinic_name`
  stay as text snapshots, same reasoning as visits/tests). New accounts start with
  **no** entries and the empty-state copy handles that; the earlier demo's
  fake-sample-data seeding at signup (`sampleVisits()`/`sampleTests()`/
  `sampleAppointments()`) was deliberately removed when this moved to real Supabase
  Auth accounts, since fabricating visit/test/appointment history into what's now a
  potentially real patient's chart would be actively misleading, not just a demo
  nicety.
- Patient "My Eyes" page: self-entered eyeglass prescription tracking — SPH, CYL, and
  axis for each eye, one entry per date, newest first, click a row for the full
  detail. Two hand-drawn inline SVG line charts (same no-dependency approach as the
  doctor's trend chart) plot SPH-over-time and CYL-over-time, each with a teal line
  for the left eye and a red line for the right eye plotted together so trends are
  easy to compare at a glance; hover a point for the exact date and value. Doctors
  have no visibility into this — it's entirely patient-owned data, unlike visits/tests
  which doctors write.
- Doctor clinics: a "Currently seeing patients at" dropdown on the doctor dashboard,
  fed by a `clinics` list the doctor builds on its own **"Manage clinics" page**
  (`view-doc-clinics`, reached from the Account dropdown — pulled out of Account
  settings into its own page since it had grown into a big enough chunk of
  functionality, schedule-management included, to not belong under
  contact-info fields any more). Whichever clinic is
  selected as `currentClinic` is stamped onto every new visit note as `clinicName`,
  and shown to the patient (and the doctor) in the visit list and detail modal.
  **Each clinic is now `{name, address, phone, note}`, not a bare name string** —
  `normalizeClinic()` in app.js upgrades a legacy element missing any of these
  (a bare string from before addresses existed, or a `{name, address}` pair from
  before phone/note existed) by defaulting whatever's missing to `''`, so
  existing rows never needed a data migration each time this shape grew.
  `phone` and `note` (a free-text "when the phone is actually answered" note,
  e.g. "Phone lines open Mon-Sat, 9am-6pm") exist purely for patients to know
  how to reach the clinic directly — nothing in the booking logic reads them,
  they're display-only. **Add and
  Manage share one modal** (`openManageBookingsModal(clinicName)` — omitting
  `clinicName` opens it in "create a new clinic" mode instead of editing an
  existing one): the top-level "+ Add a clinic" button is just a plain button
  now, no adjacent text input — clicking it opens the same
  `#doc-manage-bookings-modal` used for "Manage", with a name field revealed
  at the top (`#avail-clinic-name-field`, hidden in edit mode) alongside
  address, phone, note, and the weekly grid, so a doctor sets a new clinic's name,
  contact details, *and* hours in one sitting instead of adding a bare name first and
  configuring the rest later. **Address, phone, and note are each view/edit, not
  bare textboxes, once a clinic already has values** — editing an existing clinic
  shows each as plain text next to its own small "Edit" button
  (`showClinicFieldView(key, ...)`/`showClinicFieldInput(key)`, one generic pair
  driving all three fields by id prefix — `avail-clinic-{key}`/`-view`/`-text`/
  `-edit-btn` — rather than three near-identical copies of the same toggle), and only clicking "Edit" swaps
  in the actual `<input>`/`<textarea>` (pre-filled, so saving without ever touching it
  can't blank the field out); creating a new clinic skips straight to the
  inputs since there's nothing to display yet. Saving in create mode inserts the
  full `{name, address, phone, note}` into `doctors.clinics` first (a clinic's identity has to
  exist before any `doctor_availability` row can reference it by name), then
  falls through into the exact same schedule-replace logic edit mode already
  used; editing checks all three contact fields for a change (not just address)
  before writing. Each clinic row (no longer a bare chip — a
  `.list-item` row, since it now carries more than just a name) has only a
  **"Manage" button** now (plain "Manage", not "Manage bookings" — the modal it
  opens does more than scheduling now) — **no separate "×" remove button next
  to the row any more**; deleting a clinic moved *inside* Manage instead (see
  below), since removing a clinic and its whole schedule is exactly the kind
  of action that benefits from the extra "are you sure" friction a bare inline
  × never had. Manage opens
  (`.modal-card-wide`) built as a name field (create mode only), an address
  field, and a **fixed Monday→Sunday
  grid**, not an incremental
  add-one-row-then-see-it-in-a-list flow (that version shipped first and the
  doctor found it "confusing and difficult to manage" — this replaced it). Each
  day row has its own From/To time inputs and an "+ Add another slot"
  link that appends a second (or third...) from/to pair to that same day, for a
  split shift like mornings-and-evenings; a shared "avg. minutes per patient"
  field applies to the whole clinic, not per day. A single "Repeat weekly for the
  next __ week(s)" checkbox + number (max 4) controls how far the whole schedule
  extends. **Saving replaces the clinic's entire schedule** — every existing
  `doctor_availability` row for that clinic is superseded by whatever the grid
  currently shows, computed as `valid_until = today + repeat_weeks*7` on every row
  — rather than editing rows in place. The write order matters and was a real bug
  once: the first version deleted the clinic's old rows *then* inserted the new
  ones, so a failed insert (as happened live once, testing before the
  `valid_until` migration had been run) silently wiped the doctor's existing
  schedule with nothing to replace it. Fixed to insert the new rows first and only
  delete the old ones (by the specific ids captured before the insert, not a
  blanket clinic_name delete) once the insert has actually succeeded — a failed
  save now leaves the previous schedule untouched. The modal's one "Save" button
  covers both writes — the address field (a plain `doctors.clinics` update,
  independent of the schedule tables) only fires when the address actually
  changed from what the modal opened with, then the schedule replace runs as
  above (or, in create mode, the new clinic is inserted into `doctors.clinics`
  first, same idea). **Deleting a clinic is a "Delete clinic" link at the
  bottom of Manage** (hidden in create mode — nothing to delete yet), not a
  bare row-level ×. It opens a second, smaller confirm popup
  (`#doc-delete-clinic-modal`) stacked on top of Manage — same
  press-and-hold pattern as the appointment confirm/cancel buttons
  (`makeHoldButton`, "Hold to delete clinic", 2 seconds) rather than a plain
  click, since removing a clinic wipes its whole schedule and can't be undone.
  Confirming removes the clinic from `doctors.clinics`, clears `currentClinic`
  if it pointed at the deleted one, deletes every `doctor_availability` row for
  that `clinic_name`, and closes *both* popups — cancelling out of the confirm
  popup (× or "Cancel") only closes that one, leaving Manage still open so the
  doctor can keep editing — an outright delete, no replacement rows to protect
  the way the schedule-save above does. **The 4-week
  figure is a hard cap enforced twice**: the "Repeat weekly" number input is
  clamped to 4 when saving, and separately `generateBookableDates()` (patient
  side, below) never looks past `today + 28 days` regardless of what any row's
  `valid_until` says — so no single doctor's setting, or a bad row, can push a
  patient's booking window past the app-wide limit. **`currentClinic` also picks
  itself**: every dashboard load, `autoDetectCurrentClinic()` checks whether right
  now falls inside one of the doctor's still-valid weekly blocks
  (`isAvailabilityBlockActive()` — skips anything past its `valid_until`,
  including legacy rows saved before that column existed, since those come back
  `null`) and, if so, persists that clinic as current — the same write path as
  picking it manually from the dropdown — so the doctor doesn't have to remember
  to flip it themselves, and a patient searching the directory sees where they
  actually are. These same `doctor_availability` rows are what the patient booking
  flow slices into bookable slots — see "Appointments" below.
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
4. **RESOLVED — real SMTP connected and verified working** (Resend, 2026-09-01).
   Remaining caveat, not a bug: Resend's sandbox restricts delivery to the account
   owner's own email until a sending domain is verified — needs that verification
   done before onboarding real pilot users (see "Email verification" above).
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
   decide whether "Confirm email" should be on (blocks sign-in until the
   confirmation link is clicked) or off (lets a new account use the app
   immediately, with just the dashboard banner nudging them to verify) — currently
   **off** on the pilot project (toggled off mid-session for easier testing; revisit
   before real users). Either way, connect a real SMTP provider (Authentication →
   SMTP page — a dedicated top-level page, `/auth/smtp`, not a tab buried under
   something else) before real pilot users sign up — Supabase's own default sender
   is rate-limited and meant for testing only. **Already done for the pilot
   project**: Resend is connected and verified working (host `smtp.resend.com`,
   username literally `resend`, password = Resend API key) — the one remaining step
   is verifying a sending domain in Resend, since its sandbox mode only delivers to
   the account owner's own email otherwise.
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

1. Verify a sending domain in Resend (Domains → Add Domain) so real pilot users can
   actually receive email — right now delivery is sandbox-restricted to the account
   owner's own address (see "Known limitations"). A real consent flow at signup is
   the other concrete blocker before onboarding real pilot users.
2. Wire `supabase.auth.resetPasswordForEmail()` into the "Forgot password?" modal —
   the *email-sending mechanism* is already verified working (tested directly via
   the `/auth/v1/recover` endpoint during SMTP setup), but the app's UI still just
   explains self-service reset isn't built; needs the modal's form wired to call it,
   plus handling the `type=recovery` link landing (a "set new password" screen).
3. Edit/delete for visits and tests.
4. Access-history log UI, now that `written_via_grant_id` is already being captured.
5. Real rate limiting on live-code redemption attempts.
6. Mobile pass — responsive breakpoints exist but haven't been stress-tested on an
   actual phone.
7. Real file upload for test reports (once there's file storage wired up — Supabase
   Storage is a natural fit given everything else is already on Supabase).
8. **RESOLVED — appointment booking.** Patients search the full doctor directory by
   name or clinic and book directly (see "Appointments" above); auto-confirmed,
   auto-grants access, no doctor review step by deliberate scope choice. A real
   pending/confirm flow and appointment cancellation are the natural follow-ups if a
   pilot doctor asks for review-before-booking.

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
- **The whole type/spacing scale is ~80% of the numbers you'd naively expect,
  on purpose.** Every size/spacing decision made across this session was eyeballed
  against a browser that turned out to be sitting at 80% zoom the whole time,
  without either side realizing it (discovered 2026-09-10, when a fresh check at
  true 100% zoom showed everything rendering noticeably larger than intended). The
  first fix attempt was a single `html{ zoom: 80%; }` rule — quick, but a real hack:
  it renders correctly but leaves every actual value in the file lying about its own
  size (a declared `padding:12px 20px` never actually renders at 12/20px to any
  visitor), which would confuse the next person editing this file and silently
  compounds with a visitor's own browser zoom. It was reverted in favor of doing it
  properly: every genuine visual-size value in `style.css` (`font-size` in `rem`,
  every `padding`/`margin`/`gap`/`width`/`height`/`border-radius`/positioning
  offset/`box-shadow` px value, `--radius`, the `.dash-grid` column widths, etc.) was
  hand-multiplied by 0.8 and rounded to a clean px/0.01rem value — same approach
  applied to inline HTML `style="...px"` attributes scattered through
  `pakHealth.html` and template strings in `app.js`, plus every inline `<svg
  width="…" height="…">` icon's outer dimensions (`viewBox` and path/circle
  coordinates untouched — only the outer render size shrinks) and the
  `DAYGRID_ROW_H` constant driving the day-grid's real pixel math. **`@media
  (max-width: …)` breakpoint thresholds were deliberately left unscaled** — those
  test real device/viewport width (a phone is still ~390–430px wide regardless of
  our internal type scale), not a value this rescale has any business touching;
  everything *inside* a media query block that represents an actual component
  dimension (e.g. `.dash-grid{ grid-template-columns: 336px 1fr; }` under the
  1180px tier) was scaled like everywhere else. **Two elements needed the opposite
  treatment — reverted rather than scaled**: `.live-code-ring`'s `stroke-width`/
  `transform-origin` and `.pulse path`'s `stroke-width` are SVG user units tied to
  each element's own fixed, unchanged `viewBox` — not CSS pixels — so scaling them
  would have thrown off the ring's rotation center and the pulse line's proportions
  relative to their own artwork; only their outer HTML-attribute/inline-style
  render size needed to shrink (the SVG scales its internal geometry to fit
  automatically). If sizes ever look "off" again relative to what was designed on
  screen, this 80% history is why — not a regression.

## How this file came to be

Built iteratively in a chat with Claude (claude.ai), one feature at a time, starting
from "two buttons on a landing page" through to the current doctor/patient visit-and-
test loop. No prior spec doc existed before this file — it's a snapshot of everything
discussed, written so a fresh Claude Code session (or a human) can pick up the project
without re-reading that whole conversation.

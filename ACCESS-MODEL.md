# PakHealth — The Access Model

**Status:** Working draft · **Scope:** v1, a doctor–patient product — not a national system · **Last updated:** 22 Aug 2026

A design reference for PakHealth's *next* version — a real access-control model to replace
the current prototype's single permanent code. Nothing here is built yet; see
[`CLAUDE.md`](CLAUDE.md) for the actual current state of `pakHealth.html`. Full interactive
version (same content): https://claude.ai/code/artifact/9e5aeba6-0a20-4835-92ba-cdf444370e8e

## 1. Identity is not authorization

A code should say *which* record. A separate, revocable decision should say *whether* this
clinician may act on it. The two must never be the same fact — that's the one idea
everything below is built on.

The running prototype breaks this today: its single 8-digit code does both jobs at once,
so whoever has it gets full, permanent, invisible access — a leak is silent and never ends.
§ 5 covers exactly how the new mechanism avoids that, and what got tried and rejected along
the way.

## 2. What this is — and isn't

This design started as a sketch for a national CNIC-linked, NADRA-authenticated system. It
isn't that. It's a product two people can actually build: doctors and patients sharing
records securely, running **alongside** the existing paper-based system, not replacing it.

- Patients or clinics without a smartphone simply keep using paper — nothing is taken away
  from them.
- Full displacement of paper records is a fine long-term ambition. It is not a v1
  requirement, and nothing here is designed to force that pace.
- Everything in [§ 11](#11-explicitly-out-of-scope) was seriously discussed for the national
  version and deliberately left out here — not forgotten, declined.
- Every account on the currently deployed prototype is a test account. This design ships as
  a clean relaunch, not a migration — nothing here needs to preserve or carry forward old
  data.

## 3. Two platforms, one doing double duty

**Web app** — Sign-up and sign-in for both doctors and patients. Where records and history
get read — the shared working surface for both roles.

**Mobile app** — Patient-only, PIN or biometric to open. Everything the web app gives a
patient — sign-up, sign-in, their own record — plus one thing the web app doesn't: granting
and revoking a doctor's access.

Doctors operate entirely on web — there's no clinician-side need for a second app yet. For
patients, mobile isn't a stripped-down consent-only companion; it's the full patient
experience, with access management layered on top specifically because it's a
security-sensitive action worth tying to a device only the patient holds and unlocks with a
PIN.

## 4. Identity & verification

Patient accounts are just accounts — real auth, no different from any other product. Doctor
accounts carry one more fact: whether anyone has actually confirmed the license.

**Verification, deferred on purpose.** A doctor can upload a license to become **Verified**.
For v1 this is not required to sign up or to write to a record — the review workflow that
would make "verified" mean something doesn't exist yet, and building it isn't worth delaying
launch for. Ship first; add the review queue once there's real traffic to justify it.

> **Cheap mitigation while verification doesn't exist:** every entry written by an
> unverified account carries a small, visible "unverified" tag in the record. Costs nothing
> to build now, and means there's no retrofitting trust signals onto old data once real
> verification ships — the distinction has existed in the data from day one.

## 5. The access mechanism

This is the part that went through the most revision. Worth showing the path, not just the
destination — each earlier version failed for a specific, instructive reason.

### How we got here

| Version | Mechanism | Outcome |
|---|---|---|
| v0 | Permanent shared code *(today's prototype)* | Whoever has the code has full access, forever. A bearer token. The exact problem this document exists to fix. |
| v1 | Low-sensitivity ID + auto write-grant, time-boxed on lookup | **Rejected.** Looking the patient up minted a 48-hour write grant. Looked airtight — until it was clear the *doctor's own lookup* was what renewed it. Anyone who'd ever had the identifier could re-mint access for free, instantly, forever. The time-box added token hygiene, not security. |
| v2 | A code that rotates on patient login | **Rejected.** Better principle — the *patient's* action renews it, not the doctor's, closing the free-renewal loophole. But the exposure window was only as tight as the patient's own login habits: daily use = tight window, monthly use = an old code stays live for weeks. |
| v3 | One code. Single-use. 3-minute hard expiry. | **Adopted.** Generated fresh in the mobile app every login. Dead the instant it's used, or after 3 minutes regardless — whichever comes first. No behavior-dependence, no free renewal by the requester. Only the patient's own action ever produces a valid code, and a valid code is barely alive long enough to be read aloud. |

### The one-time code, in practice

A patient opens the mobile app, sees the current code, and tells or shows it to the doctor
in front of them — the same gesture as reciting today's static code, just no longer
dangerous if someone overhears it or it's written on a chit of paper. It covers walk-ins,
first visits, anyone with no standing relationship yet.

**Decided — redemption scope & duration:** redeeming the code grants **read and write
together**, for a flat **one hour** from the moment it's redeemed — separate from the code's
own 3-minute shelf life, which only governs how long it waits to be used. A visit that runs
longer, or a doctor who needs to come back to it later, needs a fresh code from the patient
— or the relationship graduates to Trusted.

### Trusted doctors — the standing relationship

For a GP or regular specialist, asking for a fresh code every visit is friction nobody
wants. A patient can mark a specific doctor **Trusted** from within the app. A trusted
doctor has full read and write access with no code needed, for as long as the patient
allows it.

- **Patient-initiated only.** A doctor cannot request trust, and cannot self-grant it. The
  patient has to proactively find and add them.
- **Unlimited duration, revoked anytime.** No automatic expiry — a single tap on the
  patient's "manage access" list ends it.

> **Known trade-off, accepted:** because trust is strictly patient-initiated, a referral —
> a GP sending a patient to a specialist they've never met — doesn't get standing access
> set up in advance. The specialist falls back to the one-time code at the first actual
> visit, and the patient can promote them to trusted afterward if the relationship
> continues. A deliberate simplicity trade, not an oversight.

### Finding the patient on a return visit

Trust removes the need for *authorization* on each visit, but not the need to *locate* the
right chart — the single-code redesign removed the old standalone lookup identifier, so
trust needs its own answer here. Two paths, either usable, neither mandatory:

- **The patient shares the live one-time code, same as always.** The doctor redeems it and
  lands directly on the right chart. For a trusted doctor this is pure navigation, not a
  fresh grant — their standing access already covers everything the code would otherwise
  unlock, so redeeming one doesn't add anything or start some separate one-hour window.
- **Or the doctor searches their own "my patients" roster by name** — a list populated
  automatically by who currently trusts them, no code exchange needed at all. Useful when
  the doctor already recognizes a regular patient and there's nothing to ask them for.

Two things worth building into the roster from the start: entries need something beyond a
name to disambiguate ("John Smith" isn't unique) — date of birth or a masked phone number
alongside it — and the list has to reflect live trust exactly, so a revoked patient
disappears from it immediately rather than lingering grayed out.

### Verified × Trusted — two axes, not one

It's tempting to collapse these into a single "how much do I trust this doctor" dial. They
answer different questions and should stay separate: verification is the platform's claim
about the doctor's real-world license; trust is this specific patient's choice about
standing access. A patient can trust a doctor the platform hasn't verified yet — and often
will, since verification isn't even built for v1.

| | Trusted | Not trusted |
|---|---|---|
| **Verified** | Full standing access. Read and write, no expiry, entries carry no flag. | Ad-hoc only. One-time code per visit; identity is confirmed, but no standing relationship yet. |
| **Unverified** | Full standing access, flagged. The patient's trust decision stands regardless — but entries still carry the unverified tag, since that's a platform fact, not a patient one. | Ad-hoc only, flagged. The default state for any new, unverified doctor with no relationship yet. |

## 6. Read access & revocation

Standing read access, once granted, doesn't expire on its own — which means the
mobile-only screen where a patient sees and revokes it is quietly the most important piece
of UI in the entire read-side model.

Nothing else bounds a trust grant over time. Not a timer, not a policy — just whether the
patient goes and looks, and whether revoking is a single obvious tap when they do. This
screen isn't a settings-page afterthought; it's load-bearing.

**Decided — revocation timing:** revoking isn't instant against an already-open session. It
takes effect the next time something loads — the next page view, the next app open — not
mid-session. Simpler to build than pushing a live kill signal into an active session, and a
reasonable bar for v1.

## 7. Transparency, without the noise

No push notification on every view. That's a considered choice, not a shortcut.

In the old bearer-code design, a notification on every access was doing real work — it was
the only thing that ever told the patient a stranger had their code. Here, that awareness
happens earlier instead: the patient consciously swiped to trust this doctor, or handed
over a code they generated themselves seconds ago.

**Deferred:** a historical access-history log (who viewed or wrote, and when) was planned as
an additional, passive transparency layer on top of that — but it's cut from v1 to keep the
build simple, and picked up in a later version (§ 10). For now, transparency lives entirely
in the grant itself: a patient knows who has access because they're the one who granted it,
and can check the current state — not the history — any time on the manage-access screen
(§ 6).

## 8. Patient recourse against a bad entry

**Considered, then set aside** — the mechanism it was protecting against no longer has a
realistic way in.

Hide-or-flag existed to give patients a way to act on an illegitimate entry from a doctor
with no real relationship to them — exactly the risk a leaked or stale code created. With
redemption now single-use, three minutes to live, and only ever handed over in person, that
path is effectively closed: an ad-hoc write can only come from whoever the patient is
physically standing in front of at that moment. A dedicated recourse tool doesn't add
protection against a threat that no longer has a way in.

The one write path without a live, in-person check is a **Trusted** doctor, who can write
from anywhere, anytime, by design. That's already governed by revoking trust (§ 6) rather
than needing its own tool — the underlying issue there is a relationship decision, not an
unauthorized write.

## 9. Why this holds up without any single perfect lock

No one mechanism here is airtight alone against a determined bad actor. Together, they're a
defensible bar for a v1 — and each one is honest about what it actually does.

1. **Scarcity** — One-time, three minutes, only the patient can ever mint a valid one.
   Minimizes the odds of an illegitimate redemption happening at all.
2. **Trust signal** — The unverified tag tells anyone reading the record how much weight to
   give an entry, before real verification exists to gate writing outright.

> **Known gap, accepted for v1:** with the access-history log deferred (§ 7), a Trusted
> doctor's activity between being granted and being revoked leaves no audit trail inside the
> app. The only real check on that relationship is the revoke button itself — which is part
> of why trust being just as easy to revoke as it is to grant matters more than it otherwise
> would.

## 10. Deferred to later, not designed away

None of these need the current architecture reworked to add later — they're extensions, not
corrections.

- **CNIC linking for emergencies.** A future path lets a verified doctor pull a record via
  the patient's CNIC in a true emergency, bypassing the normal code/trust flow — and
  specifically because it bypasses the patient's usual moment of awareness, this is the one
  case where an automatic notification still earns its keep.
- **Verification gates writing.** Eventually, only verified doctors can write at all, and
  the unverified tier disappears rather than growing forever.
- **Doctor MFA.** A compromised doctor account exposes every patient who's trusted them; a
  compromised patient account exposes one. That asymmetry is a real argument for stronger
  auth on the doctor side specifically — but v1 keeps auth simple for both roles, and adds
  this once there's a reason to.
- **Access-history log.** Who viewed or wrote, and when, as a passive screen the patient can
  check on their own terms — designed in § 7, cut from v1 to keep the build simple, picked
  up once the core mechanism is proven out.
- **Appointment booking.** A genuinely good, separate feature — book a doctor online.
  Sequenced after the access model ships and holds up, not bundled into the same release.
  Nice side effect: patients who use it open the app more, which keeps their live codes
  easier to get to when a doctor actually needs one.

## 11. Explicitly out of scope

Carried over from the earlier, national-scale version of this conversation and consciously
left out here — right for a government system, overkill for what two people can ship.

~~CNIC as the primary identifier~~ · ~~NADRA biometric auth~~ · ~~PMDC verification API~~ ·
~~Federated provincial architecture~~ · ~~HL7 FHIR / SMART-on-FHIR~~ ·
~~Break-the-glass override~~ · ~~Mandatory reason-for-access~~ ·
~~Hash-chained audit log~~ · ~~Patient-held encryption keys~~

Patient-held keys specifically were rejected twice, at two different scales, for the same
reason: they break on key loss and break exactly when emergency access matters most. Policy
enforcement belongs server-side; integrity belongs in the audit trail, not in a key only the
patient can lose.

## 12. Open questions

None outstanding as of this update — the design's access model is fully decided. New
questions will surface once implementation starts; add them here rather than letting them
live only in chat.

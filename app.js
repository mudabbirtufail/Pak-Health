(function(){
  "use strict";

  // ---------- helpers ----------
  function $(id){ return document.getElementById(id); }

  // A "How it works" modal that slides between step slides one at a time via
  // Back/Next arrows, reused for both the patient and doctor account menus (same
  // mechanism, different step markup and DOM ids since each role's modal lives
  // inside its own view). The slides themselves are static HTML side-by-side inside
  // `ids.track`; stepping just translates the track — content isn't injected by JS.
  var STEPPER_NEXT_ICON = '<svg width="13" height="13" viewBox="0 0 16 16"><path d="M6,2 L12,8 L6,14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var STEPPER_DONE_ICON = '<svg width="13" height="13" viewBox="0 0 16 16"><path d="M3,8 L7,12 L13,4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function makeStepperModal(ids){
    var idx = 0;
    var total = 0;
    function render(){
      $(ids.track).style.transform = 'translateX(-' + (idx * 100) + '%)';
      $(ids.counter).textContent = 'Step ' + (idx + 1) + ' of ' + total;
      $(ids.back).disabled = idx === 0;
      var last = idx === total - 1;
      $(ids.next).innerHTML = last ? STEPPER_DONE_ICON : STEPPER_NEXT_ICON;
      $(ids.next).setAttribute('aria-label', last ? 'Done' : 'Next');
    }
    function open(){
      total = $(ids.track).children.length;
      idx = 0;
      render();
      $(ids.modal).classList.remove('hidden');
    }
    function close(){ $(ids.modal).classList.add('hidden'); }
    $(ids.next).addEventListener('click', function(){
      if (idx === total - 1){ close(); return; }
      idx++; render();
    });
    $(ids.back).addEventListener('click', function(){ if (idx > 0){ idx--; render(); } });
    $(ids.close).addEventListener('click', close);
    $(ids.modal).addEventListener('click', function(e){ if (e.target === $(ids.modal)) close(); });
    return { open: open, close: close };
  }
  // Every "screen" here is just a div toggled hidden/visible — there's no real
  // browser navigation, so without this the back/forward buttons would leave the
  // app entirely instead of moving between views. showView() mirrors each switch
  // into history (hash-only, no server routes to match) so back/forward works, while
  // popstate below re-applies the view without re-pushing (avoiding a push loop) and
  // bounces to the landing page if the target needs a session that no longer exists
  // (e.g. back after signing out).
  var suppressHistoryPush = false;
  // Fades the just-unhidden view in from opacity 0 rather than the instant
  // hide/show cut every other view transition used to be. The "add .hidden
  // to everything, un-hide the target" swap itself stays exactly as instant
  // as before (so nothing that reads the DOM right after showView() returns
  // sees a mid-transition state) — this only animates the target's opacity
  // afterward. Both classes are no-ops (see .view-fade/.view-fade-in in
  // style.css) unless the browser is under the no-preference branch of
  // prefers-reduced-motion, same convention the pulse-divider draw-in
  // animation already uses elsewhere in this file. Needs a forced reflow
  // (void el.offsetWidth) between adding the opacity:0 starting class and
  // the opacity:1 transitioning class, in its own animation frame — setting
  // both in the same tick lets the browser coalesce them into one frame with
  // nothing to transition from, so it'd just snap straight to visible.
  function fadeInView(el){
    el.classList.add('view-fade');
    el.classList.remove('view-fade-in');
    void el.offsetWidth;
    requestAnimationFrame(function(){
      el.classList.add('view-fade-in');
      el.classList.remove('view-fade');
    });
  }
  function showView(id){
    document.querySelectorAll('.view').forEach(function(v){ v.classList.add('hidden'); });
    var targetView = $(id);
    targetView.classList.remove('hidden');
    fadeInView(targetView);
    window.scrollTo(0,0);
    // Landing back on the doctor dashboard (from a patient record, or via browser
    // back/forward) re-pulls this doctor's appointments so a patient's new booking
    // shows up without needing a full reload — see refreshDoctorAppointments().
    if (id === 'view-doctor-dash') refreshDoctorAppointments();
    // The blood-pressure chart is drawn at the width it actually has on screen, which
    // is only known once its page is showing.
    if (id === 'view-patient-bp') renderBpChart();
    // Keep the "Individual account"/"Viewing: X" indicator on screen across
    // every patient page, not just the dashboard — see placeFamilyIndicator().
    if (session && session.type === 'patient' && PATIENT_ONLY_VIEWS.indexOf(id) !== -1) placeFamilyIndicator(id);
    if (suppressHistoryPush) return;
    if (!history.state){
      history.replaceState({ view: id }, '', '#' + id);
    } else if (history.state.view !== id){
      history.pushState({ view: id }, '', '#' + id);
    }
  }
  var PATIENT_ONLY_VIEWS = ['view-patient-dash','view-record-visits','view-record-tests','view-record-prescriptions','view-patient-eyes','view-patient-bp','view-pat-profile','view-pat-account-settings','view-pat-stats','view-pat-book-appt'];
  var DOCTOR_ONLY_VIEWS = ['view-doctor-dash', 'view-doctor-record', 'view-doc-profile', 'view-doc-account-settings', 'view-doc-clinics', 'view-doc-stats'];
  window.addEventListener('popstate', function(e){
    var requested = (e.state && e.state.view) || 'view-landing';
    var id = requested;
    if (!$(id)) id = 'view-landing';
    if (PATIENT_ONLY_VIEWS.indexOf(id) !== -1 && (!session || session.type !== 'patient')) id = 'view-landing';
    if (DOCTOR_ONLY_VIEWS.indexOf(id) !== -1 && (!session || session.type !== 'doctor')) id = 'view-landing';
    suppressHistoryPush = true;
    showView(id);
    suppressHistoryPush = false;
    if (id !== requested) history.replaceState({ view: id }, '', '#' + id);
  });
  function randomDigits(n){
    var s = '';
    for (var i=0;i<n;i++) s += Math.floor(Math.random()*10);
    return s;
  }

  // ---------- Supabase (real backend — required, not a fallback) ----------
  // This app now holds real pilot patient/doctor data (see CLAUDE.md), so there is
  // no in-memory or window.storage fallback the way the earlier demo had — if this
  // client can't be created or reach the project, the app shows a clear error
  // instead of silently pretending to work. See supabase/schema.sql for the tables,
  // RLS policies, and RPC functions this client talks to.
  var SUPABASE_URL = 'https://siywcdmewzayoqzmuekb.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpeXdjZG1ld3pheW9xem11ZWtiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNDgyMDgsImV4cCI6MjEwMzgyNDIwOH0.rBEfjbVYF14bFRQJ8Lxw_WN-HSWjxbByBf_0zzXBNDA';
  var supabaseClient = null;
  try{
    if (window.supabase) supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }catch(e){}
  if (!supabaseClient){
    document.addEventListener('DOMContentLoaded', function(){
      document.body.innerHTML = '<div style="max-width:416px;margin:64px auto;padding:19px;font-family:sans-serif;text-align:center;">'
        + '<h2>Can’t connect</h2><p>Pak Health couldn’t reach its backend. Please reload the page, or contact support if this keeps happening.</p></div>';
    });
    return;
  }

  // Landing on this page from a password-reset email's link makes the client
  // consume that link's token and establish a session automatically — this event
  // is how Supabase distinguishes that from an ordinary sign-in, so it's the only
  // reliable signal to show "Set a new password" instead of just dropping the
  // visitor into their dashboard as if they'd signed in normally. Registered here,
  // synchronously right after the client is created, so the subscription is in
  // place before the client's own internal URL-token processing can fire it —
  // bootstrap() below (which awaits getSession()) is guaranteed to run after this,
  // since getSession() itself waits on that same internal initialization.
  var awaitingPasswordRecovery = false;
  supabaseClient.auth.onAuthStateChange(function(event){
    if (event === 'PASSWORD_RECOVERY'){
      awaitingPasswordRecovery = true;
      $('set-new-password').value = '';
      $('set-new-password-confirm').value = '';
      clearError($('set-new-password-error'));
      suppressHistoryPush = true;
      showView('view-set-new-password');
      suppressHistoryPush = false;
    }
  });

  function timeOfDayGreetingUrdu(){
    var h = new Date().getHours();
    if (h < 12) return 'صبح بخیر';
    if (h < 17) return 'دوپہر بخیر';
    return 'شام بخیر';
  }
  // The welcome screen (#view-welcome) shown right after a successful sign-in or
  // sign-up, while enterPatientDash()/enterDoctorDash() load the dashboard's
  // data. Those functions finish by calling showView() for the dashboard the
  // moment their data is ready — which on a fast connection would cut the
  // greeting off almost instantly — so they first await waitForWelcome(),
  // which holds until WELCOME_MIN_MS after startWelcome() was called. With no
  // startWelcome() pending (family switching, reloads), welcomeUntil is 0 and
  // waitForWelcome() returns immediately.
  var WELCOME_MIN_MS = 2200;
  var welcomeUntil = 0;
  function startWelcome(){
    $('welcome-greeting-main').textContent = timeOfDayGreetingUrdu();
    welcomeUntil = Date.now() + WELCOME_MIN_MS;
    // No history entry — back/forward must never land on the welcome screen.
    suppressHistoryPush = true;
    showView('view-welcome');
    suppressHistoryPush = false;
  }
  async function waitForWelcome(){
    var remaining = welcomeUntil - Date.now();
    welcomeUntil = 0;
    if (remaining > 0) await new Promise(function(resolve){ setTimeout(resolve, remaining); });
  }
  function isDoctorVerified(d){ return !!(d && d.verified); }
  function maskPhone(phone){
    if (!phone) return 'No phone on file';
    var digits = phone.replace(/\D/g, '');
    if (digits.length < 4) return phone;
    return '••• ' + digits.slice(-4);
  }
  async function getAuthUser(){
    var res = await supabaseClient.auth.getUser();
    return res.data && res.data.user;
  }
  function authErrorMessage(error, fallback){
    var msg = (error && error.message) || '';
    if (/email not confirmed/i.test(msg)) return 'Please confirm your email before signing in — check your inbox for the confirmation link.';
    if (/invalid login credentials/i.test(msg)) return 'Incorrect email or password.';
    return msg || fallback || 'Something went wrong. Please try again.';
  }

  // ---------- Data mapping (DB snake_case rows -> the camelCase shape the rest of
  // this file's rendering code already expects) ----------
  function mapPatientRow(row){
    return {
      id: row.id, code: row.code, name: row.name || '', dob: row.dob || '', gender: row.gender || '',
      phone: row.phone || '', photoUrl: row.photo_url || '', bloodType: row.blood_type || '',
      emergencyContact: row.emergency_contact || '', allergies: row.allergies || '',
      conditions: row.conditions || '', medications: row.medications || '',
      isDependent: !!row.is_dependent
    };
  }
  // Clinics used to be plain name strings; now each is {name, address}. Existing
  // rows saved before this change still come back as bare strings, so every read
  // normalizes through here instead of the DB needing a migration.
  function normalizeClinic(c){
    return typeof c === 'string'
      ? { name: c, address: '', phone: '', note: '' }
      : { name: c.name || '', address: c.address || '', phone: c.phone || '', note: c.note || '' };
  }
  function mapDoctorRow(row){
    return {
      id: row.id, doctorId: row.doctor_code, name: row.name || '', dob: row.dob || '', gender: row.gender || '',
      phone: row.phone || '', photoUrl: row.photo_url || '', license: row.license || '', specialty: row.specialty || '',
      education: row.education || '', about: row.about || '', verified: !!row.verified,
      clinics: (row.clinics || []).map(normalizeClinic), currentClinic: row.current_clinic || ''
    };
  }
  function mapVisitRow(row){
    return {
      id: row.id, doctorName: row.doctor_name || '', clinicName: row.clinic_name || '', date: row.date,
      time: row.time || '', symptoms: row.symptoms || '', diagnosis: row.diagnosis || '', prescription: row.prescription || '',
      notes: row.notes || '', writtenViaGrantId: row.written_via_grant_id, unverified: !!row.unverified
    };
  }
  function mapTestRow(row){
    return {
      id: row.id, name: row.name || '', date: row.date, doctorName: row.doctor_name || '',
      resultSummary: row.result_summary || '', writtenViaGrantId: row.written_via_grant_id, unverified: !!row.unverified,
      reportFilePath: row.report_file_path || '', uploadedByPatient: !!row.uploaded_by_patient
    };
  }
  function mapEyeRow(row){
    return { id: row.id, date: row.date, sphL: row.sph_l || '', cylL: row.cyl_l || '', axisL: row.axis_l || '', sphR: row.sph_r || '', cylR: row.cyl_r || '', axisR: row.axis_r || '' };
  }
  function mapAppointmentRow(row){
    return { id: row.id, doctorId: row.doctor_id || null, patientId: row.patient_id || null, doctorName: row.doctor_name || '', clinicName: row.clinic_name || '', clinicAddress: row.clinic_address || '', date: row.date, time: row.time || '', reason: row.reason || '' };
  }

  async function loadPatientProfile(id){
    var res = await supabaseClient.from('patients').select('*').eq('id', id).maybeSingle();
    return res.data ? mapPatientRow(res.data) : null;
  }
  async function loadDoctorProfile(id){
    var res = await supabaseClient.from('doctors').select('*').eq('id', id).maybeSingle();
    return res.data ? mapDoctorRow(res.data) : null;
  }
  async function loadPatientRecordForDoctor(patientId){
    // Fired together instead of one-after-another — three sequential round trips
    // to Supabase was the main source of lag when opening a patient's record.
    var results = await Promise.all([
      loadPatientProfile(patientId),
      supabaseClient.from('visits').select('*').eq('patient_id', patientId).order('date', { ascending:false }),
      supabaseClient.from('tests').select('*').eq('patient_id', patientId).order('date', { ascending:false })
    ]);
    var profile = results[0];
    if (!profile) return null;
    profile.visits = (results[1].data || []).map(mapVisitRow);
    profile.tests = (results[2].data || []).map(mapTestRow);
    return profile;
  }

  // ---------- Access grants (see ACCESS-MODEL.md) ----------
  // A doctor never gets standing access just by knowing a patient's permanent
  // account code. Access is either a single-use, 2-minute live code redeemed in
  // person (good for one hour from redemption) or a standing "Trusted" grant the
  // patient creates and can revoke any time. Both produce the same kind of row,
  // checked the same way — see the has_active_grant() predicate in
  // supabase/schema.sql, which is the real enforcement now (RLS), not this client
  // code. What's left here is just the client's own read/write access to the parts
  // RLS lets it touch, plus redeem_access_code() which is a server-side RPC because
  // a doctor's browser has no direct read access to access_codes at all.
  async function createAccessCode(patientId){
    var row = { patient_id: patientId, code: randomDigits(6), expires_at: new Date(Date.now() + 2*60*1000).toISOString() };
    var res = await supabaseClient.from('access_codes').insert(row).select().maybeSingle();
    return res.data || null;
  }
  function isGrantActive(g){
    if (!g || g.revoked_at) return false;
    if (!g.expires_at) return true;
    return new Date(g.expires_at).getTime() > Date.now();
  }
  async function getActiveGrant(patientId, doctorId){
    var res = await supabaseClient.from('access_grants').select('*')
      .eq('patient_id', patientId).eq('doctor_id', doctorId).is('revoked_at', null);
    var active = (res.data || []).filter(isGrantActive);
    if (!active.length) return null;
    active.sort(function(a,b){ return a.granted_via === 'trust' ? -1 : 1; });
    return active[0];
  }
  async function redeemAccessCode(code){
    var res = await supabaseClient.rpc('redeem_access_code', { p_code: code });
    if (res.error) return { ok:false, error: res.error };
    var row = res.data && res.data[0];
    if (!row) return { ok:false, error: null };
    return { ok:true, patientId: row.patient_id, patientName: row.patient_name, grantedVia: row.granted_via };
  }
  function mapRedeemErrorText(error){
    var msg = (error && error.message) || '';
    if (/code_expired/.test(msg)) return 'That code has expired — ask your patient to generate a new one.';
    if (/code_redeemed/.test(msg)) return 'That code has already been used — ask your patient for a new one.';
    return 'No active code found. Double-check it with your patient.';
  }
  // ---- Guardian-link code (family) — same shape as redeemAccessCode()/
  // mapRedeemErrorText() above, just for join_as_guardian() instead. ----
  async function joinAsGuardian(code){
    var res = await supabaseClient.rpc('join_as_guardian', { p_code: code });
    if (res.error) return { ok:false, error: res.error };
    var row = res.data && res.data[0];
    if (!row) return { ok:false, error: null };
    return { ok:true, dependentId: row.dependent_id, dependentName: row.dependent_name };
  }
  function mapGuardianLinkErrorText(error){
    var msg = (error && error.message) || '';
    if (/code_expired/.test(msg)) return 'That code has expired — ask them to generate a new one.';
    if (/code_redeemed/.test(msg)) return 'That code has already been used — ask them for a new one.';
    return 'No active code found. Double-check it with them.';
  }
  async function createGuardianLinkCode(dependentId){
    var row = { dependent_id: dependentId, code: randomDigits(6), expires_at: new Date(Date.now() + 60*1000).toISOString() };
    var res = await supabaseClient.from('guardian_link_codes').insert(row).select().maybeSingle();
    return res.data || null;
  }
  async function loadDependentsForGuardian(guardianId){
    var res = await supabaseClient.from('dependent_guardians').select('*, patients(*)').eq('guardian_id', guardianId);
    return (res.data || []).filter(function(r){ return r.patients; }).map(function(r){ return mapPatientRow(r.patients); });
  }
  async function revokeGrant(grantId){
    await supabaseClient.from('access_grants').update({ revoked_at: new Date().toISOString() }).eq('id', grantId);
  }
  async function createTrustGrant(patientId, doctorId){
    var existing = await getActiveGrant(patientId, doctorId);
    if (existing && !existing.expires_at) return existing;
    var res = await supabaseClient.from('access_grants').insert({ patient_id: patientId, doctor_id: doctorId, granted_via: 'trust' }).select().maybeSingle();
    if (res.error) throw res.error;
    return res.data;
  }
  async function listTrustedDoctorsForPatient(patientId){
    var res = await supabaseClient.from('access_grants').select('*, doctors(*)')
      .eq('patient_id', patientId).eq('granted_via', 'trust').is('revoked_at', null);
    return (res.data || []).map(function(g){
      var d = g.doctors || {};
      return { grant: g, doctor: { doctorId: d.doctor_code, name: d.name, phone: d.phone, verified: !!d.verified } };
    });
  }
  async function listActiveAdhocGrantsForPatient(patientId){
    var res = await supabaseClient.from('access_grants').select('*, doctors(*)')
      .eq('patient_id', patientId).eq('granted_via', 'code').is('revoked_at', null)
      .gt('expires_at', new Date().toISOString());
    return (res.data || []).map(function(g){
      var d = g.doctors || {};
      return { grant: g, doctor: { doctorId: d.doctor_code, name: d.name, phone: d.phone, verified: !!d.verified } };
    });
  }
  async function listTrustedPatientsForDoctor(doctorId){
    var res = await supabaseClient.from('access_grants').select('*, patients(*)')
      .eq('doctor_id', doctorId).eq('granted_via', 'trust').is('revoked_at', null);
    return (res.data || []).filter(function(g){ return g.patients; }).map(function(g){
      return { grant: g, patient: mapPatientRow(g.patients) };
    });
  }

  function showError(el, message){
    el.textContent = message;
    el.classList.add('show');
  }
  function clearError(el){
    el.textContent = '';
    el.classList.remove('show');
  }

  // Press-and-hold confirmation for irreversible actions (cancelling/booking an
  // appointment) — a plain click does nothing but a harmless blip; onComplete
  // only fires once the fill has visibly swept the whole button for holdMs.
  // Mouse and touch share the same start/cancel pair so it works on phones too.
  function makeHoldButton(el, holdMs, onComplete){
    var fillEl = el.querySelector('.hold-fill');
    var timer = null;
    function start(e){
      if (el.disabled || timer) return;
      el.classList.add('holding');
      // Reset to 0% with transitions off and force a reflow (reading
      // offsetWidth) before turning the transition back on — setting
      // `transition` and the new `width` in the same tick, with no commit of
      // the 0% state in between, lets the browser coalesce both into one
      // frame and jump straight to 100% instead of animating. This is what
      // made the fill look like it "didn't fill up" — the hold itself was
      // still correctly timed (the setTimeout below), only the visible sweep
      // wasn't.
      fillEl.style.transition = 'none';
      fillEl.style.width = '0%';
      void fillEl.offsetWidth;
      fillEl.style.transition = 'width ' + holdMs + 'ms linear';
      fillEl.style.width = '100%';
      timer = setTimeout(function(){
        timer = null;
        el.classList.remove('holding');
        fillEl.style.transition = 'none';
        fillEl.style.width = '0%';
        onComplete();
      }, holdMs);
    }
    function cancel(){
      if (timer){ clearTimeout(timer); timer = null; }
      el.classList.remove('holding');
      fillEl.style.transition = 'width 0.2s ease';
      fillEl.style.width = '0%';
    }
    el.addEventListener('mousedown', start);
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('mouseup', cancel);
    el.addEventListener('mouseleave', cancel);
    el.addEventListener('touchend', cancel);
    el.addEventListener('touchcancel', cancel);
    el.addEventListener('click', function(e){ e.preventDefault(); });
  }
  function renderVerifyBanner(prefix, email, confirmed){
    $(prefix + '-verify-banner').classList.toggle('hidden', !email || confirmed === true);
  }
  function copyToClipboard(text, noteEl){
    var done = function(){
      noteEl.textContent = 'Copied';
      setTimeout(function(){ noteEl.textContent = ''; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(done).catch(function(){
        noteEl.textContent = 'Copy failed — select and copy manually';
      });
    } else {
      noteEl.textContent = 'Copy not supported here';
    }
  }

  var session = { type: null, id: null };

  // ---------- landing ----------
  $('choice-individual').addEventListener('click', function(){
    resetPatientAuthView();
    showView('view-patient-auth');
  });
  $('choice-doctor').addEventListener('click', function(){
    resetDoctorAuthView();
    showView('view-doctor-auth');
  });
  document.querySelectorAll('[data-goto]').forEach(function(el){
    el.addEventListener('click', function(){ showView(el.getAttribute('data-goto')); });
  });

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // ================= DOCTOR AUTH =================
  function showDoctorAuthPane(pane){
    var signin = pane === 'signin';
    $('doc-signin-pane').classList.toggle('hidden', !signin);
    $('doc-signup-pane').classList.toggle('hidden', signin);
  }
  function resetDoctorAuthView(){
    showDoctorAuthPane('signin');
    $('doc-signin-email').value = '';
    $('doc-signin-password').value = '';
    clearError($('doc-signin-error'));
    $('doc-signup-first').value = '';
    $('doc-signup-middle').value = '';
    $('doc-signup-last').value = '';
    $('doc-signup-dob').value = '';
    $('doc-signup-gender').value = '';
    $('doc-signup-email').value = '';
    $('doc-signup-password').value = '';
    $('doc-signup-license').value = '';
    clearError($('doc-create-error'));
    $('doc-signup-checkemail').classList.add('hidden');
  }
  $('doc-goto-signup-btn').addEventListener('click', function(){ showDoctorAuthPane('signup'); });
  $('doc-back-to-signin-btn').addEventListener('click', function(){ showDoctorAuthPane('signin'); });
  $('doc-create-btn').addEventListener('click', async function(){
    var first = $('doc-signup-first').value.trim();
    var middle = $('doc-signup-middle').value.trim();
    var last = $('doc-signup-last').value.trim();
    var dob = $('doc-signup-dob').value;
    var gender = $('doc-signup-gender').value;
    var email = $('doc-signup-email').value.trim();
    var password = $('doc-signup-password').value;
    var license = $('doc-signup-license').value.trim();
    clearError($('doc-create-error'));
    $('doc-signup-checkemail').classList.add('hidden');
    if (!first || !last){ showError($('doc-create-error'), 'First and last name are required.'); return; }
    if (!dob){ showError($('doc-create-error'), 'Date of birth is required.'); return; }
    if (!gender){ showError($('doc-create-error'), 'Please select a gender.'); return; }
    if (!EMAIL_RE.test(email)){ showError($('doc-create-error'), 'Enter a valid email address.'); return; }
    if (!password || password.length < 6){ showError($('doc-create-error'), 'Password must be at least 6 characters.'); return; }
    var name = [first, middle, last].filter(Boolean).join(' ');
    $('doc-create-btn').disabled = true;
    $('doc-create-btn').textContent = 'Creating...';
    try{
      var res = await supabaseClient.auth.signUp({
        email: email, password: password,
        options: { data: { role: 'doctor', name: name, dob: dob, gender: gender, license: license } }
      });
      if (res.error){
        showError($('doc-create-error'), authErrorMessage(res.error, 'Something went wrong creating your account. Please try again.'));
        return;
      }
      if (res.data.user && res.data.user.identities && res.data.user.identities.length === 0){
        showError($('doc-create-error'), 'An account with that email already exists.');
        return;
      }
      if (res.data.session){
        session = { type:'doctor', id:res.data.user.id };
        startWelcome();
        await enterDoctorDash(res.data.user.id);
      } else {
        $('doc-signup-checkemail-addr').textContent = email;
        $('doc-signup-checkemail').classList.remove('hidden');
      }
    }catch(e){
      showError($('doc-create-error'), 'Something went wrong creating your account. Please try again.');
    }finally{
      $('doc-create-btn').disabled = false;
      $('doc-create-btn').textContent = 'Submit';
    }
  });
  $('doc-signin-btn').addEventListener('click', async function(){
    var email = $('doc-signin-email').value.trim();
    var password = $('doc-signin-password').value;
    clearError($('doc-signin-error'));
    $('doc-signin-btn').disabled = true;
    try{
      var res = await supabaseClient.auth.signInWithPassword({ email: email, password: password });
      if (res.error){
        showError($('doc-signin-error'), authErrorMessage(res.error));
        return;
      }
      session = { type:'doctor', id:res.data.user.id };
      startWelcome();
      await enterDoctorDash(res.data.user.id);
    }finally{
      $('doc-signin-btn').disabled = false;
    }
  });
  $('doc-signin-password').addEventListener('keydown', function(e){
    if (e.key === 'Enter') $('doc-signin-btn').click();
  });
  $('doc-forgot-btn').addEventListener('click', function(){
    $('doc-forgot-form').classList.remove('hidden');
    $('doc-forgot-sent-note').classList.add('hidden');
    $('doc-forgot-email').value = '';
    clearError($('doc-forgot-error'));
    $('doc-forgot-modal').classList.remove('hidden');
  });
  function closeDocForgotModal(){ $('doc-forgot-modal').classList.add('hidden'); }
  $('doc-forgot-close').addEventListener('click', closeDocForgotModal);
  $('doc-forgot-ok').addEventListener('click', closeDocForgotModal);
  $('doc-forgot-modal').addEventListener('click', function(e){ if (e.target === $('doc-forgot-modal')) closeDocForgotModal(); });
  $('doc-forgot-send-btn').addEventListener('click', async function(){
    var email = $('doc-forgot-email').value.trim();
    clearError($('doc-forgot-error'));
    if (!EMAIL_RE.test(email)){ showError($('doc-forgot-error'), 'Enter a valid email address.'); return; }
    $('doc-forgot-send-btn').disabled = true;
    try{
      var res = await supabaseClient.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + window.location.pathname
      });
      if (res.error){
        showError($('doc-forgot-error'), authErrorMessage(res.error, 'Something went wrong. Please try again.'));
        return;
      }
      $('doc-forgot-sent-addr').textContent = email;
      $('doc-forgot-form').classList.add('hidden');
      $('doc-forgot-sent-note').classList.remove('hidden');
    }finally{
      $('doc-forgot-send-btn').disabled = false;
    }
  });
  $('doc-forgot-email').addEventListener('keydown', function(e){
    if (e.key === 'Enter') $('doc-forgot-send-btn').click();
  });

  // ================= PATIENT AUTH =================
  function showPatientAuthPane(pane){
    var signin = pane === 'signin';
    $('pat-signin-pane').classList.toggle('hidden', !signin);
    $('pat-signup-pane').classList.toggle('hidden', signin);
  }
  function resetPatientAuthView(){
    showPatientAuthPane('signin');
    $('pat-signin-email').value = '';
    $('pat-signin-password').value = '';
    clearError($('pat-signin-error'));
    $('pat-signup-first').value = '';
    $('pat-signup-middle').value = '';
    $('pat-signup-last').value = '';
    $('pat-signup-dob').value = '';
    $('pat-signup-gender').value = '';
    $('pat-signup-email').value = '';
    $('pat-signup-password').value = '';
    clearError($('pat-create-error'));
    $('pat-signup-checkemail').classList.add('hidden');
  }
  $('pat-goto-signup-btn').addEventListener('click', function(){ showPatientAuthPane('signup'); });
  $('pat-back-to-signin-btn').addEventListener('click', function(){ showPatientAuthPane('signin'); });
  $('pat-create-btn').addEventListener('click', async function(){
    var first = $('pat-signup-first').value.trim();
    var middle = $('pat-signup-middle').value.trim();
    var last = $('pat-signup-last').value.trim();
    var dob = $('pat-signup-dob').value;
    var gender = $('pat-signup-gender').value;
    var email = $('pat-signup-email').value.trim();
    var password = $('pat-signup-password').value;
    clearError($('pat-create-error'));
    $('pat-signup-checkemail').classList.add('hidden');
    if (!first || !last){ showError($('pat-create-error'), 'First and last name are required.'); return; }
    if (!dob){ showError($('pat-create-error'), 'Date of birth is required.'); return; }
    if (!gender){ showError($('pat-create-error'), 'Please select a gender.'); return; }
    if (!EMAIL_RE.test(email)){ showError($('pat-create-error'), 'Enter a valid email address.'); return; }
    if (!password || password.length < 6){ showError($('pat-create-error'), 'Password must be at least 6 characters.'); return; }
    var name = [first, middle, last].filter(Boolean).join(' ');
    $('pat-create-btn').disabled = true;
    $('pat-create-btn').textContent = 'Creating...';
    try{
      var res = await supabaseClient.auth.signUp({
        email: email, password: password,
        options: { data: { role: 'patient', name: name, dob: dob, gender: gender } }
      });
      if (res.error){
        showError($('pat-create-error'), authErrorMessage(res.error, 'Something went wrong creating your account. Please try again.'));
        return;
      }
      if (res.data.user && res.data.user.identities && res.data.user.identities.length === 0){
        showError($('pat-create-error'), 'An account with that email already exists.');
        return;
      }
      if (res.data.session){
        session = { type:'patient', id:res.data.user.id };
        startWelcome();
        await enterPatientDash(res.data.user.id);
      } else {
        $('pat-signup-checkemail-addr').textContent = email;
        $('pat-signup-checkemail').classList.remove('hidden');
      }
    }catch(e){
      showError($('pat-create-error'), 'Something went wrong creating your account. Please try again.');
    }finally{
      $('pat-create-btn').disabled = false;
      $('pat-create-btn').textContent = 'Submit';
    }
  });
  $('pat-signin-btn').addEventListener('click', async function(){
    var email = $('pat-signin-email').value.trim();
    var password = $('pat-signin-password').value;
    clearError($('pat-signin-error'));
    $('pat-signin-btn').disabled = true;
    try{
      var res = await supabaseClient.auth.signInWithPassword({ email: email, password: password });
      if (res.error){
        showError($('pat-signin-error'), authErrorMessage(res.error));
        return;
      }
      session = { type:'patient', id:res.data.user.id };
      startWelcome();
      await enterPatientDash(res.data.user.id);
    }finally{
      $('pat-signin-btn').disabled = false;
    }
  });
  $('pat-signin-password').addEventListener('keydown', function(e){
    if (e.key === 'Enter') $('pat-signin-btn').click();
  });
  $('pat-forgot-btn').addEventListener('click', function(){
    $('pat-forgot-form').classList.remove('hidden');
    $('pat-forgot-sent-note').classList.add('hidden');
    $('pat-forgot-email').value = '';
    clearError($('pat-forgot-error'));
    $('pat-forgot-modal').classList.remove('hidden');
  });
  function closePatForgotModal(){ $('pat-forgot-modal').classList.add('hidden'); }
  $('pat-forgot-close').addEventListener('click', closePatForgotModal);
  $('pat-forgot-ok').addEventListener('click', closePatForgotModal);
  $('pat-forgot-modal').addEventListener('click', function(e){ if (e.target === $('pat-forgot-modal')) closePatForgotModal(); });
  $('pat-forgot-send-btn').addEventListener('click', async function(){
    var email = $('pat-forgot-email').value.trim();
    clearError($('pat-forgot-error'));
    if (!EMAIL_RE.test(email)){ showError($('pat-forgot-error'), 'Enter a valid email address.'); return; }
    $('pat-forgot-send-btn').disabled = true;
    try{
      var res = await supabaseClient.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + window.location.pathname
      });
      if (res.error){
        showError($('pat-forgot-error'), authErrorMessage(res.error, 'Something went wrong. Please try again.'));
        return;
      }
      $('pat-forgot-sent-addr').textContent = email;
      $('pat-forgot-form').classList.add('hidden');
      $('pat-forgot-sent-note').classList.remove('hidden');
    }finally{
      $('pat-forgot-send-btn').disabled = false;
    }
  });
  $('pat-forgot-email').addEventListener('keydown', function(e){
    if (e.key === 'Enter') $('pat-forgot-send-btn').click();
  });

  // ================= PATIENT DASHBOARD =================
  var currentPatientData = null;
  var calViewDate = new Date();
  // Which patients.id the dashboard is currently showing — normally the signed-in
  // guardian's own id, but the family switcher can point this at a dependent's id
  // instead. Every patient-context write (live code, trust grants, appointments,
  // profile/settings saves) reads this instead of session.id directly, so the same
  // dashboard/functions work unmodified regardless of which profile is active.
  // session.id itself never changes here — it's still the real signed-in account.
  var activePatientId = null;

  function getInitials(name){
    if (!name || !name.trim()) return '?';
    var parts = name.trim().split(/\s+/);
    var initials = parts.slice(0, 2).map(function(p){ return p[0] ? p[0].toUpperCase() : ''; }).join('');
    return initials || '?';
  }
  function renderHealthCard(data){
    $('card-name').textContent = data.name || 'Unnamed patient';
    if (data.photoUrl){
      $('pat-avatar-img').src = data.photoUrl;
      $('pat-avatar-img').classList.remove('hidden');
      $('pat-avatar-fallback').classList.add('hidden');
    } else {
      $('pat-avatar-img').classList.add('hidden');
      $('pat-avatar-fallback').classList.remove('hidden');
      $('pat-avatar-fallback').textContent = getInitials(data.name);
    }
  }

  async function enterPatientDash(id){
    var data = await loadPatientProfile(id);
    if (!data){
      // profile row missing is unexpected (the signup trigger should have created
      // it) — bail out to landing rather than show a broken dashboard. (This can't
      // happen for a dependent lookup gone wrong — see the switcher/guard below —
      // only for the guardian's own row.)
      session = { type:null, id:null };
      showView('view-landing');
      return;
    }
    activePatientId = id;
    var authUser = await getAuthUser();
    // getAuthUser() can transiently come back null (seen in testing after a 403
    // from Supabase's auth endpoint under rapid repeated calls) — one retry covers
    // that without ever leaving authUser.email/email_confirmed_at reads below to
    // throw and strand the dashboard mid-switch on the previous profile.
    if (!authUser){
      authUser = await getAuthUser();
    }
    if (!authUser){
      console.warn('enterPatientDash: getAuthUser() returned null twice, proceeding without it');
      authUser = { email: null, email_confirmed_at: null };
    }
    // A dependent has no login/email of their own — only attach the real signed-in
    // email when we're actually looking at that same account's own row, so Account
    // settings never shows (or, worse, lets someone edit-and-save) the guardian's
    // own login email while viewing a dependent's profile.
    data.email = (id === session.id) ? authUser.email : '';
    var visitsRes = await supabaseClient.from('visits').select('*').eq('patient_id', id).order('date', { ascending:false });
    var testsRes = await supabaseClient.from('tests').select('*').eq('patient_id', id).order('date', { ascending:false });
    var eyesRes = await supabaseClient.from('eye_entries').select('*').eq('patient_id', id).order('date', { ascending:false });
    var apptsRes = await supabaseClient.from('appointments').select('*').eq('patient_id', id).order('date', { ascending:true });
    var bpRes = await supabaseClient.from('bp_entries').select('*').eq('patient_id', id).order('measured_at', { ascending:false });
    if (bpRes.error) console.warn('Could not load blood pressure readings:', bpRes.error.message);
    data.visits = (visitsRes.data || []).map(mapVisitRow);
    data.tests = (testsRes.data || []).map(mapTestRow);
    data.eyeEntries = (eyesRes.data || []).map(mapEyeRow);
    data.bpEntries = (bpRes.data || []).map(mapBpRow);
    data.appointments = (apptsRes.data || []).map(mapAppointmentRow);
    currentPatientData = data;
    renderHealthCard(data);
    // Still about the real signed-in account's own email, unrelated to which
    // profile is currently active — stays keyed to authUser regardless.
    renderVerifyBanner('pat', authUser.email, !!authUser.email_confirmed_at);
    renderVisitsList(data.visits);
    renderTestsList(data.tests);
    renderPrescriptionsList(data.visits);
    renderEyesList(data.eyeEntries);
    renderBpPage(data.bpEntries);
    calViewDate = new Date();
    renderAppointmentsCalendar(data.appointments);
    renderAppointmentsList(data.appointments);
    closeAddEyeModal();
    closeEyeRxPrevModal();
    closeAddBpModal();
    closePatAccessModal();
    closePatApptDetailModal();
    closePatFamilyModal();
    closePatAcctDropdown();
    patHowItWorks.close();
    await regenerateLiveCode();
    await renderFamilySwitcher();
    await waitForWelcome();
    showView('view-patient-dash');
    syncStickyColumnHeights();
  }

  // ---- Live access code (patient side) ----
  // Generated automatically the moment the patient reaches their dashboard — no
  // button. The ring around it drains over the code's 2-minute life; when it runs
  // out this tab quietly mints a fresh one, so there's always a live code on screen
  // to hand to a doctor without the patient having to do anything.
  var LIVE_CODE_SECONDS = 120;
  var RING_R = 21;
  var RING_C = 2 * Math.PI * RING_R;
  var liveCodeTimer = null;
  var liveCodeGenerating = false;
  function stopLiveCodeTimer(){
    if (liveCodeTimer){ clearInterval(liveCodeTimer); liveCodeTimer = null; }
  }
  function setLiveCodeRing(elapsedFraction){
    var ringEl = $('pat-live-code-ring');
    ringEl.style.strokeDasharray = RING_C;
    ringEl.style.strokeDashoffset = RING_C * Math.max(0, Math.min(1, elapsedFraction));
  }
  function renderLiveCodeState(row){
    stopLiveCodeTimer();
    var codeEl = $('pat-live-code');
    function tick(){
      if (!row){ codeEl.textContent = '— — — — — —'; setLiveCodeRing(0); return; }
      var msLeft = new Date(row.expires_at).getTime() - Date.now();
      if (msLeft <= 0){
        stopLiveCodeTimer();
        regenerateLiveCode();
        return;
      }
      codeEl.textContent = row.code.slice(0,3) + ' ' + row.code.slice(3);
      setLiveCodeRing(1 - (msLeft / (LIVE_CODE_SECONDS * 1000)));
    }
    tick();
    liveCodeTimer = setInterval(tick, 1000);
  }
  async function regenerateLiveCode(){
    if (liveCodeGenerating) return;
    liveCodeGenerating = true;
    try{
      var row = await createAccessCode(activePatientId);
      renderLiveCodeState(row);
    }finally{
      liveCodeGenerating = false;
    }
  }
  $('pat-live-code-reset').addEventListener('click', function(){
    regenerateLiveCode();
  });

  // ---- Manage access (patient side) ----
  function openPatAccessModal(){
    renderTrustedList();
    renderAdhocList();
    $('pat-trust-input').value = '';
    clearError($('pat-trust-error'));
    closePatAcctDropdown();
    $('pat-access-modal').classList.remove('hidden');
  }
  function closePatAccessModal(){ $('pat-access-modal').classList.add('hidden'); }
  $('pat-access-manage-btn').addEventListener('click', openPatAccessModal);
  $('pat-access-close').addEventListener('click', closePatAccessModal);
  $('pat-access-modal').addEventListener('click', function(e){ if (e.target === $('pat-access-modal')) closePatAccessModal(); });

  function renderGrantRow(entry, showRevoke, subtext){
    var d = entry.doctor;
    var name = d.name ? ('Dr. ' + d.name.replace(/^Dr\.?\s*/i,'')) : (d.doctorId || 'Unknown doctor');
    var verified = !!d.verified;
    return '<div class="list-item" data-grant="'+entry.grant.id+'" style="cursor:default;">'
      + '<div><div class="li-title">'+escapeHtml(name)+' <span class="badge '+(verified?'verified':'unverified')+'" style="margin-left:5px;">'+(verified?'Verified':'Unverified')+'</span></div>'
      + '<div class="li-sub">'+escapeHtml(maskPhone(d.phone))+(subtext ? ' · '+subtext : '')+'</div></div>'
      + (showRevoke ? '<button class="btn btn-secondary btn-sm revoke-grant-btn" data-grant="'+entry.grant.id+'">Revoke</button>' : '')
      + '</div>';
  }
  async function renderTrustedList(){
    var listEl = $('pat-trusted-list');
    var emptyEl = $('pat-trusted-empty');
    var entries = await listTrustedDoctorsForPatient(activePatientId);
    if (!entries.length){
      listEl.innerHTML = '';
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    listEl.innerHTML = entries.map(function(e){ return renderGrantRow(e, true, 'Standing access'); }).join('');
    listEl.querySelectorAll('.revoke-grant-btn').forEach(function(btn){
      btn.addEventListener('click', async function(){
        btn.disabled = true;
        await revokeGrant(btn.getAttribute('data-grant'));
        renderTrustedList();
      });
    });
  }
  async function renderAdhocList(){
    var listEl = $('pat-adhoc-list');
    var emptyEl = $('pat-adhoc-empty');
    var entries = await listActiveAdhocGrantsForPatient(activePatientId);
    if (!entries.length){
      listEl.innerHTML = '';
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    listEl.innerHTML = entries.map(function(e){
      var mins = Math.max(0, Math.ceil((new Date(e.grant.expires_at).getTime() - Date.now()) / 60000));
      return renderGrantRow(e, true, 'One-time code · ends in ~'+mins+'m');
    }).join('');
    listEl.querySelectorAll('.revoke-grant-btn').forEach(function(btn){
      btn.addEventListener('click', async function(){
        btn.disabled = true;
        await revokeGrant(btn.getAttribute('data-grant'));
        renderAdhocList();
      });
    });
  }
  // Trusting a doctor is a name search against the doctor directory (the same one
  // booking uses) — there's no ID to ask the doctor for.
  var trustSearchToken = 0;
  var trustSearchTimer = null;
  async function runTrustSearch(){
    var resultsEl = $('pat-trust-results');
    clearError($('pat-trust-error'));
    var q = $('pat-trust-input').value.trim().replace(/^Dr\.?\s*/i, '').replace(/[%_,()]/g, ' ').trim();
    var token = ++trustSearchToken;
    if (q.length < 2){ resultsEl.innerHTML = ''; return; }
    var res = await supabaseClient.from('doctors').select('*').ilike('name', '%' + q + '%').limit(6);
    if (token !== trustSearchToken) return;
    var docs = (res.data || []).map(mapDoctorRow);
    if (!docs.length){
      resultsEl.innerHTML = '<div class="empty-state">No doctor found with that name.</div>';
      return;
    }
    resultsEl.innerHTML = docs.map(function(d, i){
      var sub = [d.specialty, (d.clinics || []).map(function(c){ return c.name; }).join(', ')].filter(Boolean).join(' · ');
      return '<div class="list-item static">'
        + '<div><div class="li-title">'+escapeHtml(doctorDisplayName(d))+' <span class="badge '+(d.verified?'verified':'unverified')+'" style="margin-left:5px;">'+(d.verified?'Verified':'Unverified')+'</span></div>'
        + '<div class="li-sub">'+escapeHtml(sub || 'No clinic on file')+'</div></div>'
        + '<button type="button" class="btn btn-secondary btn-sm trust-doctor-btn" data-idx="'+i+'">Trust</button>'
        + '</div>';
    }).join('');
    resultsEl.querySelectorAll('.trust-doctor-btn').forEach(function(btn){
      btn.addEventListener('click', async function(){
        btn.disabled = true;
        try{
          await createTrustGrant(activePatientId, docs[parseInt(btn.getAttribute('data-idx'), 10)].id);
          $('pat-trust-input').value = '';
          resultsEl.innerHTML = '';
          renderTrustedList();
        }finally{
          btn.disabled = false;
        }
      });
    });
  }
  $('pat-trust-input').addEventListener('input', function(){
    clearTimeout(trustSearchTimer);
    trustSearchTimer = setTimeout(runTrustSearch, 250);
  });

  // ---- Family (dependent profiles) ----
  // The switcher lives on the health card now — a "Change person" button
  // pinned to the card's own top-right corner (#pat-card-switcher-wrap),
  // not woven into the name display itself. The topbar's
  // #pat-active-profile-name stays plain, non-interactive text (see the
  // comment above its markup) — "Viewing: X" there, always, regardless of
  // whether there's anyone else to switch to; only the card's button
  // depends on dependents.length. #pat-card-switcher-menu is position:fixed
  // (see style.css), not the ordinary .dropdown-menu position:absolute,
  // since .health-card has overflow:hidden — an absolutely-positioned menu
  // would get clipped the instant it tried to extend past the card's own
  // bottom edge. Fixed positioning needs its coordinates set from the
  // trigger's own getBoundingClientRect() on open (right-aligned to the
  // button's own right edge, since the button sits at the card's right
  // edge and a left-aligned menu would run off narrow viewports), since
  // "top:100%" only means something relative to a normal positioning
  // context. Selecting a name re-runs enterPatientDash() against that
  // patients.id; every patient-context function already reads
  // activePatientId (set at the top of enterPatientDash), so the rest of
  // the dashboard just follows along unmodified.
  function closeCardSwitcher(){
    $('pat-card-switcher-menu').classList.add('hidden');
    $('pat-card-switcher-trigger').setAttribute('aria-expanded', 'false');
  }
  $('pat-card-switcher-trigger').addEventListener('click', function(e){
    e.stopPropagation();
    var menu = $('pat-card-switcher-menu');
    var opening = menu.classList.contains('hidden');
    if (opening){
      var r = this.getBoundingClientRect();
      menu.style.top = (r.bottom + 6) + 'px';
      menu.style.right = (window.innerWidth - r.right) + 'px';
    }
    menu.classList.toggle('hidden', !opening);
    this.setAttribute('aria-expanded', String(opening));
  });
  document.addEventListener('click', function(e){
    if (!$('pat-card-switcher-menu').classList.contains('hidden') && !e.target.closest('#pat-card-switcher-wrap')){
      closeCardSwitcher();
    }
  });
  async function renderFamilySwitcher(){
    var dependents = await loadDependentsForGuardian(session.id);
    // currentPatientData already holds the guardian's own name if that's what's
    // active right now — only worth a fresh fetch when a dependent is active.
    var ownName;
    if (activePatientId === session.id){
      ownName = (currentPatientData && currentPatientData.name) || 'You';
    } else {
      var ownData = await loadPatientProfile(session.id);
      ownName = (ownData && ownData.name) || 'You';
    }
    var activeDependent = dependents.find(function(d){ return d.id === activePatientId; });
    var activeName = (activePatientId === session.id) ? ownName : ((activeDependent && activeDependent.name) || '—');
    $('pat-active-profile-name').textContent = 'Viewing: ' + activeName;
    var wrap = $('pat-card-switcher-wrap');
    if (!dependents.length){
      wrap.classList.add('hidden');
      closeCardSwitcher();
      return;
    }
    wrap.classList.remove('hidden');
    // The person you're already viewing has no business in a "switch to
    // who?" list — only the others are worth offering.
    var rows = [{ id: session.id, name: ownName }].concat(dependents)
      .filter(function(p){ return p.id !== activePatientId; });
    $('pat-card-switcher-menu').innerHTML = rows.map(function(p){
      return '<button type="button" class="family-switch-btn" data-id="' + p.id + '">' + escapeHtml(p.name || 'Unnamed') + '</button>';
    }).join('');
    $('pat-card-switcher-menu').querySelectorAll('.family-switch-btn').forEach(function(btn){
      btn.addEventListener('click', function(){
        closeCardSwitcher();
        var id = btn.getAttribute('data-id');
        if (id !== activePatientId) enterPatientDash(id);
      });
    });
  }
  // #pat-family-indicator lives once in the DOM, outside every .view — this
  // physically moves it into whichever patient view is now on screen (as the
  // first item in that view's .topbar-right, ahead of the back link/Account
  // dropdown) so it reads on every patient page, not just the dashboard. A
  // no-op if it's already there. Called from showView() below.
  function placeFamilyIndicator(viewId){
    var indicator = $('pat-family-indicator');
    var right = $(viewId) && $(viewId).querySelector('.topbar-right');
    if (!right) return;
    indicator.classList.remove('hidden');
    if (right.firstChild === indicator) return;
    right.insertBefore(indicator, right.firstChild);
  }

  // ---- "Manage family" (top-level: list + add + join-by-code) ----
  function closePatFamilyModal(){ $('pat-family-modal').classList.add('hidden'); }
  async function renderFamilyList(){
    var dependents = await loadDependentsForGuardian(session.id);
    var listEl = $('pat-family-list');
    var emptyEl = $('pat-family-empty');
    if (!dependents.length){
      listEl.innerHTML = '';
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    listEl.innerHTML = dependents.map(function(d){
      return '<div class="list-item" style="cursor:default;">'
        + '<div><div class="li-title">' + escapeHtml(d.name || 'Unnamed') + '</div></div>'
        + '<button class="btn btn-secondary btn-sm family-manage-btn" data-id="' + d.id + '" type="button">Manage</button>'
        + '</div>';
    }).join('');
    listEl.querySelectorAll('.family-manage-btn').forEach(function(btn){
      btn.addEventListener('click', function(){
        var id = btn.getAttribute('data-id');
        openFamilyDetailModal(id, dependents.find(function(d){ return d.id === id; }));
      });
    });
  }
  async function openPatFamilyModal(){
    closePatAcctDropdown();
    clearError($('pat-family-join-error'));
    $('pat-family-join-input').value = '';
    await renderFamilyList();
    $('pat-family-modal').classList.remove('hidden');
  }
  $('pat-family-manage-btn').addEventListener('click', openPatFamilyModal);
  $('pat-family-close').addEventListener('click', closePatFamilyModal);
  $('pat-family-modal').addEventListener('click', function(e){ if (e.target === $('pat-family-modal')) closePatFamilyModal(); });

  $('pat-family-join-btn').addEventListener('click', async function(){
    var raw = $('pat-family-join-input').value.trim().replace(/[^0-9]/g, '');
    clearError($('pat-family-join-error'));
    if (raw.length !== 6){
      showError($('pat-family-join-error'), 'Enter the 6-digit code shown on their screen.');
      return;
    }
    $('pat-family-join-btn').disabled = true;
    try{
      var result = await joinAsGuardian(raw);
      if (!result.ok){
        showError($('pat-family-join-error'), mapGuardianLinkErrorText(result.error));
        return;
      }
      $('pat-family-join-input').value = '';
      await renderFamilyList();
      await renderFamilySwitcher();
    }finally{
      $('pat-family-join-btn').disabled = false;
    }
  });

  // ---- "Add family member" ----
  function closeAddFamilyModal(){ $('pat-add-family-modal').classList.add('hidden'); }
  $('pat-family-add-open-btn').addEventListener('click', function(){
    closePatFamilyModal();
    $('family-add-name').value = '';
    $('family-add-dob').value = '';
    $('family-add-gender').value = '';
    clearError($('family-add-error'));
    $('pat-add-family-modal').classList.remove('hidden');
  });
  $('pat-add-family-close').addEventListener('click', closeAddFamilyModal);
  $('family-add-cancel').addEventListener('click', closeAddFamilyModal);
  $('pat-add-family-modal').addEventListener('click', function(e){ if (e.target === $('pat-add-family-modal')) closeAddFamilyModal(); });
  $('family-add-save').addEventListener('click', async function(){
    var name = $('family-add-name').value.trim();
    var dob = $('family-add-dob').value;
    var gender = $('family-add-gender').value;
    clearError($('family-add-error'));
    if (!name){
      showError($('family-add-error'), 'Please enter a name.');
      return;
    }
    $('family-add-save').disabled = true;
    try{
      var res = await supabaseClient.rpc('create_dependent', { p_name: name, p_dob: dob || null, p_gender: gender });
      if (res.error || !res.data || !res.data[0]){
        showError($('family-add-error'), 'Something went wrong adding this family member. Please try again.');
        return;
      }
      var newId = res.data[0].id;
      closeAddFamilyModal();
      await enterPatientDash(newId);
    }catch(e){
      showError($('family-add-error'), 'Something went wrong adding this family member. Please try again.');
    }finally{
      $('family-add-save').disabled = false;
    }
  });

  // ---- Family member detail (per-dependent: guardians, generate a link code,
  // remove) — same "list -> Manage -> nested detail modal" pattern as doctor
  // clinics already use. ----
  var familyDetailDependent = null;
  var familyDetailCodeTimer = null;
  function stopFamilyDetailCodeTimer(){
    if (familyDetailCodeTimer){ clearInterval(familyDetailCodeTimer); familyDetailCodeTimer = null; }
  }
  async function renderFamilyDetailGuardians(dependentId){
    var linksRes = await supabaseClient.from('dependent_guardians').select('guardian_id').eq('dependent_id', dependentId);
    var guardianIds = (linksRes.data || []).map(function(r){ return r.guardian_id; });
    var listEl = $('pat-family-detail-guardians');
    if (!guardianIds.length){ listEl.innerHTML = ''; return 0; }
    var patRes = await supabaseClient.from('patients').select('id, name').in('id', guardianIds);
    var byId = {};
    (patRes.data || []).forEach(function(p){ byId[p.id] = p.name; });
    listEl.innerHTML = guardianIds.map(function(gid){
      var name = byId[gid] || 'Unknown';
      return '<div class="list-item" style="cursor:default;"><div><div class="li-title">' + escapeHtml(name) + (gid === session.id ? ' (you)' : '') + '</div></div></div>';
    }).join('');
    return guardianIds.length;
  }
  function updateFamilyDetailRemoveLabel(guardianCount){
    $('pat-family-detail-remove-label').textContent = (guardianCount <= 1)
      ? "Hold to permanently delete — you're the only guardian"
      : 'Hold to remove from your family';
  }
  function renderFamilyDetailCode(row){
    stopFamilyDetailCodeTimer();
    $('pat-family-detail-code-wrap').classList.remove('hidden');
    $('pat-family-detail-code').textContent = row.code.slice(0, 3) + ' ' + row.code.slice(3);
    var qrEl = $('pat-family-detail-qr');
    qrEl.innerHTML = '';
    var qr = qrcode(0, 'M');
    qr.addData(row.code);
    qr.make();
    qrEl.innerHTML = qr.createImgTag(4, 4);
    function tick(){
      var msLeft = new Date(row.expires_at).getTime() - Date.now();
      if (msLeft <= 0){
        stopFamilyDetailCodeTimer();
        $('pat-family-detail-code-wrap').classList.add('hidden');
        return;
      }
      $('pat-family-detail-code-expiry').textContent = 'Expires in ' + Math.ceil(msLeft / 1000) + 's';
    }
    tick();
    familyDetailCodeTimer = setInterval(tick, 1000);
  }
  function closeFamilyDetailModal(){
    stopFamilyDetailCodeTimer();
    $('pat-family-detail-modal').classList.add('hidden');
  }
  async function openFamilyDetailModal(id, dependent){
    familyDetailDependent = dependent || { id: id, name: '' };
    $('pat-family-detail-name').textContent = familyDetailDependent.name || '—';
    $('pat-family-detail-code-wrap').classList.add('hidden');
    stopFamilyDetailCodeTimer();
    var guardianCount = await renderFamilyDetailGuardians(id);
    updateFamilyDetailRemoveLabel(guardianCount);
    $('pat-family-detail-modal').classList.remove('hidden');
  }
  $('pat-family-detail-close').addEventListener('click', closeFamilyDetailModal);
  $('pat-family-detail-modal').addEventListener('click', function(e){ if (e.target === $('pat-family-detail-modal')) closeFamilyDetailModal(); });
  $('pat-family-detail-generate-btn').addEventListener('click', async function(){
    if (!familyDetailDependent) return;
    var btn = $('pat-family-detail-generate-btn');
    btn.disabled = true;
    try{
      var row = await createGuardianLinkCode(familyDetailDependent.id);
      if (row) renderFamilyDetailCode(row);
    }finally{
      btn.disabled = false;
    }
  });
  makeHoldButton($('pat-family-detail-remove-btn'), 2000, async function(){
    if (!familyDetailDependent) return;
    var removedId = familyDetailDependent.id;
    try{
      await supabaseClient.rpc('remove_dependent', { p_dependent_id: removedId });
    }catch(e){}
    closeFamilyDetailModal();
    closePatFamilyModal();
    if (removedId === activePatientId){
      // Viewing the profile that just got removed/unlinked — fall back to the
      // guardian's own dashboard rather than one that may no longer be reachable.
      await enterPatientDash(session.id);
    } else {
      await renderFamilySwitcher();
    }
  });

  function openPatAccountSettingsPage(){
    var isDependent = !!(currentPatientData && currentPatientData.isDependent);
    // A dependent has no login of their own — hide the email field entirely
    // rather than show it blank-but-editable, which could otherwise be typed
    // into and saved as a change to the *guardian's own* login email (see the
    // guard in the save handler below).
    $('pat-email-field').classList.toggle('hidden', isDependent);
    $('pat-email').value = (currentPatientData && currentPatientData.email) || '';
    $('pat-phone').value = (currentPatientData && currentPatientData.phone) || '';
    closePatAcctDropdown();
    showView('view-pat-account-settings');
  }
  $('pat-account-settings-btn').addEventListener('click', openPatAccountSettingsPage);

  function openPatProfilePage(){
    $('pat-name').value = (currentPatientData && currentPatientData.name) || '';
    $('pat-dob').value = (currentPatientData && currentPatientData.dob) || '';
    $('pat-dob').max = toDateKey(new Date());
    $('pat-gender').value = (currentPatientData && currentPatientData.gender) || '';
    clearError($('pat-profile-error'));
    $('pat-emergency-contact').value = (currentPatientData && currentPatientData.emergencyContact) || '';
    $('pat-allergies').value = (currentPatientData && currentPatientData.allergies) || '';
    $('pat-conditions').value = (currentPatientData && currentPatientData.conditions) || '';
    closePatAcctDropdown();
    showView('view-pat-profile');
  }
  $('pat-myprofile-btn').addEventListener('click', openPatProfilePage);

  $('pat-profile-save-btn').addEventListener('click', async function(){
    var name = $('pat-name').value.trim();
    var dob = $('pat-dob').value;
    var gender = $('pat-gender').value;
    var emergencyContact = $('pat-emergency-contact').value.trim();
    var allergies = $('pat-allergies').value.trim();
    var conditions = $('pat-conditions').value.trim();
    clearError($('pat-profile-error'));
    if (dob && dob > toDateKey(new Date())){ showError($('pat-profile-error'), 'Date of birth can\'t be in the future.'); return; }
    var res = await supabaseClient.from('patients').update({
      name: name, dob: dob || null, gender: gender,
      emergency_contact: emergencyContact, allergies: allergies, conditions: conditions
    }).eq('id', activePatientId);
    if (res.error){ showError($('pat-profile-error'), 'Something went wrong saving your profile. Please try again.'); return; }
    currentPatientData.name = name;
    currentPatientData.dob = dob;
    currentPatientData.gender = gender;
    currentPatientData.emergencyContact = emergencyContact;
    currentPatientData.allergies = allergies;
    currentPatientData.conditions = conditions;
    renderHealthCard(currentPatientData);
    showView('view-patient-dash');
  });

  $('pat-save-btn').addEventListener('click', async function(){
    var email = $('pat-email').value.trim();
    var phone = $('pat-phone').value.trim();
    var isDependent = !!(currentPatientData && currentPatientData.isDependent);
    $('pat-save-btn').disabled = true;
    try{
      var authUser = await getAuthUser();
      // The email field is hidden entirely for a dependent (see
      // openPatAccountSettingsPage) — this guard is the actual safety backstop,
      // since a dependent has no login of its own and this must never end up
      // changing the *guardian's* real signed-in email by accident.
      if (!isDependent && email && email !== authUser.email){
        await supabaseClient.auth.updateUser({ email: email });
        // Supabase confirms the new address before auth.users.email actually
        // changes — the verify banner naturally reappears until that happens,
        // no separate "reset the flag" step needed.
      }
      await supabaseClient.from('patients').update({ phone: phone }).eq('id', activePatientId);
      currentPatientData.phone = phone;
      authUser = await getAuthUser();
      if (!isDependent) currentPatientData.email = authUser.email;
      renderVerifyBanner('pat', authUser.email, !!authUser.email_confirmed_at);
      var note = $('pat-save-note');
      note.classList.add('show');
      setTimeout(function(){ note.classList.remove('show'); }, 1800);
    }finally{
      $('pat-save-btn').disabled = false;
    }
  });
  $('pat-verify-btn').addEventListener('click', async function(){
    var btn = $('pat-verify-btn');
    var authUser = await getAuthUser();
    if (!authUser || !authUser.email) return;
    btn.disabled = true;
    btn.textContent = 'Sending...';
    try{
      await supabaseClient.auth.resend({ type:'signup', email: authUser.email });
      btn.textContent = 'Sent!';
    }catch(e){
      btn.textContent = 'Resend email';
    }finally{
      setTimeout(function(){ btn.textContent = 'Resend email'; btn.disabled = false; }, 2500);
    }
  });

  function computePatientStats(data){
    var visits = (data && data.visits) || [];
    var doctors = {};
    visits.forEach(function(v){
      var name = (v.doctorName || '').trim().toLowerCase();
      if (name) doctors[name] = true;
    });
    return {
      hasData: visits.length > 0,
      totalVisits: visits.length,
      doctorsSeen: Object.keys(doctors).length
    };
  }
  function openPatStatsPage(){
    var stats = computePatientStats(currentPatientData);
    if (!stats.hasData){
      $('pat-stats-grid').innerHTML = '';
      $('pat-stats-empty').classList.remove('hidden');
    } else {
      $('pat-stats-empty').classList.add('hidden');
      var tiles = [
        { value: stats.totalVisits, label: 'Total visits so far' },
        { value: stats.doctorsSeen, label: 'Doctors you’ve been to' }
      ];
      $('pat-stats-grid').innerHTML = tiles.map(function(t){
        return '<div class="stat-tile"><div class="stat-value">'+t.value+'</div><div class="stat-label">'+t.label+'</div></div>';
      }).join('');
    }
    closePatAcctDropdown();
    showView('view-pat-stats');
  }
  $('pat-stats-btn').addEventListener('click', openPatStatsPage);

  // ---- Account dropdown (topbar) — How it works / Account settings / My statistics ----
  function closePatAcctDropdown(){
    $('pat-account-dropdown-menu').classList.add('hidden');
    $('pat-account-dropdown-trigger').setAttribute('aria-expanded', 'false');
  }
  $('pat-account-dropdown-trigger').addEventListener('click', function(e){
    e.stopPropagation();
    var menu = $('pat-account-dropdown-menu');
    var opening = menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !opening);
    this.setAttribute('aria-expanded', String(opening));
  });
  document.addEventListener('click', function(e){
    if (!$('pat-account-dropdown-menu').classList.contains('hidden') && !e.target.closest('#pat-account-dropdown-wrap')){
      closePatAcctDropdown();
    }
  });
  $('pat-howitworks-btn').addEventListener('click', closePatAcctDropdown);

  var patHowItWorks = makeStepperModal({
    modal:'pat-howitworks-modal', track:'pat-howitworks-track',
    counter:'pat-howitworks-counter', back:'pat-howitworks-back', next:'pat-howitworks-next', close:'pat-howitworks-close'
  });
  $('pat-howitworks-btn').addEventListener('click', patHowItWorks.open);

  $('pat-avatar-btn').addEventListener('click', function(){
    $('pat-avatar-input').click();
  });
  $('pat-avatar-input').addEventListener('change', function(e){
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')){ e.target.value = ''; return; }
    if (file.size > 3 * 1024 * 1024){
      $('pat-dash-copy-note').textContent = 'Image too large — please use one under 3MB';
      setTimeout(function(){ $('pat-dash-copy-note').textContent = ''; }, 2500);
      e.target.value = '';
      return;
    }
    var reader = new FileReader();
    reader.onload = async function(){
      var dataUrl = reader.result;
      $('pat-avatar-img').src = dataUrl;
      $('pat-avatar-img').classList.remove('hidden');
      $('pat-avatar-fallback').classList.add('hidden');
      currentPatientData.photoUrl = dataUrl;
      try{ await supabaseClient.from('patients').update({ photo_url: dataUrl }).eq('id', activePatientId); }catch(err){}
    };
    reader.readAsDataURL(file);
  });
  $('pat-signout').addEventListener('click', async function(){
    closePatAcctDropdown();
    stopLiveCodeTimer();
    await supabaseClient.auth.signOut();
    session = { type:null, id:null };
    activePatientId = null;
    showView('view-landing');
  });

  // ---- Record pages (Visits / Lab Results / Prescriptions / My Eyes) ----
  // Navigation between these and the dashboard is handled entirely by the generic
  // [data-goto] + showView() mechanism already wired up near the top of this script —
  // no per-card open/close handlers needed. Lists just need to be rendered before the
  // patient can reach them, which enterPatientDash already does at sign-in.
  function isMeaningfulPrescription(p){
    if (!p) return false;
    var t = p.trim().toLowerCase();
    return t !== '' && t !== 'none' && t !== 'n/a' && t !== 'na' && t !== '-';
  }
  // Shared by every master-detail list below (patient Visits/Lab/
  // Prescriptions, doctor Visits/Lab/Prescriptions) — clears whichever row
  // was previously marked selected in this particular list and marks the
  // new one, purely a DOM concern with nothing list-specific about it.
  function markActiveListItem(listEl, activeEl){
    listEl.querySelectorAll('.list-item.active').forEach(function(el){ el.classList.remove('active'); });
    if (activeEl) activeEl.classList.add('active');
  }
  // Master-detail: the list on the left, a persistent detail panel on the
  // right (#pat-prescription-detail/-empty) instead of a modal popup — the
  // first row auto-selects/renders whenever the list itself has data, and
  // clicking a different row just re-renders the same panel in place.
  function renderPrescriptionsList(visits){
    var listEl = $('pat-prescriptions-list');
    var emptyEl = $('pat-prescriptions-empty');
    var entries = (visits || []).map(function(v, i){ return { v: v, i: i }; }).filter(function(e){ return isMeaningfulPrescription(e.v.prescription); });
    if (!entries.length){
      listEl.innerHTML = '';
      emptyEl.classList.remove('hidden');
      $('pat-prescription-detail-empty').classList.remove('hidden');
      $('pat-prescription-detail').classList.add('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    listEl.innerHTML = entries.map(function(e){
      return '<div class="list-item" data-idx="'+e.i+'">'
        + '<div>'
        + '<div class="li-title">'+escapeHtml(e.v.doctorName || 'Doctor')+'</div>'
        + '<div class="li-sub">'+escapeHtml(formatDateDisplay(e.v.date))+'</div>'
        + '</div>'
        + chevronSvg + '</div>';
    }).join('');
    var items = listEl.querySelectorAll('.list-item');
    items.forEach(function(el){
      el.addEventListener('click', function(){
        markActiveListItem(listEl, el);
        renderPrescriptionDetail(visits[parseInt(el.getAttribute('data-idx'), 10)]);
      });
    });
    markActiveListItem(listEl, items[0]);
    renderPrescriptionDetail(visits[parseInt(items[0].getAttribute('data-idx'), 10)]);
  }
  // A focused detail for just the medicine from one visit — the full
  // symptoms/diagnosis/notes visit detail is more than this page needs,
  // since My Prescriptions is specifically about what was prescribed.
  function renderPrescriptionDetail(v){
    $('pat-prescription-detail-empty').classList.add('hidden');
    $('pat-prescription-detail').classList.remove('hidden');
    $('prescription-detail-date').textContent = formatDateDisplay(v.date);
    $('prescription-detail-doctor').innerHTML = escapeHtml(v.doctorName || 'Doctor') + unverifiedTagHtml(v);
    var items = (v.prescription || '').split(/\r?\n/).map(function(s){ return s.trim(); }).filter(Boolean);
    if (!items.length) items = ['Not recorded'];
    $('prescription-detail-list').innerHTML = items.map(function(item){ return '<li>' + escapeHtml(item) + '</li>'; }).join('');
  }

  function formatDateDisplay(dateStr){
    if (!dateStr) return '—';
    var d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' });
  }
  // Lab results are dated by when they were added, shown as "Date uploaded: 29-Oct-2026".
  function formatUploadedDate(dateStr){
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr || '');
    if (!m) return 'Date uploaded: ' + (dateStr || '—');
    return 'Date uploaded: ' + m[3] + '-' + MONTH_NAMES[parseInt(m[2], 10) - 1].slice(0, 3) + '-' + m[1];
  }
  var chevronSvg = '<svg class="chevron" width="11" height="7" viewBox="0 0 16 10"><path d="M0,5 H14 M9,0 L14,5 L9,10" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';

  function renderVisitsList(visits, opts){
    opts = opts || {};
    var listEl = $('pat-visits-list');
    var emptyEl = $('pat-visits-empty');
    var searchEmptyEl = $('pat-visits-search-empty');
    if (!opts.isSearch) $('pat-visits-search').value = '';
    var hasAnyVisits = !!(currentPatientData && currentPatientData.visits && currentPatientData.visits.length);
    if (!visits || !visits.length){
      listEl.innerHTML = '';
      if (opts.isSearch && hasAnyVisits){
        emptyEl.classList.add('hidden');
        searchEmptyEl.classList.remove('hidden');
      } else {
        searchEmptyEl.classList.add('hidden');
        emptyEl.classList.remove('hidden');
      }
      $('pat-visit-detail-empty').classList.remove('hidden');
      $('pat-visit-detail').classList.add('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    searchEmptyEl.classList.add('hidden');
    listEl.innerHTML = visits.map(function(v, i){
      return '<div class="list-item" data-idx="'+i+'">'
        + '<div>'
        + '<div class="li-title">'+escapeHtml(v.doctorName || 'Doctor')+unverifiedTagHtml(v)+'</div>'
        + '<div class="li-sub">'+escapeHtml(formatDateDisplay(v.date))+(v.time ? ' · '+escapeHtml(v.time) : '')+'</div>'
        + '</div>'
        + chevronSvg + '</div>';
    }).join('');
    var items = listEl.querySelectorAll('.list-item');
    items.forEach(function(el){
      el.addEventListener('click', function(){
        markActiveListItem(listEl, el);
        renderVisitDetail(visits[parseInt(el.getAttribute('data-idx'), 10)]);
      });
    });
    markActiveListItem(listEl, items[0]);
    renderVisitDetail(visits[parseInt(items[0].getAttribute('data-idx'), 10)]);
  }
  $('pat-visits-search').addEventListener('input', function(){
    var q = this.value.trim().toLowerCase();
    var all = (currentPatientData && currentPatientData.visits) || [];
    var filtered = q ? all.filter(function(v){
      return (v.doctorName || '').toLowerCase().indexOf(q) !== -1;
    }) : all;
    renderVisitsList(filtered, { isSearch: true });
  });
  function renderTestsList(tests){
    var listEl = $('pat-tests-list');
    var emptyEl = $('pat-tests-empty');
    if (!tests || !tests.length){
      listEl.innerHTML = '';
      emptyEl.classList.remove('hidden');
      clearTestViewer('test-detail');
      $('pat-test-detail-empty').classList.remove('hidden');
      $('pat-test-detail').classList.add('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    listEl.innerHTML = tests.map(function(t, i){
      return '<div class="list-item" data-idx="'+i+'">'
        + '<div>'
        + '<div class="li-title">'+escapeHtml(t.name || 'Test')+testTagHtml(t, 'patient')+'</div>'
        + '<div class="li-sub">'+escapeHtml(formatUploadedDate(t.date))+'</div>'
        + '</div>'
        + chevronSvg + '</div>';
    }).join('');
    var testItems = listEl.querySelectorAll('.list-item');
    testItems.forEach(function(el){
      el.addEventListener('click', function(){
        markActiveListItem(listEl, el);
        renderTestDetail(tests[parseInt(el.getAttribute('data-idx'), 10)]);
      });
    });
    markActiveListItem(listEl, testItems[0]);
    renderTestDetail(tests[parseInt(testItems[0].getAttribute('data-idx'), 10)]);
  }

  // ---- Appointments calendar + upcoming list ----
  var MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  function toDateKey(d){
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function renderAppointmentsCalendar(appointments){
    var apptDays = {};
    (appointments || []).forEach(function(a){ if (a.date) apptDays[a.date] = true; });

    var year = calViewDate.getFullYear();
    var month = calViewDate.getMonth();
    $('pat-cal-month-label').textContent = MONTH_NAMES[month] + ' ' + year;

    var firstOfMonth = new Date(year, month, 1);
    var startOffset = firstOfMonth.getDay();
    var gridStart = new Date(year, month, 1 - startOffset);
    var today = new Date();
    var todayKey = toDateKey(today);

    var cells = [];
    for (var i = 0; i < 42; i++){
      var d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      var key = toDateKey(d);
      var classes = ['calendar-day'];
      if (d.getMonth() !== month) classes.push('outside');
      if (key === todayKey) classes.push('today');
      if (apptDays[key]) classes.push('has-appt');
      cells.push('<div class="' + classes.join(' ') + '">' + d.getDate() + '</div>');
    }
    $('pat-cal-grid').innerHTML = cells.join('');
  }
  $('pat-cal-prev').addEventListener('click', function(){
    calViewDate = new Date(calViewDate.getFullYear(), calViewDate.getMonth() - 1, 1);
    renderAppointmentsCalendar(currentPatientData && currentPatientData.appointments);
  });
  $('pat-cal-next').addEventListener('click', function(){
    calViewDate = new Date(calViewDate.getFullYear(), calViewDate.getMonth() + 1, 1);
    renderAppointmentsCalendar(currentPatientData && currentPatientData.appointments);
  });

  function renderAppointmentsList(appointments){
    var listEl = $('pat-appts-list');
    var emptyEl = $('pat-appts-empty');
    var todayKey = toDateKey(new Date());
    var upcoming = (appointments || [])
      .filter(function(a){ return a.date && a.date >= todayKey; })
      .sort(function(a, b){ return (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')); });
    if (!upcoming.length){
      listEl.innerHTML = '';
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    listEl.innerHTML = upcoming.map(function(a, i){
      return '<div class="list-item" data-idx="'+i+'" style="cursor:pointer;">'
        + '<div><div class="li-title">'+escapeHtml(a.doctorName || 'Doctor')+'</div>'
        + '<div class="li-sub">'+escapeHtml(formatDateDisplay(a.date))+(a.time ? ' · '+escapeHtml(a.time) : '')+(a.clinicName ? ' · '+escapeHtml(a.clinicName) : '')+'</div></div>'
        + '</div>';
    }).join('');
    listEl.querySelectorAll('.list-item').forEach(function(el){
      el.addEventListener('click', function(){
        openPatApptDetailModal(upcoming[parseInt(el.getAttribute('data-idx'), 10)]);
      });
    });
  }
  // Clicking an upcoming appointment opens a read-only detail popup with a
  // cancel action — the only way to manage an existing booking today (no
  // reschedule yet). Deleting only removes the appointments row; the trust
  // grant booking created stays intact, same as the rest of the access model
  // where only the patient's own "Manage access" revokes standing access.
  var patApptDetailCurrent = null;
  function openPatApptDetailModal(a){
    patApptDetailCurrent = a;
    $('pat-appt-detail-doctor').textContent = a.doctorName || 'Doctor';
    $('pat-appt-detail-clinic').textContent = a.clinicName || 'Not recorded';
    $('pat-appt-detail-address').textContent = a.clinicAddress || '';
    $('pat-appt-detail-address').classList.toggle('hidden', !a.clinicAddress);
    $('pat-appt-detail-date').textContent = formatDateDisplay(a.date);
    $('pat-appt-detail-time').textContent = a.time || '';
    $('pat-appt-detail-time').classList.toggle('hidden', !a.time);
    $('pat-appt-detail-reason-wrap').classList.toggle('hidden', !a.reason);
    $('pat-appt-detail-reason').textContent = a.reason || '';
    clearError($('pat-appt-detail-error'));
    $('pat-appt-detail-modal').classList.remove('hidden');
  }
  function closePatApptDetailModal(){ $('pat-appt-detail-modal').classList.add('hidden'); patApptDetailCurrent = null; }
  $('pat-appt-detail-close').addEventListener('click', closePatApptDetailModal);
  $('pat-appt-detail-modal').addEventListener('click', function(e){ if (e.target === $('pat-appt-detail-modal')) closePatApptDetailModal(); });
  makeHoldButton($('pat-appt-detail-delete'), 2000, async function(){
    if (!patApptDetailCurrent) return;
    clearError($('pat-appt-detail-error'));
    var btn = $('pat-appt-detail-delete');
    var label = btn.querySelector('.hold-label');
    btn.disabled = true;
    label.textContent = 'Cancelling...';
    try{
      var res = await supabaseClient.from('appointments').delete().eq('id', patApptDetailCurrent.id);
      if (res.error){
        showError($('pat-appt-detail-error'), 'Something went wrong cancelling this appointment. Please try again.');
        return;
      }
      var deletedId = patApptDetailCurrent.id;
      currentPatientData.appointments = (currentPatientData.appointments || []).filter(function(a){ return a.id !== deletedId; });
      renderAppointmentsList(currentPatientData.appointments);
      renderAppointmentsCalendar(currentPatientData.appointments);
      closePatApptDetailModal();
    }catch(e){
      showError($('pat-appt-detail-error'), 'Something went wrong cancelling this appointment. Please try again.');
    }finally{
      btn.disabled = false;
      label.textContent = 'Hold to cancel appointment';
    }
  });

  // ---- Book an appointment: search the doctor directory, then pick a date/time.
  // Booking auto-creates a trust grant (see createTrustGrant()) — this is the one
  // place a patient can hand a doctor standing access without either a live code
  // or the "Manage access" modal, so the form step says so plainly.
  // Weekly availability blocks (see doctor_availability in supabase/schema.sql)
  // sliced into concrete bookable slots — shared by the patient booking flow
  // below and the doctor's "Manage bookings" modal / auto-clinic-select further
  // down. day_of_week follows JS Date.getDay() (0=Sunday) on both ends so
  // nothing has to translate between conventions.
  function mapAvailabilityRow(row){
    return { id: row.id, clinicName: row.clinic_name, dayOfWeek: row.day_of_week, startTime: row.start_time, endTime: row.end_time, slotMinutes: row.slot_minutes, validUntil: row.valid_until };
  }
  // A block only counts while today is on or before its valid_until — this is
  // also where a legacy row saved before valid_until existed (null) quietly
  // stops counting, without needing a destructive migration to retire it.
  function isAvailabilityBlockActive(a, dateStr){
    return !!(a.validUntil && dateStr <= a.validUntil);
  }
  var BOOKING_HORIZON_DAYS = 28;
  function minutesFromTimeStr(t){
    var parts = (t || '0:0').split(':');
    return (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
  }
  function formatSlotLabel(totalMinutes){
    var hh = Math.floor(totalMinutes / 60) % 24;
    var mm = totalMinutes % 60;
    var h12 = hh % 12; if (h12 === 0) h12 = 12;
    var ampm = hh < 12 ? 'AM' : 'PM';
    return h12 + ':' + (mm < 10 ? '0' + mm : mm) + ' ' + ampm;
  }
  function generateSlotTimes(startTime, endTime, slotMinutes){
    var start = minutesFromTimeStr(startTime);
    var end = minutesFromTimeStr(endTime);
    var slots = [];
    for (var t = start; t + slotMinutes <= end; t += slotMinutes){
      slots.push(formatSlotLabel(t));
    }
    return slots;
  }

  var bookApptDoctors = [];
  var bookApptSelectedDoctor = null;
  var bookApptAvailability = [];
  var bookApptSelectedSlot = null;
  function doctorDisplayName(d){
    return d.name ? ('Dr. ' + d.name.replace(/^Dr\.?\s*/i, '')) : (d.doctorId || 'Unknown doctor');
  }
  async function openBookApptPage(){
    clearError($('book-appt-error'));
    $('book-appt-search-input').value = '';
    bookApptSelectedDoctor = null;
    bookApptSelectedClinic = null;
    $('book-appt-search-step').classList.remove('hidden');
    $('book-appt-form-step').classList.add('hidden');
    $('book-appt-doctor-list').innerHTML = '';
    $('book-appt-doctor-empty').classList.add('hidden');
    showView('view-pat-book-appt');
    var res = await supabaseClient.from('doctors').select('*');
    bookApptDoctors = (res.data || []).map(mapDoctorRow);
    collectSpecialtyNames();
    bookApptSpecialtyFilter = [];
    renderFilterButtonAndChips();
    renderBookApptDoctorList(bookApptDoctors);
  }
  // Clicking a doctor doesn't navigate anywhere — it expands a clinics sub-list
  // right under that row (same .list-item look as the doctor row itself, just
  // indented), accordion-style (opening one collapses whichever else was open).
  // Picking a clinic from there is what actually advances to the date/time step.
  function renderBookApptDoctorList(list){
    var listEl = $('book-appt-doctor-list');
    var emptyEl = $('book-appt-doctor-empty');
    if (!list.length){
      listEl.innerHTML = '';
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    listEl.innerHTML = list.map(function(d, i){
      var sub = [d.specialty, (d.clinics || []).map(function(c){ return c.name; }).join(', ')].filter(Boolean).join(' · ');
      return '<div class="book-doctor-entry" data-idx="'+i+'">'
        + '<div class="list-item" data-idx="'+i+'">'
        + '<div><div class="li-title book-doctor-name">'+escapeHtml(doctorDisplayName(d))+' <span class="badge '+(d.verified?'verified':'unverified')+'" style="margin-left:5px;">'+(d.verified?'Verified':'Unverified')+'</span></div>'
        + '<div class="li-sub">'+escapeHtml(sub || 'No clinic on file')+'</div></div>'
        + chevronSvg + '</div>'
        + '<div class="book-doctor-clinics hidden"></div>'
        + '</div>';
    }).join('');
    listEl.querySelectorAll('.book-doctor-entry > .list-item').forEach(function(el){
      el.addEventListener('click', function(){
        toggleDoctorClinics(list[parseInt(el.getAttribute('data-idx'), 10)], el.parentElement);
      });
    });
  }
  var bookApptSelectedDate = null;
  var bookApptSelectedClinic = null;
  var DOW_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  // Only clinics that are actually still bookable today are worth offering —
  // one with every block expired would just lead to an empty date-tab row.
  function distinctBookableClinics(availability){
    var todayStr = toDateKey(new Date());
    var names = [];
    availability.forEach(function(a){
      if (!isAvailabilityBlockActive(a, todayStr)) return;
      if (names.indexOf(a.clinicName) === -1) names.push(a.clinicName);
    });
    return names;
  }
  async function toggleDoctorClinics(d, entryEl){
    var clinicsEl = entryEl.querySelector('.book-doctor-clinics');
    var alreadyOpen = !clinicsEl.classList.contains('hidden');
    $('book-appt-doctor-list').querySelectorAll('.book-doctor-clinics').forEach(function(el){
      el.classList.add('hidden');
      el.innerHTML = '';
    });
    if (alreadyOpen) return;
    clinicsEl.classList.remove('hidden');
    clinicsEl.innerHTML = '<div class="li-sub" style="padding:8px 15px;">Loading…</div>';
    var res = await supabaseClient.from('doctor_availability').select('*').eq('doctor_id', d.id);
    var availability = (res.data || []).map(mapAvailabilityRow);
    var clinicNames = distinctBookableClinics(availability);
    // A doctor's About is shown whether or not they're verified — it's their own
    // words about themselves, not a verified credential.
    var aboutHtml = d.about
      ? '<div class="li-sub" style="padding:8px 15px; white-space:pre-wrap; color:var(--ink-soft);">'+escapeHtml(d.about)+'</div>'
      : '';
    if (!clinicNames.length){
      clinicsEl.innerHTML = aboutHtml + '<div class="li-sub" style="padding:8px 15px;">No bookable clinics yet.</div>';
      return;
    }
    var clinics = clinicNames.map(function(name){ return findClinicByName(d, name); });
    clinicsEl.innerHTML = aboutHtml + clinics.map(function(c){
      return '<div class="list-item" data-clinic="'+escapeHtml(c.name)+'">'
        + '<div><div class="li-title">'+escapeHtml(c.name)+'</div>'
        + (c.address ? '<div class="li-sub">'+escapeHtml(c.address)+'</div>' : '')
        + '</div>' + chevronSvg + '</div>';
    }).join('');
    clinicsEl.querySelectorAll('.list-item').forEach(function(el){
      el.addEventListener('click', function(e){
        e.stopPropagation();
        selectBookApptDoctorClinic(d, availability, el.getAttribute('data-clinic'));
      });
    });
  }
  function findClinicByName(d, name){
    var match = (d.clinics || []).find(function(c){ return c.name === name; });
    return match || { name: name, address: '', phone: '', note: '' };
  }
  var bookApptSelectedClinicAddress = '';
  function selectBookApptDoctorClinic(d, availability, clinicName){
    bookApptSelectedDoctor = d;
    bookApptAvailability = availability;
    bookApptSelectedClinic = clinicName;
    var clinic = findClinicByName(d, clinicName);
    bookApptSelectedClinicAddress = clinic.address || '';
    $('book-appt-search-step').classList.add('hidden');
    $('book-appt-form-step').classList.remove('hidden');
    $('book-appt-doctor-name').textContent = doctorDisplayName(d);
    $('book-appt-clinic-name').textContent = clinicName;
    $('book-appt-clinic-address').textContent = bookApptSelectedClinicAddress;
    $('book-appt-clinic-address').classList.toggle('hidden', !bookApptSelectedClinicAddress);
    $('book-appt-clinic-phone').textContent = clinic.phone ? ('Phone: ' + clinic.phone) : '';
    $('book-appt-clinic-phone').classList.toggle('hidden', !clinic.phone);
    $('book-appt-clinic-note').textContent = clinic.note ? ('Phone hours: ' + clinic.note) : '';
    $('book-appt-clinic-note').classList.toggle('hidden', !clinic.note);
    bookApptSelectedSlot = null;
    bookApptSelectedDate = null;
    $('book-appt-reason').value = '';
    clearError($('book-appt-error'));
    $('book-appt-date-tabs').innerHTML = '';
    $('book-appt-date-empty').classList.add('hidden');
    $('book-appt-slots').innerHTML = '';
    $('book-appt-slots-empty').textContent = 'Pick a date to see available times.';
    $('book-appt-slots-empty').classList.remove('hidden');
    renderBookApptDateTabs();
  }
  // Every bookable date in the window for the chosen clinic, not just weekday
  // labels — a date only shows up if some block actually covers it (right
  // weekday, not yet expired), so the row never offers a day the doctor isn't
  // really at this clinic. The 28-day cap is enforced here regardless of what
  // any block's valid_until says, so no single doctor setting can push a
  // patient past the app-wide limit.
  function generateBookableDates(availability, clinicName){
    var dates = [];
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    for (var i = 0; i < BOOKING_HORIZON_DAYS; i++){
      var d = new Date(today);
      d.setDate(d.getDate() + i);
      var dateStr = toDateKey(d);
      var dow = d.getDay();
      var covered = availability.some(function(a){ return a.clinicName === clinicName && a.dayOfWeek === dow && isAvailabilityBlockActive(a, dateStr); });
      if (covered) dates.push({ date: dateStr, jsDate: d });
    }
    return dates;
  }
  function renderBookApptDateTabs(){
    var wrap = $('book-appt-date-tabs');
    var emptyEl = $('book-appt-date-empty');
    var dates = generateBookableDates(bookApptAvailability, bookApptSelectedClinic);
    wrap.innerHTML = '';
    if (!dates.length){
      emptyEl.classList.remove('hidden');
      $('book-appt-slots-empty').textContent = 'Pick a date to see available times.';
      return;
    }
    emptyEl.classList.add('hidden');
    wrap.innerHTML = dates.map(function(d){
      return '<button type="button" class="date-tab-btn" data-date="'+d.date+'">'
        + '<span class="dow">'+DOW_SHORT[d.jsDate.getDay()]+'</span>'
        + '<span class="dnum">'+d.jsDate.getDate()+'</span>'
        + '<span class="dmon">'+MONTH_SHORT[d.jsDate.getMonth()]+'</span>'
        + '</button>';
    }).join('');
    wrap.querySelectorAll('.date-tab-btn').forEach(function(btn){
      btn.addEventListener('click', function(){
        wrap.querySelectorAll('.date-tab-btn').forEach(function(b){ b.classList.remove('selected'); });
        btn.classList.add('selected');
        bookApptSelectedDate = btn.getAttribute('data-date');
        renderBookApptSlots();
      });
    });
    wrap.querySelector('.date-tab-btn').click();
  }
  async function renderBookApptSlots(){
    var dateStr = bookApptSelectedDate;
    var slotsEl = $('book-appt-slots');
    var emptyEl = $('book-appt-slots-empty');
    slotsEl.innerHTML = '';
    bookApptSelectedSlot = null;
    if (!dateStr || !bookApptSelectedDoctor || !bookApptSelectedClinic){
      emptyEl.textContent = 'Pick a date to see available times.';
      emptyEl.classList.remove('hidden');
      return;
    }
    var dayOfWeek = new Date(dateStr + 'T00:00:00').getDay();
    var blocks = bookApptAvailability.filter(function(a){ return a.clinicName === bookApptSelectedClinic && a.dayOfWeek === dayOfWeek && isAvailabilityBlockActive(a, dateStr); });
    if (!blocks.length){
      emptyEl.textContent = 'No bookable hours on that day — try another date.';
      emptyEl.classList.remove('hidden');
      return;
    }
    var takenRes = await supabaseClient.from('appointments').select('time').eq('doctor_id', bookApptSelectedDoctor.id).eq('date', dateStr);
    var taken = {};
    (takenRes.data || []).forEach(function(r){ taken[r.time] = true; });
    var allTimes = [];
    blocks.forEach(function(block){
      generateSlotTimes(block.startTime, block.endTime, block.slotMinutes).forEach(function(t){
        if (!taken[t] && allTimes.indexOf(t) === -1) allTimes.push(t);
      });
    });
    if (!allTimes.length){
      emptyEl.textContent = 'No open times left on that day — try another date.';
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    slotsEl.innerHTML = '<div class="slot-grid">' + allTimes.map(function(t){
      return '<button type="button" class="slot-btn" data-time="'+escapeHtml(t)+'">'+escapeHtml(t)+'</button>';
    }).join('') + '</div>';
    slotsEl.querySelectorAll('.slot-btn').forEach(function(btn){
      btn.addEventListener('click', function(){
        slotsEl.querySelectorAll('.slot-btn').forEach(function(b){ b.classList.remove('selected'); });
        btn.classList.add('selected');
        bookApptSelectedSlot = { time: btn.getAttribute('data-time'), clinicName: bookApptSelectedClinic };
      });
    });
  }
  // A doctor's specialty is free text and can list several ("Cardiology, Family
  // Medicine") — split on commas so each one is its own filter option/match.
  function doctorSpecialties(d){
    return (d.specialty || '').split(',').map(function(s){ return s.trim(); }).filter(Boolean);
  }
  // Filter options come from the doctors actually registered (case-insensitive
  // dedupe), so the checkbox list never offers a specialty nobody has. Selected
  // ones are kept lowercase in bookApptSpecialtyFilter; a doctor matches if they
  // list ANY of them (OR), on top of whatever the text search says.
  var bookApptSpecialtyFilter = [];
  var bookApptSpecialtyNames = {};
  function collectSpecialtyNames(){
    // Every specialty on the fixed list is always offered, even if no doctor has
    // picked it yet; anything a doctor entered before the list existed is added too.
    bookApptSpecialtyNames = {};
    SPECIALTY_OPTIONS.forEach(function(s){ bookApptSpecialtyNames[s.toLowerCase()] = s; });
    bookApptDoctors.forEach(function(d){
      doctorSpecialties(d).forEach(function(s){
        if (!bookApptSpecialtyNames[s.toLowerCase()]) bookApptSpecialtyNames[s.toLowerCase()] = s;
      });
    });
  }
  function renderFilterButtonAndChips(){
    var n = bookApptSpecialtyFilter.length;
    $('book-appt-filter-btn').textContent = n ? 'Filter (' + n + ')' : 'Filter';
    var chipsEl = $('book-appt-filter-chips');
    chipsEl.classList.toggle('hidden', !n);
    chipsEl.innerHTML = bookApptSpecialtyFilter.map(function(k){
      var label = bookApptSpecialtyNames[k] || k;
      return '<span class="chip">'+escapeHtml(label)+'<button type="button" data-key="'+escapeHtml(k)+'" aria-label="Remove '+escapeHtml(label)+' filter">&times;</button></span>';
    }).join('');
    chipsEl.querySelectorAll('button').forEach(function(b){
      b.addEventListener('click', function(){
        bookApptSpecialtyFilter = bookApptSpecialtyFilter.filter(function(k){ return k !== b.getAttribute('data-key'); });
        renderFilterButtonAndChips();
        applyBookApptFilters();
      });
    });
  }
  function applyBookApptFilters(){
    var q = $('book-appt-search-input').value.trim().toLowerCase();
    var filtered = bookApptDoctors.filter(function(d){
      if (bookApptSpecialtyFilter.length){
        var mine = doctorSpecialties(d).map(function(s){ return s.toLowerCase(); });
        if (!bookApptSpecialtyFilter.some(function(k){ return mine.indexOf(k) !== -1; })) return false;
      }
      if (!q) return true;
      if ((d.name || '').toLowerCase().indexOf(q) !== -1) return true;
      if ((d.specialty || '').toLowerCase().indexOf(q) !== -1) return true;
      if ((d.currentClinic || '').toLowerCase().indexOf(q) !== -1) return true;
      return (d.clinics || []).some(function(c){ return (c.name || '').toLowerCase().indexOf(q) !== -1; });
    });
    renderBookApptDoctorList(filtered);
  }
  function closeBookApptFilterModal(){ $('book-appt-filter-modal').classList.add('hidden'); }
  $('book-appt-filter-btn').addEventListener('click', function(){
    var keys = Object.keys(bookApptSpecialtyNames).sort(function(a, b){ return bookApptSpecialtyNames[a].localeCompare(bookApptSpecialtyNames[b]); });
    var listEl = $('book-appt-filter-options');
    listEl.innerHTML = keys.map(function(k){
      return '<label class="check-row"><input type="checkbox" value="'+escapeHtml(k)+'"'
        + (bookApptSpecialtyFilter.indexOf(k) !== -1 ? ' checked' : '') + '><span>'+escapeHtml(bookApptSpecialtyNames[k])+'</span></label>';
    }).join('');
    listEl.querySelectorAll('input').forEach(function(cb){
      cb.addEventListener('change', function(){
        bookApptSpecialtyFilter = Array.prototype.map.call(listEl.querySelectorAll('input:checked'), function(el){ return el.value; });
        renderFilterButtonAndChips();
        applyBookApptFilters();
      });
    });
    $('book-appt-filter-modal').classList.remove('hidden');
  });
  $('book-appt-filter-done').addEventListener('click', closeBookApptFilterModal);
  $('book-appt-filter-close').addEventListener('click', closeBookApptFilterModal);
  $('book-appt-filter-modal').addEventListener('click', function(e){ if (e.target === $('book-appt-filter-modal')) closeBookApptFilterModal(); });
  $('book-appt-filter-clear').addEventListener('click', function(){
    bookApptSpecialtyFilter = [];
    $('book-appt-filter-options').querySelectorAll('input').forEach(function(cb){ cb.checked = false; });
    renderFilterButtonAndChips();
    applyBookApptFilters();
  });
  $('book-appt-search-input').addEventListener('input', applyBookApptFilters);
  $('book-appt-change-doctor').addEventListener('click', function(){
    bookApptSelectedDoctor = null;
    bookApptSelectedClinic = null;
    bookApptSelectedSlot = null;
    $('book-appt-form-step').classList.add('hidden');
    $('book-appt-search-step').classList.remove('hidden');
  });
  // "Book appointment" doesn't insert directly — it opens a confirm modal
  // summarizing exactly what's about to be booked (doctor, clinic, address,
  // date, time), and the actual insert only happens from that modal's own
  // "Confirm booking" button.
  function openBookApptConfirmModal(){
    var d = bookApptSelectedDoctor;
    $('book-appt-confirm-doctor').textContent = doctorDisplayName(d);
    $('book-appt-confirm-clinic').textContent = bookApptSelectedSlot.clinicName;
    $('book-appt-confirm-address').textContent = bookApptSelectedClinicAddress || '';
    $('book-appt-confirm-address').classList.toggle('hidden', !bookApptSelectedClinicAddress);
    $('book-appt-confirm-date').textContent = formatDateDisplay(bookApptSelectedDate);
    $('book-appt-confirm-time').textContent = bookApptSelectedSlot.time;
    clearError($('book-appt-confirm-error'));
    $('book-appt-confirm-modal').classList.remove('hidden');
  }
  function closeBookApptConfirmModal(){ $('book-appt-confirm-modal').classList.add('hidden'); }
  $('book-appt-confirm-close').addEventListener('click', closeBookApptConfirmModal);
  $('book-appt-confirm-modal').addEventListener('click', function(e){ if (e.target === $('book-appt-confirm-modal')) closeBookApptConfirmModal(); });
  $('book-appt-save').addEventListener('click', function(){
    if (!bookApptSelectedDoctor) return;
    if (!bookApptSelectedDate){
      showError($('book-appt-error'), 'Please choose a date.');
      return;
    }
    if (!bookApptSelectedSlot){
      showError($('book-appt-error'), 'Please choose an available time.');
      return;
    }
    clearError($('book-appt-error'));
    openBookApptConfirmModal();
  });
  makeHoldButton($('book-appt-confirm-save'), 2000, async function(){
    var d = bookApptSelectedDoctor;
    var btn = $('book-appt-confirm-save');
    var label = btn.querySelector('.hold-label');
    clearError($('book-appt-confirm-error'));
    btn.disabled = true;
    label.textContent = 'Booking...';
    try{
      var row = {
        patient_id: activePatientId,
        doctor_id: d.id,
        doctor_name: doctorDisplayName(d),
        clinic_name: bookApptSelectedSlot.clinicName,
        clinic_address: bookApptSelectedClinicAddress || '',
        date: bookApptSelectedDate,
        time: bookApptSelectedSlot.time,
        reason: $('book-appt-reason').value.trim()
      };
      var res = await supabaseClient.from('appointments').insert(row).select().maybeSingle();
      if (res.error || !res.data){
        showError($('book-appt-confirm-error'), (res.error && res.error.code === '23505')
          ? 'That time was just booked by someone else — pick another.'
          : 'Something went wrong booking this appointment. Please try again.');
        closeBookApptConfirmModal();
        await renderBookApptSlots();
        return;
      }
      await createTrustGrant(activePatientId, d.id);
      currentPatientData.appointments = [mapAppointmentRow(res.data)].concat(currentPatientData.appointments || []);
      renderAppointmentsList(currentPatientData.appointments);
      renderAppointmentsCalendar(currentPatientData.appointments);
      closeBookApptConfirmModal();
      showView('view-patient-dash');
    }catch(e){
      showError($('book-appt-confirm-error'), 'Something went wrong booking this appointment. Please try again.');
    }finally{
      btn.disabled = false;
      label.textContent = 'Hold to confirm booking';
    }
  });
  $('pat-book-appt-btn').addEventListener('click', openBookApptPage);
  $('book-appt-cancel').addEventListener('click', function(){ showView('view-patient-dash'); });

  // Above 1180px both the health card and the calendar/appointments column are
  // position:sticky (see .sticky-inner in style.css). A sticky element's "room to
  // stay pinned" before it releases depends on its own height relative to its
  // (shared, equal) container — so when the two sticky panels have different content
  // heights, the taller one runs out of room and un-sticks before the shorter one,
  // which looks like it "gives up" scrolling early. Padding the shorter one to match
  // the taller one's real height keeps both releasing at the same scroll position,
  // and re-measuring (instead of a hardcoded number) keeps this correct as content
  // like the checklist or appointment count changes.
  function syncStickyColumnHeights(){
    var a = document.querySelector('.sidebar .sticky-inner');
    var b = document.querySelector('.right-col .sticky-inner');
    if (!a || !b || $('view-patient-dash').classList.contains('hidden')) return;
    a.style.minHeight = '';
    b.style.minHeight = '';
    if (window.innerWidth <= 1180) return;
    var max = Math.max(a.getBoundingClientRect().height, b.getBoundingClientRect().height);
    a.style.minHeight = max + 'px';
    b.style.minHeight = max + 'px';
  }
  var stickyResizeTimer = null;
  window.addEventListener('resize', function(){
    clearTimeout(stickyResizeTimer);
    stickyResizeTimer = setTimeout(syncStickyColumnHeights, 150);
  });

  function renderVisitDetail(v){
    $('pat-visit-detail-empty').classList.add('hidden');
    $('pat-visit-detail').classList.remove('hidden');
    $('visit-detail-date').textContent = formatDateDisplay(v.date) + (v.time ? ' · ' + v.time : '');
    $('visit-detail-doctor').innerHTML = escapeHtml(v.doctorName || 'Doctor') + unverifiedTagHtml(v);
    $('visit-detail-clinic').textContent = v.clinicName || 'Not recorded';
    $('visit-detail-symptoms').textContent = v.symptoms || 'Not recorded';
    $('visit-detail-diagnosis').textContent = v.diagnosis || 'Not recorded';
    $('visit-detail-prescription').textContent = v.prescription || 'Not recorded';
    $('visit-detail-notes').textContent = v.notes || 'Not recorded';
  }

  // The Lab Results report viewer, shared by the patient's page ('test-detail')
  // and the doctor's patient-record page ('doc-test-detail') — the two panels have
  // the same markup shape, so every id is built from that prefix. A report with a
  // file is fetched as a blob (the bucket is private, and a blob URL also sidesteps
  // the storage server's locked-down headers that can stop a PDF rendering inside
  // an iframe) and shown in the right-hand panel; a report without one shows its
  // text instead.
  var patTestDetailCurrent = null;
  var testViewers = {};   // prefix -> { url: blob URL on screen, token: bumped on every change }
  function testViewerState(prefix){
    return testViewers[prefix] || (testViewers[prefix] = { url: '', token: 0 });
  }
  function clearTestViewer(prefix){
    var st = testViewerState(prefix);
    st.token++;
    if (st.url){ URL.revokeObjectURL(st.url); st.url = ''; }
    $(prefix + '-viewer').innerHTML = '';
  }
  // Fills one detail panel's report area for test t (viewer + "Open in new tab").
  function renderTestReport(prefix, t){
    $(prefix + '-viewer-wrap').classList.toggle('hidden', !t.reportFilePath);
    // A patient upload with no typed summary has nothing to say beyond the file itself.
    var hideSummary = !t.resultSummary && !!t.reportFilePath;
    $(prefix + '-result-label').classList.toggle('hidden', hideSummary);
    $(prefix + '-result').classList.toggle('hidden', hideSummary);
    if (t.reportFilePath) showTestViewer(prefix, t);
    else { clearTestViewer(prefix); clearError($(prefix + '-file-error')); }
  }
  function wireTestOpenButton(prefix){
    $(prefix + '-file-btn').addEventListener('click', function(){
      // The blob is already in hand, so this opens straight away — no popup-blocker dance.
      var url = testViewerState(prefix).url;
      if (url) window.open(url, '_blank');
    });
  }
  function testReportMimeType(path){
    var ext = (path.split('.').pop() || '').toLowerCase();
    return { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[ext] || '';
  }
  var PDFJS_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/';
  var pdfjsPromise = null;
  // PDF.js is only needed once someone opens a PDF report, so it's fetched on
  // first use instead of weighing down every page load.
  function loadPdfJs(){
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (!pdfjsPromise){
      pdfjsPromise = new Promise(function(resolve, reject){
        var sc = document.createElement('script');
        sc.src = PDFJS_BASE + 'pdf.min.js';
        sc.onload = function(){
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'pdf.worker.min.js';
          resolve(window.pdfjsLib);
        };
        sc.onerror = function(){ pdfjsPromise = null; reject(new Error('PDF.js failed to load')); };
        document.head.appendChild(sc);
      });
    }
    return pdfjsPromise;
  }
  async function showTestViewer(prefix, t){
    var viewer = $(prefix + '-viewer');
    var errEl = $(prefix + '-file-error');
    var st = testViewerState(prefix);
    clearError(errEl);
    clearTestViewer(prefix);
    var token = st.token;
    viewer.textContent = 'Loading report...';
    var res = await supabaseClient.storage.from(TEST_REPORT_BUCKET).download(t.reportFilePath);
    if (token !== st.token) return;   // a different report was picked meanwhile
    if (res.error || !res.data){
      viewer.innerHTML = '';
      showError(errEl, 'Couldn\'t load this report. It may have been removed, or your access may have changed.');
      return;
    }
    var type = testReportMimeType(t.reportFilePath) || res.data.type;
    st.url = URL.createObjectURL(new Blob([res.data], { type: type }));
    viewer.innerHTML = '';
    viewer.classList.toggle('pdf-pages', type === 'application/pdf');
    if (type !== 'application/pdf'){
      var img = document.createElement('img');
      img.alt = t.name || 'Report';
      img.src = st.url;
      viewer.appendChild(img);
      return;
    }
    // A PDF is drawn page by page onto plain canvases (PDF.js) so it reads as the
    // document itself rather than sitting inside the browser's PDF viewer with its
    // toolbar and side rail. If PDF.js can't load or the file can't be parsed, fall
    // back to the browser's own viewer so the report is still readable.
    try{
      var pdfjs = await loadPdfJs();
      var pdf = await pdfjs.getDocument({ data: await res.data.arrayBuffer() }).promise;
      var cssWidth = viewer.clientWidth || 600;
      var ratio = window.devicePixelRatio || 1;
      for (var n = 1; n <= pdf.numPages; n++){
        var page = await pdf.getPage(n);
        if (token !== st.token){ pdf.destroy(); return; }
        var base = page.getViewport({ scale: 1 });
        var vp = page.getViewport({ scale: (cssWidth / base.width) * ratio });
        var canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        if (token !== st.token){ pdf.destroy(); return; }
        if (n === 1) viewer.innerHTML = '';   // clears "Loading report..." once page 1 is ready
        viewer.appendChild(canvas);
      }
    }catch(e){
      if (token !== st.token) return;
      viewer.classList.remove('pdf-pages');
      viewer.innerHTML = '';
      var frame = document.createElement('iframe');
      frame.title = t.name || 'Report';
      frame.src = st.url;
      viewer.appendChild(frame);
    }
  }
  function renderTestDetail(t){
    $('pat-test-detail-empty').classList.add('hidden');
    $('pat-test-detail').classList.remove('hidden');
    $('test-detail-date').textContent = formatUploadedDate(t.date);
    $('test-detail-name').innerHTML = escapeHtml(t.name || 'Test') + testTagHtml(t, 'patient');
    $('test-detail-doctor-label').textContent = t.uploadedByPatient ? 'Added by' : 'Ordered by';
    $('test-detail-doctor').textContent = t.uploadedByPatient ? 'You (uploaded)' : (t.doctorName || 'Not recorded');
    $('test-detail-result').textContent = t.resultSummary || 'No result summary added yet.';
    patTestDetailCurrent = t;
    renderTestReport('test-detail', t);
    // Delete is only ever offered for a report the patient uploaded themselves —
    // a doctor-written test isn't theirs to remove (the database enforces the same).
    $('test-detail-delete-wrap').classList.toggle('hidden', !t.uploadedByPatient);
    clearError($('test-detail-delete-error'));
  }
  wireTestOpenButton('test-detail');
  wireTestOpenButton('doc-test-detail');

  // ---- My Eyes ----
  // Clinical range per field, used both to position the number-line marker and
  // as the fixed min/max labels shown at each end of the line.
  var EYE_RANGES = { sph: [-40, 20], cyl: [-8, 8], axis: [1, 180] };
  function fmtDiopter(v){
    var n = parseFloat(v);
    if (v === '' || v === null || v === undefined || isNaN(n)) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(2);
  }
  // One "value plotted on a line spanning [min,max]" row — the core visual unit
  // the whole prescription panel (current + previous) is built from.
  function numberLineHtml(label, value, range, isAxis){
    var min = range[0], max = range[1];
    var n = parseFloat(value);
    var hasVal = value !== '' && value !== null && value !== undefined && !isNaN(n);
    var pct = hasVal ? Math.max(0, Math.min(100, ((n - min) / (max - min)) * 100)) : 0;
    var displayVal = hasVal ? (isAxis ? (Math.round(n) + '°') : fmtDiopter(n)) : null;
    return '<div class="number-line">'
      + '<div class="number-line-label">' + label + '</div>'
      + '<div class="number-line-track">'
      + (hasVal ? '<div class="number-line-marker" style="left:' + pct + '%;"><span class="number-line-value">' + escapeHtml(displayVal) + '</span></div>' : '')
      + '</div>'
      + '<div class="number-line-range"><span>' + min + '</span><span>' + max + '</span></div>'
      + (hasVal ? '' : '<div class="number-line-empty">Not recorded</div>')
      + '</div>';
  }
  // Shared by the "current prescription" panel and every row of the "previous
  // prescriptions" list, so both stay visually identical as requested.
  function eyeRxColumnsHtml(entry){
    return '<div class="eye-rx-columns">'
      + '<div><div class="eye-rx-col-label">Left eye</div>'
        + numberLineHtml('SPH', entry.sphL, EYE_RANGES.sph, false)
        + numberLineHtml('CYL', entry.cylL, EYE_RANGES.cyl, false)
        + numberLineHtml('Axis', entry.axisL, EYE_RANGES.axis, true)
      + '</div>'
      + '<div><div class="eye-rx-col-label">Right eye</div>'
        + numberLineHtml('SPH', entry.sphR, EYE_RANGES.sph, false)
        + numberLineHtml('CYL', entry.cylR, EYE_RANGES.cyl, false)
        + numberLineHtml('Axis', entry.axisR, EYE_RANGES.axis, true)
      + '</div>'
      + '</div>';
  }
  // "Previous prescriptions" is a plain list of dates; clicking one drops down
  // the same number-line detail used for the current prescription, directly
  // under that date, rather than opening a second modal per entry.
  function renderEyeRxPrevModalList(previous){
    $('eye-rx-prev-modal-list').innerHTML = previous.map(function(e, i){
      return '<div class="eye-rx-prev-row" data-idx="' + i + '">'
        + '<button class="eye-rx-prev-row-toggle" type="button">'
        + '<span>' + escapeHtml(formatDateDisplay(e.date)) + '</span>' + chevronSvg
        + '</button>'
        + '<div class="eye-rx-prev-row-detail hidden">' + eyeRxColumnsHtml(e) + '</div>'
        + '</div>';
    }).join('');
    $('eye-rx-prev-modal-list').querySelectorAll('.eye-rx-prev-row-toggle').forEach(function(btn){
      btn.addEventListener('click', function(){
        var row = btn.closest('.eye-rx-prev-row');
        var detail = row.querySelector('.eye-rx-prev-row-detail');
        var opening = detail.classList.contains('hidden');
        detail.classList.toggle('hidden', !opening);
        row.classList.toggle('open', opening);
      });
    });
  }
  function openEyeRxPrevModal(){ $('eye-rx-prev-modal').classList.remove('hidden'); }
  function closeEyeRxPrevModal(){ $('eye-rx-prev-modal').classList.add('hidden'); }
  $('eye-rx-prev-modal-close').addEventListener('click', closeEyeRxPrevModal);
  $('eye-rx-prev-modal').addEventListener('click', function(e){ if (e.target === $('eye-rx-prev-modal')) closeEyeRxPrevModal(); });
  $('eye-rx-prev-toggle').addEventListener('click', openEyeRxPrevModal);

  function renderEyesList(entries){
    var emptyEl = $('pat-eyes-empty');
    var currentPanel = $('eye-rx-current-panel');
    var prevToggle = $('eye-rx-prev-toggle');
    var chartsEl = $('pat-eyes-charts');
    if (!entries || !entries.length){
      currentPanel.classList.add('hidden');
      prevToggle.classList.add('hidden');
      closeEyeRxPrevModal();
      chartsEl.classList.add('hidden');
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    currentPanel.classList.remove('hidden');

    // entries are loaded newest-first (see enterPatientDash's order('date',
    // {ascending:false}) query) and new saves are unshifted to match.
    var current = entries[0];
    var previous = entries.slice(1);

    $('eye-rx-current-date').textContent = formatDateDisplay(current.date);
    $('eye-rx-current-columns').innerHTML = eyeRxColumnsHtml(current);

    if (previous.length){
      prevToggle.classList.remove('hidden');
      prevToggle.textContent = 'Previous prescriptions (' + previous.length + ')';
      renderEyeRxPrevModalList(previous);
    } else {
      prevToggle.classList.add('hidden');
      closeEyeRxPrevModal();
      $('eye-rx-prev-modal-list').innerHTML = '';
    }

    chartsEl.classList.remove('hidden');
    renderEyeMetricChart('eyes-sph-chart-wrap', entries, 'sphL', 'sphR');
    renderEyeMetricChart('eyes-cyl-chart-wrap', entries, 'cylL', 'cylR');
  }
  // The trend charts plot real elapsed time (not just entry order), spanning at
  // least 3 years even if the actual data covers less — a lone data point still
  // reads as a point on a real timeline rather than stretching to fill the chart.
  function renderEyeMetricChart(containerId, entries, leftKey, rightKey){
    var wrap = $(containerId);
    var sorted = entries.filter(function(e){ return e.date; }).slice().sort(function(a, b){
      return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0);
    });
    var n = sorted.length;
    if (!n){ wrap.innerHTML = ''; return; }
    var vals = [];
    sorted.forEach(function(e){
      var l = parseFloat(e[leftKey]); if (!isNaN(l)) vals.push(l);
      var r = parseFloat(e[rightKey]); if (!isNaN(r)) vals.push(r);
    });
    if (!vals.length){ wrap.innerHTML = ''; return; }
    // Whole-number y-axis bounds/ticks, per spec — padded by half a unit before
    // rounding so a data point never lands exactly on the top/bottom edge.
    var minV = Math.floor(Math.min.apply(null, vals) - 0.5);
    var maxV = Math.ceil(Math.max.apply(null, vals) + 0.5);
    if (minV === maxV){ minV -= 1; maxV += 1; }

    var MS_DAY = 24 * 60 * 60 * 1000;
    var THREE_YEARS_MS = 3 * 365.25 * MS_DAY;
    var firstT = parseLocalDate(sorted[0].date).getTime();
    var lastT = parseLocalDate(sorted[n - 1].date).getTime();
    var xEnd = lastT;
    var xStart = Math.min(firstT, xEnd - THREE_YEARS_MS);

    var w = 580, h = 200, padL = 34, padR = 12, padT = 14, padB = 26;
    var innerW = w - padL - padR, innerH = h - padT - padB;
    function x(dateStr){ return padL + ((parseLocalDate(dateStr).getTime() - xStart) / (xEnd - xStart)) * innerW; }
    function y(v){ return padT + innerH - ((v - minV) / (maxV - minV)) * innerH; }

    function buildLine(key, color){
      var pts = [];
      sorted.forEach(function(e){
        var v = parseFloat(e[key]);
        if (!isNaN(v)) pts.push({ date: e.date, v: v });
      });
      if (!pts.length) return '';
      var line = pts.map(function(p){ return x(p.date) + ',' + y(p.v); }).join(' ');
      var dots = pts.map(function(p){
        return '<circle cx="'+x(p.date)+'" cy="'+y(p.v)+'" r="3" fill="'+color+'"><title>'+escapeHtml(formatDateDisplay(p.date))+': '+fmtDiopter(p.v)+'</title></circle>';
      }).join('');
      return '<polyline points="'+line+'" fill="none" stroke="'+color+'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' + dots;
    }

    var yTicks = [minV, Math.round((minV + maxV) / 2), maxV].filter(function(v, i, a){ return a.indexOf(v) === i; });
    var gridHtml = yTicks.map(function(t){
      var yy = y(t);
      return '<line x1="'+padL+'" y1="'+yy+'" x2="'+(w-padR)+'" y2="'+yy+'" stroke="var(--line)" stroke-width="1"/>'
        + '<text x="'+(padL-8)+'" y="'+(yy+3)+'" text-anchor="end" font-size="9" fill="var(--muted)" font-family=\'IBM Plex Mono, monospace\'>'+t+'</text>';
    }).join('');

    // One label per calendar year the (>=3-year) axis actually spans.
    var startYear = new Date(xStart).getFullYear();
    var endYear = new Date(xEnd).getFullYear();
    var xLabelsHtml = '';
    for (var yr = startYear; yr <= endYear; yr++){
      var t = new Date(yr, 0, 1).getTime();
      if (t < xStart || t > xEnd) continue;
      var xx = padL + ((t - xStart) / (xEnd - xStart)) * innerW;
      xLabelsHtml += '<text x="'+xx+'" y="'+(h-8)+'" text-anchor="middle" font-size="9" fill="var(--muted)" font-family=\'IBM Plex Mono, monospace\'>'+yr+'</text>';
    }

    wrap.innerHTML = '<svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none">'
      + gridHtml
      + buildLine(leftKey, 'var(--teal)')
      + buildLine(rightKey, 'var(--red)')
      + xLabelsHtml
      + '</svg>'
      + '<div class="chart-legend"><span><span class="legend-dot" style="background:var(--teal);"></span>Left eye</span>'
      + '<span><span class="legend-dot" style="background:var(--red);"></span>Right eye</span></div>';
  }

  function openAddEyeModal(){
    $('eye-date').value = new Date().toISOString().slice(0, 10);
    $('eye-sph-l').value = '';
    $('eye-cyl-l').value = '';
    $('eye-axis-l').value = '';
    $('eye-sph-r').value = '';
    $('eye-cyl-r').value = '';
    $('eye-axis-r').value = '';
    clearError($('add-eye-error'));
    $('add-eye-modal').classList.remove('hidden');
  }
  function closeAddEyeModal(){ $('add-eye-modal').classList.add('hidden'); }
  $('add-eye-btn').addEventListener('click', openAddEyeModal);
  $('add-eye-close').addEventListener('click', closeAddEyeModal);
  $('add-eye-cancel').addEventListener('click', closeAddEyeModal);
  $('add-eye-modal').addEventListener('click', function(e){ if (e.target === $('add-eye-modal')) closeAddEyeModal(); });
  $('add-eye-save').addEventListener('click', async function(){
    var date = $('eye-date').value;
    if (!date){
      showError($('add-eye-error'), 'Please choose a date.');
      return;
    }
    clearError($('add-eye-error'));
    var row = {
      patient_id: activePatientId,
      date: date,
      sph_l: $('eye-sph-l').value.trim(),
      cyl_l: $('eye-cyl-l').value.trim(),
      axis_l: $('eye-axis-l').value.trim(),
      sph_r: $('eye-sph-r').value.trim(),
      cyl_r: $('eye-cyl-r').value.trim(),
      axis_r: $('eye-axis-r').value.trim()
    };
    $('add-eye-save').disabled = true;
    $('add-eye-save').textContent = 'Saving...';
    try{
      var res = await supabaseClient.from('eye_entries').insert(row).select().maybeSingle();
      if (res.error || !res.data){
        showError($('add-eye-error'), 'Something went wrong saving this entry. Please try again.');
        return;
      }
      currentPatientData.eyeEntries.unshift(mapEyeRow(res.data));
      renderEyesList(currentPatientData.eyeEntries);
      closeAddEyeModal();
      var note = $('add-eye-note');
      note.classList.add('show');
      setTimeout(function(){ note.classList.remove('show'); }, 2200);
    }catch(err){
      showError($('add-eye-error'), 'Something went wrong saving this entry. Please try again.');
    }finally{
      $('add-eye-save').disabled = false;
      $('add-eye-save').textContent = 'Save prescription';
    }
  });

  // ---- Blood Pressure ----
  // Patient-owned like My Eyes: a log the patient (or a guardian) keeps for themselves,
  // with no doctor access. Readings load newest-first and a new save is unshifted to
  // match. measured_at is a real timestamp, so a reading sorts and charts by when it
  // was taken, not when it was typed in.
  function mapBpRow(row){
    return {
      id: row.id, measuredAt: row.measured_at, systolic: row.systolic, diastolic: row.diastolic,
      pulse: (row.pulse === null || row.pulse === undefined) ? null : row.pulse, note: row.note || ''
    };
  }
  // The usual adult bands (AHA). Shown as a label for tracking, never as a diagnosis.
  function bpCategory(sys, dia){
    if (sys > 180 || dia > 120) return { label: 'Very high', tone: 'high', urgent: true };
    if (sys >= 140 || dia >= 90) return { label: 'High (stage 2)', tone: 'high' };
    if (sys >= 130 || dia >= 80) return { label: 'High (stage 1)', tone: 'elevated' };
    if (sys >= 120) return { label: 'Elevated', tone: 'elevated' };
    return { label: 'Normal', tone: 'normal' };
  }
  function formatBpWhen(iso){
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, { day:'numeric', month:'short', year:'numeric' })
      + ', ' + d.toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
  }
  function bpReading(e){ return e.systolic + '/' + e.diastolic; }
  // A small heart and the pulse, for sitting right beside a reading ("120/80 mmHg ♥ 72").
  function bpPulseInner(pulse){
    return '<svg width="11" height="11" viewBox="9.5 6.5 11 10.5" aria-hidden="true"><path d="M19,8.3 C18,7.3 16.3,7.3 15.3,8.3 L15,8.6 L14.7,8.3 C13.7,7.3 12,7.3 11,8.3 C10,9.3 10,11 11,12 L15,16 L19,12 C20,11 20,9.3 19,8.3 Z" fill="currentColor"/></svg>' + pulse;
  }
  function bpPulseHtml(pulse){
    if (pulse === null || pulse === undefined) return '';
    return '<span class="bp-pulse" title="Pulse, beats per minute">' + bpPulseInner(pulse) + '</span>';
  }
  var BIN_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5,4 H13.5 M6,4 V2.5 H10 V4 M4,4 L4.7,13.5 H11.3 L12,4 M6.6,6.5 V11 M9.4,6.5 V11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function setBpCategory(el, cat){
    el.textContent = cat.label;
    el.className = 'bp-category ' + cat.tone;
  }

  var BP_LIST_INITIAL = 15;
  var bpShowAll = false;
  function renderBpPage(entries){
    entries = entries || [];
    var has = entries.length > 0;
    $('pat-bp-empty').classList.toggle('hidden', has);
    $('bp-latest').classList.toggle('hidden', !has);
    $('pat-bp-chart-panel').classList.toggle('hidden', !has);
    $('pat-bp-list-panel').classList.toggle('hidden', !has);
    if (!has){
      $('pat-bp-list').innerHTML = '';
      $('bp-chart-wrap').innerHTML = '';
      bpShowAll = false;
      return;
    }
    var latest = entries[0];
    var cat = bpCategory(latest.systolic, latest.diastolic);
    $('bp-latest-value').textContent = bpReading(latest);
    $('bp-latest-meta').textContent = formatBpWhen(latest.measuredAt);
    if (latest.pulse !== null) $('bp-latest-pulse').innerHTML = bpPulseInner(latest.pulse);
    $('bp-latest-pulse').classList.toggle('hidden', latest.pulse === null);
    setBpCategory($('bp-latest-category'), cat);
    $('bp-latest-hint').textContent = cat.urgent
      ? 'A reading this high needs medical attention. If you also have chest pain, shortness of breath, weakness or a severe headache, get emergency help now.'
      : 'For your own tracking — this label isn\'t a diagnosis. Talk to your doctor about your readings.';

    var shown = bpShowAll ? entries : entries.slice(0, BP_LIST_INITIAL);
    clearError($('pat-bp-list-error'));
    $('pat-bp-list').innerHTML = shown.map(function(e){
      var c = bpCategory(e.systolic, e.diastolic);
      return '<div class="list-item static">'
        + '<div>'
        + '<div class="li-title"><span class="bp-row-value">'+escapeHtml(bpReading(e))+'</span> mmHg'
        + bpPulseHtml(e.pulse)
        + '<span class="bp-category sm '+c.tone+'">'+escapeHtml(c.label)+'</span></div>'
        + '<div class="li-sub">'+escapeHtml(formatBpWhen(e.measuredAt))+'</div>'
        + (e.note ? '<div class="li-sub bp-note">'+escapeHtml(e.note)+'</div>' : '')
        + '</div>'
        + '<button class="btn btn-secondary btn-sm hold-btn hold-btn-danger bp-del-btn" type="button" data-id="'+escapeHtml(e.id)+'" title="Press and hold to delete" aria-label="Press and hold to delete this reading">'
        + '<span class="hold-fill"></span><span class="hold-label">'+BIN_SVG+'</span></button>'
        + '</div>';
    }).join('');
    // Press-and-hold like the app's other irreversible deletes. The delete is checked by
    // asking for the deleted row back, so an RLS-blocked delete can't look like it worked.
    $('pat-bp-list').querySelectorAll('.bp-del-btn').forEach(function(btn){
      makeHoldButton(btn, 2000, async function(){
        var id = btn.getAttribute('data-id');
        clearError($('pat-bp-list-error'));
        var res = await supabaseClient.from('bp_entries').delete().eq('id', id).select();
        if (res.error || !res.data || !res.data.length){
          showError($('pat-bp-list-error'), 'Couldn\'t delete this reading. Please try again.');
          return;
        }
        currentPatientData.bpEntries = currentPatientData.bpEntries.filter(function(e){ return e.id !== id; });
        renderBpPage(currentPatientData.bpEntries);
      });
    });
    var hidden = entries.length - shown.length;
    $('pat-bp-more-btn').classList.toggle('hidden', hidden <= 0);
    $('pat-bp-more-btn').textContent = 'Show older readings (' + hidden + ')';

    renderBpChart();
  }
  $('pat-bp-more-btn').addEventListener('click', function(){
    bpShowAll = true;
    renderBpPage(currentPatientData.bpEntries);
  });

  // Which stretch of time the trend chart covers. Today is the calendar day (so the axis
  // shows the whole day, with the rest still to come); 30 days, 6 months and 1 year are
  // rolling windows counted back from now; All runs from the first reading to the latest,
  // never less than a week so a lone reading still sits on a timeline.
  var bpRange = 'all';
  var BP_MS_DAY = 24 * 60 * 60 * 1000;
  function bpRangeWindow(range, entries){
    var now = new Date(), y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
    // A reading may be dated a few minutes ahead (the form allows 5), so rolling windows
    // reach slightly past now rather than clipping it.
    var soon = now.getTime() + 10 * 60 * 1000;
    if (range === 'today') return { start: new Date(y, m, d).getTime(), end: new Date(y, m, d + 1).getTime() };
    if (range === '30d') return { start: new Date(y, m, d - 30).getTime(), end: soon };
    if (range === '6m') return { start: new Date(y, m - 6, d).getTime(), end: soon };
    if (range === '1y') return { start: new Date(y - 1, m, d).getTime(), end: soon };
    var newest = new Date(entries[0].measuredAt).getTime();
    var oldest = new Date(entries[entries.length - 1].measuredAt).getTime();
    return { start: Math.min(oldest, newest - 7 * BP_MS_DAY), end: newest + 1 };   // +1ms: the window is end-exclusive
  }

  // Systolic (teal) and diastolic (red) against real elapsed time, drawn at the
  // container's real pixel width so its text isn't stretched on a phone.
  function renderBpChart(){
    var wrap = $('bp-chart-wrap');
    var entries = currentPatientData && currentPatientData.bpEntries;
    if (!wrap || !entries || !entries.length){ if (wrap) wrap.innerHTML = ''; return; }
    document.querySelectorAll('#bp-range .bp-range-btn').forEach(function(btn){
      btn.classList.toggle('active', btn.getAttribute('data-range') === bpRange);
    });
    var win = bpRangeWindow(bpRange, entries);
    var pts = entries.filter(function(e){
      var t = new Date(e.measuredAt).getTime();
      return t >= win.start && t < win.end;
    }).reverse();   // oldest first
    var subEl = $('pat-bp-chart-sub');
    if (!pts.length){
      subEl.textContent = 'No readings in this period.';
      wrap.innerHTML = '';
      return;
    }
    var avgSys = Math.round(pts.reduce(function(a, e){ return a + e.systolic; }, 0) / pts.length);
    var avgDia = Math.round(pts.reduce(function(a, e){ return a + e.diastolic; }, 0) / pts.length);
    subEl.textContent = pts.length + (pts.length === 1 ? ' reading' : ' readings') + ' · average ' + avgSys + '/' + avgDia + ' mmHg';
    var w = wrap.clientWidth;
    if (!w) return;   // page not showing yet — showView() calls this again once it is

    var h = 210, padL = 34, padR = 14, padT = 12, padB = 28;
    var innerW = w - padL - padR, innerH = h - padT - padB;
    var span = win.end - win.start;
    var lo = Infinity, hi = -Infinity;
    pts.forEach(function(e){ lo = Math.min(lo, e.diastolic); hi = Math.max(hi, e.systolic); });
    var minV = Math.floor((lo - 10) / 10) * 10, maxV = Math.ceil((hi + 10) / 10) * 10;
    var step = (maxV - minV) > 100 ? 40 : 20;
    function xAt(t){ return padL + ((t - win.start) / span) * innerW; }
    function x(iso){ return xAt(new Date(iso).getTime()); }
    function y(v){ return padT + innerH - ((v - minV) / (maxV - minV)) * innerH; }
    var mono = 'font-size="9" fill="var(--muted)" font-family=\'IBM Plex Mono, monospace\'';

    var grid = '';
    for (var v = minV; v <= maxV; v += step){
      grid += '<line x1="'+padL+'" y1="'+y(v)+'" x2="'+(w-padR)+'" y2="'+y(v)+'" stroke="var(--line)" stroke-width="1"/>'
        + '<text x="'+(padL-7)+'" y="'+(y(v)+3)+'" text-anchor="end" '+mono+'>'+v+'</text>';
    }
    // Axis labels: hours across a day; otherwise start / middle / end dates (with the
    // year once the window is long enough for the month alone to be ambiguous).
    var ticks = [];
    if (bpRange === 'today'){
      var base = new Date(win.start);
      [0, 6, 12, 18, 24].forEach(function(hr){
        var t = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hr).getTime();
        var h12 = hr % 12 === 0 ? 12 : hr % 12;
        ticks.push({ t: t, text: h12 + (hr % 24 < 12 ? ' AM' : ' PM') });
      });
    } else {
      var fmt = span > 300 * BP_MS_DAY ? { month:'short', year:'numeric' } : { day:'numeric', month:'short' };
      [win.start, (win.start + win.end) / 2, win.end].forEach(function(t, i){
        // The end tick sits a few minutes past now; label it with now so a late-night
        // look can't read as tomorrow.
        var shown = i === 2 ? Math.min(t, Date.now()) : t;
        ticks.push({ t: t, text: new Date(shown).toLocaleDateString(undefined, fmt) });
      });
    }
    var xLabels = ticks.map(function(tk, i){
      var anchor = i === 0 ? 'start' : (i === ticks.length - 1 ? 'end' : 'middle');
      return '<text x="'+xAt(tk.t)+'" y="'+(h-9)+'" text-anchor="'+anchor+'" '+mono+'>'+escapeHtml(tk.text)+'</text>';
    }).join('');

    var r = pts.length > 60 ? 2 : 3;
    function line(key, color, label){
      var poly = pts.map(function(e){ return x(e.measuredAt)+','+y(e[key]); }).join(' ');
      var dots = pts.map(function(e){
        return '<circle cx="'+x(e.measuredAt)+'" cy="'+y(e[key])+'" r="'+r+'" fill="'+color+'"><title>'
          + escapeHtml(formatBpWhen(e.measuredAt)+' — '+label+' '+e[key])+'</title></circle>';
      }).join('');
      return '<polyline points="'+poly+'" fill="none" stroke="'+color+'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' + dots;
    }
    wrap.innerHTML = '<svg width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'">'
      + grid + xLabels + line('systolic', 'var(--teal)', 'Systolic') + line('diastolic', 'var(--red)', 'Diastolic')
      + '</svg>'
      + '<div class="chart-legend"><span><span class="legend-dot" style="background:var(--teal);"></span>Systolic</span>'
      + '<span><span class="legend-dot" style="background:var(--red);"></span>Diastolic</span></div>';
  }
  document.querySelectorAll('#bp-range .bp-range-btn').forEach(function(btn){
    btn.addEventListener('click', function(){
      bpRange = btn.getAttribute('data-range');
      renderBpChart();
    });
  });
  window.addEventListener('resize', function(){
    if (!$('view-patient-bp').classList.contains('hidden')) renderBpChart();
  });

  function pad2(n){ return (n < 10 ? '0' : '') + n; }
  function openAddBpModal(){
    var now = new Date();
    $('bp-date').value = toDateKey(now);
    $('bp-time').value = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
    ['bp-sys', 'bp-dia', 'bp-pulse', 'bp-note'].forEach(function(id){ $(id).value = ''; });
    clearError($('add-bp-error'));
    $('add-bp-modal').classList.remove('hidden');
  }
  function closeAddBpModal(){ $('add-bp-modal').classList.add('hidden'); }
  $('add-bp-btn').addEventListener('click', openAddBpModal);
  $('add-bp-close').addEventListener('click', closeAddBpModal);
  $('add-bp-cancel').addEventListener('click', closeAddBpModal);
  $('add-bp-modal').addEventListener('click', function(e){ if (e.target === $('add-bp-modal')) closeAddBpModal(); });
  $('add-bp-save').addEventListener('click', async function(){
    var errEl = $('add-bp-error');
    clearError(errEl);
    var date = $('bp-date').value, time = $('bp-time').value;
    if (!date || !time){ showError(errEl, 'Please choose a date and time.'); return; }
    var when = new Date(date + 'T' + time);   // local time
    if (isNaN(when.getTime())){ showError(errEl, 'Please choose a valid date and time.'); return; }
    if (when.getTime() > Date.now() + 5 * 60 * 1000){ showError(errEl, 'The date and time can\'t be in the future.'); return; }
    function whole(id){
      var raw = $(id).value.trim();
      return /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
    }
    var sys = whole('bp-sys'), dia = whole('bp-dia');
    if (isNaN(sys) || isNaN(dia)){ showError(errEl, 'Enter both the systolic (top) and diastolic (bottom) numbers.'); return; }
    if (sys < 50 || sys > 300){ showError(errEl, 'Systolic should be between 50 and 300.'); return; }
    if (dia < 30 || dia > 200){ showError(errEl, 'Diastolic should be between 30 and 200.'); return; }
    if (sys <= dia){ showError(errEl, 'Systolic (top) should be higher than diastolic (bottom).'); return; }
    var pulse = null;
    if ($('bp-pulse').value.trim() !== ''){
      pulse = whole('bp-pulse');
      if (isNaN(pulse) || pulse < 20 || pulse > 250){ showError(errEl, 'Pulse should be between 20 and 250.'); return; }
    }
    var row = {
      patient_id: activePatientId, measured_at: when.toISOString(),
      systolic: sys, diastolic: dia, pulse: pulse, note: $('bp-note').value.trim()
    };
    $('add-bp-save').disabled = true;
    $('add-bp-save').textContent = 'Saving...';
    try{
      var res = await supabaseClient.from('bp_entries').insert(row).select().maybeSingle();
      if (res.error || !res.data){
        if (res.error) console.warn('Could not save blood pressure reading:', res.error.message);
        showError(errEl, 'Something went wrong saving this reading. Please try again.');
        return;
      }
      var entries = currentPatientData.bpEntries;
      entries.push(mapBpRow(res.data));
      // Back-dated readings belong in date order, not at the top.
      entries.sort(function(a, b){ return new Date(b.measuredAt) - new Date(a.measuredAt); });
      renderBpPage(entries);
      closeAddBpModal();
      var note = $('add-bp-note');
      note.classList.add('show');
      setTimeout(function(){ note.classList.remove('show'); }, 2200);
    }catch(err){
      showError(errEl, 'Something went wrong saving this reading. Please try again.');
    }finally{
      $('add-bp-save').disabled = false;
      $('add-bp-save').textContent = 'Save reading';
    }
  });

  // ================= DOCTOR DASHBOARD =================
  var currentDoctorData = null;
  function getDoctorInitials(name){
    if (!name || !name.trim()) return '?';
    var parts = name.trim().split(/\s+/);
    var initials = parts.slice(0, 2).map(function(p){ return p[0] ? p[0].toUpperCase() : ''; }).join('');
    return initials || '?';
  }
  function renderDoctorCard(data){
    $('doc-card-name').textContent = data.name ? ('Dr. ' + data.name.replace(/^Dr\.?\s*/i, '')) : 'Unnamed doctor';
    $('doc-card-specialty').textContent = data.specialty || 'Specialty not set';
    if (data.photoUrl){
      $('doc-avatar-img').src = data.photoUrl;
      $('doc-avatar-img').classList.remove('hidden');
      $('doc-avatar-fallback').classList.add('hidden');
    } else {
      $('doc-avatar-img').classList.add('hidden');
      $('doc-avatar-fallback').classList.remove('hidden');
      $('doc-avatar-fallback').textContent = getDoctorInitials(data.name);
    }
  }
  async function loadDoctorVisitLog(doctorId){
    var res = await supabaseClient.from('visits').select('patient_id, date').eq('authored_by_doctor_id', doctorId);
    return (res.data || []).map(function(r){ return { patientCode: r.patient_id, date: r.date }; });
  }
  async function loadDoctorAppointments(doctorId){
    var res = await supabaseClient.from('appointments').select('*, patients(name)').eq('doctor_id', doctorId);
    return (res.data || []).map(function(row){
      var a = mapAppointmentRow(row);
      a.patientName = (row.patients && row.patients.name) || 'Patient';
      return a;
    });
  }
  async function loadDoctorAvailability(doctorId){
    var res = await supabaseClient.from('doctor_availability').select('*').eq('doctor_id', doctorId);
    return (res.data || []).map(mapAvailabilityRow);
  }
  function autoDetectCurrentClinic(availability){
    var now = new Date();
    var day = now.getDay();
    var nowMinutes = now.getHours() * 60 + now.getMinutes();
    var todayStr = toDateKey(now);
    var match = (availability || []).find(function(a){
      if (a.dayOfWeek !== day) return false;
      if (!isAvailabilityBlockActive(a, todayStr)) return false;
      return nowMinutes >= minutesFromTimeStr(a.startTime) && nowMinutes < minutesFromTimeStr(a.endTime);
    });
    return match ? match.clinicName : null;
  }
  // ---- Doctor dashboard day-view calendar (a single day's appointments as
  // time-positioned blocks, Google-Calendar-day-view style, not a plain list) ----
  var DAYGRID_START_HOUR = 7;
  var DAYGRID_END_HOUR = 21;
  var DAYGRID_ROW_H = 45;
  var doctorDayGridDate = null; // null = today; set by prev/next
  function formatHourLabel(h){
    var h12 = h % 12; if (h12 === 0) h12 = 12;
    return h12 + (h < 12 ? ' AM' : ' PM');
  }
  function formatCurrentTime(){
    var d = new Date();
    var h = d.getHours();
    var h12 = h % 12; if (h12 === 0) h12 = 12;
    var mm = (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
    return h12 + ':' + mm + (h < 12 ? ' AM' : ' PM');
  }
  // Appointment times are stored as "9:00 AM"-style strings (or, for a few old
  // manually-entered rows predating the slot system, bare "10:00" 24h text) —
  // this covers both.
  function parseApptTimeToMinutes(t){
    if (!t) return null;
    var m = /^(\d{1,2}):(\d{2})\s*([AaPp][Mm])?$/.exec(t.trim());
    if (!m) return null;
    var hh = parseInt(m[1], 10);
    var mm = parseInt(m[2], 10);
    var ampm = m[3] ? m[3].toUpperCase() : null;
    if (ampm === 'PM' && hh !== 12) hh += 12;
    if (ampm === 'AM' && hh === 12) hh = 0;
    return hh * 60 + mm;
  }
  // A block's height comes from the matching doctor_availability slot length
  // (same clinic/weekday/time-range the appointment was booked from), falling
  // back to a generic 20 minutes for anything that doesn't match (e.g. an old
  // appointment from before per-slot durations existed).
  function findApptDurationMinutes(a, startMinutes){
    var dow = new Date(a.date + 'T00:00:00').getDay();
    var match = (currentDoctorData.availability || []).find(function(av){
      return av.clinicName === a.clinicName && av.dayOfWeek === dow
        && startMinutes >= minutesFromTimeStr(av.startTime) && startMinutes < minutesFromTimeStr(av.endTime);
    });
    return match ? match.slotMinutes : 20;
  }
  function renderDoctorDayGrid(){
    var dateObj = doctorDayGridDate || new Date();
    var dateStr = toDateKey(dateObj);
    $('doc-daygrid-label').textContent = dateObj.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' });
    var dayAppts = (currentDoctorData.appointments || [])
      .filter(function(a){ return a.date === dateStr; })
      .sort(function(a, b){ return (parseApptTimeToMinutes(a.time) || 0) - (parseApptTimeToMinutes(b.time) || 0); });

    var totalRows = DAYGRID_END_HOUR - DAYGRID_START_HOUR;
    var linesHtml = '';
    var labelsHtml = '';
    for (var r = 0; r <= totalRows; r++){
      linesHtml += '<div class="daygrid-hourline" style="top:' + (r * DAYGRID_ROW_H) + 'px;"></div>';
      if (r < totalRows){
        labelsHtml += '<div class="daygrid-hour-label" style="top:' + (r * DAYGRID_ROW_H) + 'px;">' + formatHourLabel(DAYGRID_START_HOUR + r) + '</div>';
      }
    }
    var blocksHtml = dayAppts.map(function(a, i){
      var startMin = parseApptTimeToMinutes(a.time);
      if (startMin == null) return '';
      var top = (startMin - DAYGRID_START_HOUR * 60) / 60 * DAYGRID_ROW_H;
      var durMin = findApptDurationMinutes(a, startMin);
      var height = Math.max(18, durMin / 60 * DAYGRID_ROW_H - 2);
      var titleAttr = a.reason ? (a.patientName + ' — ' + a.reason) : a.patientName;
      return '<div class="daygrid-block" data-idx="' + i + '" style="top:' + top + 'px; height:' + height + 'px;" title="' + escapeHtml(titleAttr) + '">'
        + '<span class="daygrid-block-title">' + escapeHtml(a.patientName) + '</span>'
        + (a.reason ? ' - ' + escapeHtml(a.reason) : '')
        + '</div>';
    }).join('');

    $('doc-daygrid').innerHTML = '<div class="daygrid-events" style="height:' + (totalRows * DAYGRID_ROW_H) + 'px;">' + linesHtml + labelsHtml + blocksHtml + '</div>';
    $('doc-daygrid-empty').classList.toggle('hidden', dayAppts.length > 0);

    $('doc-daygrid').querySelectorAll('.daygrid-block').forEach(function(el){
      el.addEventListener('click', async function(){
        var a = dayAppts[parseInt(el.getAttribute('data-idx'), 10)];
        if (!a || !a.patientId) return;
        var full = await loadPatientRecordForDoctor(a.patientId);
        if (!full) return;
        var grant = await getActiveGrant(a.patientId, session.id);
        showLookupResult(a.patientId, full, grant);
      });
    });
  }
  $('doc-daygrid-prev').addEventListener('click', function(){
    doctorDayGridDate = new Date(doctorDayGridDate || new Date());
    doctorDayGridDate.setDate(doctorDayGridDate.getDate() - 1);
    renderDoctorDayGrid();
  });
  $('doc-daygrid-next').addEventListener('click', function(){
    doctorDayGridDate = new Date(doctorDayGridDate || new Date());
    doctorDayGridDate.setDate(doctorDayGridDate.getDate() + 1);
    renderDoctorDayGrid();
  });
  // The calendar only ever reflects appointments as of the last time this doctor's
  // data was fetched — there's no realtime subscription (consistent with the rest
  // of this app, which is all fetch-on-load, not live). A patient booking a slot
  // while the doctor is sitting on the dashboard, or already inside a patient's
  // record, wouldn't otherwise show up until a full reload/re-sign-in. Re-querying
  // specifically when the doctor *lands back on the dashboard* (see the showView()
  // hook below) covers that without needing a poll/subscription — cheap enough at
  // this pilot's scale.
  async function refreshDoctorAppointments(){
    if (!currentDoctorData || session.type !== 'doctor') return;
    currentDoctorData.appointments = await loadDoctorAppointments(session.id);
    renderDoctorDayGrid();
  }
  async function enterDoctorDash(id){
    var data = await loadDoctorProfile(id);
    if (!data){
      session = { type:null, id:null };
      showView('view-landing');
      return;
    }
    var authUser = await getAuthUser();
    data.email = authUser.email;
    // Self-heal: "Verified" now requires a confirmed email too, not just its
    // presence — recompute and persist it here so a doctor who just clicked their
    // confirmation link sees the badge update the next time they land here.
    var shouldBeVerified = !!(data.phone && data.license && authUser.email_confirmed_at);
    if (shouldBeVerified !== data.verified){
      data.verified = shouldBeVerified;
      try{ await supabaseClient.from('doctors').update({ verified: shouldBeVerified }).eq('id', id); }catch(e){}
    }
    var doctorLoads = await Promise.all([loadDoctorVisitLog(id), loadDoctorAppointments(id), loadDoctorAvailability(id)]);
    data.visitLog = doctorLoads[0];
    data.appointments = doctorLoads[1];
    data.availability = doctorLoads[2];
    // "Currently seeing patients at" picks itself from the doctor's own weekly
    // schedule (see doctor_availability) whenever right now falls inside one of
    // their blocks — persisted immediately, same as a manual select does, so a
    // patient's directory search/booking sees the right clinic without the
    // doctor having to remember to flip the dropdown themselves.
    var autoClinic = autoDetectCurrentClinic(data.availability);
    if (autoClinic && autoClinic !== data.currentClinic){
      data.currentClinic = autoClinic;
      try{ await supabaseClient.from('doctors').update({ current_clinic: autoClinic }).eq('id', id); }catch(e){}
    }
    currentDoctorData = data;
    $('doc-name').value = data.name || '';
    $('doc-email').value = authUser.email || '';
    $('doc-phone').value = data.phone || '';
    $('doc-license').value = data.license || '';
    docSpecialties = doctorSpecialties(data);
    renderDocSpecialtyChips();
    $('doc-education').value = data.education || '';
    $('doc-about').value = data.about || '';
    updateDocCharCounts();
    renderDoctorCard(data);
    renderVerifyBanner('doc', authUser.email, !!authUser.email_confirmed_at);
    renderDoctorVerification(data);
    renderClinicSelect(data);
    doctorDayGridDate = null;
    renderDoctorDayGrid();
    $('lookup-code').value = '';
    $('lookup-row').classList.remove('hidden');
    $('lookup-subtitle').classList.remove('hidden');
    $('lookup-not-found').classList.add('hidden');
    currentLookupCode = null;
    currentLookupData = null;
    currentLookupGrant = null;
    switchFindTab('code');
    renderRoster();
    collapseAddVisitFields();
    closeManageBookingsModal();
    closeDeleteClinicModal();
    closeDocAcctDropdown();
    docHowItWorks.close();
    await waitForWelcome();
    showView('view-doctor-dash');
  }

  // ---- Find a patient: code vs. roster ----
  function switchFindTab(tab){
    var code = tab === 'code';
    $('doc-find-tab-code').classList.toggle('active', code);
    $('doc-find-tab-roster').classList.toggle('active', !code);
    $('doc-find-code-pane').classList.toggle('hidden', !code);
    $('doc-find-roster-pane').classList.toggle('hidden', code);
    // Clicking either tab means "let me search again" — drop whatever patient
    // was previously loaded. This also has to restore lookup-row/lookup-subtitle,
    // since showLookupResult() hides both before navigating to the record page.
    currentLookupCode = null;
    currentLookupData = null;
    currentLookupGrant = null;
    $('lookup-code').value = '';
    $('lookup-row').classList.remove('hidden');
    $('lookup-subtitle').classList.remove('hidden');
    $('lookup-not-found').classList.add('hidden');
  }
  $('doc-find-tab-code').addEventListener('click', function(){ switchFindTab('code'); });
  $('doc-find-tab-roster').addEventListener('click', function(){ switchFindTab('roster'); renderRoster(); });
  async function renderRoster(){
    var listEl = $('doc-roster-list');
    var emptyEl = $('doc-roster-empty');
    var entries = await listTrustedPatientsForDoctor(session.id);
    if (!entries.length){
      listEl.innerHTML = '';
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    listEl.innerHTML = entries.map(function(e, i){
      var p = e.patient;
      return '<div class="list-item" data-idx="'+i+'">'
        + '<div><div class="li-title">'+escapeHtml(p.name || 'Unnamed patient')+'</div>'
        + '<div class="li-sub">'+escapeHtml(maskPhone(p.phone))+'</div></div>'
        + chevronSvg + '</div>';
    }).join('');
    listEl.querySelectorAll('.list-item').forEach(function(el){
      el.addEventListener('click', async function(){
        var e = entries[parseInt(el.getAttribute('data-idx'), 10)];
        var full = await loadPatientRecordForDoctor(e.patient.id);
        if (full) showLookupResult(e.patient.id, full, e.grant);
      });
    });
  }
  function renderDoctorVerification(data){
    var verified = !!data.verified;
    var badge = $('doc-badge');
    badge.textContent = verified ? 'Verified' : 'Unverified';
    badge.className = 'badge ' + (verified ? 'verified' : 'unverified');
    $('doc-card-license').textContent = data.license || 'Not added';
  }

  // ---- Clinics ----
  function renderClinicSelect(data){
    var clinics = data.clinics || [];
    var select = $('doc-current-clinic');
    var current = data.currentClinic || '';
    select.innerHTML = '<option value="">No clinic selected</option>' + clinics.map(function(c){
      return '<option value="'+escapeHtml(c.name)+'"'+(c.name === current ? ' selected' : '')+'>'+escapeHtml(c.name)+'</option>';
    }).join('');
    select.title = clinics.length ? 'Currently seeing patients at' : 'Add clinics under Manage clinics to select one here.';
  }
  function renderClinicsList(data){
    var clinics = data.clinics || [];
    var listEl = $('doc-clinics-list');
    if (!clinics.length){
      listEl.innerHTML = '<span class="hint">No clinics added yet.</span>';
      return;
    }
    listEl.innerHTML = clinics.map(function(c){
      return '<div class="list-item" style="cursor:default;">'
        + '<div><div class="li-title">'+escapeHtml(c.name)+'</div>'
        + (c.address ? '<div class="li-sub">'+escapeHtml(c.address)+'</div>' : '')
        + '</div>'
        + '<button type="button" class="btn btn-secondary btn-sm manage-bookings-btn" data-clinic="'+escapeHtml(c.name)+'">Manage</button>'
        + '</div>';
    }).join('');
    listEl.querySelectorAll('.manage-bookings-btn').forEach(function(btn){
      btn.addEventListener('click', function(){ openManageBookingsModal(btn.getAttribute('data-clinic')); });
    });
  }

  // ---- Manage bookings: a clinic's weekly bookable hours (doctor_availability) ----
  // The whole grid is one form — saving replaces this clinic's entire schedule
  // (delete + re-insert) rather than adding rows one at a time, since the doctor
  // is editing the whole week's picture at once, not appending isolated blocks.
  var manageBookingsClinic = null;
  var DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday..Sunday, values are JS Date.getDay()
  var DAY_LABELS = { 0:'Sunday', 1:'Monday', 2:'Tuesday', 3:'Wednesday', 4:'Thursday', 5:'Friday', 6:'Saturday' };
  function availPairHtml(from, to){
    return '<div class="avail-slot-pair">'
      + '<input type="time" class="avail-from" value="'+escapeHtml(from || '')+'">'
      + '<span>to</span>'
      + '<input type="time" class="avail-to" value="'+escapeHtml(to || '')+'">'
      + '<button type="button" class="avail-remove-pair" aria-label="Remove slot">&times;</button>'
      + '</div>';
  }
  function renderAvailDaysForm(blocksForClinic){
    var byDay = {};
    (blocksForClinic || []).forEach(function(a){ (byDay[a.dayOfWeek] = byDay[a.dayOfWeek] || []).push(a); });
    $('avail-days').innerHTML = DAY_ORDER.map(function(day){
      var blocks = (byDay[day] || []).slice().sort(function(a, b){ return minutesFromTimeStr(a.startTime) - minutesFromTimeStr(b.startTime); });
      var pairsHtml = blocks.length
        ? blocks.map(function(b){ return availPairHtml(b.startTime, b.endTime); }).join('')
        : availPairHtml('', '');
      return '<div class="avail-day-row" data-day="'+day+'">'
        + '<div class="avail-day-label">'+DAY_LABELS[day]+'</div>'
        + '<div class="avail-day-body">'
        + '<div class="avail-pairs">'+pairsHtml+'</div>'
        + '<button type="button" class="avail-add-pair">+ Add another slot</button>'
        + '</div></div>';
    }).join('');
  }
  // Delegated once for the whole grid — rows/pairs are re-templated on every
  // modal open, so per-element listeners would need constant re-wiring.
  $('avail-days').addEventListener('click', function(e){
    if (e.target.classList.contains('avail-add-pair')){
      e.target.previousElementSibling.insertAdjacentHTML('beforeend', availPairHtml('', ''));
    } else if (e.target.classList.contains('avail-remove-pair')){
      var pair = e.target.closest('.avail-slot-pair');
      var pairsEl = pair.parentElement;
      if (pairsEl.children.length > 1){
        pair.remove();
      } else {
        pair.querySelector('.avail-from').value = '';
        pair.querySelector('.avail-to').value = '';
      }
    }
  });
  function readAvailDaysForm(){
    var result = [];
    $('avail-days').querySelectorAll('.avail-day-row').forEach(function(row){
      var day = parseInt(row.getAttribute('data-day'), 10);
      row.querySelectorAll('.avail-slot-pair').forEach(function(pair){
        var from = pair.querySelector('.avail-from').value;
        var to = pair.querySelector('.avail-to').value;
        if (from && to) result.push({ dayOfWeek: day, startTime: from, endTime: to });
      });
    });
    return result;
  }
  // Shared by address/phone/note — each is {key}-view (text + Edit button) vs
  // a plain {key} input/textarea. New clinics skip straight to the input
  // (nothing to show yet); editing an existing clinic starts in view mode and
  // only swaps to the input if the doctor clicks Edit — the input still gets
  // prefilled either way, so saving without ever touching it can't blank the
  // field out.
  function showClinicFieldView(key, value, emptyLabel){
    $('avail-clinic-'+key+'-text').textContent = value || emptyLabel;
    $('avail-clinic-'+key+'-view').classList.remove('hidden');
    $('avail-clinic-'+key).classList.add('hidden');
  }
  function showClinicFieldInput(key){
    $('avail-clinic-'+key+'-view').classList.add('hidden');
    $('avail-clinic-'+key).classList.remove('hidden');
    $('avail-clinic-'+key).focus();
  }
  ['address', 'phone', 'note'].forEach(function(key){
    $('avail-clinic-'+key+'-edit-btn').addEventListener('click', function(){ showClinicFieldInput(key); });
  });
  // clinicName omitted (or falsy) opens the modal in "create a new clinic"
  // mode instead of editing an existing one — same form, just with a name
  // field revealed up top and no existing data to prefill.
  function openManageBookingsModal(clinicName){
    manageBookingsClinic = clinicName || null;
    var isNew = !clinicName;
    $('doc-manage-bookings-title').textContent = isNew ? 'Add a clinic' : 'Manage — ' + clinicName;
    clearError($('avail-error'));
    $('avail-clinic-name-field').classList.toggle('hidden', !isNew);
    $('avail-clinic-name').value = '';
    $('avail-delete-clinic-btn').classList.toggle('hidden', isNew);
    var blocks = isNew ? [] : (currentDoctorData.availability || []).filter(function(a){ return a.clinicName === clinicName; });
    var clinic = isNew ? { address: '', phone: '', note: '' } : findClinicByName(currentDoctorData, clinicName);
    $('avail-clinic-address').value = clinic.address || '';
    $('avail-clinic-phone').value = clinic.phone || '';
    $('avail-clinic-note').value = clinic.note || '';
    if (isNew){
      showClinicFieldInput('address');
      showClinicFieldInput('phone');
      showClinicFieldInput('note');
    } else {
      showClinicFieldView('address', clinic.address, 'No address on file');
      showClinicFieldView('phone', clinic.phone, 'No phone number on file');
      showClinicFieldView('note', clinic.note, 'No note on file');
    }
    $('avail-slot-minutes').value = blocks.length ? blocks[0].slotMinutes : 15;
    var todayStr = toDateKey(new Date());
    var maxValidUntil = blocks.reduce(function(max, b){
      return (b.validUntil && (!max || b.validUntil > max)) ? b.validUntil : max;
    }, null);
    var weeks = 4;
    if (maxValidUntil){
      var days = Math.round((new Date(maxValidUntil + 'T00:00:00') - new Date(todayStr + 'T00:00:00')) / 86400000);
      weeks = Math.max(1, Math.min(4, Math.ceil(days / 7)));
    }
    $('avail-repeat-check').checked = true;
    $('avail-repeat-weeks').value = weeks;
    renderAvailDaysForm(blocks);
    $('doc-manage-bookings-modal').classList.remove('hidden');
  }
  function closeManageBookingsModal(){ $('doc-manage-bookings-modal').classList.add('hidden'); }
  $('doc-manage-bookings-close').addEventListener('click', closeManageBookingsModal);
  $('avail-cancel-btn').addEventListener('click', closeManageBookingsModal);
  $('doc-manage-bookings-modal').addEventListener('click', function(e){ if (e.target === $('doc-manage-bookings-modal')) closeManageBookingsModal(); });
  $('avail-save-btn').addEventListener('click', async function(){
    clearError($('avail-error'));
    var isNew = !manageBookingsClinic;
    var newName = '';
    if (isNew){
      newName = $('avail-clinic-name').value.trim();
      if (!newName){
        showError($('avail-error'), 'Enter a clinic or hospital name.');
        return;
      }
      var dupe = (currentDoctorData.clinics || []).some(function(c){ return c.name.toLowerCase() === newName.toLowerCase(); });
      if (dupe){
        showError($('avail-error'), 'You already have a clinic with that name.');
        return;
      }
    }
    var slotMinutes = parseInt($('avail-slot-minutes').value, 10);
    if (!slotMinutes || slotMinutes < 1){
      showError($('avail-error'), 'Enter how many minutes an average patient takes.');
      return;
    }
    var pairs = readAvailDaysForm();
    for (var i = 0; i < pairs.length; i++){
      if (minutesFromTimeStr(pairs[i].endTime) <= minutesFromTimeStr(pairs[i].startTime)){
        showError($('avail-error'), 'Each "to" time must be after its "from" time.');
        return;
      }
    }
    var repeatWeeks = $('avail-repeat-check').checked
      ? Math.max(1, Math.min(4, parseInt($('avail-repeat-weeks').value, 10) || 1))
      : 1;
    var validUntilDate = new Date();
    validUntilDate.setDate(validUntilDate.getDate() + repeatWeeks * 7);
    var validUntilStr = toDateKey(validUntilDate);

    $('avail-save-btn').disabled = true;
    $('avail-save-btn').textContent = 'Saving...';
    try{
      var address = $('avail-clinic-address').value.trim();
      var phone = $('avail-clinic-phone').value.trim();
      var note = $('avail-clinic-note').value.trim();
      if (isNew){
        // The clinic's identity (its doctors.clinics entry) has to exist
        // before any doctor_availability row can reference it by name.
        currentDoctorData.clinics = (currentDoctorData.clinics || []).concat([{ name: newName, address: address, phone: phone, note: note }]);
        if (!currentDoctorData.currentClinic) currentDoctorData.currentClinic = newName;
        await supabaseClient.from('doctors').update({ clinics: currentDoctorData.clinics, current_clinic: currentDoctorData.currentClinic }).eq('id', session.id);
        manageBookingsClinic = newName;
        renderClinicsList(currentDoctorData);
        renderClinicSelect(currentDoctorData);
      } else {
        var clinicEntry = findClinicByName(currentDoctorData, manageBookingsClinic);
        if (clinicEntry.address !== address || clinicEntry.phone !== phone || clinicEntry.note !== note){
          currentDoctorData.clinics = currentDoctorData.clinics.map(function(c){
            return c.name === manageBookingsClinic ? { name: c.name, address: address, phone: phone, note: note } : c;
          });
          await supabaseClient.from('doctors').update({ clinics: currentDoctorData.clinics }).eq('id', session.id);
          renderClinicsList(currentDoctorData);
        }
      }
      // Insert the replacement rows BEFORE deleting the old ones, and delete
      // only those specific old row ids — never a blanket "delete then
      // insert" on the same clinic_name. If the insert fails partway (e.g. a
      // network blip), the doctor's existing schedule is still sitting there
      // untouched instead of having already been wiped by a delete that ran
      // first. For a brand-new clinic this is always empty anyway.
      var oldIds = (currentDoctorData.availability || [])
        .filter(function(a){ return a.clinicName === manageBookingsClinic; })
        .map(function(a){ return a.id; });
      var newRows = [];
      if (pairs.length){
        var insertRows = pairs.map(function(p){
          return { doctor_id: session.id, clinic_name: manageBookingsClinic, day_of_week: p.dayOfWeek, start_time: p.startTime, end_time: p.endTime, slot_minutes: slotMinutes, valid_until: validUntilStr };
        });
        var res = await supabaseClient.from('doctor_availability').insert(insertRows).select();
        if (res.error){
          showError($('avail-error'), 'Something went wrong saving your schedule. Please try again.');
          return;
        }
        newRows = (res.data || []).map(mapAvailabilityRow);
      }
      if (oldIds.length){
        await supabaseClient.from('doctor_availability').delete().in('id', oldIds);
      }
      currentDoctorData.availability = (currentDoctorData.availability || [])
        .filter(function(a){ return a.clinicName !== manageBookingsClinic; })
        .concat(newRows);
      closeManageBookingsModal();
    }catch(e){
      showError($('avail-error'), 'Something went wrong saving your schedule. Please try again.');
    }finally{
      $('avail-save-btn').disabled = false;
      $('avail-save-btn').textContent = 'Save';
    }
  });
  $('doc-clinic-add-btn').addEventListener('click', function(){
    openManageBookingsModal(null);
  });

  // ---- Delete clinic: a hold-to-confirm popup opened from inside "Manage" ----
  var deleteClinicTarget = null;
  function openDeleteClinicModal(clinicName){
    deleteClinicTarget = clinicName;
    $('doc-delete-clinic-name').textContent = clinicName;
    clearError($('doc-delete-clinic-error'));
    $('doc-delete-clinic-modal').classList.remove('hidden');
  }
  function closeDeleteClinicModal(){ $('doc-delete-clinic-modal').classList.add('hidden'); deleteClinicTarget = null; }
  $('avail-delete-clinic-btn').addEventListener('click', function(){
    if (manageBookingsClinic) openDeleteClinicModal(manageBookingsClinic);
  });
  $('doc-delete-clinic-close').addEventListener('click', closeDeleteClinicModal);
  $('doc-delete-clinic-cancel').addEventListener('click', closeDeleteClinicModal);
  $('doc-delete-clinic-modal').addEventListener('click', function(e){ if (e.target === $('doc-delete-clinic-modal')) closeDeleteClinicModal(); });
  makeHoldButton($('doc-delete-clinic-confirm'), 2000, async function(){
    if (!deleteClinicTarget) return;
    var removedName = deleteClinicTarget;
    var btn = $('doc-delete-clinic-confirm');
    var label = btn.querySelector('.hold-label');
    clearError($('doc-delete-clinic-error'));
    btn.disabled = true;
    label.textContent = 'Deleting...';
    try{
      var idx = currentDoctorData.clinics.findIndex(function(c){ return c.name === removedName; });
      if (idx !== -1) currentDoctorData.clinics.splice(idx, 1);
      if (currentDoctorData.currentClinic === removedName) currentDoctorData.currentClinic = '';
      await supabaseClient.from('doctors').update({ clinics: currentDoctorData.clinics, current_clinic: currentDoctorData.currentClinic }).eq('id', session.id);
      await supabaseClient.from('doctor_availability').delete().eq('doctor_id', session.id).eq('clinic_name', removedName);
      currentDoctorData.availability = (currentDoctorData.availability || []).filter(function(a){ return a.clinicName !== removedName; });
      renderClinicsList(currentDoctorData);
      renderClinicSelect(currentDoctorData);
      closeDeleteClinicModal();
      closeManageBookingsModal();
    }catch(e){
      showError($('doc-delete-clinic-error'), 'Something went wrong deleting this clinic. Please try again.');
    }finally{
      btn.disabled = false;
      label.textContent = 'Hold to delete clinic';
    }
  });

  $('doc-current-clinic').addEventListener('change', async function(){
    currentDoctorData.currentClinic = $('doc-current-clinic').value;
    await supabaseClient.from('doctors').update({ current_clinic: currentDoctorData.currentClinic }).eq('id', session.id);
  });

  $('doc-save-btn').addEventListener('click', async function(){
    var email = $('doc-email').value.trim();
    var phone = $('doc-phone').value.trim();
    var license = $('doc-license').value.trim();
    $('doc-save-btn').disabled = true;
    try{
      var authUser = await getAuthUser();
      if (email && email !== authUser.email){
        await supabaseClient.auth.updateUser({ email: email });
        authUser = await getAuthUser();
      }
      var verified = !!(phone && license && authUser.email_confirmed_at);
      await supabaseClient.from('doctors').update({ phone: phone, license: license, verified: verified }).eq('id', session.id);
      currentDoctorData.phone = phone;
      currentDoctorData.license = license;
      currentDoctorData.verified = verified;
      currentDoctorData.email = authUser.email;
      renderDoctorVerification(currentDoctorData);
      renderVerifyBanner('doc', authUser.email, !!authUser.email_confirmed_at);
      var note = $('doc-save-note');
      note.classList.add('show');
      setTimeout(function(){ note.classList.remove('show'); }, 1800);
    }finally{
      $('doc-save-btn').disabled = false;
    }
  });
  $('doc-verify-btn').addEventListener('click', async function(){
    var btn = $('doc-verify-btn');
    var authUser = await getAuthUser();
    if (!authUser || !authUser.email) return;
    btn.disabled = true;
    btn.textContent = 'Sending...';
    try{
      await supabaseClient.auth.resend({ type:'signup', email: authUser.email });
      btn.textContent = 'Sent!';
    }catch(e){
      btn.textContent = 'Resend email';
    }finally{
      setTimeout(function(){ btn.textContent = 'Resend email'; btn.disabled = false; }, 2500);
    }
  });
  // Specialties are picked from a fixed list, never typed. Stored in the existing
  // doctors.specialty text column as a comma-separated string (so no schema
  // change) — which is why no option below may itself contain a comma.
  var SPECIALTY_OPTIONS = [
    'Cardiology', 'Dentistry', 'Dermatology', 'Endocrinology', 'ENT (Ear Nose & Throat)',
    'Family Medicine', 'Gastroenterology', 'General Medicine', 'General Surgery',
    'Gynecology & Obstetrics', 'Neurology', 'Ophthalmology', 'Orthopedics', 'Pediatrics',
    'Psychiatry', 'Pulmonology', 'Radiology', 'Urology'
  ];
  var docSpecialties = [];
  // The maxlength attributes in the HTML (60 / 200) do the actual limiting; this
  // just keeps the "n/max" counters under each field in step.
  function updateDocCharCounts(){
    $('doc-education-count').textContent = $('doc-education').value.length + '/60';
    $('doc-about-count').textContent = $('doc-about').value.length + '/200';
  }
  $('doc-education').addEventListener('input', updateDocCharCounts);
  $('doc-about').addEventListener('input', updateDocCharCounts);
  function renderDocSpecialtyChips(){
    var el = $('doc-specialty-chips');
    if (!docSpecialties.length){
      el.innerHTML = '<span class="panel-sub">No specialty added yet.</span>';
      return;
    }
    el.innerHTML = docSpecialties.map(function(s, i){
      return '<span class="chip">'+escapeHtml(s)+'<button type="button" data-idx="'+i+'" aria-label="Remove '+escapeHtml(s)+'">&times;</button></span>';
    }).join('');
    el.querySelectorAll('button').forEach(function(b){
      b.addEventListener('click', function(){
        docSpecialties.splice(parseInt(b.getAttribute('data-idx'), 10), 1);
        renderDocSpecialtyChips();
      });
    });
  }
  function closeDocSpecialtyModal(){ $('doc-specialty-modal').classList.add('hidden'); }
  $('doc-specialty-add-btn').addEventListener('click', function(){
    var chosen = docSpecialties.map(function(s){ return s.toLowerCase(); });
    var remaining = SPECIALTY_OPTIONS.filter(function(o){ return chosen.indexOf(o.toLowerCase()) === -1; });
    var listEl = $('doc-specialty-options');
    if (!remaining.length){
      listEl.innerHTML = '<div class="li-sub" style="padding:8px 0;">You\'ve added every specialty on the list.</div>';
    } else {
      listEl.innerHTML = remaining.map(function(o){
        return '<div class="list-item" data-opt="'+escapeHtml(o)+'"><div class="li-title">'+escapeHtml(o)+'</div></div>';
      }).join('');
      listEl.querySelectorAll('.list-item').forEach(function(item){
        item.addEventListener('click', function(){
          docSpecialties.push(item.getAttribute('data-opt'));
          renderDocSpecialtyChips();
          closeDocSpecialtyModal();
        });
      });
    }
    $('doc-specialty-modal').classList.remove('hidden');
  });
  $('doc-specialty-close').addEventListener('click', closeDocSpecialtyModal);
  $('doc-specialty-modal').addEventListener('click', function(e){ if (e.target === $('doc-specialty-modal')) closeDocSpecialtyModal(); });

  $('doc-profile-save-btn').addEventListener('click', async function(){
    var name = $('doc-name').value.trim();
    var specialty = docSpecialties.join(', ');
    var education = $('doc-education').value.trim();
    var about = $('doc-about').value.trim();
    await supabaseClient.from('doctors').update({ name: name, specialty: specialty, education: education, about: about }).eq('id', session.id);
    currentDoctorData.name = name;
    currentDoctorData.specialty = specialty;
    currentDoctorData.education = education;
    currentDoctorData.about = about;
    renderDoctorCard(currentDoctorData);
    showView('view-doctor-dash');
  });
  $('doc-avatar-btn').addEventListener('click', function(){
    $('doc-avatar-input').click();
  });
  $('doc-avatar-input').addEventListener('change', function(e){
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')){ e.target.value = ''; return; }
    if (file.size > 3 * 1024 * 1024){
      $('doc-dash-copy-note').textContent = 'Image too large — please use one under 3MB';
      setTimeout(function(){ $('doc-dash-copy-note').textContent = ''; }, 2500);
      e.target.value = '';
      return;
    }
    var reader = new FileReader();
    reader.onload = async function(){
      var dataUrl = reader.result;
      $('doc-avatar-img').src = dataUrl;
      $('doc-avatar-img').classList.remove('hidden');
      $('doc-avatar-fallback').classList.add('hidden');
      currentDoctorData.photoUrl = dataUrl;
      try{ await supabaseClient.from('doctors').update({ photo_url: dataUrl }).eq('id', session.id); }catch(err){}
    };
    reader.readAsDataURL(file);
  });
  $('doc-signout').addEventListener('click', async function(){
    closeDocAcctDropdown();
    await supabaseClient.auth.signOut();
    session = { type:null, id:null };
    showView('view-landing');
  });

  function openDocAccountSettingsPage(){
    closeDocAcctDropdown();
    showView('view-doc-account-settings');
  }
  $('doc-account-settings-btn').addEventListener('click', openDocAccountSettingsPage);

  $('doc-clinics-btn').addEventListener('click', function(){
    renderClinicsList(currentDoctorData);
    closeDocAcctDropdown();
    showView('view-doc-clinics');
  });

  $('doc-myprofile-btn').addEventListener('click', function(){
    closeDocAcctDropdown();
    showView('view-doc-profile');
  });

  // ---- Account dropdown (topbar) — How it works / Account settings / My statistics ----
  function closeDocAcctDropdown(){
    $('doc-account-dropdown-menu').classList.add('hidden');
    $('doc-account-dropdown-trigger').setAttribute('aria-expanded', 'false');
  }
  $('doc-account-dropdown-trigger').addEventListener('click', function(e){
    e.stopPropagation();
    var menu = $('doc-account-dropdown-menu');
    var opening = menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !opening);
    this.setAttribute('aria-expanded', String(opening));
  });
  document.addEventListener('click', function(e){
    if (!$('doc-account-dropdown-menu').classList.contains('hidden') && !e.target.closest('#doc-account-dropdown-wrap')){
      closeDocAcctDropdown();
    }
  });
  $('doc-howitworks-btn').addEventListener('click', closeDocAcctDropdown);

  var docHowItWorks = makeStepperModal({
    modal:'doc-howitworks-modal', track:'doc-howitworks-track',
    counter:'doc-howitworks-counter', back:'doc-howitworks-back', next:'doc-howitworks-next', close:'doc-howitworks-close'
  });
  $('doc-howitworks-btn').addEventListener('click', docHowItWorks.open);

  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape'){ collapseAddVisitFields(); closeAddEyeModal(); closeEyeRxPrevModal(); closePatAccessModal(); closePatApptDetailModal(); closeBookApptConfirmModal(); closeManageBookingsModal(); closeDeleteClinicModal(); closePatFamilyModal(); closeFamilyDetailModal(); closeAddFamilyModal(); closeFamilySwitcher(); closePatAcctDropdown(); patHowItWorks.close(); closeDocAcctDropdown(); docHowItWorks.close(); }
  });

  function escapeHtml(s){
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
  function unverifiedTagHtml(entry){
    return entry && entry.unverified ? ' <span class="badge unverified" style="padding:2px 6px; font-size:0.54rem;">Unverified</span>' : '';
  }

  // ---- Test reports a patient uploaded themselves ----
  // A self-uploaded row is labelled as such instead of carrying the doctor-written
  // "Unverified" tag — it was never a doctor's entry to begin with.
  function testTagHtml(t, viewer){
    if (t && t.uploadedByPatient){
      return ' <span class="badge self" style="padding:2px 6px; font-size:0.54rem;">'+(viewer === 'doctor' ? 'Patient upload' : 'Uploaded by you')+'</span>';
    }
    return unverifiedTagHtml(t);
  }
  var TEST_REPORT_BUCKET = 'test-reports';
  var TEST_REPORT_MAX_BYTES = 5 * 1024 * 1024;
  var TEST_REPORT_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
  function safeFileName(name){
    var cleaned = (name || 'report').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
    return (cleaned || 'report').slice(-80);
  }
  // The chosen file can come from either picker (camera or files), so it's kept
  // here rather than read back off one input at save time.
  var patTestUploadFile = null;
  function setPatTestUploadFile(f){
    patTestUploadFile = f || null;
    $('pat-test-upload-filename').textContent = f ? f.name : 'No file chosen';
  }
  function resetPatTestUploadForm(){
    $('pat-test-upload-name').value = '';
    $('pat-test-upload-file').value = '';
    $('pat-test-upload-camera-input').value = '';
    setPatTestUploadFile(null);
    clearError($('pat-test-upload-error'));
  }
  // "Take photo" opens the camera directly (capture="environment" = the rear
  // camera) — but only where there is a camera to open. On a computer the
  // attribute is ignored and the button would just be a second file dialog, so
  // it's offered on touch devices only.
  if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches){
    $('pat-test-upload-camera').classList.remove('hidden');
  }
  $('pat-test-upload-camera').addEventListener('click', function(){ $('pat-test-upload-camera-input').click(); });
  $('pat-test-upload-camera-input').addEventListener('change', function(){
    $('pat-test-upload-file').value = '';
    setPatTestUploadFile(this.files && this.files[0]);
  });
  $('pat-test-upload-btn').addEventListener('click', function(){
    resetPatTestUploadForm();
    $('pat-test-upload-fields').classList.toggle('hidden');
  });
  $('pat-test-upload-cancel').addEventListener('click', function(){
    $('pat-test-upload-fields').classList.add('hidden');
  });
  $('pat-test-upload-choose').addEventListener('click', function(){ $('pat-test-upload-file').click(); });
  $('pat-test-upload-file').addEventListener('change', function(){
    $('pat-test-upload-camera-input').value = '';
    setPatTestUploadFile(this.files && this.files[0]);
  });
  $('pat-test-upload-save').addEventListener('click', async function(){
    var errEl = $('pat-test-upload-error');
    clearError(errEl);
    var name = $('pat-test-upload-name').value.trim();
    // The report is dated the day it's uploaded — nothing for the patient to type.
    var date = toDateKey(new Date());
    var file = patTestUploadFile;
    if (!name){ showError(errEl, 'Give the report a name.'); return; }
    if (!file){ showError(errEl, 'Choose a file to upload.'); return; }
    if (TEST_REPORT_TYPES.indexOf(file.type) === -1){ showError(errEl, 'Only PDF, PNG, JPG or WebP files can be uploaded.'); return; }
    if (file.size > TEST_REPORT_MAX_BYTES){ showError(errEl, 'That file is over 5 MB — please choose a smaller one.'); return; }

    var btn = $('pat-test-upload-save');
    btn.disabled = true;
    btn.textContent = 'Uploading…';
    var path = activePatientId + '/' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '-' + safeFileName(file.name);
    try{
      var up = await supabaseClient.storage.from(TEST_REPORT_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
      if (up.error){
        showError(errEl, /bucket not found/i.test(up.error.message || '')
          ? 'Report uploads aren\'t switched on for this project yet.'
          : 'The file couldn\'t be uploaded. Please try again.');
        return;
      }
      var ins = await supabaseClient.from('tests').insert({
        patient_id: activePatientId, name: name, date: date, doctor_name: '', result_summary: '',
        uploaded_by_patient: true, report_file_path: path
      }).select().maybeSingle();
      if (ins.error || !ins.data){
        // Don't leave an orphaned file behind a row that never got written.
        await supabaseClient.storage.from(TEST_REPORT_BUCKET).remove([path]);
        showError(errEl, 'The report couldn\'t be saved. Please try again.');
        return;
      }
      var entry = mapTestRow(ins.data);
      currentPatientData.tests.push(entry);
      currentPatientData.tests.sort(function(a, b){ return (b.date || '').localeCompare(a.date || ''); });
      renderTestsList(currentPatientData.tests);
      var newRow = $('pat-tests-list').querySelectorAll('.list-item')[currentPatientData.tests.indexOf(entry)];
      if (newRow) newRow.click();
      $('pat-test-upload-fields').classList.add('hidden');
    }finally{
      btn.disabled = false;
      btn.textContent = 'Upload report';
    }
  });

  makeHoldButton($('test-detail-delete-btn'), 2000, async function(){
    var t = patTestDetailCurrent;
    if (!t || !t.uploadedByPatient) return;
    var errEl = $('test-detail-delete-error');
    var btn = $('test-detail-delete-btn');
    var label = btn.querySelector('.hold-label');
    clearError(errEl);
    btn.disabled = true;
    label.textContent = 'Deleting...';
    try{
      // File first, then the row: if the second step fails the row is still there
      // to retry from, rather than a file left behind with nothing pointing at it.
      if (t.reportFilePath){
        var rm = await supabaseClient.storage.from(TEST_REPORT_BUCKET).remove([t.reportFilePath]);
        if (rm.error){ showError(errEl, 'The report file couldn\'t be deleted. Please try again.'); return; }
      }
      // .select() so a delete that row security silently turned into "0 rows" is
      // caught here instead of looking like it worked until the next reload.
      var res = await supabaseClient.from('tests').delete().eq('id', t.id).select();
      if (res.error || !res.data || !res.data.length){
        showError(errEl, 'The report couldn\'t be deleted. Please try again.');
        return;
      }
      currentPatientData.tests = currentPatientData.tests.filter(function(x){ return x.id !== t.id; });
      renderTestsList(currentPatientData.tests);
    }catch(e){
      showError(errEl, 'The report couldn\'t be deleted. Please try again.');
    }finally{
      btn.disabled = false;
      label.textContent = 'Hold to delete report';
    }
  });

  // "34 years" for anyone two or older; younger patients (a family member's profile,
  // say) read better in months, or days for a newborn.
  function formatAge(dob){
    var d = dob ? parseLocalDate(dob) : null;
    if (!d || isNaN(d.getTime())) return 'Not recorded';
    var now = new Date();
    var months = (now.getFullYear() - d.getFullYear()) * 12 + now.getMonth() - d.getMonth() - (now.getDate() < d.getDate() ? 1 : 0);
    if (months < 0) return 'Not recorded';
    if (months >= 24) return Math.floor(months / 12) + ' years';
    if (months >= 1) return months + (months === 1 ? ' month' : ' months');
    var days = Math.max(0, Math.floor((now - d) / 86400000));
    return days + (days === 1 ? ' day' : ' days');
  }

  var currentLookupCode = null;
  var currentLookupData = null;
  var currentLookupGrant = null;

  // The right-hand detail panel is shared across all three tabs (only one
  // tab's list is ever visible at a time) — clearing every detail/empty
  // pair before showing the one that's actually relevant is simpler than
  // tracking which of the three was last shown.
  function hideAllDocDetails(){
    $('doc-visit-detail-empty').classList.add('hidden');
    $('doc-visit-detail').classList.add('hidden');
    $('doc-test-detail-empty').classList.add('hidden');
    $('doc-test-detail').classList.add('hidden');
    clearTestViewer('doc-test-detail');
    $('doc-prescription-detail-empty').classList.add('hidden');
    $('doc-prescription-detail').classList.add('hidden');
  }
  function renderDoctorVisitsList(visits){
    var listEl = $('doc-visits-list');
    var emptyEl = $('doc-visits-empty');
    if (!visits || !visits.length){
      listEl.innerHTML = '';
      emptyEl.classList.remove('hidden');
      hideAllDocDetails();
      $('doc-visit-detail-empty').classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    listEl.innerHTML = visits.map(function(v, i){
      return '<div class="list-item" data-idx="'+i+'">'
        + '<div>'
        + '<div class="li-title">'+escapeHtml(v.doctorName || 'Doctor')+unverifiedTagHtml(v)+'</div>'
        + '<div class="li-sub">'+escapeHtml(formatDateDisplay(v.date))+(v.time ? ' · '+escapeHtml(v.time) : '')+'</div>'
        + '</div>'
        + chevronSvg + '</div>';
    }).join('');
    var items = listEl.querySelectorAll('.list-item');
    items.forEach(function(el){
      el.addEventListener('click', function(){
        markActiveListItem(listEl, el);
        renderDocVisitDetail(visits[parseInt(el.getAttribute('data-idx'), 10)]);
      });
    });
    markActiveListItem(listEl, items[0]);
    renderDocVisitDetail(visits[parseInt(items[0].getAttribute('data-idx'), 10)]);
  }
  function renderDocVisitDetail(v){
    hideAllDocDetails();
    $('doc-visit-detail').classList.remove('hidden');
    $('doc-visit-detail-date').textContent = formatDateDisplay(v.date) + (v.time ? ' · ' + v.time : '');
    $('doc-visit-detail-doctor').innerHTML = escapeHtml(v.doctorName || 'Doctor') + unverifiedTagHtml(v);
    $('doc-visit-detail-clinic').textContent = v.clinicName || 'Not recorded';
    $('doc-visit-detail-symptoms').textContent = v.symptoms || 'Not recorded';
    $('doc-visit-detail-diagnosis').textContent = v.diagnosis || 'Not recorded';
    $('doc-visit-detail-prescription').textContent = v.prescription || 'Not recorded';
    $('doc-visit-detail-notes').textContent = v.notes || 'Not recorded';
  }

  function renderDoctorTestsList(tests){
    var listEl = $('doc-tests-list');
    var emptyEl = $('doc-tests-empty');
    if (!tests || !tests.length){
      listEl.innerHTML = '';
      emptyEl.classList.remove('hidden');
      hideAllDocDetails();
      $('doc-test-detail-empty').classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    listEl.innerHTML = tests.map(function(t, i){
      return '<div class="list-item" data-idx="'+i+'">'
        + '<div>'
        + '<div class="li-title">'+escapeHtml(t.name || 'Test')+testTagHtml(t, 'doctor')+'</div>'
        + '<div class="li-sub">'+escapeHtml(formatUploadedDate(t.date))+'</div>'
        + '</div>'
        + chevronSvg + '</div>';
    }).join('');
    var testItems = listEl.querySelectorAll('.list-item');
    testItems.forEach(function(el){
      el.addEventListener('click', function(){
        markActiveListItem(listEl, el);
        renderDocTestDetail(tests[parseInt(el.getAttribute('data-idx'), 10)]);
      });
    });
    markActiveListItem(listEl, testItems[0]);
    renderDocTestDetail(tests[parseInt(testItems[0].getAttribute('data-idx'), 10)]);
  }
  function renderDocTestDetail(t){
    hideAllDocDetails();
    $('doc-test-detail').classList.remove('hidden');
    $('doc-test-detail-date').textContent = formatUploadedDate(t.date);
    $('doc-test-detail-name').innerHTML = escapeHtml(t.name || 'Test') + testTagHtml(t, 'doctor');
    $('doc-test-detail-doctor-label').textContent = t.uploadedByPatient ? 'Added by' : 'Ordered by';
    $('doc-test-detail-doctor').textContent = t.uploadedByPatient ? 'Patient (uploaded)' : (t.doctorName || 'Not recorded');
    $('doc-test-detail-result').textContent = t.resultSummary || 'No result summary added yet.';
    renderTestReport('doc-test-detail', t);
  }

  function showLookupResult(patientId, data, grant){
    currentLookupCode = patientId;
    currentLookupData = data;
    currentLookupGrant = grant || null;
    $('res-name').textContent = data.name || 'Unnamed patient';
    $('doc-pt-age').textContent = formatAge(data.dob);
    $('doc-pt-gender').textContent = data.gender || 'Not recorded';
    $('doc-pt-allergies-text').textContent = data.allergies || 'Not recorded';
    $('doc-pt-allergies-text').classList.toggle('allergy-on-file', !!data.allergies);
    $('doc-pt-conditions-text').textContent = data.conditions || 'Not recorded';
    collapseAddVisitFields();
    renderDoctorVisitsList(data.visits || []);
    renderDoctorTestsList(data.tests || []);
    renderDocPrescriptionsList(data.visits || []);
    switchPatientResultTab('visits');
    showView('view-doctor-record');
  }

  // ---- Patient record tabs: Visits / Lab results / Prescriptions. The "Add visit
  // note" section above the tab row only shows on Visits — a doctor can only add
  // visits, so Lab results (patient uploads, plus older doctor entries) and
  // Prescriptions (derived from visits) are read-only. ----
  function switchPatientResultTab(tab){
    collapseAddVisitFields();
    $('doc-pt-add-visit-section').classList.toggle('hidden', tab !== 'visits');
    $('doc-pt-tab-visits').classList.toggle('active', tab === 'visits');
    $('doc-pt-tab-lab').classList.toggle('active', tab === 'lab');
    $('doc-pt-tab-rx').classList.toggle('active', tab === 'rx');
    $('doc-pt-pane-visits').classList.toggle('hidden', tab !== 'visits');
    $('doc-pt-pane-lab').classList.toggle('hidden', tab !== 'lab');
    $('doc-pt-pane-rx').classList.toggle('hidden', tab !== 'rx');
    // The right-hand detail panel is shared across all three tabs — re-run
    // whichever list just became visible so its first row (re-)selects and
    // the panel always matches what's actually on screen, not whatever a
    // previously active tab last left there. Each render*List function
    // already fully handles both the empty and has-data cases.
    if (!currentLookupData) return;
    if (tab === 'visits') renderDoctorVisitsList(currentLookupData.visits || []);
    else if (tab === 'lab') renderDoctorTestsList(currentLookupData.tests || []);
    else renderDocPrescriptionsList(currentLookupData.visits || []);
  }
  $('doc-pt-tab-visits').addEventListener('click', function(){ switchPatientResultTab('visits'); });
  $('doc-pt-tab-lab').addEventListener('click', function(){ switchPatientResultTab('lab'); });
  $('doc-pt-tab-rx').addEventListener('click', function(){ switchPatientResultTab('rx'); });

  function renderDocPrescriptionsList(visits){
    var listEl = $('doc-prescriptions-list');
    var emptyEl = $('doc-prescriptions-empty');
    var entries = (visits || []).map(function(v, i){ return { v: v, i: i }; }).filter(function(e){ return isMeaningfulPrescription(e.v.prescription); });
    if (!entries.length){
      listEl.innerHTML = '';
      emptyEl.classList.remove('hidden');
      hideAllDocDetails();
      $('doc-prescription-detail-empty').classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    listEl.innerHTML = entries.map(function(e){
      return '<div class="list-item" data-idx="'+e.i+'">'
        + '<div>'
        + '<div class="li-title">'+escapeHtml(e.v.doctorName || 'Doctor')+'</div>'
        + '<div class="li-sub">'+escapeHtml(formatDateDisplay(e.v.date))+'</div>'
        + '</div>'
        + chevronSvg + '</div>';
    }).join('');
    var rxItems = listEl.querySelectorAll('.list-item');
    rxItems.forEach(function(el){
      el.addEventListener('click', function(){
        markActiveListItem(listEl, el);
        renderDocPrescriptionDetail(visits[parseInt(el.getAttribute('data-idx'), 10)]);
      });
    });
    markActiveListItem(listEl, rxItems[0]);
    renderDocPrescriptionDetail(visits[parseInt(rxItems[0].getAttribute('data-idx'), 10)]);
  }
  function renderDocPrescriptionDetail(v){
    hideAllDocDetails();
    $('doc-prescription-detail').classList.remove('hidden');
    $('doc-prescription-detail-date').textContent = formatDateDisplay(v.date);
    $('doc-prescription-detail-doctor').innerHTML = escapeHtml(v.doctorName || 'Doctor') + unverifiedTagHtml(v);
    var items = (v.prescription || '').split(/\r?\n/).map(function(s){ return s.trim(); }).filter(Boolean);
    if (!items.length) items = ['Not recorded'];
    $('doc-prescription-detail-list').innerHTML = items.map(function(s){ return '<li>'+escapeHtml(s)+'</li>'; }).join('');
  }
  $('lookup-btn').addEventListener('click', async function(){
    var code = $('lookup-code').value.replace(/[^0-9]/g,'');
    if (code.length !== 6){
      $('lookup-not-found').classList.remove('hidden');
      $('lookup-not-found').textContent = 'Enter the 6-digit live code your patient showed you.';
      currentLookupCode = null;
      currentLookupData = null;
      return;
    }
    $('lookup-btn').disabled = true;
    try{
      var result = await redeemAccessCode(code);
      if (!result.ok){
        $('lookup-not-found').classList.remove('hidden');
        $('lookup-not-found').textContent = mapRedeemErrorText(result.error);
        return;
      }
      var full = await loadPatientRecordForDoctor(result.patientId);
      if (!full){
        $('lookup-not-found').classList.remove('hidden');
        $('lookup-not-found').textContent = 'That patient’s record could not be found.';
        return;
      }
      var grant = await getActiveGrant(result.patientId, session.id);
      showLookupResult(result.patientId, full, grant);
    }finally{
      $('lookup-btn').disabled = false;
    }
  });
  $('lookup-code').addEventListener('keydown', function(e){
    if (e.key === 'Enter') $('lookup-btn').click();
  });

  function currentDoctorDisplayName(){
    var name = currentDoctorData && currentDoctorData.name ? currentDoctorData.name.trim() : '';
    if (name) return 'Dr. ' + name.replace(/^Dr\.?\s*/i, '');
    return (currentDoctorData && currentDoctorData.doctorId) || 'Doctor';
  }
  function expandAddVisitFields(){
    if (!currentLookupCode) return;
    $('visit-symptoms').value = '';
    $('visit-diagnosis').value = '';
    $('visit-prescription').value = '';
    $('visit-notes').value = '';
    clearError($('add-visit-error'));
    $('add-visit-fields').classList.remove('hidden');
  }
  function collapseAddVisitFields(){
    $('add-visit-fields').classList.add('hidden');
  }
  $('add-visit-btn').addEventListener('click', function(){
    if ($('add-visit-fields').classList.contains('hidden')) expandAddVisitFields();
    else collapseAddVisitFields();
  });
  $('add-visit-cancel').addEventListener('click', collapseAddVisitFields);
  $('add-visit-save').addEventListener('click', async function(){
    if (!currentLookupCode){
      showError($('add-visit-error'), 'No patient selected.');
      return;
    }
    clearError($('add-visit-error'));
    $('add-visit-save').disabled = true;
    $('add-visit-save').textContent = 'Saving...';
    try{
      var activeGrant = await getActiveGrant(currentLookupCode, session.id);
      if (!activeGrant){
        showError($('add-visit-error'), 'Your access to this patient has expired or been revoked. Ask them for a new code or to re-trust you.');
        return;
      }
      var row = {
        patient_id: currentLookupCode,
        authored_by_doctor_id: session.id,
        written_via_grant_id: activeGrant.id,
        doctor_name: currentDoctorDisplayName(),
        clinic_name: (currentDoctorData && currentDoctorData.currentClinic) || '',
        date: new Date().toISOString().slice(0, 10),
        time: formatCurrentTime(),
        symptoms: $('visit-symptoms').value.trim(),
        diagnosis: $('visit-diagnosis').value.trim(),
        prescription: $('visit-prescription').value.trim(),
        notes: $('visit-notes').value.trim(),
        unverified: !isDoctorVerified(currentDoctorData || {})
      };
      // RLS re-checks the grant independently at insert time (has_active_grant on
      // the visits_insert policy) — the client-side check above is UX, not the
      // security boundary, so a rejected insert here means access was revoked in
      // the moment between the check and the save.
      var res = await supabaseClient.from('visits').insert(row).select().maybeSingle();
      if (res.error || !res.data){
        showError($('add-visit-error'), 'Your access to this patient has expired or been revoked. Ask them for a new code or to re-trust you.');
        return;
      }
      currentLookupData.visits = [mapVisitRow(res.data)].concat(currentLookupData.visits || []);
      renderDoctorVisitsList(currentLookupData.visits);
      renderDocPrescriptionsList(currentLookupData.visits);
      collapseAddVisitFields();
      var note = $('add-visit-note');
      note.classList.add('show');
      setTimeout(function(){ note.classList.remove('show'); }, 2200);
    }catch(e){
      showError($('add-visit-error'), 'Something went wrong saving this visit. Please try again.');
    }finally{
      $('add-visit-save').disabled = false;
      $('add-visit-save').textContent = 'Save visit note';
    }
  });

  // ---- Doctor statistics ----
  function localDateStr(d){
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }
  function parseLocalDate(str){
    var parts = (str || '').split('-').map(Number);
    return new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1);
  }
  function formatDateShort(dateStr){
    var d = parseLocalDate(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString(undefined, { month:'short', day:'numeric' });
  }
  function computeDailyCounts(log){
    var counts = {};
    (log || []).forEach(function(entry){
      if (!entry.date) return;
      counts[entry.date] = (counts[entry.date] || 0) + 1;
    });
    var dates = Object.keys(counts).sort();
    if (!dates.length) return [];
    var cur = parseLocalDate(dates[0]);
    var end = parseLocalDate(localDateStr(new Date()));
    if (end < cur) end = cur;
    var series = [];
    while (cur <= end){
      var key = localDateStr(cur);
      series.push({ date: key, count: counts[key] || 0 });
      cur.setDate(cur.getDate() + 1);
    }
    return series;
  }
  function renderDoctorTrendChart(series){
    var wrap = $('doc-stats-chart-wrap');
    if (!series.length){
      wrap.innerHTML = '';
      return;
    }
    var w = 580, h = 200, padL = 30, padR = 12, padT = 14, padB = 26;
    var innerW = w - padL - padR, innerH = h - padT - padB;
    var n = series.length;
    var maxCount = 0;
    series.forEach(function(p){ if (p.count > maxCount) maxCount = p.count; });
    var yMax = Math.max(1, maxCount);
    function x(i){ return padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW); }
    function y(v){ return padT + innerH - (v / yMax) * innerH; }

    var yTicks = yMax <= 1 ? [0, 1] : [0, Math.round(yMax / 2), yMax];
    yTicks = yTicks.filter(function(v, i, a){ return a.indexOf(v) === i; });
    var gridHtml = yTicks.map(function(t){
      var yy = y(t);
      return '<line x1="'+padL+'" y1="'+yy+'" x2="'+(w-padR)+'" y2="'+yy+'" stroke="var(--line)" stroke-width="1"/>'
        + '<text x="'+(padL-8)+'" y="'+(yy+3)+'" text-anchor="end" font-size="9" fill="var(--muted)" font-family=\'IBM Plex Mono, monospace\'>'+t+'</text>';
    }).join('');

    var labelCount = Math.min(5, n);
    var labelIdxs = [];
    for (var i = 0; i < labelCount; i++){
      labelIdxs.push(Math.round(i * (n - 1) / Math.max(1, labelCount - 1)));
    }
    labelIdxs = labelIdxs.filter(function(v, i, a){ return a.indexOf(v) === i; });
    var xLabelsHtml = labelIdxs.map(function(i){
      return '<text x="'+x(i)+'" y="'+(h-8)+'" text-anchor="middle" font-size="9" fill="var(--muted)" font-family=\'IBM Plex Mono, monospace\'>'+escapeHtml(formatDateShort(series[i].date))+'</text>';
    }).join('');

    var linePoints = series.map(function(p, i){ return x(i) + ',' + y(p.count); }).join(' ');
    var areaPath = 'M' + x(0) + ',' + (padT + innerH) + ' L' + series.map(function(p, i){ return x(i) + ',' + y(p.count); }).join(' L') + ' L' + x(n - 1) + ',' + (padT + innerH) + ' Z';
    var showDots = n <= 60;
    var dotsHtml = showDots ? series.map(function(p, i){
      return '<circle cx="'+x(i)+'" cy="'+y(p.count)+'" r="3" fill="var(--teal)"><title>'+escapeHtml(formatDateDisplay(p.date))+': '+p.count+' patient'+(p.count === 1 ? '' : 's')+'</title></circle>';
    }).join('') : '';

    wrap.innerHTML = '<svg viewBox="0 0 '+w+' '+h+'" width="100%" style="display:block;">'
      + gridHtml
      + '<path d="'+areaPath+'" fill="var(--teal-wash)" stroke="none"/>'
      + '<polyline points="'+linePoints+'" fill="none" stroke="var(--teal)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
      + dotsHtml
      + xLabelsHtml
      + '</svg>';
  }
  function computeDoctorStats(data){
    var log = (data && data.visitLog) || [];
    var todayStr = localDateStr(new Date());
    var todayYear = todayStr.slice(0, 4);
    var todayMonth = todayStr.slice(0, 7);
    var allPatients = {}, todayPatients = {}, monthPatients = {}, yearPatients = {};
    log.forEach(function(entry){
      if (!entry.patientCode) return;
      allPatients[entry.patientCode] = true;
      var d = entry.date || '';
      if (d === todayStr) todayPatients[entry.patientCode] = true;
      if (d.slice(0, 7) === todayMonth) monthPatients[entry.patientCode] = true;
      if (d.slice(0, 4) === todayYear) yearPatients[entry.patientCode] = true;
    });
    return {
      hasData: log.length > 0,
      totalVisits: log.length,
      totalPatients: Object.keys(allPatients).length,
      todayPatients: Object.keys(todayPatients).length,
      monthPatients: Object.keys(monthPatients).length,
      yearPatients: Object.keys(yearPatients).length
    };
  }
  function openDocStatsPage(){
    var stats = computeDoctorStats(currentDoctorData);
    if (!stats.hasData){
      $('doc-stats-grid').innerHTML = '';
      $('doc-stats-empty').classList.remove('hidden');
      $('doc-stats-chart-section').classList.add('hidden');
    } else {
      $('doc-stats-empty').classList.add('hidden');
      var tiles = [
        { value: stats.totalPatients, label: 'Total patients seen' },
        { value: stats.totalVisits, label: 'Total visits logged' },
        { value: stats.todayPatients, label: 'Patients seen today' },
        { value: stats.monthPatients, label: 'Patients seen this month' },
        { value: stats.yearPatients, label: 'Patients seen this year' }
      ];
      $('doc-stats-grid').innerHTML = tiles.map(function(t){
        return '<div class="stat-tile"><div class="stat-value">'+t.value+'</div><div class="stat-label">'+t.label+'</div></div>';
      }).join('');
      $('doc-stats-chart-section').classList.remove('hidden');
      renderDoctorTrendChart(computeDailyCounts(currentDoctorData && currentDoctorData.visitLog));
    }
    closeDocAcctDropdown();
    showView('view-doc-stats');
  }
  $('doc-stats-btn').addEventListener('click', openDocStatsPage);

  // ---------- Bootstrap ----------
  // Unlike the old kv_store version, the Supabase client persists its own session
  // in localStorage — so a reload no longer has to restart at landing. If a
  // session already exists (including one just established by a confirmation
  // link's #access_token=... fragment, which the client consumes automatically
  // during getSession()), route straight into the right dashboard instead of
  // showing landing at all. A password-*recovery* link's session is handled
  // separately — see PASSWORD_RECOVERY, near the top of this file.
  //
  // routeIntoDashboard() is shared by bootstrap() below and by the "set new
  // password" success handler just above — both end up with an established
  // auth session and need the exact same role-check/enter-dashboard routing,
  // just reached a different way.
  async function routeIntoDashboard(authSession){
    var role = authSession.user.user_metadata && authSession.user.user_metadata.role;
    var targetView = role === 'doctor' ? 'view-doctor-dash' : 'view-patient-dash';
    history.replaceState({ view: targetView }, '', location.pathname + location.search);
    suppressHistoryPush = true;
    if (role === 'doctor'){
      session = { type:'doctor', id: authSession.user.id };
      await enterDoctorDash(authSession.user.id);
    } else {
      session = { type:'patient', id: authSession.user.id };
      await enterPatientDash(authSession.user.id);
    }
    suppressHistoryPush = false;
  }

  $('set-new-password-btn').addEventListener('click', async function(){
    var pw = $('set-new-password').value;
    var confirmPw = $('set-new-password-confirm').value;
    clearError($('set-new-password-error'));
    if (!pw || pw.length < 6){ showError($('set-new-password-error'), 'Password must be at least 6 characters.'); return; }
    if (pw !== confirmPw){ showError($('set-new-password-error'), "Passwords don't match."); return; }
    $('set-new-password-btn').disabled = true;
    try{
      var res = await supabaseClient.auth.updateUser({ password: pw });
      if (res.error){
        // "Auth session missing" is what an expired/already-used reset link's
        // session looks like here — the far more likely real-world case than a
        // genuine backend error, so it gets its own plain-language message
        // rather than surfacing Supabase's own wording.
        var msg = /session/i.test(res.error.message || '')
          ? 'This reset link has expired or was already used. Please request a new one.'
          : authErrorMessage(res.error, 'Something went wrong. Please request a new reset link and try again.');
        showError($('set-new-password-error'), msg);
        return;
      }
      awaitingPasswordRecovery = false;
      var sessionRes = await supabaseClient.auth.getSession();
      var authSession = sessionRes.data && sessionRes.data.session;
      if (authSession && authSession.user) await routeIntoDashboard(authSession);
    }finally{
      $('set-new-password-btn').disabled = false;
    }
  });
  $('set-new-password').addEventListener('keydown', function(e){
    if (e.key === 'Enter') $('set-new-password-btn').click();
  });
  $('set-new-password-confirm').addEventListener('keydown', function(e){
    if (e.key === 'Enter') $('set-new-password-btn').click();
  });

  (async function bootstrap(){
    var res = await supabaseClient.auth.getSession();
    // A password-recovery session is real and valid, but the visitor hasn't set
    // a new password yet — the PASSWORD_RECOVERY listener above has already (or
    // is about to) show "Set a new password"; don't race it by also dropping
    // them into their normal dashboard as if this were an ordinary sign-in.
    if (awaitingPasswordRecovery) return;
    var authSession = res.data && res.data.session;
    if (authSession && authSession.user){
      await routeIntoDashboard(authSession);
    } else {
      history.replaceState({ view: 'view-landing' }, '', '#view-landing');
      suppressHistoryPush = true;
      showView('view-landing');
      suppressHistoryPush = false;
    }
  })();
})();

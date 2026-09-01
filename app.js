(function(){
  "use strict";

  // ---------- helpers ----------
  function $(id){ return document.getElementById(id); }

  // A "How it works" modal that slides between step slides one at a time via
  // Back/Next arrows, reused for both the patient and doctor account menus (same
  // mechanism, different step markup and DOM ids since each role's modal lives
  // inside its own view). The slides themselves are static HTML side-by-side inside
  // `ids.track`; stepping just translates the track — content isn't injected by JS.
  var STEPPER_NEXT_ICON = '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M6,2 L12,8 L6,14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var STEPPER_DONE_ICON = '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M3,8 L7,12 L13,4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
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
  function showView(id){
    document.querySelectorAll('.view').forEach(function(v){ v.classList.add('hidden'); });
    $(id).classList.remove('hidden');
    window.scrollTo(0,0);
    if (suppressHistoryPush) return;
    if (!history.state){
      history.replaceState({ view: id }, '', '#' + id);
    } else if (history.state.view !== id){
      history.pushState({ view: id }, '', '#' + id);
    }
  }
  var PATIENT_ONLY_VIEWS = ['view-patient-dash','view-record-visits','view-record-tests','view-record-prescriptions','view-patient-eyes','view-pat-profile','view-pat-account-settings','view-pat-stats'];
  var DOCTOR_ONLY_VIEWS = ['view-doctor-dash', 'view-doctor-record-visits', 'view-doctor-record-tests', 'view-doc-profile', 'view-doc-account-settings', 'view-doc-stats'];
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
      document.body.innerHTML = '<div style="max-width:520px;margin:80px auto;padding:24px;font-family:sans-serif;text-align:center;">'
        + '<h2>Can’t connect</h2><p>Pak Health couldn’t reach its backend. Please reload the page, or contact support if this keeps happening.</p></div>';
    });
    return;
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
      conditions: row.conditions || '', medications: row.medications || ''
    };
  }
  function mapDoctorRow(row){
    return {
      id: row.id, doctorId: row.doctor_code, name: row.name || '', dob: row.dob || '', gender: row.gender || '',
      phone: row.phone || '', photoUrl: row.photo_url || '', license: row.license || '', specialty: row.specialty || '',
      education: row.education || '', about: row.about || '', verified: !!row.verified,
      clinics: row.clinics || [], currentClinic: row.current_clinic || ''
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
      resultSummary: row.result_summary || '', writtenViaGrantId: row.written_via_grant_id, unverified: !!row.unverified
    };
  }
  function mapEyeRow(row){
    return { id: row.id, date: row.date, sphL: row.sph_l || '', cylL: row.cyl_l || '', axisL: row.axis_l || '', sphR: row.sph_r || '', cylR: row.cyl_r || '', axisR: row.axis_r || '' };
  }
  function mapAppointmentRow(row){
    return { id: row.id, doctorName: row.doctor_name || '', clinicName: row.clinic_name || '', date: row.date, time: row.time || '', reason: row.reason || '' };
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
    var profile = await loadPatientProfile(patientId);
    if (!profile) return null;
    var visitsRes = await supabaseClient.from('visits').select('*').eq('patient_id', patientId).order('date', { ascending:false });
    var testsRes = await supabaseClient.from('tests').select('*').eq('patient_id', patientId).order('date', { ascending:false });
    profile.visits = (visitsRes.data || []).map(mapVisitRow);
    profile.tests = (testsRes.data || []).map(mapTestRow);
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
      await enterDoctorDash(res.data.user.id);
    }finally{
      $('doc-signin-btn').disabled = false;
    }
  });
  $('doc-signin-password').addEventListener('keydown', function(e){
    if (e.key === 'Enter') $('doc-signin-btn').click();
  });
  $('doc-forgot-btn').addEventListener('click', function(){ $('doc-forgot-modal').classList.remove('hidden'); });
  function closeDocForgotModal(){ $('doc-forgot-modal').classList.add('hidden'); }
  $('doc-forgot-close').addEventListener('click', closeDocForgotModal);
  $('doc-forgot-ok').addEventListener('click', closeDocForgotModal);
  $('doc-forgot-modal').addEventListener('click', function(e){ if (e.target === $('doc-forgot-modal')) closeDocForgotModal(); });

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
      await enterPatientDash(res.data.user.id);
    }finally{
      $('pat-signin-btn').disabled = false;
    }
  });
  $('pat-signin-password').addEventListener('keydown', function(e){
    if (e.key === 'Enter') $('pat-signin-btn').click();
  });
  $('pat-forgot-btn').addEventListener('click', function(){ $('pat-forgot-modal').classList.remove('hidden'); });
  function closePatForgotModal(){ $('pat-forgot-modal').classList.add('hidden'); }
  $('pat-forgot-close').addEventListener('click', closePatForgotModal);
  $('pat-forgot-ok').addEventListener('click', closePatForgotModal);
  $('pat-forgot-modal').addEventListener('click', function(e){ if (e.target === $('pat-forgot-modal')) closePatForgotModal(); });

  // ================= PATIENT DASHBOARD =================
  var currentPatientData = null;
  var calViewDate = new Date();

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
      // it) — bail out to landing rather than show a broken dashboard.
      session = { type:null, id:null };
      showView('view-landing');
      return;
    }
    var authUser = await getAuthUser();
    data.email = authUser.email;
    var visitsRes = await supabaseClient.from('visits').select('*').eq('patient_id', id).order('date', { ascending:false });
    var testsRes = await supabaseClient.from('tests').select('*').eq('patient_id', id).order('date', { ascending:false });
    var eyesRes = await supabaseClient.from('eye_entries').select('*').eq('patient_id', id).order('date', { ascending:false });
    var apptsRes = await supabaseClient.from('appointments').select('*').eq('patient_id', id).order('date', { ascending:true });
    data.visits = (visitsRes.data || []).map(mapVisitRow);
    data.tests = (testsRes.data || []).map(mapTestRow);
    data.eyeEntries = (eyesRes.data || []).map(mapEyeRow);
    data.appointments = (apptsRes.data || []).map(mapAppointmentRow);
    currentPatientData = data;
    renderHealthCard(data);
    renderVerifyBanner('pat', authUser.email, !!authUser.email_confirmed_at);
    renderVisitsList(data.visits);
    renderTestsList(data.tests);
    renderPrescriptionsList(data.visits);
    renderEyesList(data.eyeEntries);
    calViewDate = new Date();
    renderAppointmentsCalendar(data.appointments);
    renderAppointmentsList(data.appointments);
    closeVisitModal();
    closeTestModal();
    closeAddEyeModal();
    closeEyeModal();
    closePatAccessModal();
    closeBookApptModal();
    closePatAcctDropdown();
    patHowItWorks.close();
    await regenerateLiveCode();
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
      var row = await createAccessCode(session.id);
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
      + '<div><div class="li-title">'+escapeHtml(name)+' <span class="badge '+(verified?'verified':'unverified')+'" style="margin-left:6px;">'+(verified?'Verified':'Unverified')+'</span></div>'
      + '<div class="li-sub">'+escapeHtml(maskPhone(d.phone))+(subtext ? ' · '+subtext : '')+'</div></div>'
      + (showRevoke ? '<button class="btn btn-secondary btn-sm revoke-grant-btn" data-grant="'+entry.grant.id+'">Revoke</button>' : '')
      + '</div>';
  }
  async function renderTrustedList(){
    var listEl = $('pat-trusted-list');
    var emptyEl = $('pat-trusted-empty');
    var entries = await listTrustedDoctorsForPatient(session.id);
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
    var entries = await listActiveAdhocGrantsForPatient(session.id);
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
  $('pat-trust-add-btn').addEventListener('click', async function(){
    var raw = $('pat-trust-input').value.trim().toUpperCase();
    var code = raw.indexOf('DR-') === 0 ? raw : 'DR-' + raw.replace(/[^0-9]/g,'');
    clearError($('pat-trust-error'));
    if (!/^DR-\d{6}$/.test(code)){
      showError($('pat-trust-error'), 'Enter a valid doctor ID, like DR-482913.');
      return;
    }
    var docRes = await supabaseClient.from('doctors').select('id').eq('doctor_code', code).maybeSingle();
    if (!docRes.data){
      showError($('pat-trust-error'), 'No doctor found with that ID.');
      return;
    }
    $('pat-trust-add-btn').disabled = true;
    try{
      await createTrustGrant(session.id, docRes.data.id);
      $('pat-trust-input').value = '';
      renderTrustedList();
    }finally{
      $('pat-trust-add-btn').disabled = false;
    }
  });

  function openPatAccountSettingsPage(){
    $('pat-email').value = (currentPatientData && currentPatientData.email) || '';
    $('pat-phone').value = (currentPatientData && currentPatientData.phone) || '';
    closePatAcctDropdown();
    showView('view-pat-account-settings');
  }
  $('pat-account-settings-btn').addEventListener('click', openPatAccountSettingsPage);

  function openPatProfilePage(){
    $('pat-name').value = (currentPatientData && currentPatientData.name) || '';
    closePatAcctDropdown();
    showView('view-pat-profile');
  }
  $('pat-myprofile-btn').addEventListener('click', openPatProfilePage);

  $('pat-profile-save-btn').addEventListener('click', async function(){
    var name = $('pat-name').value.trim();
    await supabaseClient.from('patients').update({ name: name }).eq('id', session.id);
    currentPatientData.name = name;
    renderHealthCard(currentPatientData);
    var note = $('pat-profile-save-note');
    note.classList.add('show');
    setTimeout(function(){ note.classList.remove('show'); }, 1800);
  });

  $('pat-save-btn').addEventListener('click', async function(){
    var email = $('pat-email').value.trim();
    var phone = $('pat-phone').value.trim();
    $('pat-save-btn').disabled = true;
    try{
      var authUser = await getAuthUser();
      if (email && email !== authUser.email){
        await supabaseClient.auth.updateUser({ email: email });
        // Supabase confirms the new address before auth.users.email actually
        // changes — the verify banner naturally reappears until that happens,
        // no separate "reset the flag" step needed.
      }
      await supabaseClient.from('patients').update({ phone: phone }).eq('id', session.id);
      currentPatientData.phone = phone;
      authUser = await getAuthUser();
      currentPatientData.email = authUser.email;
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
      try{ await supabaseClient.from('patients').update({ photo_url: dataUrl }).eq('id', session.id); }catch(err){}
    };
    reader.readAsDataURL(file);
  });
  $('pat-signout').addEventListener('click', async function(){
    stopLiveCodeTimer();
    await supabaseClient.auth.signOut();
    session = { type:null, id:null };
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
  function renderPrescriptionsList(visits){
    var listEl = $('pat-prescriptions-list');
    var emptyEl = $('pat-prescriptions-empty');
    var entries = (visits || []).map(function(v, i){ return { v: v, i: i }; }).filter(function(e){ return isMeaningfulPrescription(e.v.prescription); });
    if (!entries.length){
      listEl.innerHTML = '';
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    listEl.innerHTML = entries.map(function(e){
      return '<div class="list-item" data-idx="'+e.i+'">'
        + '<div><div class="li-title">'+escapeHtml(e.v.prescription)+'</div>'
        + '<div class="li-sub">'+escapeHtml(e.v.doctorName || 'Doctor')+' · '+escapeHtml(formatDateDisplay(e.v.date))+'</div></div>'
        + chevronSvg + '</div>';
    }).join('');
    listEl.querySelectorAll('.list-item').forEach(function(el){
      el.addEventListener('click', function(){
        openVisitModal(visits[parseInt(el.getAttribute('data-idx'), 10)]);
      });
    });
  }

  function formatDateDisplay(dateStr){
    if (!dateStr) return '—';
    var d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' });
  }
  var chevronSvg = '<svg class="chevron" width="14" height="9" viewBox="0 0 16 10"><path d="M0,5 H14 M9,0 L14,5 L9,10" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';

  function renderVisitsList(visits){
    var listEl = $('pat-visits-list');
    var emptyEl = $('pat-visits-empty');
    if (!visits || !visits.length){
      listEl.innerHTML = '';
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    listEl.innerHTML = visits.map(function(v, i){
      return '<div class="list-item" data-idx="'+i+'">'
        + '<div><div class="li-title">'+escapeHtml(v.doctorName || 'Doctor')+unverifiedTagHtml(v)+'</div>'
        + '<div class="li-sub">'+escapeHtml(formatDateDisplay(v.date))+(v.time ? ' · '+escapeHtml(v.time) : '')+(v.clinicName ? ' · '+escapeHtml(v.clinicName) : '')+'</div></div>'
        + chevronSvg + '</div>';
    }).join('');
    listEl.querySelectorAll('.list-item').forEach(function(el){
      el.addEventListener('click', function(){
        openVisitModal(visits[parseInt(el.getAttribute('data-idx'), 10)]);
      });
    });
  }
  function renderTestsList(tests){
    var listEl = $('pat-tests-list');
    var emptyEl = $('pat-tests-empty');
    if (!tests || !tests.length){
      listEl.innerHTML = '';
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    listEl.innerHTML = tests.map(function(t, i){
      return '<div class="list-item" data-idx="'+i+'">'
        + '<div><div class="li-title">'+escapeHtml(t.name || 'Test')+unverifiedTagHtml(t)+'</div>'
        + '<div class="li-sub">'+escapeHtml(formatDateDisplay(t.date))+'</div></div>'
        + chevronSvg + '</div>';
    }).join('');
    listEl.querySelectorAll('.list-item').forEach(function(el){
      el.addEventListener('click', function(){
        openTestModal(tests[parseInt(el.getAttribute('data-idx'), 10)]);
      });
    });
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
    listEl.innerHTML = upcoming.map(function(a){
      return '<div class="list-item static">'
        + '<div><div class="li-title">'+escapeHtml(a.doctorName || 'Doctor')+'</div>'
        + '<div class="li-sub">'+escapeHtml(formatDateDisplay(a.date))+(a.time ? ' · '+escapeHtml(a.time) : '')+(a.clinicName ? ' · '+escapeHtml(a.clinicName) : '')+'</div></div>'
        + '</div>';
    }).join('');
  }

  function openBookApptModal(){ $('pat-book-appt-modal').classList.remove('hidden'); }
  function closeBookApptModal(){ $('pat-book-appt-modal').classList.add('hidden'); }
  $('pat-book-appt-btn').addEventListener('click', openBookApptModal);
  $('pat-book-appt-close').addEventListener('click', closeBookApptModal);
  $('pat-book-appt-ok').addEventListener('click', closeBookApptModal);
  $('pat-book-appt-modal').addEventListener('click', function(e){ if (e.target === $('pat-book-appt-modal')) closeBookApptModal(); });

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

  function openVisitModal(v){
    $('visit-modal-date').textContent = formatDateDisplay(v.date) + (v.time ? ' · ' + v.time : '');
    $('visit-modal-doctor').innerHTML = escapeHtml(v.doctorName || 'Doctor') + unverifiedTagHtml(v);
    $('visit-modal-clinic').textContent = v.clinicName || 'Not recorded';
    $('visit-modal-symptoms').textContent = v.symptoms || 'Not recorded';
    $('visit-modal-diagnosis').textContent = v.diagnosis || 'Not recorded';
    $('visit-modal-prescription').textContent = v.prescription || 'Not recorded';
    $('visit-modal-notes').textContent = v.notes || 'Not recorded';
    $('pat-visit-modal').classList.remove('hidden');
  }
  function closeVisitModal(){ $('pat-visit-modal').classList.add('hidden'); }
  $('pat-visit-modal-close').addEventListener('click', closeVisitModal);
  $('pat-visit-modal').addEventListener('click', function(e){ if (e.target === $('pat-visit-modal')) closeVisitModal(); });

  function openTestModal(t){
    $('test-modal-date').textContent = formatDateDisplay(t.date);
    $('test-modal-name').innerHTML = escapeHtml(t.name || 'Test') + unverifiedTagHtml(t);
    $('test-modal-doctor').textContent = t.doctorName || 'Not recorded';
    $('test-modal-result').textContent = t.resultSummary || 'No result summary added yet.';
    $('pat-test-modal').classList.remove('hidden');
  }
  function closeTestModal(){ $('pat-test-modal').classList.add('hidden'); }
  $('pat-test-modal-close').addEventListener('click', closeTestModal);
  $('pat-test-modal').addEventListener('click', function(e){ if (e.target === $('pat-test-modal')) closeTestModal(); });

  // ---- My Eyes ----
  function fmtDiopter(v){
    var n = parseFloat(v);
    if (v === '' || v === null || v === undefined || isNaN(n)) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(2);
  }
  function renderEyesList(entries){
    var listEl = $('pat-eyes-list');
    var emptyEl = $('pat-eyes-empty');
    var chartsEl = $('pat-eyes-charts');
    if (!entries || !entries.length){
      listEl.innerHTML = '';
      emptyEl.classList.remove('hidden');
      chartsEl.classList.add('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    chartsEl.classList.remove('hidden');
    listEl.innerHTML = entries.map(function(e, i){
      return '<div class="list-item" data-idx="'+i+'">'
        + '<div><div class="li-title">'+escapeHtml(formatDateDisplay(e.date))+'</div>'
        + '<div class="li-sub">L '+escapeHtml(fmtDiopter(e.sphL))+' / '+escapeHtml(fmtDiopter(e.cylL))+' / '+escapeHtml(e.axisL || '—')+'°'
        + ' · R '+escapeHtml(fmtDiopter(e.sphR))+' / '+escapeHtml(fmtDiopter(e.cylR))+' / '+escapeHtml(e.axisR || '—')+'°</div></div>'
        + chevronSvg + '</div>';
    }).join('');
    listEl.querySelectorAll('.list-item').forEach(function(el){
      el.addEventListener('click', function(){
        openEyeModal(entries[parseInt(el.getAttribute('data-idx'), 10)]);
      });
    });
    renderEyeMetricChart('eyes-sph-chart-wrap', entries, 'sphL', 'sphR');
    renderEyeMetricChart('eyes-cyl-chart-wrap', entries, 'cylL', 'cylR');
  }
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
    var minV = Math.min.apply(null, vals), maxV = Math.max.apply(null, vals);
    if (minV === maxV){ minV -= 1; maxV += 1; }
    var pad = (maxV - minV) * 0.2;
    minV -= pad; maxV += pad;

    var w = 580, h = 200, padL = 38, padR = 12, padT = 14, padB = 26;
    var innerW = w - padL - padR, innerH = h - padT - padB;
    function x(i){ return padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW); }
    function y(v){ return padT + innerH - ((v - minV) / (maxV - minV)) * innerH; }

    function buildLine(key, color){
      var pts = [];
      sorted.forEach(function(e, i){
        var v = parseFloat(e[key]);
        if (!isNaN(v)) pts.push({ i: i, v: v });
      });
      if (!pts.length) return '';
      var line = pts.map(function(p){ return x(p.i) + ',' + y(p.v); }).join(' ');
      var dots = pts.map(function(p){
        return '<circle cx="'+x(p.i)+'" cy="'+y(p.v)+'" r="3" fill="'+color+'"><title>'+escapeHtml(formatDateDisplay(sorted[p.i].date))+': '+fmtDiopter(p.v)+'</title></circle>';
      }).join('');
      return '<polyline points="'+line+'" fill="none" stroke="'+color+'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' + dots;
    }

    var yTicks = [minV, (minV + maxV) / 2, maxV];
    var gridHtml = yTicks.map(function(t){
      var yy = y(t);
      return '<line x1="'+padL+'" y1="'+yy+'" x2="'+(w-padR)+'" y2="'+yy+'" stroke="var(--line)" stroke-width="1"/>'
        + '<text x="'+(padL-8)+'" y="'+(yy+3)+'" text-anchor="end" font-size="9" fill="var(--muted)" font-family=\'IBM Plex Mono, monospace\'>'+fmtDiopter(t)+'</text>';
    }).join('');

    var labelCount = Math.min(5, n);
    var labelIdxs = [];
    for (var i = 0; i < labelCount; i++){
      labelIdxs.push(Math.round(i * (n - 1) / Math.max(1, labelCount - 1)));
    }
    labelIdxs = labelIdxs.filter(function(v, i, a){ return a.indexOf(v) === i; });
    var xLabelsHtml = labelIdxs.map(function(i){
      return '<text x="'+x(i)+'" y="'+(h-8)+'" text-anchor="middle" font-size="9" fill="var(--muted)" font-family=\'IBM Plex Mono, monospace\'>'+escapeHtml(formatDateShort(sorted[i].date))+'</text>';
    }).join('');

    wrap.innerHTML = '<svg viewBox="0 0 '+w+' '+h+'" width="100%" style="display:block;">'
      + gridHtml
      + buildLine(leftKey, 'var(--teal)')
      + buildLine(rightKey, 'var(--red)')
      + xLabelsHtml
      + '</svg>'
      + '<div class="chart-legend"><span><span class="legend-dot" style="background:var(--teal);"></span>Left eye</span>'
      + '<span><span class="legend-dot" style="background:var(--red);"></span>Right eye</span></div>';
  }
  function openEyeModal(e){
    $('eye-modal-date').textContent = formatDateDisplay(e.date);
    $('eye-modal-left').textContent = fmtDiopter(e.sphL) + ' / ' + fmtDiopter(e.cylL) + ' / ' + (e.axisL || '—') + '°';
    $('eye-modal-right').textContent = fmtDiopter(e.sphR) + ' / ' + fmtDiopter(e.cylR) + ' / ' + (e.axisR || '—') + '°';
    $('eye-modal').classList.remove('hidden');
  }
  function closeEyeModal(){ $('eye-modal').classList.add('hidden'); }
  $('eye-modal-close').addEventListener('click', closeEyeModal);
  $('eye-modal').addEventListener('click', function(e){ if (e.target === $('eye-modal')) closeEyeModal(); });

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
      patient_id: session.id,
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
      $('add-eye-save').textContent = 'Save eye check';
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
    data.visitLog = await loadDoctorVisitLog(id);
    currentDoctorData = data;
    $('doc-dash-id').textContent = data.doctorId;
    $('doc-modal-id').textContent = data.doctorId;
    $('doc-name').value = data.name || '';
    $('doc-email').value = authUser.email || '';
    $('doc-phone').value = data.phone || '';
    $('doc-license').value = data.license || '';
    $('doc-specialty').value = data.specialty || '';
    $('doc-education').value = data.education || '';
    $('doc-about').value = data.about || '';
    renderDoctorCard(data);
    renderVerifyBanner('doc', authUser.email, !!authUser.email_confirmed_at);
    renderDoctorVerification(data);
    renderClinicSelect(data);
    $('lookup-code').value = '';
    $('lookup-row').classList.remove('hidden');
    $('lookup-subtitle').classList.remove('hidden');
    $('patient-result').classList.add('hidden');
    $('lookup-not-found').classList.add('hidden');
    $('lookup-empty').classList.remove('hidden');
    currentLookupCode = null;
    currentLookupData = null;
    currentLookupGrant = null;
    switchFindTab('code');
    renderRoster();
    closeAddVisitModal();
    closeDocVisitModal();
    closeAddTestModal();
    closeDocTestModal();
    closeDocAcctDropdown();
    docHowItWorks.close();
    showView('view-doctor-dash');
  }

  // ---- Find a patient: code vs. roster ----
  function switchFindTab(tab){
    var code = tab === 'code';
    $('doc-find-tab-code').classList.toggle('active', code);
    $('doc-find-tab-roster').classList.toggle('active', !code);
    $('doc-find-code-pane').classList.toggle('hidden', !code);
    $('doc-find-roster-pane').classList.toggle('hidden', code);
    if ($('patient-result').classList.contains('hidden')){
      $('lookup-empty').classList.toggle('hidden', !code);
    }
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
    var items = [
      { label:'Medical license number', done: !!data.license }
    ];
    var html = '';
    items.forEach(function(it){
      html += '<li class="'+(it.done?'done':'')+'"><span class="dot"></span>'+it.label+'</li>';
    });
    $('doc-checklist').innerHTML = html;
  }

  // ---- Clinics ----
  function renderClinicSelect(data){
    var clinics = data.clinics || [];
    var select = $('doc-current-clinic');
    var current = data.currentClinic || '';
    select.innerHTML = '<option value="">No clinic selected</option>' + clinics.map(function(c){
      return '<option value="'+escapeHtml(c)+'"'+(c === current ? ' selected' : '')+'>'+escapeHtml(c)+'</option>';
    }).join('');
    $('doc-clinic-hint').classList.toggle('hidden', clinics.length > 0);
  }
  function renderClinicsList(data){
    var clinics = data.clinics || [];
    var listEl = $('doc-clinics-list');
    if (!clinics.length){
      listEl.innerHTML = '<span class="hint">No clinics added yet.</span>';
      return;
    }
    listEl.innerHTML = clinics.map(function(c, i){
      return '<span class="chip">'+escapeHtml(c)+'<button type="button" data-idx="'+i+'" aria-label="Remove clinic">&times;</button></span>';
    }).join('');
    listEl.querySelectorAll('button').forEach(function(btn){
      btn.addEventListener('click', async function(){
        var idx = parseInt(btn.getAttribute('data-idx'), 10);
        var removed = currentDoctorData.clinics.splice(idx, 1)[0];
        if (currentDoctorData.currentClinic === removed) currentDoctorData.currentClinic = '';
        await supabaseClient.from('doctors').update({ clinics: currentDoctorData.clinics, current_clinic: currentDoctorData.currentClinic }).eq('id', session.id);
        renderClinicsList(currentDoctorData);
        renderClinicSelect(currentDoctorData);
      });
    });
  }
  $('doc-clinic-add-btn').addEventListener('click', async function(){
    var input = $('doc-clinic-input');
    var name = input.value.trim();
    if (!name) return;
    if (!currentDoctorData.clinics) currentDoctorData.clinics = [];
    var exists = currentDoctorData.clinics.some(function(c){ return c.toLowerCase() === name.toLowerCase(); });
    if (!exists){
      currentDoctorData.clinics.push(name);
      if (!currentDoctorData.currentClinic) currentDoctorData.currentClinic = name;
      await supabaseClient.from('doctors').update({ clinics: currentDoctorData.clinics, current_clinic: currentDoctorData.currentClinic }).eq('id', session.id);
      renderClinicsList(currentDoctorData);
      renderClinicSelect(currentDoctorData);
    }
    input.value = '';
    input.focus();
  });
  $('doc-clinic-input').addEventListener('keydown', function(e){
    if (e.key === 'Enter'){ e.preventDefault(); $('doc-clinic-add-btn').click(); }
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
  $('doc-profile-save-btn').addEventListener('click', async function(){
    var name = $('doc-name').value.trim();
    var specialty = $('doc-specialty').value.trim();
    var education = $('doc-education').value.trim();
    var about = $('doc-about').value.trim();
    await supabaseClient.from('doctors').update({ name: name, specialty: specialty, education: education, about: about }).eq('id', session.id);
    currentDoctorData.name = name;
    currentDoctorData.specialty = specialty;
    currentDoctorData.education = education;
    currentDoctorData.about = about;
    renderDoctorCard(currentDoctorData);
    var note = $('doc-profile-save-note');
    note.classList.add('show');
    setTimeout(function(){ note.classList.remove('show'); }, 1800);
  });
  $('doc-dash-copy').addEventListener('click', function(){
    copyToClipboard(currentDoctorData.doctorId, $('doc-dash-copy-note'));
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
    await supabaseClient.auth.signOut();
    session = { type:null, id:null };
    showView('view-landing');
  });

  function openDocAccountSettingsPage(){
    renderClinicsList(currentDoctorData);
    $('doc-clinic-input').value = '';
    closeDocAcctDropdown();
    showView('view-doc-account-settings');
  }
  $('doc-account-settings-btn').addEventListener('click', openDocAccountSettingsPage);

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
    if (e.key === 'Escape'){ closeVisitModal(); closeTestModal(); closeAddVisitModal(); closeDocVisitModal(); closeDocTestModal(); closeAddTestModal(); closeAddEyeModal(); closeEyeModal(); closePatAccessModal(); closeBookApptModal(); closePatAcctDropdown(); patHowItWorks.close(); closeDocAcctDropdown(); docHowItWorks.close(); }
  });

  function escapeHtml(s){
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
  function unverifiedTagHtml(entry){
    return entry && entry.unverified ? ' <span class="badge unverified" style="padding:2px 8px; font-size:0.68rem;">Unverified</span>' : '';
  }
  var currentLookupCode = null;
  var currentLookupData = null;
  var currentLookupGrant = null;

  function renderDoctorVisitsList(visits){
    var listEl = $('doc-visits-list');
    var emptyEl = $('doc-visits-empty');
    if (!visits || !visits.length){
      listEl.innerHTML = '';
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    listEl.innerHTML = visits.map(function(v, i){
      return '<div class="list-item" data-idx="'+i+'">'
        + '<div><div class="li-title">'+escapeHtml(v.doctorName || 'Doctor')+unverifiedTagHtml(v)+'</div>'
        + '<div class="li-sub">'+escapeHtml(formatDateDisplay(v.date))+(v.time ? ' · '+escapeHtml(v.time) : '')+(v.clinicName ? ' · '+escapeHtml(v.clinicName) : '')+'</div></div>'
        + chevronSvg + '</div>';
    }).join('');
    listEl.querySelectorAll('.list-item').forEach(function(el){
      el.addEventListener('click', function(){
        openDocVisitModal(visits[parseInt(el.getAttribute('data-idx'), 10)]);
      });
    });
  }
  function openDocVisitModal(v){
    $('doc-visit-modal-date').textContent = formatDateDisplay(v.date) + (v.time ? ' · ' + v.time : '');
    $('doc-visit-modal-doctor').innerHTML = escapeHtml(v.doctorName || 'Doctor') + unverifiedTagHtml(v);
    $('doc-visit-modal-clinic').textContent = v.clinicName || 'Not recorded';
    $('doc-visit-modal-symptoms').textContent = v.symptoms || 'Not recorded';
    $('doc-visit-modal-diagnosis').textContent = v.diagnosis || 'Not recorded';
    $('doc-visit-modal-prescription').textContent = v.prescription || 'Not recorded';
    $('doc-visit-modal-notes').textContent = v.notes || 'Not recorded';
    $('doc-visit-modal').classList.remove('hidden');
  }
  function closeDocVisitModal(){ $('doc-visit-modal').classList.add('hidden'); }
  $('doc-visit-modal-close').addEventListener('click', closeDocVisitModal);
  $('doc-visit-modal').addEventListener('click', function(e){ if (e.target === $('doc-visit-modal')) closeDocVisitModal(); });

  function renderDoctorTestsList(tests){
    var listEl = $('doc-tests-list');
    var emptyEl = $('doc-tests-empty');
    if (!tests || !tests.length){
      listEl.innerHTML = '';
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    listEl.innerHTML = tests.map(function(t, i){
      return '<div class="list-item" data-idx="'+i+'">'
        + '<div><div class="li-title">'+escapeHtml(t.name || 'Test')+unverifiedTagHtml(t)+'</div>'
        + '<div class="li-sub">'+escapeHtml(formatDateDisplay(t.date))+'</div></div>'
        + chevronSvg + '</div>';
    }).join('');
    listEl.querySelectorAll('.list-item').forEach(function(el){
      el.addEventListener('click', function(){
        openDocTestModal(tests[parseInt(el.getAttribute('data-idx'), 10)]);
      });
    });
  }
  function openDocTestModal(t){
    $('doc-test-modal-date').textContent = formatDateDisplay(t.date);
    $('doc-test-modal-name').innerHTML = escapeHtml(t.name || 'Test') + unverifiedTagHtml(t);
    $('doc-test-modal-doctor').textContent = t.doctorName || 'Not recorded';
    $('doc-test-modal-result').textContent = t.resultSummary || 'No result summary added yet.';
    $('doc-test-modal').classList.remove('hidden');
  }
  function closeDocTestModal(){ $('doc-test-modal').classList.add('hidden'); }
  $('doc-test-modal-close').addEventListener('click', closeDocTestModal);
  $('doc-test-modal').addEventListener('click', function(e){ if (e.target === $('doc-test-modal')) closeDocTestModal(); });

  function showLookupResult(patientId, data, grant){
    currentLookupCode = patientId;
    currentLookupData = data;
    currentLookupGrant = grant || null;
    $('lookup-row').classList.add('hidden');
    $('lookup-subtitle').classList.add('hidden');
    $('doc-find-code-pane').classList.add('hidden');
    $('doc-find-roster-pane').classList.add('hidden');
    $('lookup-not-found').classList.add('hidden');
    $('lookup-empty').classList.add('hidden');
    $('patient-result').classList.remove('hidden');
    $('res-name').textContent = data.name || 'Unnamed patient';
    $('add-visit-patient-name').textContent = data.name || 'this patient';
    var accessNote = 'Access: standing trust';
    if (currentLookupGrant && currentLookupGrant.granted_via === 'code' && currentLookupGrant.expires_at){
      var mins = Math.max(0, Math.ceil((new Date(currentLookupGrant.expires_at).getTime() - Date.now()) / 60000));
      accessNote = 'Access: one-time code · ends in ~' + mins + 'm';
    }
    $('res-access-note').textContent = accessNote;
    $('doc-record-visits-heading').textContent = 'Visits — ' + (data.name || 'Unnamed patient');
    $('doc-record-tests-heading').textContent = 'Tests — ' + (data.name || 'Unnamed patient');
    renderDoctorVisitsList(data.visits || []);
    renderDoctorTestsList(data.tests || []);
  }
  function resetLookup(){
    currentLookupCode = null;
    currentLookupData = null;
    currentLookupGrant = null;
    $('lookup-code').value = '';
    switchFindTab('code');
    $('lookup-row').classList.remove('hidden');
    $('lookup-subtitle').classList.remove('hidden');
    $('patient-result').classList.add('hidden');
    $('lookup-not-found').classList.add('hidden');
    $('lookup-empty').classList.remove('hidden');
    $('lookup-code').focus();
  }
  $('lookup-btn').addEventListener('click', async function(){
    var code = $('lookup-code').value.replace(/[^0-9]/g,'');
    $('lookup-empty').classList.add('hidden');
    if (code.length !== 6){
      $('patient-result').classList.add('hidden');
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
        $('patient-result').classList.add('hidden');
        $('lookup-not-found').classList.remove('hidden');
        $('lookup-not-found').textContent = mapRedeemErrorText(result.error);
        return;
      }
      var full = await loadPatientRecordForDoctor(result.patientId);
      if (!full){
        $('patient-result').classList.add('hidden');
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
  $('lookup-change-btn').addEventListener('click', resetLookup);

  function currentDoctorDisplayName(){
    var name = currentDoctorData && currentDoctorData.name ? currentDoctorData.name.trim() : '';
    if (name) return 'Dr. ' + name.replace(/^Dr\.?\s*/i, '');
    return (currentDoctorData && currentDoctorData.doctorId) || 'Doctor';
  }
  function openAddVisitModal(){
    if (!currentLookupCode) return;
    $('visit-date').value = new Date().toISOString().slice(0, 10);
    $('visit-time').value = '';
    $('visit-symptoms').value = '';
    $('visit-diagnosis').value = '';
    $('visit-prescription').value = '';
    $('visit-notes').value = '';
    clearError($('add-visit-error'));
    $('add-visit-modal').classList.remove('hidden');
  }
  function closeAddVisitModal(){
    $('add-visit-modal').classList.add('hidden');
  }
  $('add-visit-btn').addEventListener('click', openAddVisitModal);
  $('add-visit-close').addEventListener('click', closeAddVisitModal);
  $('add-visit-cancel').addEventListener('click', closeAddVisitModal);
  $('add-visit-modal').addEventListener('click', function(e){
    if (e.target === $('add-visit-modal')) closeAddVisitModal();
  });
  $('add-visit-save').addEventListener('click', async function(){
    if (!currentLookupCode){
      showError($('add-visit-error'), 'No patient selected.');
      return;
    }
    var date = $('visit-date').value;
    if (!date){
      showError($('add-visit-error'), 'Please choose a date.');
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
        date: date,
        time: $('visit-time').value.trim(),
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
      closeAddVisitModal();
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

  function openAddTestModal(){
    if (!currentLookupCode) return;
    $('test-name').value = '';
    $('test-date').value = new Date().toISOString().slice(0, 10);
    $('test-result').value = '';
    clearError($('add-test-error'));
    $('add-test-patient-name').textContent = (currentLookupData && currentLookupData.name) || 'this patient';
    $('add-test-modal').classList.remove('hidden');
  }
  function closeAddTestModal(){
    $('add-test-modal').classList.add('hidden');
  }
  $('add-test-btn').addEventListener('click', openAddTestModal);
  $('add-test-close').addEventListener('click', closeAddTestModal);
  $('add-test-cancel').addEventListener('click', closeAddTestModal);
  $('add-test-modal').addEventListener('click', function(e){
    if (e.target === $('add-test-modal')) closeAddTestModal();
  });
  $('add-test-save').addEventListener('click', async function(){
    if (!currentLookupCode){
      showError($('add-test-error'), 'No patient selected.');
      return;
    }
    var name = $('test-name').value.trim();
    var date = $('test-date').value;
    if (!name){
      showError($('add-test-error'), 'Please enter a test name.');
      return;
    }
    if (!date){
      showError($('add-test-error'), 'Please choose a date.');
      return;
    }
    clearError($('add-test-error'));
    $('add-test-save').disabled = true;
    $('add-test-save').textContent = 'Saving...';
    try{
      var activeGrant = await getActiveGrant(currentLookupCode, session.id);
      if (!activeGrant){
        showError($('add-test-error'), 'Your access to this patient has expired or been revoked. Ask them for a new code or to re-trust you.');
        return;
      }
      var row = {
        patient_id: currentLookupCode,
        authored_by_doctor_id: session.id,
        written_via_grant_id: activeGrant.id,
        name: name,
        date: date,
        doctor_name: currentDoctorDisplayName(),
        result_summary: $('test-result').value.trim(),
        unverified: !isDoctorVerified(currentDoctorData || {})
      };
      var res = await supabaseClient.from('tests').insert(row).select().maybeSingle();
      if (res.error || !res.data){
        showError($('add-test-error'), 'Your access to this patient has expired or been revoked. Ask them for a new code or to re-trust you.');
        return;
      }
      currentLookupData.tests = [mapTestRow(res.data)].concat(currentLookupData.tests || []);
      renderDoctorTestsList(currentLookupData.tests);
      closeAddTestModal();
      var note = $('add-test-note');
      note.classList.add('show');
      setTimeout(function(){ note.classList.remove('show'); }, 2200);
    }catch(e){
      showError($('add-test-error'), 'Something went wrong saving this test. Please try again.');
    }finally{
      $('add-test-save').disabled = false;
      $('add-test-save').textContent = 'Save test';
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
  // session already exists (including one just established by a confirmation or
  // password-reset link's #access_token=... fragment, which the client consumes
  // automatically during getSession()), route straight into the right dashboard
  // instead of showing landing at all.
  (async function bootstrap(){
    var res = await supabaseClient.auth.getSession();
    var authSession = res.data && res.data.session;
    if (authSession && authSession.user){
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
    } else {
      history.replaceState({ view: 'view-landing' }, '', '#view-landing');
      suppressHistoryPush = true;
      showView('view-landing');
      suppressHistoryPush = false;
    }
  })();
})();

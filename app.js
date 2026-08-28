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
  // Real persistence for a live deploy: a Supabase project with a single `kv_store`
  // table (key text primary key, value text) mirrors this file's get/set-by-key
  // interface almost exactly, so the rest of the app didn't need to change.
  // Fill these in once you have a Supabase project (Settings > API) — until then
  // they're left as placeholders and the app quietly skips straight to the
  // in-memory fallback below, exactly like before.
  var SUPABASE_URL = 'https://topuupugxzulubrbkuzo.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvcHV1cHVneHp1bHVicmJrdXpvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY3ODA4NzQsImV4cCI6MjEwMjM1Njg3NH0.0DLPi6wP2NgibwJjf7ZSkazUQos81RAL6aM8JO7MLb4';
  var supabaseClient = null;
  if (window.supabase && SUPABASE_URL.indexOf('YOUR_') !== 0 && SUPABASE_ANON_KEY.indexOf('YOUR_') !== 0){
    try{ supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY); }catch(e){}
  }

  // In-memory fallback store, used if window.storage and Supabase are both
  // unavailable or error out, so the app still works (for this browser tab) even
  // without persistence.
  var memoryStore = {};
  async function storeGet(key){
    if (window.storage && typeof window.storage.get === 'function'){
      try{
        var r = await window.storage.get(key, true);
        return r ? r.value : null;
      }catch(e){
        // treat as "not found" and fall through below
      }
    }
    if (supabaseClient){
      try{
        var res = await supabaseClient.from('kv_store').select('value').eq('key', key).maybeSingle();
        if (!res.error) return res.data ? res.data.value : null;
      }catch(e){
        // fall through to memory below
      }
    }
    return Object.prototype.hasOwnProperty.call(memoryStore, key) ? memoryStore[key] : null;
  }
  async function storeSet(key, value){
    memoryStore[key] = value;
    if (window.storage && typeof window.storage.set === 'function'){
      try{
        await window.storage.set(key, value, true);
      }catch(e){
        // keep the memory copy so the app still works this session
      }
    }
    if (supabaseClient){
      try{
        await supabaseClient.from('kv_store').upsert({ key: key, value: value, updated_at: new Date().toISOString() });
      }catch(e){
        // keep the memory copy so the app still works this session
      }
    }
  }
  async function keyExists(key){
    var v = await storeGet(key);
    return v !== null && v !== undefined;
  }
  async function generatePatientCode(){
    var code, exists = true;
    while(exists){ code = randomDigits(8); exists = await keyExists('patient:'+code); }
    return code;
  }
  async function generateDoctorId(){
    var id, exists = true;
    while(exists){ id = 'DR-' + randomDigits(6); exists = await keyExists('doctor:'+id); }
    return id;
  }
  async function savePatient(code, data){
    await storeSet('patient:'+code, JSON.stringify(data));
  }
  async function loadPatient(code){
    var v = await storeGet('patient:'+code);
    try{ return v ? JSON.parse(v) : null; }catch(e){ return null; }
  }
  async function saveDoctor(id, data){
    await storeSet('doctor:'+id, JSON.stringify(data));
  }
  async function loadDoctor(id){
    var v = await storeGet('doctor:'+id);
    try{ return v ? JSON.parse(v) : null; }catch(e){ return null; }
  }
  function isDoctorVerified(d){ return !!(d.email && d.phone && d.license); }

  // ---------- Access grants (see ACCESS-MODEL.md) ----------
  // A doctor never gets standing access just by knowing a patient's permanent account
  // code. Access is either a single-use, 2-minute code redeemed in person (good for one
  // hour from redemption) or a standing "Trusted" grant the patient creates and can
  // revoke any time. Both produce the same kind of row here, checked the same way:
  // valid = exists a grant for (patient, doctor) with revoked_at null and
  // (expires_at null or expires_at > now). Real persistence needs the access_codes /
  // access_grants tables (see the SQL in the access-model plan); if they're not there
  // yet, these fall back to in-memory arrays for this tab's session only, same spirit
  // as the kv_store fallback above.
  var memoryAccessCodes = [];
  var memoryAccessGrants = [];
  function uid(){
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c){
      var r = Math.random()*16|0, v = c === 'x' ? r : (r&0x3|0x8);
      return v.toString(16);
    });
  }
  async function createAccessCode(patientId){
    var row = {
      id: uid(), patient_id: patientId, code: randomDigits(6),
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 2*60*1000).toISOString(),
      redeemed_at: null, redeemed_by_doctor_id: null
    };
    if (supabaseClient){
      try{
        var res = await supabaseClient.from('access_codes').insert(row).select().maybeSingle();
        if (!res.error && res.data) return res.data;
      }catch(e){}
    }
    memoryAccessCodes.push(row);
    return row;
  }
  async function getLatestAccessCode(patientId){
    if (supabaseClient){
      try{
        var res = await supabaseClient.from('access_codes').select('*').eq('patient_id', patientId).order('created_at', { ascending:false }).limit(1).maybeSingle();
        if (!res.error) return res.data || null;
      }catch(e){}
    }
    var mine = memoryAccessCodes.filter(function(r){ return r.patient_id === patientId; });
    if (!mine.length) return null;
    mine.sort(function(a,b){ return a.created_at < b.created_at ? 1 : -1; });
    return mine[0];
  }
  async function markCodeRedeemed(row, doctorId){
    row.redeemed_at = new Date().toISOString();
    row.redeemed_by_doctor_id = doctorId;
    if (supabaseClient){
      try{ await supabaseClient.from('access_codes').update({ redeemed_at: row.redeemed_at, redeemed_by_doctor_id: doctorId }).eq('id', row.id); return; }catch(e){}
    }
    // memory row was mutated in place above
  }
  async function insertGrant(row){
    if (supabaseClient){
      try{
        var res = await supabaseClient.from('access_grants').insert(row).select().maybeSingle();
        if (!res.error && res.data) return res.data;
      }catch(e){}
    }
    memoryAccessGrants.push(row);
    return row;
  }
  async function createTrustGrant(patientId, doctorId){
    var existing = await getActiveGrant(patientId, doctorId);
    if (existing && !existing.expires_at) return existing;
    return await insertGrant({
      id: uid(), patient_id: patientId, doctor_id: doctorId, granted_via:'trust',
      source_code_id: null, granted_at: new Date().toISOString(), expires_at: null, revoked_at: null
    });
  }
  async function revokeGrant(grantId){
    if (supabaseClient){
      try{ await supabaseClient.from('access_grants').update({ revoked_at: new Date().toISOString() }).eq('id', grantId); }catch(e){}
    }
    memoryAccessGrants.forEach(function(g){ if (g.id === grantId) g.revoked_at = new Date().toISOString(); });
  }
  async function listGrantsForPatient(patientId){
    var rows = [];
    if (supabaseClient){
      try{
        var res = await supabaseClient.from('access_grants').select('*').eq('patient_id', patientId);
        if (!res.error && res.data) rows = res.data;
      }catch(e){}
    }
    memoryAccessGrants.forEach(function(g){ if (g.patient_id === patientId && rows.indexOf(g) === -1 && !rows.some(function(r){ return r.id === g.id; })) rows.push(g); });
    return rows;
  }
  async function listGrantsForDoctor(doctorId){
    var rows = [];
    if (supabaseClient){
      try{
        var res = await supabaseClient.from('access_grants').select('*').eq('doctor_id', doctorId);
        if (!res.error && res.data) rows = res.data;
      }catch(e){}
    }
    memoryAccessGrants.forEach(function(g){ if (g.doctor_id === doctorId && !rows.some(function(r){ return r.id === g.id; })) rows.push(g); });
    return rows;
  }
  function isGrantActive(g){
    if (!g || g.revoked_at) return false;
    if (!g.expires_at) return true;
    return new Date(g.expires_at).getTime() > Date.now();
  }
  async function getActiveGrant(patientId, doctorId){
    var rows = (await listGrantsForPatient(patientId)).filter(function(g){ return g.doctor_id === doctorId; });
    var active = rows.filter(isGrantActive);
    if (!active.length) return null;
    // Prefer the trust grant if both exist somehow.
    active.sort(function(a,b){ return a.granted_via === 'trust' ? -1 : 1; });
    return active[0];
  }
  async function redeemAccessCode(code, doctorId){
    var latest = null;
    // We need the code across all patients, not just one — search isn't scoped to a
    // patient the doctor already knows, so query directly.
    if (supabaseClient){
      try{
        var res = await supabaseClient.from('access_codes').select('*').eq('code', code).order('created_at', { ascending:false }).limit(1).maybeSingle();
        if (!res.error) latest = res.data || null;
      }catch(e){}
    }
    if (!latest){
      var candidates = memoryAccessCodes.filter(function(r){ return r.code === code; });
      candidates.sort(function(a,b){ return a.created_at < b.created_at ? 1 : -1; });
      latest = candidates[0] || null;
    }
    if (!latest) return { ok:false, reason:'not-found' };
    // Only the most recent code issued for that patient is ever valid (v3 design —
    // generating a fresh code silently retires the previous one).
    var current = await getLatestAccessCode(latest.patient_id);
    if (!current || current.id !== latest.id || current.code !== code) return { ok:false, reason:'not-found' };
    if (latest.redeemed_at) return { ok:false, reason:'redeemed' };
    if (new Date(latest.expires_at).getTime() <= Date.now()) return { ok:false, reason:'expired' };

    var trustGrant = await getActiveGrant(latest.patient_id, doctorId);
    if (trustGrant && trustGrant.granted_via === 'trust'){
      // Trusted doctor redeeming a code is pure navigation — mark the code used, but
      // don't create a separate one-hour grant that would just shadow the standing one.
      await markCodeRedeemed(latest, doctorId);
      return { ok:true, patientId: latest.patient_id, grant: trustGrant };
    }
    await markCodeRedeemed(latest, doctorId);
    var grant = await insertGrant({
      id: uid(), patient_id: latest.patient_id, doctor_id: doctorId, granted_via:'code',
      source_code_id: latest.id, granted_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60*60*1000).toISOString(), revoked_at: null
    });
    return { ok:true, patientId: latest.patient_id, grant: grant };
  }
  function maskPhone(phone){
    if (!phone) return 'No phone on file';
    var digits = phone.replace(/\D/g, '');
    if (digits.length < 4) return phone;
    return '••• ' + digits.slice(-4);
  }
  async function listTrustedDoctorsForPatient(patientId){
    var grants = (await listGrantsForPatient(patientId)).filter(function(g){ return g.granted_via === 'trust' && isGrantActive(g); });
    var out = [];
    for (var i=0;i<grants.length;i++){
      var d = await loadDoctor(grants[i].doctor_id);
      out.push({ grant: grants[i], doctor: d || { doctorId: grants[i].doctor_id, name:'' } });
    }
    return out;
  }
  async function listActiveAdhocGrantsForPatient(patientId){
    var grants = (await listGrantsForPatient(patientId)).filter(function(g){ return g.granted_via === 'code' && isGrantActive(g); });
    var out = [];
    for (var i=0;i<grants.length;i++){
      var d = await loadDoctor(grants[i].doctor_id);
      out.push({ grant: grants[i], doctor: d || { doctorId: grants[i].doctor_id, name:'' } });
    }
    return out;
  }
  async function listTrustedPatientsForDoctor(doctorId){
    var grants = (await listGrantsForDoctor(doctorId)).filter(function(g){ return g.granted_via === 'trust' && isGrantActive(g); });
    var out = [];
    for (var i=0;i<grants.length;i++){
      var p = await loadPatient(grants[i].patient_id);
      if (p) out.push({ grant: grants[i], patient: p });
    }
    return out;
  }

  async function hashPassword(password){
    if (!password) return '';
    try{
      var enc = new TextEncoder().encode(password);
      var digest = await crypto.subtle.digest('SHA-256', enc);
      return Array.from(new Uint8Array(digest)).map(function(b){ return b.toString(16).padStart(2, '0'); }).join('');
    }catch(e){
      // Fallback for environments without SubtleCrypto (e.g. non-HTTPS). Not cryptographically secure.
      var h = 0;
      for (var i = 0; i < password.length; i++){ h = ((h << 5) - h + password.charCodeAt(i)) | 0; }
      return 'fb_' + h;
    }
  }
  function showError(el, message){
    el.textContent = message;
    el.classList.add('show');
  }
  function clearError(el){
    el.textContent = '';
    el.classList.remove('show');
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

  // ================= DOCTOR AUTH =================
  function resetDoctorAuthView(){
    $('doc-tab-signup').classList.add('active');
    $('doc-tab-signin').classList.remove('active');
    $('doc-signup-pane').classList.remove('hidden');
    $('doc-signin-pane').classList.add('hidden');
    $('doc-google-panel').classList.add('hidden');
    $('doc-signup-name').value = '';
    $('doc-signup-phone').value = '';
    $('doc-signup-email').value = '';
    $('doc-signup-password').value = '';
    $('doc-signup-password2').value = '';
    $('doc-google-name').value = '';
    $('doc-google-phone').value = '';
    $('doc-google-email').value = '';
    clearError($('doc-create-error'));
    clearError($('doc-google-error'));
    $('doc-signin-id').value = '';
    $('doc-signin-password').value = '';
    clearError($('doc-signin-error'));
  }
  $('doc-tab-signup').addEventListener('click', function(){
    $('doc-tab-signup').classList.add('active'); $('doc-tab-signin').classList.remove('active');
    $('doc-signup-pane').classList.remove('hidden'); $('doc-signin-pane').classList.add('hidden');
  });
  $('doc-tab-signin').addEventListener('click', function(){
    $('doc-tab-signin').classList.add('active'); $('doc-tab-signup').classList.remove('active');
    $('doc-signin-pane').classList.remove('hidden'); $('doc-signup-pane').classList.add('hidden');
  });
  async function createDoctorAccount(name, phone, email, password){
    var id = await generateDoctorId();
    var passwordHash = password ? await hashPassword(password) : '';
    var data = { doctorId:id, name:name||'', email:email||'', phone:phone||'', license:'', specialty:'', education:'', about:'', photoUrl:'', passwordHash:passwordHash, clinics:[], currentClinic:'', visitLog:[], createdAt: Date.now() };
    data.verified = isDoctorVerified(data);
    await saveDoctor(id, data);
    session = { type:'doctor', id:id };
    await enterDoctorDash(id);
  }
  $('doc-create-btn').addEventListener('click', async function(){
    var name = $('doc-signup-name').value.trim();
    var phone = $('doc-signup-phone').value.trim();
    var email = $('doc-signup-email').value.trim();
    var password = $('doc-signup-password').value;
    var password2 = $('doc-signup-password2').value;
    clearError($('doc-create-error'));
    if (password && password.length < 6){
      showError($('doc-create-error'), 'Password must be at least 6 characters, or leave both password fields blank to skip it for now.');
      return;
    }
    if (password !== password2){
      showError($('doc-create-error'), 'Passwords don\u2019t match.');
      return;
    }
    $('doc-create-btn').disabled = true;
    $('doc-create-btn').textContent = 'Creating...';
    try{
      await createDoctorAccount(name, phone, email, password);
    }catch(e){
      showError($('doc-create-error'), 'Something went wrong creating your account. Please try again.');
    }finally{
      $('doc-create-btn').disabled = false;
      $('doc-create-btn').textContent = 'Create my account';
    }
  });
  $('doc-google-btn').addEventListener('click', function(){
    $('doc-google-panel').classList.toggle('hidden');
  });
  $('doc-google-continue').addEventListener('click', async function(){
    var name = $('doc-google-name').value.trim();
    var phone = $('doc-google-phone').value.trim();
    var email = $('doc-google-email').value.trim();
    $('doc-google-continue').disabled = true;
    $('doc-google-continue').textContent = 'Creating...';
    clearError($('doc-google-error'));
    try{
      await createDoctorAccount(name, phone, email, '');
    }catch(e){
      showError($('doc-google-error'), 'Something went wrong creating your account. Please try again.');
    }finally{
      $('doc-google-continue').disabled = false;
      $('doc-google-continue').textContent = 'Continue';
    }
  });
  $('doc-signin-btn').addEventListener('click', async function(){
    var raw = $('doc-signin-id').value.trim().toUpperCase();
    var id = raw.indexOf('DR-') === 0 ? raw : 'DR-' + raw.replace(/[^0-9]/g,'');
    var password = $('doc-signin-password').value;
    var data = await loadDoctor(id);
    if (!data){
      showError($('doc-signin-error'), 'We couldn\u2019t find a doctor account with that ID.');
      return;
    }
    if (data.passwordHash){
      var enteredHash = await hashPassword(password);
      if (!password || enteredHash !== data.passwordHash){
        showError($('doc-signin-error'), 'Incorrect password.');
        return;
      }
    }
    clearError($('doc-signin-error'));
    session = { type:'doctor', id:id };
    await enterDoctorDash(id);
  });
  $('doc-signin-password').addEventListener('keydown', function(e){
    if (e.key === 'Enter') $('doc-signin-btn').click();
  });

  // ================= PATIENT AUTH =================
  function resetPatientAuthView(){
    $('pat-tab-signup').classList.add('active');
    $('pat-tab-signin').classList.remove('active');
    $('pat-signup-pane').classList.remove('hidden');
    $('pat-signin-pane').classList.add('hidden');
    $('pat-google-panel').classList.add('hidden');
    $('pat-signup-name').value = '';
    $('pat-signup-phone').value = '';
    $('pat-signup-email').value = '';
    $('pat-signup-password').value = '';
    $('pat-signup-password2').value = '';
    $('pat-google-name').value = '';
    $('pat-google-phone').value = '';
    $('pat-google-email').value = '';
    clearError($('pat-create-error'));
    clearError($('pat-google-error'));
    $('pat-signin-code').value = '';
    $('pat-signin-password').value = '';
    clearError($('pat-signin-error'));
  }
  $('pat-tab-signup').addEventListener('click', function(){
    $('pat-tab-signup').classList.add('active'); $('pat-tab-signin').classList.remove('active');
    $('pat-signup-pane').classList.remove('hidden'); $('pat-signin-pane').classList.add('hidden');
  });
  $('pat-tab-signin').addEventListener('click', function(){
    $('pat-tab-signin').classList.add('active'); $('pat-tab-signup').classList.remove('active');
    $('pat-signin-pane').classList.remove('hidden'); $('pat-signup-pane').classList.add('hidden');
  });
  function emailIndexKey(email){ return 'patient-email:' + email.trim().toLowerCase(); }
  async function linkPatientEmail(email, code){
    if (!email) return;
    await storeSet(emailIndexKey(email), code);
  }
  async function createPatientAccount(name, phone, email, password){
    var code = await generatePatientCode();
    var passwordHash = password ? await hashPassword(password) : '';
    var data = { code:code, name:name||'', email:email||'', phone:phone||'', dob:'', idNumber:'', bloodType:'', emergencyContact:'', allergies:'', conditions:'', medications:'', photoUrl:'', passwordHash:passwordHash, visits: sampleVisits(), tests: sampleTests(), appointments: sampleAppointments(), createdAt: Date.now() };
    await savePatient(code, data);
    await linkPatientEmail(email, code);
    session = { type:'patient', id:code };
    await enterPatientDash(code);
  }
  $('pat-create-btn').addEventListener('click', async function(){
    var name = $('pat-signup-name').value.trim();
    var phone = $('pat-signup-phone').value.trim();
    var email = $('pat-signup-email').value.trim();
    var password = $('pat-signup-password').value;
    var password2 = $('pat-signup-password2').value;
    clearError($('pat-create-error'));
    if (password && password.length < 6){
      showError($('pat-create-error'), 'Password must be at least 6 characters, or leave both password fields blank to skip it for now.');
      return;
    }
    if (password !== password2){
      showError($('pat-create-error'), 'Passwords don\u2019t match.');
      return;
    }
    $('pat-create-btn').disabled = true;
    $('pat-create-btn').textContent = 'Creating...';
    try{
      await createPatientAccount(name, phone, email, password);
    }catch(e){
      showError($('pat-create-error'), 'Something went wrong creating your account. Please try again.');
    }finally{
      $('pat-create-btn').disabled = false;
      $('pat-create-btn').textContent = 'Create my account';
    }
  });
  $('pat-google-btn').addEventListener('click', function(){
    $('pat-google-panel').classList.toggle('hidden');
  });
  $('pat-google-continue').addEventListener('click', async function(){
    var name = $('pat-google-name').value.trim();
    var phone = $('pat-google-phone').value.trim();
    var email = $('pat-google-email').value.trim();
    $('pat-google-continue').disabled = true;
    $('pat-google-continue').textContent = 'Creating...';
    clearError($('pat-google-error'));
    try{
      await createPatientAccount(name, phone, email, '');
    }catch(e){
      showError($('pat-google-error'), 'Something went wrong creating your account. Please try again.');
    }finally{
      $('pat-google-continue').disabled = false;
      $('pat-google-continue').textContent = 'Continue';
    }
  });
  $('pat-signin-btn').addEventListener('click', async function(){
    var raw = $('pat-signin-code').value.trim();
    var password = $('pat-signin-password').value;
    var code = null;
    if (raw.indexOf('@') !== -1){
      code = await storeGet(emailIndexKey(raw));
    } else {
      var digits = raw.replace(/[^0-9]/g,'');
      if (digits.length === 8) code = digits;
    }
    if (!code){
      showError($('pat-signin-error'), 'We couldn\u2019t find an account with that code or email.');
      return;
    }
    var data = await loadPatient(code);
    if (!data){
      showError($('pat-signin-error'), 'We couldn\u2019t find an account with that code or email.');
      return;
    }
    if (data.passwordHash){
      var enteredHash = await hashPassword(password);
      if (!password || enteredHash !== data.passwordHash){
        showError($('pat-signin-error'), 'Incorrect password.');
        return;
      }
    }
    clearError($('pat-signin-error'));
    session = { type:'patient', id:code };
    await enterPatientDash(code);
  });
  $('pat-signin-password').addEventListener('keydown', function(e){
    if (e.key === 'Enter') $('pat-signin-btn').click();
  });

  // ================= PATIENT DASHBOARD =================
  var currentPatientData = null;
  var calViewDate = new Date();

  function sampleVisits(){
    return [
      { doctorName:'Dr. Ali Raza', date:'2026-05-14', time:'10:30 AM', symptoms:'Persistent cough and mild fever for four days.', diagnosis:'Acute bronchitis', prescription:'Amoxicillin 500mg, 3x daily for 7 days.', notes:'Follow up if symptoms persist beyond 10 days.' },
      { doctorName:'Dr. Fatima Noor', date:'2026-02-02', time:'3:00 PM', symptoms:'Routine annual check-up, no complaints.', diagnosis:'No concerns found.', prescription:'None', notes:'Recommended an annual blood panel and flu shot.' }
    ];
  }
  function sampleTests(){
    return [
      { name:'Complete Blood Count (CBC)', date:'2026-02-02' },
      { name:'Chest X-Ray', date:'2026-05-15' }
    ];
  }
  function sampleAppointments(){
    var d = new Date();
    function inDays(n){ var t = new Date(d); t.setDate(t.getDate() + n); return t.toISOString().slice(0, 10); }
    return [
      { doctorName:'Dr. Ali Raza', clinicName:'City General Hospital', date: inDays(4), time:'11:00 AM', reason:'Follow-up for bronchitis' },
      { doctorName:'Dr. Fatima Noor', clinicName:'Shifa Clinic', date: inDays(11), time:'4:30 PM', reason:'Annual check-up' }
    ];
  }
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

  async function enterPatientDash(code){
    var data = await loadPatient(code);
    if (!data) data = { code:code };
    var seeded = false;
    if (!data.visits || !data.visits.length){ data.visits = sampleVisits(); seeded = true; }
    if (!data.tests || !data.tests.length){ data.tests = sampleTests(); seeded = true; }
    if (!data.appointments || !data.appointments.length){ data.appointments = sampleAppointments(); seeded = true; }
    if (!data.eyeEntries) data.eyeEntries = [];
    currentPatientData = data;
    if (seeded){ try{ await savePatient(code, data); }catch(e){} }
    renderHealthCard(data);
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
    var verified = d.email && d.phone && d.license;
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
    var id = raw.indexOf('DR-') === 0 ? raw : 'DR-' + raw.replace(/[^0-9]/g,'');
    clearError($('pat-trust-error'));
    if (!/^DR-\d{6}$/.test(id)){
      showError($('pat-trust-error'), 'Enter a valid doctor ID, like DR-482913.');
      return;
    }
    var doc = await loadDoctor(id);
    if (!doc){
      showError($('pat-trust-error'), 'No doctor found with that ID.');
      return;
    }
    $('pat-trust-add-btn').disabled = true;
    try{
      await createTrustGrant(session.id, id);
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
    var data = Object.assign({}, currentPatientData, {
      code: session.id,
      name: $('pat-name').value.trim()
    });
    await savePatient(session.id, data);
    currentPatientData = data;
    renderHealthCard(data);
    var note = $('pat-profile-save-note');
    note.classList.add('show');
    setTimeout(function(){ note.classList.remove('show'); }, 1800);
  });

  $('pat-save-btn').addEventListener('click', async function(){
    var email = $('pat-email').value.trim();
    var data = Object.assign({}, currentPatientData, {
      code: session.id,
      email: email,
      phone: $('pat-phone').value.trim()
    });
    await savePatient(session.id, data);
    await linkPatientEmail(email, session.id);
    currentPatientData = data;
    var note = $('pat-save-note');
    note.classList.add('show');
    setTimeout(function(){ note.classList.remove('show'); }, 1800);
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
      var data = Object.assign({}, currentPatientData, { photoUrl: dataUrl });
      currentPatientData = data;
      try{ await savePatient(session.id, data); }catch(err){}
    };
    reader.readAsDataURL(file);
  });
  $('pat-signout').addEventListener('click', function(){
    stopLiveCodeTimer();
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
    var entry = {
      date: date,
      sphL: $('eye-sph-l').value.trim(),
      cylL: $('eye-cyl-l').value.trim(),
      axisL: $('eye-axis-l').value.trim(),
      sphR: $('eye-sph-r').value.trim(),
      cylR: $('eye-cyl-r').value.trim(),
      axisR: $('eye-axis-r').value.trim()
    };
    $('add-eye-save').disabled = true;
    $('add-eye-save').textContent = 'Saving...';
    try{
      var data = await loadPatient(session.id);
      if (!data){
        showError($('add-eye-error'), 'Your record could not be found anymore.');
        return;
      }
      if (!data.eyeEntries) data.eyeEntries = [];
      data.eyeEntries.unshift(entry);
      await savePatient(session.id, data);
      currentPatientData = data;
      renderEyesList(data.eyeEntries);
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
  async function enterDoctorDash(id){
    var data = await loadDoctor(id);
    if (!data) data = { doctorId:id };
    if (!data.clinics) data.clinics = [];
    if (!data.currentClinic) data.currentClinic = '';
    if (!data.visitLog) data.visitLog = [];
    currentDoctorData = data;
    $('doc-dash-id').textContent = id;
    $('doc-modal-id').textContent = id;
    $('doc-name').value = data.name || '';
    $('doc-email').value = data.email || '';
    $('doc-phone').value = data.phone || '';
    $('doc-license').value = data.license || '';
    $('doc-specialty').value = data.specialty || '';
    $('doc-education').value = data.education || '';
    $('doc-about').value = data.about || '';
    renderDoctorCard(data);
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
      el.addEventListener('click', function(){
        var e = entries[parseInt(el.getAttribute('data-idx'), 10)];
        showLookupResult(e.patient.code, e.patient, e.grant);
      });
    });
  }
  function renderDoctorVerification(data){
    var verified = isDoctorVerified(data);
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
        await saveDoctor(session.id, currentDoctorData);
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
      await saveDoctor(session.id, currentDoctorData);
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
    await saveDoctor(session.id, currentDoctorData);
  });

  $('doc-save-btn').addEventListener('click', async function(){
    var data = Object.assign({}, currentDoctorData, {
      doctorId: session.id,
      email: $('doc-email').value.trim(),
      phone: $('doc-phone').value.trim(),
      license: $('doc-license').value.trim()
    });
    data.verified = isDoctorVerified(data);
    await saveDoctor(session.id, data);
    currentDoctorData = data;
    renderDoctorVerification(data);
    var note = $('doc-save-note');
    note.classList.add('show');
    setTimeout(function(){ note.classList.remove('show'); }, 1800);
  });
  $('doc-profile-save-btn').addEventListener('click', async function(){
    var data = Object.assign({}, currentDoctorData, {
      doctorId: session.id,
      name: $('doc-name').value.trim(),
      specialty: $('doc-specialty').value.trim(),
      education: $('doc-education').value.trim(),
      about: $('doc-about').value.trim()
    });
    await saveDoctor(session.id, data);
    currentDoctorData = data;
    renderDoctorCard(data);
    var note = $('doc-profile-save-note');
    note.classList.add('show');
    setTimeout(function(){ note.classList.remove('show'); }, 1800);
  });
  $('doc-dash-copy').addEventListener('click', function(){
    copyToClipboard(session.id, $('doc-dash-copy-note'));
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
      var data = Object.assign({}, currentDoctorData, { photoUrl: dataUrl });
      currentDoctorData = data;
      try{ await saveDoctor(session.id, data); }catch(err){}
    };
    reader.readAsDataURL(file);
  });
  $('doc-signout').addEventListener('click', function(){
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

  function showLookupResult(code, data, grant){
    currentLookupCode = code;
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
      var result = await redeemAccessCode(code, session.id);
      if (!result.ok){
        $('patient-result').classList.add('hidden');
        $('lookup-not-found').classList.remove('hidden');
        $('lookup-not-found').textContent =
          result.reason === 'expired' ? 'That code has expired — ask your patient to generate a new one.' :
          result.reason === 'redeemed' ? 'That code has already been used — ask your patient for a new one.' :
          'No active code found. Double-check it with your patient.';
        return;
      }
      var data = await loadPatient(result.patientId);
      if (!data){
        $('patient-result').classList.add('hidden');
        $('lookup-not-found').classList.remove('hidden');
        $('lookup-not-found').textContent = 'That patient’s record could not be found.';
        return;
      }
      showLookupResult(result.patientId, data, result.grant);
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
    return session.id || 'Doctor';
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
      var visit = {
        doctorName: currentDoctorDisplayName(),
        clinicName: (currentDoctorData && currentDoctorData.currentClinic) || '',
        date: date,
        time: $('visit-time').value.trim(),
        symptoms: $('visit-symptoms').value.trim(),
        diagnosis: $('visit-diagnosis').value.trim(),
        prescription: $('visit-prescription').value.trim(),
        notes: $('visit-notes').value.trim(),
        writtenViaGrantId: activeGrant.id,
        unverified: !isDoctorVerified(currentDoctorData || {})
      };
      var data = await loadPatient(currentLookupCode);
      if (!data){
        showError($('add-visit-error'), 'This patient record could not be found anymore.');
        return;
      }
      if (!data.visits) data.visits = [];
      data.visits.unshift(visit);
      await savePatient(currentLookupCode, data);
      currentLookupData = data;
      renderDoctorVisitsList(data.visits);
      if (currentDoctorData){
        if (!currentDoctorData.visitLog) currentDoctorData.visitLog = [];
        currentDoctorData.visitLog.push({ patientCode: currentLookupCode, patientName: data.name || '', date: date });
        try{ await saveDoctor(session.id, currentDoctorData); }catch(err){}
      }
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
      var test = {
        name: name,
        date: date,
        doctorName: currentDoctorDisplayName(),
        resultSummary: $('test-result').value.trim(),
        writtenViaGrantId: activeGrant.id,
        unverified: !isDoctorVerified(currentDoctorData || {})
      };
      var data = await loadPatient(currentLookupCode);
      if (!data){
        showError($('add-test-error'), 'This patient record could not be found anymore.');
        return;
      }
      if (!data.tests) data.tests = [];
      data.tests.unshift(test);
      await savePatient(currentLookupCode, data);
      currentLookupData = data;
      renderDoctorTestsList(data.tests);
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

  // Every session starts fresh on landing regardless of what hash a reload carried
  // in — there's no persisted session to restore a deep link into, so replace
  // (never push) to avoid leaving a stray extra entry in front of it.
  history.replaceState({ view: 'view-landing' }, '', '#view-landing');
  suppressHistoryPush = true;
  showView('view-landing');
  suppressHistoryPush = false;
})();

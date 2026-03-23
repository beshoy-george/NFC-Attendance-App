/* NFC Attendance - Multi-service (Offline-First) */
const state={supervisor:null,isMasterAdmin:false,employees:[],services:[],stages:[],currentView:'dashboard',previousView:null,selectedDate:getNearestFriday(),scanDate:getNearestFriday(),attDate:getNearestFriday(),scanning:false,nfcReader:null,nfcAbortController:null,scanCount:0,weeklyChart:null,currentFilter:'all',classFilter:'all',editingEmployee:null,birthdayDays:7,_attendanceRecords:null,offline:!navigator.onLine};
const PENDING_SCAN_KEY='pending_nfc_scans_v1';
const SUPERVISOR_CACHE_KEY='cached_supervisor_v1';
const MASTER_ADMIN_CACHE_KEY='cached_is_master_admin_v1';
const DB_NAME='nfc_attendance_offline';
const DB_VERSION=2;
let _idb=null;
let syncInProgress=false;
let _syncTimer=null;

// API BASE REMOVED

// ===== IndexedDB OFFLINE LAYER =====
function openDB(){
  return new Promise(function(resolve,reject){
    if(_idb){resolve(_idb);return;}
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded=function(e){
      const db=e.target.result;
      if(!db.objectStoreNames.contains('cache'))db.createObjectStore('cache',{keyPath:'key'});
      if(!db.objectStoreNames.contains('writeQueue'))db.createObjectStore('writeQueue',{keyPath:'id',autoIncrement:true});
    };
    req.onsuccess=function(e){_idb=e.target.result;resolve(_idb);};
    req.onerror=function(){resolve(null);};
  });
}
async function offSave(key,data){
  try{const db=await openDB();if(!db)return;
  const tx=db.transaction('cache','readwrite');tx.objectStore('cache').put({key:key,data:data,ts:Date.now()});
  }catch(e){}
}
async function offLoad(key){
  try{const db=await openDB();if(!db)return null;
  return new Promise(function(resolve){
    const tx=db.transaction('cache','readonly');const req=tx.objectStore('cache').get(key);
    req.onsuccess=function(){resolve(req.result?req.result.data:null);};
    req.onerror=function(){resolve(null);};
  });}catch(e){return null;}
}
async function queueWrite(endpoint,method,body){
  try{const db=await openDB();if(!db)return;
  const tx=db.transaction('writeQueue','readwrite');
  tx.objectStore('writeQueue').add({endpoint:endpoint,method:method,body:body,time:new Date().toISOString()});
  updateSyncBadge();
  }catch(e){}
}
async function getPendingWriteCount(){
  try{const db=await openDB();if(!db)return 0;
  return new Promise(function(resolve){
    const tx=db.transaction('writeQueue','readonly');const req=tx.objectStore('writeQueue').count();
    req.onsuccess=function(){resolve(req.result);};req.onerror=function(){resolve(0);};
  });}catch(e){return 0;}
}
async function flushPendingWrites(){
  if(syncInProgress)return;syncInProgress=true;
  try{
    const db=await openDB();if(!db){syncInProgress=false;return;}
    const tx=db.transaction('writeQueue','readonly');
    const items=await new Promise(function(resolve){
      const req=tx.objectStore('writeQueue').getAll();
      req.onsuccess=function(){resolve(req.result||[]);};req.onerror=function(){resolve([]);};
    });
    if(!items.length){syncInProgress=false;updateSyncBadge();return;}
    let synced=0;
    for(const w of items){
      try{
        const res=await fetch(w.endpoint,{method:w.method,headers:{'Content-Type':'application/json'},body:JSON.stringify(w.body)});
        if(res.ok||res.status===409){
          const dtx=db.transaction('writeQueue','readwrite');dtx.objectStore('writeQueue').delete(w.id);
          await new Promise(function(r){dtx.oncomplete=r;dtx.onerror=r;});
          synced++;
        }
      }catch(e){/* keep in queue */}
    }
    if(synced>0)showToast('تمت مزامنة '+synced+' عملية','success');
    updateSyncBadge();
  }catch(e){}
  syncInProgress=false;
}
async function fetchWithCache(url,cacheKey){
  try{
    const res=await fetch(url);
    if(res.ok){const data=await res.json();offSave(cacheKey,data);setOnline(true);return data;}
    const cached=await offLoad(cacheKey);return cached;
  }catch(e){setOnline(false);return await offLoad(cacheKey);}
}
function setOnline(isOnline){
  const wasOffline=state.offline;
  state.offline=!isOnline;
  updateOfflineIndicator();
  if(wasOffline&&isOnline){flushPendingWrites();flushPendingNfcScans(true);}
}
function updateOfflineIndicator(){
  const el=document.getElementById('offlineIndicator');
  if(!el)return;
  if(state.offline){el.classList.add('visible');el.innerHTML='<i class="fas fa-wifi-slash"></i> غير متصل';}
  else{el.classList.remove('visible');el.innerHTML='<i class="fas fa-wifi"></i> متصل';}
}
async function updateSyncBadge(){
  const count=await getPendingWriteCount();
  const scanCount=function(){try{return JSON.parse(localStorage.getItem(PENDING_SCAN_KEY)||'[]').length;}catch(e){return 0;}}();
  const total=count+scanCount;
  const el=document.getElementById('syncBadge');
  if(!el)return;
  if(total>0){el.textContent=total;el.style.display='flex';}else{el.style.display='none';}
}
window.addEventListener('online',function(){setOnline(true);showToast('تم استعادة الاتصال — جاري المزامنة...','success');});
window.addEventListener('offline',function(){setOnline(false);showToast('أنت الآن غير متصل — التطبيق يعمل بدون إنترنت','warning');});
// Listen for sync message from service worker
if('serviceWorker' in navigator){navigator.serviceWorker.addEventListener('message',function(e){if(e.data&&e.data.type==='SYNC_NOW'){flushPendingWrites();flushPendingNfcScans(true);}});}
// Periodic sync check every 30s
_syncTimer=setInterval(function(){if(navigator.onLine){flushPendingWrites();flushPendingNfcScans(true);}updateSyncBadge();},30000);

function getFilterParams(extra){const params=new URLSearchParams(extra||{});if(!state.isMasterAdmin&&state.supervisor){if(state.supervisor.service_id)params.set('service_id',state.supervisor.service_id);if(state.supervisor.stage_id)params.set('stage_id',state.supervisor.stage_id);}return params;}
function buildUrl(base,extra){const p=getFilterParams(extra);const qs=p.toString();return qs?base+'?'+qs:base;}

function saveSupervisorCache(sup,isMaster){try{localStorage.setItem(SUPERVISOR_CACHE_KEY,JSON.stringify(sup));localStorage.setItem(MASTER_ADMIN_CACHE_KEY,JSON.stringify(!!isMaster));}catch(e){}}
function loadSupervisorCache(){try{const r=localStorage.getItem(SUPERVISOR_CACHE_KEY);return r?JSON.parse(r):null;}catch(e){return null;}}
function loadMasterAdminCache(){try{return JSON.parse(localStorage.getItem(MASTER_ADMIN_CACHE_KEY)||'false');}catch(e){return false;}}
function clearSupervisorCache(){localStorage.removeItem(SUPERVISOR_CACHE_KEY);localStorage.removeItem(MASTER_ADMIN_CACHE_KEY);}

function getNearestFriday(d){if(!d)d=new Date();const day=d.getDay();const diff=(day-5+7)%7;const f=new Date(d);f.setDate(d.getDate()-diff);f.setHours(0,0,0,0);return f;}
function getPrevFriday(d){const p=new Date(d);p.setDate(p.getDate()-7);return p;}
function getNextFriday(d){const n=new Date(d);n.setDate(n.getDate()+7);return n;}
function formatDateISO(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function formatDateAr(d){const m=['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];return d.getDate()+' '+m[d.getMonth()]+' '+d.getFullYear();}
function formatDateShort(s){const d=new Date(s);return d.getDate()+'/'+(d.getMonth()+1);}
function navigateDate(dir){state.selectedDate=dir===-1?getPrevFriday(state.selectedDate):getNextFriday(state.selectedDate);document.getElementById('dashDateLabel').textContent=formatDateAr(state.selectedDate);loadDashboard();}
function navigateScanDate(dir){state.scanDate=dir===-1?getPrevFriday(state.scanDate):getNextFriday(state.scanDate);document.getElementById('scanDateLabel').textContent=formatDateAr(state.scanDate);}
function navigateAttDate(dir){state.attDate=dir===-1?getPrevFriday(state.attDate):getNextFriday(state.attDate);document.getElementById('attDateLabel').textContent=formatDateAr(state.attDate);loadAttendance();}
function goToToday(){state.selectedDate=getNearestFriday();document.getElementById('dashDateLabel').textContent=formatDateAr(state.selectedDate);loadDashboard();}
function goToTodayScan(){state.scanDate=getNearestFriday();document.getElementById('scanDateLabel').textContent=formatDateAr(state.scanDate);}
function goToTodayAtt(){state.attDate=getNearestFriday();document.getElementById('attDateLabel').textContent=formatDateAr(state.attDate);loadAttendance();}

function showLoading(){document.getElementById('loadingOverlay').classList.add('active');}
function hideLoading(){document.getElementById('loadingOverlay').classList.remove('active');}
function showToast(message,type){type=type||'info';const container=document.getElementById('toastContainer');const toast=document.createElement('div');toast.className='toast toast-'+type;const icons={success:'check-circle',error:'exclamation-circle',info:'info-circle',warning:'exclamation-triangle'};toast.innerHTML='<i class="fas fa-'+(icons[type]||'info-circle')+'"></i> '+message;container.appendChild(toast);setTimeout(function(){toast.style.opacity='0';setTimeout(function(){toast.remove();},300);},3000);}
function getAvatarColor(name){const colors=['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#e84393','#00b894','#6c5ce7'];let hash=0;for(let i=0;i<name.length;i++)hash=name.charCodeAt(i)+((hash<<5)-hash);return colors[Math.abs(hash)%colors.length];}

function toggleDrawer(){document.getElementById('sideDrawer').classList.toggle('open');document.getElementById('drawerOverlay').classList.toggle('open');}
function closeDrawer(){document.getElementById('sideDrawer').classList.remove('open');document.getElementById('drawerOverlay').classList.remove('open');}

function showView(name){
  closeDrawer();
  if(name!=='profile')state.previousView=state.currentView;
  state.currentView=name;
  document.querySelectorAll('.view').forEach(function(v){v.classList.remove('active');});
  var view=document.getElementById('view-'+name);
  if(view)view.classList.add('active');
  document.querySelectorAll('.drawer-item').forEach(function(t){t.classList.toggle('active',t.dataset.view===name);});
  if(name==='dashboard')loadDashboard();
  else if(name==='employees')loadEmployees();
  else if(name==='attendance')loadAttendance();
  else if(name==='analytics')loadAnalytics();
  else if(name==='scan')initScanView();
  else if(name==='settings')loadSettings();
  else if(name==='supervisors')loadSupervisors();
  else if(name==='birthdays')loadBirthdays(state.birthdayDays);
  else if(name==='visits')loadVisits();
  else if(name==='services')loadServicesManagement();
}
function goBack(){showView(state.previousView||'dashboard');}

async function loadServicesAndStages(){try{const[sR,tR]=await Promise.all([fetch('/api/services'),fetch('/api/stages')]);if(sR.ok){state.services=await sR.json();offSave('services',state.services);}if(tR.ok){state.stages=await tR.json();offSave('stages',state.stages);}}catch(e){state.services=(await offLoad('services'))||[];state.stages=(await offLoad('stages'))||[];}}

function normalizePhone(ph){return(ph||'').replace(/\D/g,'');}
function isValidPhone(ph){return/^01\d{9}$/.test(ph);}

async function handleLogin(){
  const phone=normalizePhone(document.getElementById('loginPhone').value.trim());
  const password=document.getElementById('loginPassword').value;
  if(!phone||!password){showToast('يرجى ملء جميع الحقول','error');return;}
  if(!isValidPhone(phone)){showToast('رقم الهاتف غير صحيح','error');return;}
  showLoading();
  try{
    const res=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone,password})});
    const data=await res.json();
    if(res.ok){state.supervisor=data.supervisor;state.isMasterAdmin=!!data.is_master_admin;saveSupervisorCache(data.supervisor,state.isMasterAdmin);showApp();flushPendingNfcScans(true);flushPendingWrites();showToast('أهلاً '+data.supervisor.name,'success');}
    else{showToast(data.error||'بيانات غير صحيحة','error');}
  }catch(e){showToast('خطأ في الاتصال','error');}
  hideLoading();
}

function onRegServiceChange(){
  const sId=parseInt(document.getElementById('regService').value);
  const stSel=document.getElementById('regStage');
  stSel.innerHTML='<option value="">-- اختر المرحلة --</option>';
  stSel.disabled=!sId;
  if(sId){state.stages.filter(function(s){return s.service_id===sId;}).forEach(function(s){stSel.innerHTML+='<option value="'+s.id+'">'+s.name+'</option>';});}
}

async function handleRegister(){
  const name=document.getElementById('regName').value.trim();
  const phone=normalizePhone(document.getElementById('regPhone').value.trim());
  const password=document.getElementById('regPassword').value;
  const serviceId=parseInt(document.getElementById('regService').value)||0;
  const stageId=parseInt(document.getElementById('regStage').value)||0;
  if(!name||!phone||!password){showToast('يرجى ملء جميع الحقول','error');return;}
  if(!isValidPhone(phone)){showToast('رقم الهاتف غير صحيح','error');return;}
  if(password.length<4){showToast('كلمة المرور 4 أحرف على الأقل','error');return;}
  if(!serviceId||!stageId){showToast('يرجى اختيار الخدمة والمرحلة','error');return;}
  showLoading();
  try{
    const res=await fetch('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,phone,password,service_id:serviceId,stage_id:stageId})});
    const data=await res.json();
    if(res.ok){state.supervisor=data.supervisor;state.isMasterAdmin=false;saveSupervisorCache(data.supervisor,false);showApp();showToast('تم التسجيل بنجاح','success');}
    else{showToast(data.error||'خطأ','error');}
  }catch(e){showToast('خطأ في الاتصال','error');}
  hideLoading();
}

async function handleLogout(){
  await fetch('/api/auth/logout',{method:'POST'}).catch(function(){});
  state.supervisor=null;state.isMasterAdmin=false;clearSupervisorCache();
  document.getElementById('authView').classList.remove('hidden');
  document.getElementById('appView').classList.add('hidden');
  showLoginForm();showToast('تم تسجيل الخروج','info');
}
function toggleAuth(){
  document.getElementById('forgotForm').classList.add('hidden');
  document.getElementById('loginForm').classList.toggle('hidden');
  document.getElementById('registerForm').classList.toggle('hidden');
  if(!document.getElementById('registerForm').classList.contains('hidden'))populateRegServiceDropdown();
}
async function populateRegServiceDropdown(){
  await loadServicesAndStages();
  const sel=document.getElementById('regService');
  sel.innerHTML='<option value="">-- اختر الخدمة --</option>';
  state.services.forEach(function(s){sel.innerHTML+='<option value="'+s.id+'">'+s.name+'</option>';});
}
function showForgotPassword(){
  document.getElementById('loginForm').classList.add('hidden');
  document.getElementById('registerForm').classList.add('hidden');
  document.getElementById('forgotForm').classList.remove('hidden');
}
function showLoginForm(){
  document.getElementById('forgotForm').classList.add('hidden');
  document.getElementById('registerForm').classList.add('hidden');
  document.getElementById('loginForm').classList.remove('hidden');
}
async function sendResetOtp(){
  const phone=normalizePhone(document.getElementById('forgotPhone').value.trim());
  if(!phone||!isValidPhone(phone)){showToast('رقم هاتف غير صحيح','error');return;}
  showLoading();
  try{const res=await fetch('/api/auth/forgot-password/request-otp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone})});const data=await res.json();if(res.ok){showToast(data.simulated&&data.otp_preview?'OTP: '+data.otp_preview:'تم إرسال OTP','success');}else{showToast(data.error||'خطأ','error');}}catch(e){showToast('خطأ في الاتصال','error');}
  hideLoading();
}
async function handleForgotPassword(){
  const phone=normalizePhone(document.getElementById('forgotPhone').value.trim());
  const otp=document.getElementById('forgotOtp').value.trim();
  const np=document.getElementById('forgotPassword').value;
  const cp=document.getElementById('forgotPasswordConfirm').value;
  if(!phone||!otp||!np||!cp){showToast('يرجى ملء جميع الحقول','error');return;}
  if(np!==cp){showToast('كلمتا المرور غير متطابقتين','error');return;}
  showLoading();
  try{const res=await fetch('/api/auth/forgot-password/verify-otp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone,otp_code:otp,new_password:np})});const data=await res.json();if(res.ok){showToast('تم تحديث كلمة المرور','success');showLoginForm();}else{showToast(data.error||'خطأ','error');}}catch(e){showToast('خطأ','error');}
  hideLoading();
}

// ===== SHOW APP =====
function showApp(){
  document.getElementById('authView').classList.add('hidden');
  document.getElementById('appView').classList.remove('hidden');
  const sup=state.supervisor;
  if(sup){
    const initial=sup.name?sup.name[0]:'?';
    const color=getAvatarColor(sup.name||'');
    document.getElementById('headerAvatar').textContent=initial;
    document.getElementById('headerAvatar').style.background=color;
    document.getElementById('drawerAvatar').textContent=initial;
    document.getElementById('drawerAvatar').style.background=color;
    document.getElementById('drawerUserName').textContent=sup.name;
  }
  if(state.isMasterAdmin){
    document.getElementById('drawerAdminBadge').style.display='';
  }else{
    document.getElementById('drawerAdminBadge').style.display='none';
  }
  document.getElementById('dashDateLabel').textContent=formatDateAr(state.selectedDate);
  document.getElementById('scanDateLabel').textContent=formatDateAr(state.scanDate);
  document.getElementById('attDateLabel').textContent=formatDateAr(state.attDate);
  loadServicesAndStages();
  updateOfflineIndicator();
  updateSyncBadge();
  showView('dashboard');
}

// ===== INIT ON LOAD =====
async function appInit(){
  showLoading();
  // Try master admin (pywebview)
  try{
    if(window.pywebview&&window.pywebview.api){
      const sec=await window.pywebview.api.get_admin_secret();
      if(sec){
        const res=await fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret:sec})});
        if(res.ok){
          state.isMasterAdmin=true;
          state.supervisor={id:-1,name:'المدير العام',phone:'',service_id:0,stage_id:0};
          saveSupervisorCache(state.supervisor,true);
          hideLoading();showApp();return;
        }
      }
    }
  }catch(e){}
  // Try existing session
  try{
    const res=await fetch('/api/auth/me');
    if(res.ok){
      const data=await res.json();
      if(data.authenticated){
        state.supervisor=data.supervisor;
        state.isMasterAdmin=data.is_master_admin||false;
        saveSupervisorCache(data.supervisor,state.isMasterAdmin);
        hideLoading();showApp();return;
      }
    }
  }catch(e){}
  // Try cached offline
  const cached=loadSupervisorCache();
  if(cached){
    state.supervisor=cached;
    state.isMasterAdmin=loadMasterAdminCache();
    hideLoading();showApp();return;
  }
  hideLoading();
  await loadServicesAndStages();
  updateOfflineIndicator();
  updateSyncBadge();
}

document.addEventListener('DOMContentLoaded',appInit);

// ===== DASHBOARD =====
async function loadDashboard(){
  const dateStr=formatDateISO(state.selectedDate);
  const url=buildUrl('/api/dashboard',{date:dateStr});
  const data=await fetchWithCache(url,'dashboard_'+dateStr);
  if(!data)return;
  try{
    document.getElementById('statTotal').textContent=data.total_employees;
    document.getElementById('statPresent').textContent=data.today_present;
    document.getElementById('statAbsent').textContent=data.today_absent;
    document.getElementById('statPending').textContent=data.today_not_scanned;
    const scansEl=document.getElementById('recentScans');
    if(data.recent_scans&&data.recent_scans.length>0){
      scansEl.innerHTML=data.recent_scans.map(function(s){
        const statusClass=s.status==='present'?'badge-present':s.status==='absent'?'badge-absent':'badge-pending';
        const statusText=s.status==='present'?'حاضر':s.status==='absent'?'غائب':'—';
        const color=getAvatarColor(s.employee_name||'');
        const initial=(s.employee_name||'?')[0];
        const time=s.scan_time?s.scan_time.split(' ')[1]||s.scan_time:'';
        return '<div class="card-item" onclick="showProfile('+s.employee_id+')">'+
          '<div class="card-avatar" style="background:'+color+';color:#fff">'+initial+'</div>'+
          '<div class="card-body"><h3>'+s.employee_name+'</h3><p>'+time+'</p></div>'+
          '<span class="card-badge '+statusClass+'">'+statusText+'</span></div>';
      }).join('');
    }else{
      scansEl.innerHTML='<div class="empty-state"><i class="fas fa-inbox"></i><p>لا توجد تسجيلات بعد</p></div>';
    }
  }catch(e){}
}

// ===== EMPLOYEES =====
async function loadEmployees(){
  const url=buildUrl('/api/employees');
  const data=await fetchWithCache(url,'employees');
  if(data){state.employees=data;}
  state.classFilter='all';
  document.querySelectorAll('#view-employees .filter-btn').forEach(function(b){b.classList.toggle('active',b.dataset.class==='all');});
  applyEmployeeFilters();
}

function renderEmployees(list){
  const el=document.getElementById('employeeList');
  if(!list||list.length===0){
    el.innerHTML='<div class="empty-state"><i class="fas fa-users"></i><p>\u0644\u0627 \u064a\u0648\u062c\u062f \u0645\u062e\u062f\u0648\u0645\u064a\u0646 \u0645\u0633\u062c\u0644\u064a\u0646</p></div>';
    return;
  }
  el.innerHTML=list.map(function(emp){
    const color=getAvatarColor(emp.name||'');
    const initial=(emp.name||'?')[0];
    const dept=emp.department||'';
    return '<div class="card-item" onclick="showProfile('+emp.id+')">'+'<div class="card-avatar" style="background:'+color+';color:#fff">'+initial+'</div>'+'<div class="card-body"><h3>'+emp.name+'</h3><p>'+(dept||emp.nfc_uid||'')+'</p></div>'+'<i class="fas fa-chevron-left" style="color:var(--text-muted);font-size:.8rem"></i></div>';
  }).join('');
}

function applyEmployeeFilters(){
  let list=state.employees;
  if(state.classFilter&&state.classFilter!=='all'){
    list=list.filter(function(e){return(e.department||'')===state.classFilter;});
  }
  const q=(document.getElementById('employeeSearch')?document.getElementById('employeeSearch').value:'').trim().toLowerCase();
  if(q){list=list.filter(function(e){return(e.name||'').toLowerCase().includes(q)||(e.nfc_uid||'').toLowerCase().includes(q)||(e.department||'').toLowerCase().includes(q);});}
  renderEmployees(list);
}

function filterEmployeesByClass(cls){
  state.classFilter=cls;
  document.querySelectorAll('#view-employees .filter-btn').forEach(function(b){b.classList.toggle('active',b.dataset.class===cls);});
  applyEmployeeFilters();
}

function searchEmployees(query){applyEmployeeFilters();}

function showAddEmployeeModal(){
  state.editingEmployee=null;
  document.getElementById('modalTitle').textContent='تسجيل مخدوم';
  document.getElementById('empNfcUid').value='';
  document.getElementById('empNfcUidDisplay').value='';
  document.getElementById('empName').value='';
  document.getElementById('empClass').value='';
  document.getElementById('empBirthdate').value='';
  document.getElementById('empPhone').value='';
  document.getElementById('empParentPhone').value='';
  document.getElementById('empConfessionFather').value='';
  document.getElementById('empAddress').value='';
  document.getElementById('empNfcUidDisplay').readOnly=false;
  document.getElementById('modalSaveBtn').onclick=saveNewEmployee;
  document.getElementById('employeeModal').classList.remove('hidden');
}

function closeEmployeeModal(){
  document.getElementById('employeeModal').classList.add('hidden');
}

async function saveNewEmployee(){
  const nfc=document.getElementById('empNfcUidDisplay').value.trim().toUpperCase();
  const name=document.getElementById('empName').value.trim();
  if(!nfc||!name){showToast('الاسم ومعرف NFC مطلوبان','error');return;}
  const body={
    nfc_uid:nfc,name:name,
    class_name:document.getElementById('empClass').value.trim(),
    birthdate:document.getElementById('empBirthdate').value,
    phone:document.getElementById('empPhone').value.trim(),
    parent_phone:document.getElementById('empParentPhone').value.trim(),
    confession_father:document.getElementById('empConfessionFather').value.trim(),
    address:document.getElementById('empAddress').value.trim(),
    service_id:state.supervisor?state.supervisor.service_id:0,
    stage_id:state.supervisor?state.supervisor.stage_id:0
  };
  showLoading();
  try{
    const res=await fetch('/api/employees',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data=await res.json();
    if(res.ok){
      showToast('تم تسجيل المخدوم','success');
      closeEmployeeModal();
      loadEmployees();
    }else{showToast(data.error||'خطأ','error');}
  }catch(e){
    queueWrite('/api/employees','POST',body);
    showToast('تم حفظ البيانات للمزامنة عند الاتصال','warning');
    closeEmployeeModal();
  }
  hideLoading();
}

// ===== PROFILE =====
async function showProfile(empId){
  state.previousView=state.currentView;
  state.currentView='profile';
  document.querySelectorAll('.view').forEach(function(v){v.classList.remove('active');});
  document.getElementById('view-profile').classList.add('active');
  const el=document.getElementById('profileContent');
  el.innerHTML='<div class="empty-state"><div class="spinner"></div><p>جاري التحميل...</p></div>';
  try{
    const data=await fetchWithCache(buildUrl('/api/employees/'+empId),'profile_'+empId);
    if(!data){el.innerHTML='<div class="empty-state"><p>لا توجد بيانات</p></div>';return;}
    const emp=data.employee;
    const stats=data.stats;
    const color=getAvatarColor(emp.name||'');
    const initial=(emp.name||'?')[0];
    state.editingEmployee=emp;

    let html='<div class="profile-header">';
    html+='<div class="profile-avatar" style="background:'+color+';color:#fff">'+initial+'</div>';
    html+='<h2>'+emp.name+'</h2>';
    html+='<div class="profile-uid">'+emp.nfc_uid+'</div>';
    html+='<div class="profile-stats">';
    html+='<div class="profile-stat"><span class="profile-stat-value text-green">'+stats.present+'</span><span class="profile-stat-label">حاضر</span></div>';
    html+='<div class="profile-stat"><span class="profile-stat-value text-red">'+stats.absent+'</span><span class="profile-stat-label">غائب</span></div>';
    html+='<div class="profile-stat"><span class="profile-stat-value text-blue">'+stats.rate+'%</span><span class="profile-stat-label">نسبة الحضور</span></div>';
    html+='</div></div>';

    // Info
    html+='<div class="profile-section"><h3><i class="fas fa-info-circle"></i> المعلومات الشخصية</h3>';
    const fields=[
      {label:'الفصل',value:emp.department},{label:'تاريخ الميلاد',value:emp.birthdate},
      {label:'الهاتف',value:emp.phone},{label:'تليفون ولي الأمر',value:emp.parent_phone},
      {label:'أب الاعتراف',value:emp.confession_father},{label:'العنوان',value:emp.address}
    ];
    fields.forEach(function(f){
      if(f.value)html+='<div class="profile-row"><span class="profile-row-label">'+f.label+'</span><span class="profile-row-value">'+f.value+'</span></div>';
    });
    html+='</div>';

    // Birthday & visit info
    if(data.next_birthday||data.last_visit){
      html+='<div class="profile-section"><h3><i class="fas fa-star"></i> معلومات اضافية</h3>';
      if(data.next_birthday)html+='<div class="profile-row"><span class="profile-row-label">عيد الميلاد القادم</span><span class="profile-row-value">'+data.next_birthday+'</span></div>';
      if(data.last_visit)html+='<div class="profile-row"><span class="profile-row-label">آخر افتقاد</span><span class="profile-row-value">'+data.last_visit+'</span></div>';
      html+='</div>';
    }

    // Weekly
    if(data.weekly&&data.weekly.length>0){
      html+='<div class="profile-section"><h3><i class="fas fa-calendar-alt"></i> آخر 12 أسبوع</h3>';
      html+='<div class="weekly-grid">';
      data.weekly.forEach(function(w){
        const cls=w.status==='present'?'week-present':'week-absent';
        const icon=w.status==='present'?'✓':'✗';
        html+='<div class="week-cell '+cls+'"><span class="week-date">'+formatDateShort(w.date)+'</span><span class="week-icon">'+icon+'</span></div>';
      });
      html+='</div></div>';
    }

    // Recent attendance
    if(data.attendance&&data.attendance.length>0){
      html+='<div class="profile-section"><h3><i class="fas fa-clipboard-list"></i> سجل الحضور</h3>';
      data.attendance.slice(0,20).forEach(function(a){
        const badge=a.status==='present'?'badge-present':'badge-absent';
        const st=a.status==='present'?'حاضر':'غائب';
        html+='<div class="attendance-record"><div class="ar-date"><h4>'+a.scan_time+'</h4>'+(a.supervisor_name?'<p>'+a.supervisor_name+'</p>':'')+'</div><span class="card-badge '+badge+'">'+st+'</span></div>';
      });
      html+='</div>';
    }

    // Delete button
    html+='<button class="btn btn-danger btn-full" style="margin-top:24px" onclick="deleteEmployee('+emp.id+')"><i class="fas fa-trash"></i> حذف المخدوم</button>';
    el.innerHTML=html;
  }catch(e){el.innerHTML='<div class="empty-state"><p>خطأ في الاتصال</p></div>';}
}

function toggleEditProfile(){
  if(!state.editingEmployee)return;
  const emp=state.editingEmployee;
  document.getElementById('modalTitle').textContent='تعديل بيانات '+emp.name;
  document.getElementById('empNfcUid').value=emp.nfc_uid||'';
  document.getElementById('empNfcUidDisplay').value=emp.nfc_uid||'';
  document.getElementById('empNfcUidDisplay').readOnly=true;
  document.getElementById('empName').value=emp.name||'';
  document.getElementById('empClass').value=emp.department||'';
  document.getElementById('empBirthdate').value=(emp.birthdate||'').substring(0,10);
  document.getElementById('empPhone').value=emp.phone||'';
  document.getElementById('empParentPhone').value=emp.parent_phone||'';
  document.getElementById('empConfessionFather').value=emp.confession_father||'';
  document.getElementById('empAddress').value=emp.address||'';
  document.getElementById('modalSaveBtn').onclick=function(){updateEmployee(emp.id);};
  document.getElementById('employeeModal').classList.remove('hidden');
}

async function updateEmployee(empId){
  const body={
    name:document.getElementById('empName').value.trim(),
    class_name:document.getElementById('empClass').value.trim(),
    birthdate:document.getElementById('empBirthdate').value,
    phone:document.getElementById('empPhone').value.trim(),
    parent_phone:document.getElementById('empParentPhone').value.trim(),
    confession_father:document.getElementById('empConfessionFather').value.trim(),
    address:document.getElementById('empAddress').value.trim()
  };
  showLoading();
  try{
    const res=await fetch('/api/employees/'+empId,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data=await res.json();
    if(res.ok){showToast('تم التحديث','success');closeEmployeeModal();showProfile(empId);}
    else{showToast(data.error||'خطأ','error');}
  }catch(e){
    queueWrite('/api/employees/'+empId,'PUT',body);
    showToast('تم حفظ التعديلات للمزامنة عند الاتصال','warning');
    closeEmployeeModal();
  }
  hideLoading();
}

async function deleteEmployee(empId){
  if(!confirm('هل أنت متأكد من حذف هذا المخدوم وجميع سجلاته؟'))return;
  showLoading();
  try{
    const res=await fetch('/api/employees/'+empId,{method:'DELETE'});
    if(res.ok){showToast('تم الحذف','success');showView('employees');}
    else{showToast('خطأ','error');}
  }catch(e){
    queueWrite('/api/employees/'+empId,'DELETE',{});
    showToast('سيتم الحذف عند الاتصال','warning');
    showView('employees');
  }
  hideLoading();
}

// ===== ATTENDANCE =====
async function loadAttendance(){
  const dateStr=formatDateISO(state.attDate);
  const cacheKey='attendance_'+dateStr;
  const data=await fetchWithCache(buildUrl('/api/attendance/date',{date:dateStr}),cacheKey);
  if(!data)return;
  state._attendanceRecords=data;
  filterAttendance(state.currentFilter);
}

function filterAttendance(filter){
  state.currentFilter=filter;
  document.querySelectorAll('.filter-btn').forEach(function(b){b.classList.toggle('active',b.dataset.filter===filter);});
  if(!state._attendanceRecords)return;
  let records=state._attendanceRecords;
  if(filter!=='all'){records=records.filter(function(r){return r.status===filter;});}
  const el=document.getElementById('attendanceList');
  if(records.length===0){
    el.innerHTML='<div class="empty-state"><i class="fas fa-clipboard"></i><p>لا يوجد سجلات</p></div>';
    return;
  }
  el.innerHTML=records.map(function(r){
    const emp=r.employee;
    const color=getAvatarColor(emp.name||'');
    const initial=(emp.name||'?')[0];
    const statusClass=r.status==='present'?'badge-present':r.status==='absent'?'badge-absent':'badge-pending';
    const statusText=r.status==='present'?'حاضر':r.status==='absent'?'غائب':'لم يُسجل';
    const time=r.scan_time?r.scan_time.split(' ')[1]||'':''
    
    let waBtn = '';
    if (r.status==='absent' && emp.parent_phone) {
       let phone = emp.parent_phone;
       if(phone.startsWith('0')) phone = '2' + phone; 
       const msg = encodeURIComponent('سلام ونعمة، افتقدنا ' + emp.name + ' في مدارس الأحد، نتمنى أن يكون بخير.');
       waBtn = '<a href="https://wa.me/' + phone + '?text=' + msg + '" target="_blank" class="btn btn-icon" style="color:#25D366;margin-right:8px;font-size:1.3rem;margin-bottom:auto;margin-top:auto;" onclick="event.stopPropagation()"><i class="fab fa-whatsapp"></i></a>';
    }

    return '<div class="card-item" onclick="showProfile('+emp.id+')">'+
      '<div class="card-avatar" style="background:'+color+';color:#fff">'+initial+'</div>'+
      '<div class="card-body"><h3>'+emp.name+'</h3><p>'+time+'</p></div>'+ waBtn +
      '<span class="card-badge '+statusClass+'">'+statusText+'</span></div>';
  }).join('');
}

// ===== ANALYTICS =====
async function loadAnalytics(){
  const el=document.getElementById('analyticsContent');
  el.innerHTML='<div class="empty-state"><div class="spinner"></div><p>جاري التحميل...</p></div>';
  const data=await fetchWithCache(buildUrl('/api/analytics'),'analytics');
  if(!data){el.innerHTML='<div class="empty-state"><p>لا توجد بيانات</p></div>';return;}
  try{
    let html='';
    // Overall stats
    html+='<div class="stats-grid" style="margin-bottom:20px">';
    html+='<div class="stat-card stat-blue"><i class="fas fa-users"></i><div class="stat-info"><span class="stat-value">'+data.total_employees+'</span><span class="stat-label">الإجمالي</span></div></div>';
    html+='<div class="stat-card stat-green"><i class="fas fa-percentage"></i><div class="stat-info"><span class="stat-value">'+data.overall_rate+'%</span><span class="stat-label">نسبة الحضور</span></div></div>';
    html+='</div>';
    // Weekly trend chart
    html+='<div class="analytics-section"><h3><i class="fas fa-chart-line"></i> الحضور الاسبوعي</h3><div class="chart-container"><canvas id="weeklyTrendChart"></canvas></div></div>';
    // Class stats
    if(data.class_stats&&data.class_stats.length>0){
      html+='<div class="analytics-section"><h3><i class="fas fa-th-large"></i> حسب الفصل</h3>';
      data.class_stats.forEach(function(c){
        html+='<div class="class-stat-card"><div class="class-info"><h4>'+c.name+'</h4><p>'+c.count+' مخدوم</p></div><div class="class-rate"><span class="rate-value">'+c.rate+'%</span><div class="rate-bar"><div class="rate-fill" style="width:'+c.rate+'%"></div></div></div></div>';
      });
      html+='</div>';
    }
    // Top attendees
    if(data.attendee_stats&&data.attendee_stats.length>0){
      html+='<div class="analytics-section"><h3><i class="fas fa-trophy"></i> ترتيب الحضور</h3>';
      data.attendee_stats.slice(0,10).forEach(function(a){
        const color=getAvatarColor(a.name||'');
        html+='<div class="card-item" onclick="showProfile('+a.id+')"><div class="card-avatar" style="background:'+color+';color:#fff">'+(a.name||'?')[0]+'</div><div class="card-body"><h3>'+a.name+'</h3><p>'+a.present+'/'+a.total+'</p></div><span class="card-badge" style="background:var(--primary-dim);color:var(--primary)">'+a.rate+'%</span></div>';
      });
      html+='</div>';
    }
    el.innerHTML=html;
    // Render chart
    if(data.weekly_trend&&data.weekly_trend.length>0){
      const ctx=document.getElementById('weeklyTrendChart');
      if(ctx){
        if(state.weeklyChart)state.weeklyChart.destroy();
        const labels=data.weekly_trend.map(function(w){return formatDateShort(w.date);}).reverse();
        const presentData=data.weekly_trend.map(function(w){return w.present;}).reverse();
        const absentData=data.weekly_trend.map(function(w){return w.absent;}).reverse();
        state.weeklyChart=new Chart(ctx,{
          type:'bar',
          data:{labels:labels,datasets:[
            {label:'حاضر',data:presentData,backgroundColor:'rgba(16,185,129,.7)',borderRadius:4},
            {label:'غائب',data:absentData,backgroundColor:'rgba(239,68,68,.7)',borderRadius:4}
          ]},
          options:{
            responsive:true,maintainAspectRatio:false,
            plugins:{legend:{labels:{color:'#94a3b8',font:{family:'Cairo'}}}},
            scales:{x:{ticks:{color:'#64748b',font:{family:'Cairo'}},grid:{color:'rgba(45,74,94,.3)'}},
                    y:{ticks:{color:'#64748b',font:{family:'Cairo'}},grid:{color:'rgba(45,74,94,.3)'}}}
          }
        });
      }
    }
  }catch(e){el.innerHTML='<div class="empty-state"><p>خطأ في عرض البيانات</p></div>';}
}

// ===== BIRTHDAYS =====
async function loadBirthdays(days){
  if(days)state.birthdayDays=days;
  // Update active button
  document.querySelectorAll('#view-birthdays .filter-btn').forEach(function(b){
    b.classList.toggle('active',parseInt(b.dataset.days)===state.birthdayDays);
  });
  const el=document.getElementById('birthdaysList');
  el.innerHTML='<div class="empty-state"><div class="spinner"></div><p>جاري التحميل...</p></div>';
  const data=await fetchWithCache(buildUrl('/api/birthdays',{days:state.birthdayDays}),'birthdays_'+state.birthdayDays);
  if(!data||data.length===0){
    el.innerHTML='<div class="empty-state"><i class="fas fa-birthday-cake"></i><p>لا توجد أعياد ميلاد خلال '+state.birthdayDays+' يوم</p></div>';
    return;
  }
    el.innerHTML=data.map(function(b){
      const color=getAvatarColor(b.name||'');
      const initial=(b.name||'?')[0];
      const isToday=b.days_until===0;
      const isSoon=b.days_until<=7;
      const badgeBg=isToday?'var(--success-dim)':isSoon?'var(--warning-dim)':'var(--bg-card-hover)';
      const badgeColor=isToday?'var(--success)':isSoon?'var(--warning)':'var(--text-secondary)';
      const badgeText=isToday?'اليوم!':b.days_until===1?'غداً':'بعد '+b.days_until+' يوم';
      const todayClass=isToday?' today':'';
      return '<div class="birthday-card'+todayClass+'" onclick="showProfile('+b.id+')">'+
        '<div class="card-avatar" style="background:'+color+';color:#fff">'+initial+'</div>'+
        '<div class="birthday-info"><h3>'+b.name+'</h3><p>'+b.birthdate+' ('+b.age+' سنة)</p></div>'+
        '<span class="birthday-badge" style="background:'+badgeBg+';color:'+badgeColor+'">'+badgeText+'</span></div>';
    }).join('');
}

// ===== VISITS =====
async function loadVisits(){
  const el=document.getElementById('visitsList');
  el.innerHTML='<div class="empty-state"><div class="spinner"></div><p>جاري التحميل...</p></div>';
  const data=await fetchWithCache(buildUrl('/api/visits'),'visits');
  if(!data||data.length===0){
    el.innerHTML='<div class="empty-state"><i class="fas fa-hand-holding-heart"></i><p>لا توجد افتقادات</p></div>';
    return;
  }
    el.innerHTML=data.map(function(v){
      const color=getAvatarColor(v.employee_name||'');
      const initial=(v.employee_name||'?')[0];
      const notesHtml=v.notes?'<div class="visit-notes">'+v.notes+'</div>':'';
      const supText=v.supervisor_name?' • '+v.supervisor_name:'';
      return '<div class="visit-card">'+
        '<div class="card-avatar" style="background:'+color+';color:#fff">'+initial+'</div>'+
        '<div class="visit-info"><h3>'+v.employee_name+'</h3><p>'+v.visit_date+supText+'</p>'+notesHtml+'</div>'+
        '<button class="visit-delete" onclick="deleteVisit('+v.id+')"><i class="fas fa-trash"></i></button></div>';
    }).join('');
}

async function showAddVisitModal(){
  // Load employees for the dropdown (online or cached)
  const emps=await fetchWithCache(buildUrl('/api/employees'),'employees');
  if(emps){
    const sel=document.getElementById('visitEmployee');
    sel.innerHTML='<option value="">-- اختر المخدوم --</option>';
    emps.forEach(function(e){sel.innerHTML+='<option value="'+e.id+'">'+e.name+'</option>';});
  }
  document.getElementById('visitDate').value=formatDateISO(new Date());
  document.getElementById('visitNotes').value='';
  document.getElementById('visitModal').classList.remove('hidden');
}

function closeVisitModal(){
  document.getElementById('visitModal').classList.add('hidden');
}

async function saveVisit(){
  const empId=document.getElementById('visitEmployee').value;
  const visitDate=document.getElementById('visitDate').value;
  const notes=document.getElementById('visitNotes').value.trim();
  if(!empId){showToast('يرجى اختيار المخدوم','error');return;}
  showLoading();
  const visitBody={employee_id:parseInt(empId),visit_date:visitDate,notes:notes};
  try{
    const res=await fetch('/api/visits',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(visitBody)});
    const data=await res.json();
    if(res.ok){showToast('تم تسجيل الافتقاد','success');closeVisitModal();loadVisits();}
    else{showToast(data.error||'خطأ','error');}
  }catch(e){
    queueWrite('/api/visits','POST',visitBody);
    showToast('تم حفظ الافتقاد للمزامنة عند الاتصال','warning');
    closeVisitModal();
  }
  hideLoading();
}

async function deleteVisit(visitId){
  if(!confirm('هل أنت متأكد من حذف هذا الافتقاد؟'))return;
  showLoading();
  try{
    const res=await fetch('/api/visits/'+visitId,{method:'DELETE'});
    if(res.ok){showToast('تم الحذف','success');loadVisits();}
    else{showToast('خطأ','error');}
  }catch(e){
    queueWrite('/api/visits/'+visitId,'DELETE',{});
    showToast('سيتم الحذف عند الاتصال','warning');
  }
  hideLoading();
}

// ===== NFC SCAN =====
function initScanView(){
  document.getElementById('scanDateLabel').textContent=formatDateAr(state.scanDate);
  state.scanCount=0;
  document.getElementById('scanCountValue').textContent='0';
  document.getElementById('scanCounter').classList.add('hidden');
  document.getElementById('scanResult').classList.add('hidden');
  document.getElementById('scanResult').innerHTML='';
  // Check NFC support
  const badge=document.getElementById('nfcBadge');
  if('NDEFReader' in window){
    badge.textContent='NFC متاح';badge.className='nfc-status-badge nfc-supported';
  }else{
    badge.textContent='NFC غير متاح';badge.className='nfc-status-badge nfc-unsupported';
  }
}

async function startNFCScan(){
  if(!('NDEFReader' in window)){
    showToast('NFC غير مدعوم في هذا المتصفح. استخدم الإدخال اليدوي','warning');
    return;
  }
  if(state.scanning){
    stopNFCScan();return;
  }
  try{
    state.nfcAbortController=new AbortController();
    state.nfcReader=new NDEFReader();
    await state.nfcReader.scan({signal:state.nfcAbortController.signal});
    state.scanning=true;
    const circle=document.getElementById('scanStatus');
    circle.classList.add('scanning');
    circle.querySelector('.scan-text').textContent='جاري المسح...';
    document.getElementById('scanHint').textContent='قرّب البطاقة من الهاتف';
    state.nfcReader.onreading=function(event){
      const uid=event.serialNumber.replace(/:/g,'').toUpperCase();
      processNfcScan(uid);
    };
  }catch(e){
    showToast('فشل تشغيل NFC: '+e.message,'error');
  }
}

function stopNFCScan(){
  if(state.nfcAbortController)state.nfcAbortController.abort();
  state.scanning=false;
  const circle=document.getElementById('scanStatus');
  circle.classList.remove('scanning');
  circle.querySelector('.scan-text').textContent='اضغط للمسح';
  document.getElementById('scanHint').textContent='اضغط على الدائرة لبدء مسح NFC';
}

function submitManualNfc(){
  const uid=document.getElementById('manualNfcUid').value.trim().toUpperCase();
  if(!uid){showToast('أدخل معرف NFC','error');return;}
  document.getElementById('manualNfcUid').value='';
  processNfcScan(uid);
}

async function processNfcScan(uid){
  const dateStr=formatDateISO(state.scanDate);
  try{
    const res=await fetch('/api/nfc/scan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nfc_uid:uid,date:dateStr})});
    if(!res.ok){
      queuePendingScan(uid,dateStr);
      showScanResult('warning','fas fa-exclamation-triangle','خطأ في الاتصال','تم حفظ البطاقة للمزامنة لاحقاً');
      return;
    }
    const data=await res.json();
    if(data.status==='recorded'){
      state.scanCount++;
      document.getElementById('scanCountValue').textContent=state.scanCount;
      document.getElementById('scanCounter').classList.remove('hidden');
      showScanResult('success','fas fa-check-circle',data.employee?data.employee.name:'تم التسجيل',data.message||'تم تسجيل الحضور');
    }else if(data.status==='already_scanned'){
      showScanResult('info','fas fa-info-circle',data.employee?data.employee.name:'',data.message||'مسجل بالفعل');
    }else if(data.status==='unknown'){
      showScanResult('warning','fas fa-question-circle','بطاقة غير معروفة','UID: '+uid);
    }
  }catch(e){
    queuePendingScan(uid,dateStr);
    showScanResult('warning','fas fa-exclamation-triangle','خطأ في الاتصال','تم حفظ البطاقة للمزامنة لاحقاً');
  }
}

function showScanResult(type,icon,title,msg){
  const el=document.getElementById('scanResult');
  const colors={success:'var(--success)',error:'var(--danger)',info:'var(--primary)',warning:'var(--warning)'};
  el.innerHTML='<div class="result-icon" style="color:'+colors[type]+'"><i class="'+icon+'"></i></div>'+
    '<div class="result-name">'+title+'</div>'+
    '<div class="result-msg">'+msg+'</div>';
  el.classList.remove('hidden');
  setTimeout(function(){el.classList.add('hidden');},4000);
}

// ===== PENDING NFC OFFLINE QUEUE =====
function queuePendingScan(uid,dateStr){
  try{
    const key=uid+'|'+dateStr;
    let pending=JSON.parse(localStorage.getItem(PENDING_SCAN_KEY)||'[]');
    if(!pending.find(function(p){return p.key===key;})){
      pending.push({uid:uid,date:dateStr,key:key,time:new Date().toISOString()});
      localStorage.setItem(PENDING_SCAN_KEY,JSON.stringify(pending));
    }
  }catch(e){}
}

async function flushPendingNfcScans(silent){
  if(syncInProgress)return;
  syncInProgress=true;
  try{
    let pending=JSON.parse(localStorage.getItem(PENDING_SCAN_KEY)||'[]');
    if(!pending.length){syncInProgress=false;return;}
    const remaining=[];
    for(const p of pending){
      try{
        const res=await fetch('/api/nfc/scan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nfc_uid:p.uid,date:p.date})});
        if(!res.ok)remaining.push(p);
      }catch(e){remaining.push(p);}
    }
    localStorage.setItem(PENDING_SCAN_KEY,JSON.stringify(remaining));
    if(!silent&&pending.length>remaining.length){
      showToast('تمت مزامنة '+(pending.length-remaining.length)+' تسجيل','success');
    }
  }catch(e){}
  syncInProgress=false;
}

// ===== SETTINGS =====
function loadSettings(){
  const sup=state.supervisor;
  if(!sup)return;
  const initial=sup.name?sup.name[0]:'?';
  const color=getAvatarColor(sup.name||'');
  document.getElementById('settingsAvatar').textContent=initial;
  document.getElementById('settingsAvatar').style.background=color;
  document.getElementById('settingsName').textContent=sup.name||'الخادم';
  document.getElementById('settingsPhone').textContent=sup.phone||'';
  // Show services management for master admin
  const svcItem=document.getElementById('settingsServicesItem');
  if(svcItem){svcItem.style.display=state.isMasterAdmin?'':'none';}
}

// ===== SUPERVISORS =====
async function loadSupervisors(){
  const el=document.getElementById('supervisorsList');
  el.innerHTML='<div class="empty-state"><div class="spinner"></div><p>جاري التحميل...</p></div>';
  const data=await fetchWithCache('/api/supervisors','supervisors');
  if(!data||data.length===0){
    el.innerHTML='<div class="empty-state"><i class="fas fa-users-cog"></i><p>لا يوجد خدام</p></div>';
    return;
  }
  el.innerHTML=data.map(function(s){
      const color=getAvatarColor(s.name||'');
      const initial=(s.name||'?')[0];
      return '<div class="card-item" onclick="showSupervisorProfile('+s.id+')">'+
        '<div class="card-avatar" style="background:'+color+';color:#fff">'+initial+'</div>'+
        '<div class="card-body"><h3>'+s.name+'</h3><p>'+s.phone+'</p></div><i class="fas fa-chevron-left" style="color:var(--text-muted);font-size:.8rem"></i></div>';
    }).join('');
}

let editingSupervisor = null;

async function showSupervisorProfile(supId){
  state.previousView=state.currentView;
  state.currentView='supervisor-profile';
  document.querySelectorAll('.view').forEach(function(v){v.classList.remove('active');});
  const vp=document.getElementById('view-supervisor-profile');
  if(vp)vp.classList.add('active');
  const el=document.getElementById('supervisorProfileContent');
  el.innerHTML='<div class="empty-state"><div class="spinner"></div><p>جاري التحميل...</p></div>';
  
  if(state.isMasterAdmin){
    document.getElementById('editSupervisorBtn').style.display='inline-flex';
  } else {
    document.getElementById('editSupervisorBtn').style.display='none';
  }
  
  try{
    const data=await fetchWithCache('/api/supervisors/'+supId, 'supervisor_'+supId);
    if(!data || data.error){el.innerHTML='<div class="empty-state"><p>لا توجد بيانات</p></div>';return;}
    const sup=data.supervisor;
    editingSupervisor=sup; // Save for editing later
    const stats=data.stats;
    const color=getAvatarColor(sup.name||'');
    const initial=(sup.name||'?')[0];

    let html='<div class="profile-header">';
    html+='<div class="profile-avatar" style="background:'+color+';color:#fff">'+initial+'</div>';
    html+='<h2>'+sup.name+'</h2>';
    html+='<div class="profile-uid">'+sup.phone+'</div>';
    html+='<div class="profile-stats">';
    html+='<div class="profile-stat"><span class="profile-stat-value text-blue">'+(stats.total_scans||0)+'</span><span class="profile-stat-label">تسجيلات حضور</span></div>';
    html+='</div></div>';

    // Info
    html+='<div class="profile-section"><h3><i class="fas fa-info-circle"></i> المعلومات الشخصية</h3>';
    let svcName = 'غير محدد';
    let stgName = 'غير محدد';
    if(state.services) {
      const s=state.services.find(x=>x.id===sup.service_id);
      if(s) svcName=s.name;
    }
    if(state.stages) {
      const st=state.stages.find(x=>x.id===sup.stage_id);
      if(st) stgName=st.name;
    }
    const fields=[
      {label:'رقم الهاتف',value:sup.phone},
      {label:'الخدمة',value:svcName},
      {label:'المرحلة',value:stgName},
      {label:'تاريخ الانضمام',value:sup.created_at?sup.created_at.split('T')[0]:''}
    ];
    fields.forEach(function(f){
      if(f.value)html+='<div class="profile-row"><span class="profile-row-label">'+f.label+'</span><span class="profile-row-value">'+f.value+'</span></div>';
    });
    html+='</div>';

    if(state.isMasterAdmin){
      html+='<button class="btn btn-danger btn-full" style="margin-top:24px" onclick="deleteSupervisorAdmin('+sup.id+')"><i class="fas fa-trash"></i> حذف الخادم</button>';
    }
    el.innerHTML=html;
  }catch(e){el.innerHTML='<div class="empty-state"><p>خطأ في الاتصال</p></div>';}
}

function closeSupervisorModal() {
  document.getElementById('supervisorEditModal').classList.add('hidden');
}

function onSupEditServiceChange(){
  const sId=parseInt(document.getElementById('supEditService').value);
  const stSel=document.getElementById('supEditStage');
  stSel.innerHTML='';
  stSel.disabled=!sId;
  if(sId){
    state.stages.filter(function(s){return s.service_id===sId;}).forEach(function(s){
      stSel.innerHTML+='<option value="'+s.id+'">'+s.name+'</option>';
    });
  }
}

function toggleEditSupervisor(){
  if(!editingSupervisor)return;
  const sup=editingSupervisor;
  document.getElementById('supEditName').value=sup.name||'';
  document.getElementById('supEditPhone').value=sup.phone||'';
  document.getElementById('supEditPassword').value='';
  
  if (state.services && state.services.length>0) {
    document.getElementById('supEditServiceGroup').style.display='block';
    document.getElementById('supEditStageGroup').style.display='block';
    const sSel=document.getElementById('supEditService');
    sSel.innerHTML='<option value="">-- اختر الخدمة --</option>';
    state.services.forEach(function(s){
      const sel=(s.id===sup.service_id)?' selected':'';
      sSel.innerHTML+='<option value="'+s.id+'"'+sel+'>'+s.name+'</option>';
    });
    onSupEditServiceChange();
    document.getElementById('supEditStage').value=sup.stage_id||'';
  }

  document.getElementById('supModalSaveBtn').onclick=function(){updateSupervisorAdmin(sup.id);};
  document.getElementById('supervisorEditModal').classList.remove('hidden');
}

async function updateSupervisorAdmin(supId){
  const name=document.getElementById('supEditName').value.trim();
  const phone=document.getElementById('supEditPhone').value.trim();
  const password=document.getElementById('supEditPassword').value;
  const sId=parseInt(document.getElementById('supEditService').value);
  const stId=parseInt(document.getElementById('supEditStage').value);
  
  if(!name || !phone) { showToast('الاسم ورقم الهاتف مطلوبان', 'error'); return; }
  
  const body={name:name, phone:phone};
  if(password) body.password=password;
  if(sId) body.service_id=sId;
  if(stId) body.stage_id=stId;

  showLoading();
  try{
    const res=await fetch('/api/supervisors/'+supId,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data=await res.json();
    if(res.ok){
      showToast('تم التحديث','success');
      closeSupervisorModal();
      showSupervisorProfile(supId); // Refresh profile
      try { const db=await openDB(); if(db) { const tx=db.transaction('cache','readwrite'); tx.objectStore('cache').delete('supervisors');} } catch(e){}
    } else { showToast(data.error||'خطأ','error'); }
  }catch(e){
    queueWrite('/api/supervisors/'+supId,'PUT',body);
    showToast('تم حفظ التعديلات للمزامنة','warning');
    closeSupervisorModal();
  }
  hideLoading();
}

async function deleteSupervisorAdmin(supId){
  if(!confirm('هل أنت متأكد من حذف هذا الخادم ومسح بياناته؟'))return;
  showLoading();
  try{
    const res=await fetch('/api/supervisors/'+supId,{method:'DELETE'});
    if(res.ok){
      showToast('تم الحذف','success');
      try { const db=await openDB(); if(db) { const tx=db.transaction('cache','readwrite'); tx.objectStore('cache').delete('supervisors');} } catch(e){}
      showView('supervisors');
    } else { showToast('خطأ','error'); }
  }catch(e){
    queueWrite('/api/supervisors/'+supId,'DELETE',{});
    showToast('سيتم الحذف عند الاتصال','warning');
    showView('supervisors');
  }
  hideLoading();
}

// ===== SERVICES MANAGEMENT =====
async function loadServicesManagement(){
  const el=document.getElementById('servicesContent');
  el.innerHTML='<div class="empty-state"><div class="spinner"></div><p>جاري التحميل...</p></div>';
  await loadServicesAndStages();
  let html='';
  // Add service form
  html+='<div class="service-section"><h3><i class="fas fa-plus-circle"></i> إضافة خدمة جديدة</h3>';
  html+='<div class="add-row"><input type="text" id="newServiceName" placeholder="اسم الخدمة" />';
  html+='<button class="btn btn-primary btn-sm" onclick="addService()"><i class="fas fa-plus"></i></button></div></div>';
  // Existing services
  state.services.forEach(function(svc){
    html+='<div class="service-section"><h3><i class="fas fa-server"></i> '+svc.name;
    html+=' <button class="btn btn-icon" style="color:var(--danger)" onclick="deleteService('+svc.id+')"><i class="fas fa-trash"></i></button></h3>';
    const svcStages=state.stages.filter(function(s){return s.service_id===svc.id;});
    svcStages.forEach(function(stg){
      html+='<div class="service-item"><span>'+stg.name+'</span>';
      html+='<button class="btn btn-icon" style="color:var(--danger)" onclick="deleteStage('+stg.id+')"><i class="fas fa-trash"></i></button></div>';
    });
    html+='<div class="add-row"><input type="text" id="newStage_'+svc.id+'" placeholder="اسم مرحلة جديدة" />';
    html+='<button class="btn btn-primary btn-sm" onclick="addStage('+svc.id+')"><i class="fas fa-plus"></i></button></div></div>';
  });
  el.innerHTML=html;
}
async function addService(){
  const name=document.getElementById('newServiceName').value.trim();
  if(!name){showToast('أدخل اسم الخدمة','error');return;}
  showLoading();
  try{
    const res=await fetch('/api/services',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name})});
    if(res.ok){showToast('تمت الإضافة','success');loadServicesManagement();}
    else{const d=await res.json();showToast(d.error||'خطأ','error');}
  }catch(e){showToast('خطأ','error');}
  hideLoading();
}

async function deleteService(id){
  if(!confirm('حذف هذه الخدمة وجميع مراحلها؟'))return;
  showLoading();
  try{await fetch('/api/services/'+id,{method:'DELETE'});showToast('تم الحذف','success');loadServicesManagement();}
  catch(e){showToast('خطأ','error');}
  hideLoading();
}

async function addStage(svcId){
  const input=document.getElementById('newStage_'+svcId);
  const name=input?input.value.trim():'';
  if(!name){showToast('أدخل اسم المرحلة','error');return;}
  showLoading();
  try{
    const res=await fetch('/api/stages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,service_id:svcId})});
    if(res.ok){showToast('تمت الإضافة','success');loadServicesManagement();}
    else{const d=await res.json();showToast(d.error||'خطأ','error');}
  }catch(e){showToast('خطأ','error');}
  hideLoading();
}

async function deleteStage(id){
  if(!confirm('حذف هذه المرحلة؟'))return;
  showLoading();
  try{await fetch('/api/stages/'+id,{method:'DELETE'});showToast('تم الحذف','success');loadServicesManagement();}
  catch(e){showToast('خطأ','error');}
  hideLoading();
}

// ===== EXPORT =====
function showReportModal() {
  const d = new Date();
  document.getElementById('reportEndDate').value = d.toISOString().split('T')[0];
  d.setDate(d.getDate() - 30);
  document.getElementById('reportStartDate').value = d.toISOString().split('T')[0];
  document.getElementById('reportModal').classList.remove('hidden');
}

function closeReportModal() {
  document.getElementById('reportModal').classList.add('hidden');
}

async function generateReport(){
  const start = document.getElementById('reportStartDate').value;
  const end = document.getElementById('reportEndDate').value;
  if(!start || !end) { showToast('يرجى تحديد التواريخ', 'warning'); return; }

  showLoading();
  try{
    const res=await fetch(buildUrl('/api/attendance/report', {start: start, end: end}));
    if(!res.ok){showToast('خطأ','error');hideLoading();return;}
    const records=await res.json();
    if(!records.length){showToast('لا توجد سجلات للتصدير','warning');hideLoading();return;}
    // Build CSV
    let csv='\uFEFF'; // BOM for Arabic
    csv+='الاسم,معرف NFC,الحالة,التاريخ والوقت,الخادم,ملاحظات\n';
    records.forEach(function(r){
      const status=r.status==='present'?'حاضر':'غائب';
      csv+='"'+(r.employee_name||'')+'",'+(r.nfc_uid||'')+','+status+',"'+(r.scan_time||'')+'","'+(r.supervisor_name||'')+'","'+(r.notes||'')+'"\n';
    });
    const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;a.download='attendance_report.csv';
    document.body.appendChild(a);a.click();document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('تم تصدير التقرير','success');
    closeReportModal();
  }catch(e){showToast('خطأ في التصدير','error');}
  hideLoading();
}

// ANDROID API SETTINGS REMOVED

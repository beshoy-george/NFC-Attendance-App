/* NFC Attendance System - Arabic RTL */

const state = {
  supervisor: null,
  employees: [],
  currentView: 'dashboard',
  previousView: null,
  selectedDate: getNearestFriday(),
  scanDate: getNearestFriday(),
  attDate: getNearestFriday(),
  scanning: false,
  nfcReader: null,
  nfcAbortController: null,
  scanCount: 0,
  weeklyChart: null,
  currentFilter: 'all',
  editingEmployee: null
};

// ===== DATE HELPERS =====
function getNearestFriday(d) {
  if (!d) d = new Date();
  const day = d.getDay();
  const diff = (day - 5 + 7) % 7;
  const friday = new Date(d);
  friday.setDate(d.getDate() - diff);
  friday.setHours(0, 0, 0, 0);
  return friday;
}
function getPrevFriday(d) {
  const prev = new Date(d);
  prev.setDate(prev.getDate() - 7);
  return prev;
}
function getNextFriday(d) {
  const next = new Date(d);
  next.setDate(next.getDate() + 7);
  return next;
}
function formatDateISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
function formatDateAr(d) {
  const months = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}
function formatDateShort(dateStr) {
  const d = new Date(dateStr);
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

// Date navigation
function navigateDate(dir) {
  state.selectedDate = dir === -1 ? getPrevFriday(state.selectedDate) : getNextFriday(state.selectedDate);
  document.getElementById('dashDateLabel').textContent = formatDateAr(state.selectedDate);
  loadDashboard();
}
function navigateScanDate(dir) {
  state.scanDate = dir === -1 ? getPrevFriday(state.scanDate) : getNextFriday(state.scanDate);
  document.getElementById('scanDateLabel').textContent = formatDateAr(state.scanDate);
}
function navigateAttDate(dir) {
  state.attDate = dir === -1 ? getPrevFriday(state.attDate) : getNextFriday(state.attDate);
  document.getElementById('attDateLabel').textContent = formatDateAr(state.attDate);
  loadAttendance();
}
function goToToday() {
  state.selectedDate = getNearestFriday();
  document.getElementById('dashDateLabel').textContent = formatDateAr(state.selectedDate);
  loadDashboard();
}
function goToTodayScan() {
  state.scanDate = getNearestFriday();
  document.getElementById('scanDateLabel').textContent = formatDateAr(state.scanDate);
}
function goToTodayAtt() {
  state.attDate = getNearestFriday();
  document.getElementById('attDateLabel').textContent = formatDateAr(state.attDate);
  loadAttendance();
}

// ===== UI HELPERS =====
function showLoading() { document.getElementById('loadingOverlay').classList.add('active'); }
function hideLoading() { document.getElementById('loadingOverlay').classList.remove('active'); }

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const icons = { success: 'check-circle', error: 'exclamation-circle', info: 'info-circle', warning: 'exclamation-triangle' };
  toast.innerHTML = `<i class="fas fa-${icons[type] || 'info-circle'}"></i> ${message}`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3000);
}

function showView(name) {
  if (name !== 'profile') state.previousView = state.currentView;
  state.currentView = name;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const view = document.getElementById(`view-${name}`);
  if (view) view.classList.add('active');
  document.querySelectorAll('.nav-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.view === name);
  });
  if (name === 'dashboard') loadDashboard();
  else if (name === 'employees') loadEmployees();
  else if (name === 'attendance') loadAttendance();
  else if (name === 'analytics') loadAnalytics();
  else if (name === 'scan') initScanView();
  else if (name === 'settings') loadSettings();
  else if (name === 'supervisors') loadSupervisors();
}

function goBack() {
  showView(state.previousView || 'dashboard');
}

// ===== AUTH =====
async function handleLogin() {
  const phone = document.getElementById('loginPhone').value.trim();
  const password = document.getElementById('loginPassword').value;
  if (!phone || !password) { showToast('يرجى ملء جميع الحقول', 'error'); return; }
  showLoading();
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, password })
    });
    const data = await res.json();
    if (res.ok) {
      state.supervisor = data.supervisor;
      showApp();
      showToast('أهلاً ' + data.supervisor.name, 'success');
    } else {
      showToast(data.error || 'بيانات غير صحيحة', 'error');
    }
  } catch (e) {
    showToast('خطأ في الاتصال', 'error');
  }
  hideLoading();
}

async function handleRegister() {
  const name = document.getElementById('regName').value.trim();
  const phone = document.getElementById('regPhone').value.trim();
  const password = document.getElementById('regPassword').value;
  if (!name || !phone || !password) { showToast('يرجى ملء جميع الحقول', 'error'); return; }
  if (password.length < 4) { showToast('كلمة المرور يجب أن تكون 4 أحرف على الأقل', 'error'); return; }
  showLoading();
  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone, password })
    });
    const data = await res.json();
    if (res.ok) {
      state.supervisor = data.supervisor;
      showApp();
      showToast('تم التسجيل بنجاح', 'success');
    } else {
      showToast(data.error || 'خطأ في التسجيل', 'error');
    }
  } catch (e) {
    showToast('خطأ في الاتصال', 'error');
  }
  hideLoading();
}

async function handleLogout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  state.supervisor = null;
  document.getElementById('authView').classList.remove('hidden');
  document.getElementById('appView').classList.add('hidden');
  showToast('تم تسجيل الخروج', 'info');
}

function toggleAuth() {
  document.getElementById('loginForm').classList.toggle('hidden');
  document.getElementById('registerForm').classList.toggle('hidden');
}

function showApp() {
  document.getElementById('authView').classList.add('hidden');
  document.getElementById('appView').classList.remove('hidden');
  if (state.supervisor) {
    const initials = state.supervisor.name.charAt(0);
    document.getElementById('headerAvatar').textContent = initials;
  }
  // Set initial dates
  document.getElementById('dashDateLabel').textContent = formatDateAr(state.selectedDate);
  document.getElementById('scanDateLabel').textContent = formatDateAr(state.scanDate);
  document.getElementById('attDateLabel').textContent = formatDateAr(state.attDate);
  loadDashboard();
}

// ===== DASHBOARD =====
async function loadDashboard() {
  try {
    const dateStr = formatDateISO(state.selectedDate);
    const res = await fetch(`/api/dashboard?date=${dateStr}`);
    if (!res.ok) return;
    const data = await res.json();
    document.getElementById('statTotal').textContent = data.total_employees;
    document.getElementById('statPresent').textContent = data.today_present;
    document.getElementById('statAbsent').textContent = data.today_absent;
    document.getElementById('statPending').textContent = data.today_not_scanned;
    document.getElementById('dashDate').textContent = 'المشرفين: ' + data.total_supervisors;
    renderRecentScans(data.recent_scans);
  } catch (e) { console.error('Dashboard error:', e); }
}

function renderRecentScans(scans) {
  const container = document.getElementById('recentScans');
  if (!scans || scans.length === 0) {
    container.innerHTML = '<div class="empty-state"><i class="fas fa-inbox"></i><p>لا توجد تسجيلات بعد</p></div>';
    return;
  }
  container.innerHTML = scans.map(s => {
    const time = s.scan_time ? new Date(s.scan_time).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }) : '';
    const color = getAvatarColor(s.employee_name);
    return `<div class="card-item" onclick="showProfile(${s.employee_id})">
      <div class="card-avatar" style="background:${color}">${s.employee_name.charAt(0)}</div>
      <div class="card-body"><h3>${s.employee_name}</h3><p>${time} • ${s.supervisor_name}</p></div>
      <span class="card-badge badge-${s.status === 'present' ? 'present' : 'absent'}">${s.status === 'present' ? 'حاضر' : 'غائب'}</span>
    </div>`;
  }).join('');
}

// ===== NFC SCAN =====
function initScanView() {
  const badge = document.getElementById('nfcBadge');
  if ('NDEFReader' in window) {
    badge.textContent = 'NFC متاح';
    badge.className = 'nfc-status-badge nfc-supported';
  } else {
    badge.textContent = 'NFC غير متاح';
    badge.className = 'nfc-status-badge nfc-unsupported';
  }
}

async function startNFCScan() {
  if (state.scanning) { stopNFCScan(); return; }
  if (!('NDEFReader' in window)) {
    showToast('جهازك لا يدعم NFC — استخدم الإدخال اليدوي', 'warning');
    return;
  }
  try {
    state.nfcAbortController = new AbortController();
    state.nfcReader = new NDEFReader();
    await state.nfcReader.scan({ signal: state.nfcAbortController.signal });
    state.scanning = true;
    const circle = document.getElementById('scanStatus');
    circle.classList.add('scanning');
    document.getElementById('scanHint').textContent = 'قرّب البطاقة من الجهاز...';
    state.nfcReader.addEventListener('reading', async (event) => {
      const uid = event.serialNumber ? event.serialNumber.replace(/:/g, '').toUpperCase() : null;
      if (uid) await processNfcScan(uid);
    }, { signal: state.nfcAbortController.signal });
    state.nfcReader.addEventListener('readingerror', async (event) => {
      const uid = event.serialNumber ? event.serialNumber.replace(/:/g, '').toUpperCase() : null;
      if (uid) {
        await processNfcScan(uid);
      } else {
        showToast('تعذر قراءة البطاقة — حاول مرة أخرى', 'warning');
      }
    }, { signal: state.nfcAbortController.signal });
  } catch (e) {
    showToast('تعذر تشغيل NFC: ' + e.message, 'error');
  }
}

function stopNFCScan() {
  if (state.nfcAbortController) { state.nfcAbortController.abort(); state.nfcAbortController = null; }
  state.scanning = false;
  state.nfcReader = null;
  const circle = document.getElementById('scanStatus');
  circle.classList.remove('scanning');
  document.getElementById('scanHint').textContent = 'اضغط على الدائرة لبدء مسح NFC';
}

let lastScanTime = 0;
async function processNfcScan(uid) {
  const now = Date.now();
  if (now - lastScanTime < 2000) return;
  lastScanTime = now;
  try {
    const res = await fetch('/api/nfc/scan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nfc_uid: uid, date: formatDateISO(state.scanDate) })
    });
    const data = await res.json();
    showScanResult(data);
    if (data.status === 'recorded') {
      state.scanCount++;
      document.getElementById('scanCounter').classList.remove('hidden');
      document.getElementById('scanCountValue').textContent = state.scanCount;
    }
  } catch (e) {
    showToast('خطأ في الاتصال', 'error');
  }
}

function showScanResult(data) {
  const container = document.getElementById('scanResult');
  container.classList.remove('hidden');
  if (data.status === 'recorded') {
    container.innerHTML = `<div class="result-icon" style="color:var(--success)">✔</div>
      <div class="result-name">${data.employee.name}</div>
      <div class="result-msg">تم تسجيل الحضور</div>`;
  } else if (data.status === 'already_scanned') {
    container.innerHTML = `<div class="result-icon" style="color:var(--warning)">⚠</div>
      <div class="result-name">${data.employee.name}</div>
      <div class="result-msg">تم التسجيل مسبقاً</div>`;
  } else if (data.status === 'unknown') {
    container.innerHTML = `<div class="result-icon" style="color:var(--danger)">❓</div>
      <div class="result-name">بطاقة غير معروفة</div>
      <div class="result-msg">UID: ${data.nfc_uid}</div>
      <div class="result-actions">
        <button class="btn btn-primary btn-sm" onclick="showAddEmployeeWithNfc('${data.nfc_uid}')"><i class="fas fa-user-plus"></i> تسجيل مخدوم جديد</button>
      </div>`;
  }
  setTimeout(() => container.classList.add('hidden'), 5000);
}

async function submitManualNfc() {
  const uid = document.getElementById('manualNfcUid').value.trim().toUpperCase();
  if (!uid) { showToast('أدخل معرف NFC', 'warning'); return; }
  await processNfcScan(uid);
  document.getElementById('manualNfcUid').value = '';
}

// ===== ATTENDANCE =====
async function loadAttendance() {
  const dateStr = formatDateISO(state.attDate);
  try {
    const res = await fetch(`/api/attendance/date?date=${dateStr}`);
    if (!res.ok) return;
    const data = await res.json();
    renderAttendance(data);
  } catch (e) { console.error('Attendance error:', e); }
}

function renderAttendance(records) {
  const container = document.getElementById('attendanceList');
  let filtered = records;
  if (state.currentFilter !== 'all') {
    filtered = records.filter(r => r.status === state.currentFilter);
  }
  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-state"><i class="fas fa-clipboard"></i><p>لا توجد سجلات</p></div>';
    return;
  }
  state._attendanceRecords = records;
  container.innerHTML = filtered.map(r => {
    const emp = r.employee;
    const color = getAvatarColor(emp.name);
    const badgeClass = r.status === 'present' ? 'badge-present' : r.status === 'absent' ? 'badge-absent' : 'badge-pending';
    const badgeText = r.status === 'present' ? 'حاضر' : r.status === 'absent' ? 'غائب' : 'لم يُسجل';
    const time = r.scan_time ? new Date(r.scan_time).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }) : '';
    return `<div class="card-item" onclick="showProfile(${emp.id})">
      <div class="card-avatar" style="background:${color}">${emp.name.charAt(0)}</div>
      <div class="card-body"><h3>${emp.name}</h3><p>${time ? time + ' • ' : ''}${emp.department || ''}</p></div>
      <span class="card-badge ${badgeClass}">${badgeText}</span>
    </div>`;
  }).join('');
}

function filterAttendance(filter) {
  state.currentFilter = filter;
  document.querySelectorAll('.filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === filter);
  });
  if (state._attendanceRecords) renderAttendance(state._attendanceRecords);
  else loadAttendance();
}

// ===== ANALYTICS =====
async function loadAnalytics() {
  const container = document.getElementById('analyticsContent');
  container.innerHTML = '<div class="empty-state"><div class="spinner"></div><p>جاري التحميل...</p></div>';
  try {
    const res = await fetch('/api/analytics?weeks=12');
    if (!res.ok) return;
    const data = await res.json();
    renderAnalytics(data);
  } catch (e) {
    container.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>خطأ في تحميل الإحصائيات</p></div>';
  }
}

function renderAnalytics(data) {
  const container = document.getElementById('analyticsContent');
  let html = '';
  // Overall stats
  html += `<div class="stats-grid" style="margin-bottom:24px">
    <div class="stat-card stat-blue"><i class="fas fa-users"></i>
      <div class="stat-info"><span class="stat-value">${data.total_employees}</span><span class="stat-label">إجمالي المخدومين</span></div></div>
    <div class="stat-card stat-green"><i class="fas fa-percentage"></i>
      <div class="stat-info"><span class="stat-value">${data.overall_rate}%</span><span class="stat-label">نسبة الحضور</span></div></div>
    <div class="stat-card stat-orange"><i class="fas fa-calendar-check"></i>
      <div class="stat-info"><span class="stat-value">${data.total_attendance_records}</span><span class="stat-label">إجمالي السجلات</span></div></div>
    <div class="stat-card stat-red"><i class="fas fa-check-double"></i>
      <div class="stat-info"><span class="stat-value">${data.total_present}</span><span class="stat-label">إجمالي الحضور</span></div></div>
  </div>`;
  // Weekly trend chart
  html += `<div class="analytics-section">
    <h3><i class="fas fa-chart-line"></i> الحضور الأسبوعي</h3>
    <div class="chart-container"><canvas id="weeklyTrendChart"></canvas></div>
  </div>`;
  // Class breakdown
  if (data.class_stats && data.class_stats.length > 0) {
    html += `<div class="analytics-section"><h3><i class="fas fa-layer-group"></i> الفصول</h3>`;
    data.class_stats.forEach(cls => {
      html += `<div class="class-stat-card">
        <div class="class-info"><h4>${cls.name}</h4><p>${cls.count} مخدوم</p></div>
        <div class="class-rate"><span class="rate-value">${cls.rate}%</span>
          <div class="rate-bar"><div class="rate-fill" style="width:${cls.rate}%"></div></div></div>
      </div>`;
    });
    html += '</div>';
  }
  // Top attendees
  if (data.attendee_stats && data.attendee_stats.length > 0) {
    html += `<div class="analytics-section"><h3><i class="fas fa-trophy"></i> أعلى حضور</h3>`;
    const medals = ['🥇', '🥈', '🥉'];
    data.attendee_stats.slice(0, 10).forEach((att, i) => {
      const medal = i < 3 ? medals[i] : `${i + 1}.`;
      const color = getAvatarColor(att.name);
      html += `<div class="card-item" onclick="showProfile(${att.id})">
        <span style="font-size:1.2rem;min-width:32px;text-align:center">${medal}</span>
        <div class="card-avatar" style="background:${color};width:36px;height:36px;font-size:.85rem">${att.name.charAt(0)}</div>
        <div class="card-body"><h3>${att.name}</h3><p>${att.class_name || ''} • ${att.present}/${att.total}</p></div>
        <span class="card-badge badge-present">${att.rate}%</span>
      </div>`;
    });
    html += '</div>';
  }
  container.innerHTML = html;
  // Draw chart
  if (data.weekly_trend && data.weekly_trend.length > 0) {
    const ctx = document.getElementById('weeklyTrendChart');
    if (ctx) {
      const trend = [...data.weekly_trend].reverse();
      if (state.weeklyChart) state.weeklyChart.destroy();
      state.weeklyChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: trend.map(w => formatDateShort(w.date)),
          datasets: [{
            label: 'حاضر', data: trend.map(w => w.present),
            backgroundColor: 'rgba(16,185,129,.7)', borderRadius: 4
          }, {
            label: 'غائب', data: trend.map(w => w.total - w.present),
            backgroundColor: 'rgba(239,68,68,.5)', borderRadius: 4
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { labels: { color: '#94a3b8', font: { family: 'Cairo' } } } },
          scales: {
            x: { ticks: { color: '#64748b' }, grid: { color: 'rgba(45,74,94,.3)' } },
            y: { ticks: { color: '#64748b' }, grid: { color: 'rgba(45,74,94,.3)' }, beginAtZero: true }
          }
        }
      });
    }
  }
}

// ===== EMPLOYEES =====
async function loadEmployees() {
  try {
    const res = await fetch('/api/employees');
    if (!res.ok) return;
    state.employees = await res.json();
    renderEmployees(state.employees);
  } catch (e) { console.error('Employees error:', e); }
}

function renderEmployees(employees) {
  const container = document.getElementById('employeeList');
  if (employees.length === 0) {
    container.innerHTML = '<div class="empty-state"><i class="fas fa-users"></i><p>لا يوجد مخدومين مسجلين</p></div>';
    return;
  }
  container.innerHTML = employees.map(emp => {
    const color = getAvatarColor(emp.name);
    return `<div class="card-item" onclick="showProfile(${emp.id})">
      <div class="card-avatar" style="background:${color}">${emp.name.charAt(0)}</div>
      <div class="card-body"><h3>${emp.name}</h3><p>${emp.department || ''} ${emp.phone ? '• ' + emp.phone : ''}</p></div>
      <i class="fas fa-chevron-left" style="color:var(--text-muted)"></i>
    </div>`;
  }).join('');
}

function searchEmployees(query) {
  const q = query.trim().toLowerCase();
  if (!q) { renderEmployees(state.employees); return; }
  const filtered = state.employees.filter(e =>
    e.name.toLowerCase().includes(q) || (e.department || '').toLowerCase().includes(q) ||
    (e.nfc_uid || '').toLowerCase().includes(q)
  );
  renderEmployees(filtered);
}

// ===== EMPLOYEE MODAL =====
function showAddEmployeeModal() {
  state.editingEmployee = null;
  document.getElementById('modalTitle').textContent = 'تسجيل مخدوم جديد';
  clearEmployeeModal();
  document.getElementById('empNfcUidDisplay').readOnly = false;
  document.getElementById('modalSaveBtn').onclick = saveNewEmployee;
  document.getElementById('employeeModal').classList.remove('hidden');
}

function showAddEmployeeWithNfc(nfcUid) {
  showAddEmployeeModal();
  document.getElementById('empNfcUidDisplay').value = nfcUid;
  document.getElementById('empNfcUidDisplay').readOnly = true;
}

function showEditEmployeeModal(emp) {
  state.editingEmployee = emp;
  document.getElementById('modalTitle').textContent = 'تعديل بيانات';
  document.getElementById('empNfcUidDisplay').value = emp.nfc_uid;
  document.getElementById('empNfcUidDisplay').readOnly = true;
  document.getElementById('empName').value = emp.name || '';
  document.getElementById('empClass').value = emp.department || '';
  document.getElementById('empBirthdate').value = emp.birthdate || '';
  document.getElementById('empPhone').value = emp.phone || '';
  document.getElementById('empParentPhone').value = emp.parent_phone || '';
  document.getElementById('empConfessionFather').value = emp.confession_father || '';
  document.getElementById('empAddress').value = emp.address || '';
  document.getElementById('modalSaveBtn').onclick = () => updateEmployee(emp.id);
  document.getElementById('employeeModal').classList.remove('hidden');
}

function clearEmployeeModal() {
  ['empNfcUidDisplay', 'empName', 'empClass', 'empBirthdate', 'empPhone', 'empParentPhone', 'empConfessionFather', 'empAddress'].forEach(id => {
    document.getElementById(id).value = '';
  });
}

function closeEmployeeModal() {
  document.getElementById('employeeModal').classList.add('hidden');
}

async function saveNewEmployee() {
  const nfc_uid = document.getElementById('empNfcUidDisplay').value.trim().toUpperCase();
  const name = document.getElementById('empName').value.trim();
  if (!nfc_uid || !name) { showToast('الاسم ومعرف NFC مطلوبان', 'error'); return; }
  showLoading();
  try {
    const res = await fetch('/api/employees', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nfc_uid, name,
        class_name: document.getElementById('empClass').value.trim(),
        birthdate: document.getElementById('empBirthdate').value,
        phone: document.getElementById('empPhone').value.trim(),
        parent_phone: document.getElementById('empParentPhone').value.trim(),
        confession_father: document.getElementById('empConfessionFather').value.trim(),
        address: document.getElementById('empAddress').value.trim()
      })
    });
    const data = await res.json();
    if (res.ok) {
      closeEmployeeModal();
      showToast('تم تسجيل ' + name, 'success');
      loadEmployees();
    } else {
      showToast(data.error || 'خطأ', 'error');
    }
  } catch (e) { showToast('خطأ في الاتصال', 'error'); }
  hideLoading();
}

async function updateEmployee(id) {
  const name = document.getElementById('empName').value.trim();
  if (!name) { showToast('الاسم مطلوب', 'error'); return; }
  showLoading();
  try {
    const res = await fetch(`/api/employees/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        class_name: document.getElementById('empClass').value.trim(),
        birthdate: document.getElementById('empBirthdate').value,
        phone: document.getElementById('empPhone').value.trim(),
        parent_phone: document.getElementById('empParentPhone').value.trim(),
        confession_father: document.getElementById('empConfessionFather').value.trim(),
        address: document.getElementById('empAddress').value.trim()
      })
    });
    const data = await res.json();
    if (res.ok) {
      closeEmployeeModal();
      showToast('تم التحديث', 'success');
      showProfile(id);
    } else {
      showToast(data.error || 'خطأ', 'error');
    }
  } catch (e) { showToast('خطأ في الاتصال', 'error'); }
  hideLoading();
}

async function deleteEmployee(id) {
  if (!confirm('هل أنت متأكد من حذف هذا المخدوم؟')) return;
  showLoading();
  try {
    await fetch(`/api/employees/${id}`, { method: 'DELETE' });
    showToast('تم الحذف', 'info');
    showView('employees');
  } catch (e) { showToast('خطأ', 'error'); }
  hideLoading();
}

// ===== PROFILE =====
async function showProfile(id) {
  showView('profile');
  const container = document.getElementById('profileContent');
  container.innerHTML = '<div class="empty-state"><div class="spinner"></div><p>جاري التحميل...</p></div>';
  try {
    const res = await fetch(`/api/employees/${id}`);
    if (!res.ok) { showToast('لم يتم العثور على المخدوم', 'error'); goBack(); return; }
    const data = await res.json();
    renderProfile(data);
    document.getElementById('editProfileBtn').onclick = () => showEditEmployeeModal(data.employee);
  } catch (e) { showToast('خطأ', 'error'); goBack(); }
}

function renderProfile(data) {
  const emp = data.employee;
  const stats = data.stats;
  const color = getAvatarColor(emp.name);
  let html = `<div class="profile-header">
    <div class="profile-avatar" style="background:${color}">${emp.name.charAt(0)}</div>
    <h2>${emp.name}</h2>
    <p class="profile-uid">${emp.nfc_uid}</p>
    <div class="profile-stats">
      <div class="profile-stat"><span class="profile-stat-value text-green">${stats.present}</span><span class="profile-stat-label">حاضر</span></div>
      <div class="profile-stat"><span class="profile-stat-value text-red">${stats.absent}</span><span class="profile-stat-label">غائب</span></div>
      <div class="profile-stat"><span class="profile-stat-value text-blue">${stats.rate}%</span><span class="profile-stat-label">النسبة</span></div>
    </div>
  </div>`;
  // Weekly grid
  if (data.weekly && data.weekly.length > 0) {
    html += `<div class="profile-section"><h3><i class="fas fa-calendar-week"></i> آخر 12 أسبوع</h3><div class="weekly-grid">`;
    data.weekly.reverse().forEach(w => {
      const cls = w.status === 'present' ? 'week-present' : 'week-absent';
      const icon = w.status === 'present' ? '✓' : '✗';
      html += `<div class="week-cell ${cls}"><span class="week-date">${formatDateShort(w.date)}</span><span class="week-icon">${icon}</span></div>`;
    });
    html += '</div></div>';
  }
  // Details
  html += `<div class="profile-section"><h3><i class="fas fa-info-circle"></i> البيانات الشخصية</h3>`;
  const fields = [
    ['الفصل', emp.department],
    ['تاريخ الميلاد', emp.birthdate],
    ['رقم الهاتف', emp.phone],
    ['تليفون ولي الأمر', emp.parent_phone],
    ['أب الاعتراف', emp.confession_father],
    ['العنوان', emp.address]
  ];
  fields.forEach(([label, value]) => {
    if (value) html += `<div class="profile-row"><span class="profile-row-label">${label}</span><span class="profile-row-value">${value}</span></div>`;
  });
  html += '</div>';
  // Actions
  html += `<div style="display:flex;gap:12px;margin-top:20px">
    <button class="btn btn-primary btn-full" onclick="showEditEmployeeModal(${JSON.stringify(emp).replace(/"/g, '&quot;')})"><i class="fas fa-pen"></i> تعديل</button>
    <button class="btn btn-danger btn-full" onclick="deleteEmployee(${emp.id})"><i class="fas fa-trash"></i> حذف</button>
  </div>`;
  document.getElementById('profileContent').innerHTML = html;
}

function toggleEditProfile() {
  if (state.editingEmployee) {
    showEditEmployeeModal(state.editingEmployee);
  }
}

// ===== SETTINGS =====
function loadSettings() {
  if (state.supervisor) {
    const initials = state.supervisor.name.charAt(0);
    document.getElementById('settingsAvatar').textContent = initials;
    document.getElementById('settingsName').textContent = state.supervisor.name;
    document.getElementById('settingsPhone').textContent = state.supervisor.phone || '';
  }
}

// ===== SUPERVISORS =====
async function loadSupervisors() {
  const container = document.getElementById('supervisorsList');
  container.innerHTML = '<div class="empty-state"><div class="spinner"></div><p>جاري التحميل...</p></div>';
  try {
    const res = await fetch('/api/supervisors');
    if (!res.ok) return;
    const data = await res.json();
    if (data.length === 0) {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-users-cog"></i><p>لا يوجد مشرفين</p></div>';
      return;
    }
    container.innerHTML = data.map(s => {
      const color = getAvatarColor(s.name);
      const date = s.created_at ? new Date(s.created_at).toLocaleDateString('ar-EG') : '';
      return `<div class="card-item">
        <div class="card-avatar" style="background:${color}">${s.name.charAt(0)}</div>
        <div class="card-body"><h3>${s.name}</h3><p>${s.phone || ''} ${date ? '• ' + date : ''}</p></div>
      </div>`;
    }).join('');
  } catch (e) {
    container.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>خطأ في التحميل</p></div>';
  }
}

// ===== EXPORT =====
async function exportAttendance() {
  showLoading();
  try {
    const res = await fetch('/api/attendance/report');
    if (!res.ok) { showToast('خطأ في تحميل التقرير', 'error'); hideLoading(); return; }
    const records = await res.json();
    let csv = '﻿الاسم,الحالة,التاريخ,الوقت,المشرف\n';
    records.forEach(r => {
      const time = r.scan_time ? new Date(r.scan_time).toLocaleTimeString('ar-EG') : '';
      const dateStr = r.scan_time ? r.scan_time.split(' ')[0] : '';
      csv += `${r.employee_name},${r.status === 'present' ? 'حاضر' : 'غائب'},${dateStr},${time},${r.supervisor_name}\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `attendance_${formatDateISO(new Date())}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('تم تصدير التقرير', 'success');
  } catch (e) { showToast('خطأ', 'error'); }
  hideLoading();
}

// ===== UTILITIES =====
function getAvatarColor(name) {
  const colors = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#e84393','#00b894','#6c5ce7'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

// ===== INIT =====
async function init() {
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();
    if (data.authenticated) {
      state.supervisor = data.supervisor;
      showApp();
    }
  } catch (e) { /* not logged in */ }
}

document.addEventListener('DOMContentLoaded', init);

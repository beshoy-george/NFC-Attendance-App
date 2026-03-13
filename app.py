"""
NFC Attendance System - Backend
Excel-based database + pywebview standalone window
"""

from flask import Flask, jsonify, request, send_from_directory, session
from werkzeug.security import generate_password_hash, check_password_hash
from functools import wraps
from openpyxl import Workbook, load_workbook
import threading
import os
import sys
import re
import random
import base64
from urllib import parse, request as urlrequest, error as urlerror
from datetime import datetime, date, timedelta

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', 'nfc-attendance-secret-key-change-in-production')

# When running as a PyInstaller .exe, use the exe's directory for runtime files
# and the bundled _MEIPASS directory for static assets
if getattr(sys, 'frozen', False):
    RUN_DIR = os.path.dirname(sys.executable)
    BASE_DIR = sys._MEIPASS
else:
    RUN_DIR = os.path.dirname(os.path.abspath(__file__))
    BASE_DIR = RUN_DIR

EXCEL_PATH = os.path.join(RUN_DIR, 'attendance_data.xlsx')
_excel_lock = threading.Lock()
_otp_lock = threading.Lock()
OTP_STORE = {}

OTP_TTL_MINUTES = int(os.environ.get('OTP_TTL_MINUTES', '5'))
OTP_MAX_ATTEMPTS = int(os.environ.get('OTP_MAX_ATTEMPTS', '5'))


# ===== EXCEL DATABASE LAYER =====

def _init_excel():
    """Create the Excel file with proper sheets and headers if it doesn't exist."""
    if os.path.exists(EXCEL_PATH):
        return
    wb = Workbook()
    # Supervisors sheet
    ws_sup = wb.active
    ws_sup.title = 'Supervisors'
    ws_sup.append(['id', 'name', 'phone', 'password_hash', 'created_at'])
    # Employees sheet
    ws_emp = wb.create_sheet('Employees')
    ws_emp.append(['id', 'nfc_uid', 'name', 'birthdate', 'address', 'phone',
                   'email', 'department', 'parent_phone', 'confession_father',
                   'photo_url', 'created_at'])
    # Attendance sheet
    ws_att = wb.create_sheet('Attendance')
    ws_att.append(['id', 'employee_id', 'supervisor_id', 'scan_time', 'status', 'notes'])
    wb.save(EXCEL_PATH)


def _load_wb():
    return load_workbook(EXCEL_PATH)


def _next_id(ws):
    """Get next auto-increment ID for a sheet."""
    max_id = 0
    for row in ws.iter_rows(min_row=2, max_col=1, values_only=True):
        if row[0] is not None:
            try:
                max_id = max(max_id, int(row[0]))
            except (ValueError, TypeError):
                pass
    return max_id + 1


def _sheet_to_dicts(ws):
    """Convert a worksheet to a list of dicts using the header row as keys."""
    rows = list(ws.iter_rows(values_only=True))
    if len(rows) < 1:
        return []
    headers = [str(h) for h in rows[0]]
    result = []
    for row in rows[1:]:
        if row[0] is None:
            continue
        d = {}
        for i, h in enumerate(headers):
            val = row[i] if i < len(row) else None
            d[h] = val if val is not None else ''
        result.append(d)
    return result


def _find_row_by_id(ws, record_id):
    """Find row number (1-indexed) by ID in column 1. Returns None if not found."""
    for row_num in range(2, ws.max_row + 1):
        cell_val = ws.cell(row=row_num, column=1).value
        if cell_val is not None and int(cell_val) == int(record_id):
            return row_num
    return None


def _get_headers(ws):
    return [str(ws.cell(row=1, column=c).value) for c in range(1, ws.max_column + 1)]


def _row_to_dict(ws, row_num):
    headers = _get_headers(ws)
    d = {}
    for i, h in enumerate(headers):
        val = ws.cell(row=row_num, column=i + 1).value
        d[h] = val if val is not None else ''
    return d


# ===== INIT =====
_init_excel()


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'supervisor_id' not in session:
            return jsonify({'error': 'Authentication required'}), 401
        return f(*args, **kwargs)
    return decorated


def get_nearest_friday(d=None):
    if d is None:
        d = date.today()
    days_since_friday = (d.weekday() - 4) % 7
    return d - timedelta(days=days_since_friday)


def normalize_phone(phone):
    """Keep only digits to normalize phone numbers before comparison/storage."""
    return ''.join(ch for ch in str(phone) if ch.isdigit())


def is_valid_phone(phone):
    """Validate Egyptian mobile numbers (11 digits starting with 01)."""
    return bool(re.fullmatch(r"01\d{9}", phone))


def to_e164_eg(phone):
    """Convert local Egyptian mobile number to E.164 format for SMS providers."""
    normalized = normalize_phone(phone)
    if normalized.startswith('01') and len(normalized) == 11:
        return '+2' + normalized
    return normalized


def generate_otp_code():
    return f"{random.randint(0, 999999):06d}"


def cleanup_expired_otps():
    now = datetime.now()
    with _otp_lock:
        expired_phones = [p for p, data in OTP_STORE.items() if data['expires_at'] < now]
        for p in expired_phones:
            OTP_STORE.pop(p, None)


def send_sms_otp(phone, otp_code):
    """
    Send OTP via SMS.
    Modes:
    - SMS_MODE=twilio with TWILIO_* vars for real SMS
    - default simulated mode (no external dependency)
    """
    sms_mode = os.environ.get('SMS_MODE', 'simulated').strip().lower()
    if sms_mode != 'twilio':
        return {'sent': True, 'simulated': True, 'message': 'SIMULATED_SMS'}

    account_sid = os.environ.get('TWILIO_ACCOUNT_SID', '').strip()
    auth_token = os.environ.get('TWILIO_AUTH_TOKEN', '').strip()
    from_number = os.environ.get('TWILIO_FROM_NUMBER', '').strip()
    to_number = to_e164_eg(phone)
    if not account_sid or not auth_token or not from_number:
        return {'sent': False, 'simulated': False, 'error': 'Twilio credentials are not configured'}

    endpoint = f"https://api.twilio.com/2010-04-01/Accounts/{account_sid}/Messages.json"
    payload = parse.urlencode({
        'From': from_number,
        'To': to_number,
        'Body': f'Your OTP code is: {otp_code}. It expires in {OTP_TTL_MINUTES} minutes.'
    }).encode('utf-8')

    basic_auth = base64.b64encode(f"{account_sid}:{auth_token}".encode('utf-8')).decode('utf-8')
    req = urlrequest.Request(endpoint, data=payload, method='POST')
    req.add_header('Authorization', f'Basic {basic_auth}')
    req.add_header('Content-Type', 'application/x-www-form-urlencoded')

    try:
        with urlrequest.urlopen(req, timeout=15) as resp:
            if 200 <= resp.status < 300:
                return {'sent': True, 'simulated': False}
            return {'sent': False, 'simulated': False, 'error': f'SMS provider returned {resp.status}'}
    except urlerror.HTTPError as exc:
        return {'sent': False, 'simulated': False, 'error': f'SMS provider HTTP error {exc.code}'}
    except Exception as exc:
        return {'sent': False, 'simulated': False, 'error': str(exc)}


# ===== STATIC FILE SERVING =====

@app.route('/')
def serve_index():
    return send_from_directory(BASE_DIR, 'index.html')

@app.route('/css/<path:path>')
def serve_css(path):
    return send_from_directory(os.path.join(BASE_DIR, 'css'), path)

@app.route('/js/<path:path>')
def serve_js(path):
    return send_from_directory(os.path.join(BASE_DIR, 'js'), path)

@app.route('/manifest.json')
def serve_manifest():
    return send_from_directory(BASE_DIR, 'manifest.json')

@app.route('/sw.js')
def serve_sw():
    return send_from_directory(BASE_DIR, 'sw.js')


# ===== AUTH ENDPOINTS =====

@app.route('/api/auth/register', methods=['POST'])
def register():
    data = request.json
    name = data.get('name', '').strip()
    phone = normalize_phone(data.get('phone', '').strip())
    password = data.get('password', '')
    if not name or not phone or not password:
        return jsonify({'error': 'All fields required'}), 400
    if not is_valid_phone(phone):
        return jsonify({'error': 'Invalid phone number. Use 11 digits starting with 01'}), 400
    if len(password) < 4:
        return jsonify({'error': 'Password must be at least 4 characters'}), 400
    with _excel_lock:
        wb = _load_wb()
        ws = wb['Supervisors']
        # Check uniqueness
        for row in ws.iter_rows(min_row=2, values_only=True):
            if row[0] is not None and normalize_phone(row[2]) == phone:
                wb.close()
                return jsonify({'error': 'Phone already registered'}), 409
        new_id = _next_id(ws)
        ws.append([new_id, name, phone, generate_password_hash(password),
                   datetime.now().isoformat()])
        wb.save(EXCEL_PATH)
        wb.close()
    session['supervisor_id'] = new_id
    return jsonify({'message': 'OK', 'supervisor': {'id': new_id, 'name': name, 'phone': phone}}), 201


@app.route('/api/auth/login', methods=['POST'])
def login():
    data = request.json
    phone = normalize_phone(data.get('phone', '').strip())
    password = data.get('password', '')
    if not is_valid_phone(phone):
        return jsonify({'error': 'Invalid phone number'}), 400
    with _excel_lock:
        wb = _load_wb()
        ws = wb['Supervisors']
        supervisors = _sheet_to_dicts(ws)
        wb.close()
    supervisor = None
    for s in supervisors:
        if normalize_phone(s['phone']) == phone:
            supervisor = s
            break
    if not supervisor or not check_password_hash(supervisor['password_hash'], password):
        return jsonify({'error': 'Invalid credentials'}), 401
    session['supervisor_id'] = int(supervisor['id'])
    return jsonify({
        'message': 'OK',
        'supervisor': {'id': int(supervisor['id']), 'name': supervisor['name'], 'phone': supervisor['phone']}
    })


@app.route('/api/auth/forgot-password/request-otp', methods=['POST'])
def forgot_password_request_otp():
    data = request.json
    phone = normalize_phone(data.get('phone', '').strip())
    if not phone:
        return jsonify({'error': 'Phone is required'}), 400
    if not is_valid_phone(phone):
        return jsonify({'error': 'Invalid phone number. Use 11 digits starting with 01'}), 400

    cleanup_expired_otps()

    # Check phone exists
    with _excel_lock:
        wb = _load_wb()
        ws = wb['Supervisors']
        phone_exists = False
        for row_num in range(2, ws.max_row + 1):
            row_phone = normalize_phone(ws.cell(row=row_num, column=3).value)
            if row_phone == phone:
                phone_exists = True
                break
        wb.close()

    if not phone_exists:
        return jsonify({'error': 'Phone number not found'}), 404

    otp_code = generate_otp_code()
    expires_at = datetime.now() + timedelta(minutes=OTP_TTL_MINUTES)
    with _otp_lock:
        OTP_STORE[phone] = {
            'otp_code': otp_code,
            'expires_at': expires_at,
            'attempts': 0
        }

    sms_result = send_sms_otp(phone, otp_code)
    if not sms_result.get('sent'):
        return jsonify({'error': sms_result.get('error', 'Failed to send OTP')}), 500

    response = {
        'message': f'OTP has been sent. It expires in {OTP_TTL_MINUTES} minutes.'
    }
    if sms_result.get('simulated'):
        # Dev/testing mode only; real SMS mode never exposes OTP in API response.
        response['simulated'] = True
        response['otp_preview'] = otp_code

    return jsonify(response)


@app.route('/api/auth/forgot-password/verify-otp', methods=['POST'])
def forgot_password_verify_otp():
    data = request.json
    phone = normalize_phone(data.get('phone', '').strip())
    otp_code = str(data.get('otp_code', '')).strip()
    new_password = data.get('new_password', '')

    if not phone or not otp_code or not new_password:
        return jsonify({'error': 'Phone, OTP, and new password are required'}), 400
    if not is_valid_phone(phone):
        return jsonify({'error': 'Invalid phone number. Use 11 digits starting with 01'}), 400
    if not re.fullmatch(r'\d{6}', otp_code):
        return jsonify({'error': 'OTP must be 6 digits'}), 400
    if len(new_password) < 4:
        return jsonify({'error': 'Password must be at least 4 characters'}), 400

    cleanup_expired_otps()

    with _otp_lock:
        otp_data = OTP_STORE.get(phone)
        if not otp_data:
            return jsonify({'error': 'OTP not found or expired. Request a new code.'}), 400
        if otp_data['attempts'] >= OTP_MAX_ATTEMPTS:
            OTP_STORE.pop(phone, None)
            return jsonify({'error': 'Too many attempts. Request a new OTP.'}), 429
        if otp_data['otp_code'] != otp_code:
            otp_data['attempts'] += 1
            return jsonify({'error': 'Invalid OTP code'}), 400

    with _excel_lock:
        wb = _load_wb()
        ws = wb['Supervisors']
        target_row = None
        for row_num in range(2, ws.max_row + 1):
            row_phone = normalize_phone(ws.cell(row=row_num, column=3).value)
            if row_phone == phone:
                target_row = row_num
                break
        if not target_row:
            wb.close()
            with _otp_lock:
                OTP_STORE.pop(phone, None)
            return jsonify({'error': 'Phone number not found'}), 404

        ws.cell(row=target_row, column=4, value=generate_password_hash(new_password))
        wb.save(EXCEL_PATH)
        wb.close()

    with _otp_lock:
        OTP_STORE.pop(phone, None)

    return jsonify({'message': 'Password has been reset successfully'})


@app.route('/api/auth/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({'message': 'OK'})


@app.route('/api/auth/me', methods=['GET'])
def auth_me():
    if 'supervisor_id' not in session:
        return jsonify({'authenticated': False}), 401
    with _excel_lock:
        wb = _load_wb()
        ws = wb['Supervisors']
        supervisors = _sheet_to_dicts(ws)
        wb.close()
    supervisor = None
    for s in supervisors:
        if int(s['id']) == session['supervisor_id']:
            supervisor = s
            break
    if not supervisor:
        session.clear()
        return jsonify({'authenticated': False}), 401
    return jsonify({'authenticated': True, 'supervisor': {
        'id': int(supervisor['id']), 'name': supervisor['name'], 'phone': supervisor['phone']
    }})


@app.route('/api/supervisors', methods=['GET'])
@login_required
def list_supervisors():
    with _excel_lock:
        wb = _load_wb()
        ws = wb['Supervisors']
        supervisors = _sheet_to_dicts(ws)
        wb.close()
    result = sorted([{
        'id': int(s['id']), 'name': s['name'], 'phone': s['phone'],
        'created_at': s.get('created_at', '')
    } for s in supervisors], key=lambda x: x['name'])
    return jsonify(result)


# ===== NFC SCAN =====

@app.route('/api/nfc/scan', methods=['POST'])
@login_required
def nfc_scan():
    data = request.json
    nfc_uid = data.get('nfc_uid', '').strip().upper()
    scan_date = data.get('date', date.today().isoformat())
    if not nfc_uid:
        return jsonify({'error': 'NFC UID required'}), 400
    with _excel_lock:
        wb = _load_wb()
        ws_emp = wb['Employees']
        employees = _sheet_to_dicts(ws_emp)
        employee = None
        for e in employees:
            if str(e['nfc_uid']).upper() == nfc_uid:
                employee = e
                break
        if not employee:
            wb.close()
            return jsonify({'status': 'unknown', 'nfc_uid': nfc_uid, 'message': 'Unknown card'})
        # Check if already scanned today
        ws_att = wb['Attendance']
        attendance = _sheet_to_dicts(ws_att)
        day_start = scan_date + ' 00:00:00'
        day_end = scan_date + ' 23:59:59'
        existing = None
        for a in attendance:
            if (int(a['employee_id']) == int(employee['id']) and
                    str(a['scan_time']) >= day_start and str(a['scan_time']) <= day_end):
                existing = a
                break
        if existing:
            wb.close()
            emp_dict = {k: (int(v) if k == 'id' else v) for k, v in employee.items()}
            return jsonify({
                'status': 'already_scanned', 'employee': emp_dict,
                'scan_time': existing['scan_time'],
                'message': employee['name'] + ' already scanned'
            })
        # Record attendance
        now_time = datetime.now().strftime('%H:%M:%S')
        record_time = scan_date + ' ' + now_time
        new_id = _next_id(ws_att)
        ws_att.append([new_id, int(employee['id']), session['supervisor_id'], record_time, 'present', ''])
        wb.save(EXCEL_PATH)
        wb.close()
    emp_dict = {k: (int(v) if k == 'id' else v) for k, v in employee.items()}
    return jsonify({
        'status': 'recorded', 'employee': emp_dict,
        'scan_time': record_time, 'message': 'Recorded ' + employee['name']
    })


@app.route('/api/attendance/manual', methods=['POST'])
@login_required
def manual_attendance():
    data = request.json
    employee_id = data.get('employee_id')
    status = data.get('status', 'present')
    notes = data.get('notes', '')
    record_date = data.get('date', date.today().isoformat())
    if not employee_id:
        return jsonify({'error': 'Employee ID required'}), 400
    employee_id = int(employee_id)
    with _excel_lock:
        wb = _load_wb()
        ws_att = wb['Attendance']
        attendance = _sheet_to_dicts(ws_att)
        day_start = record_date + ' 00:00:00'
        day_end = record_date + ' 23:59:59'
        existing = None
        for a in attendance:
            if (int(a['employee_id']) == employee_id and
                    str(a['scan_time']) >= day_start and str(a['scan_time']) <= day_end):
                existing = a
                break
        now_time = datetime.now().strftime('%H:%M:%S')
        record_time = record_date + ' ' + now_time
        if existing:
            row_num = _find_row_by_id(ws_att, existing['id'])
            if row_num:
                headers = _get_headers(ws_att)
                ws_att.cell(row=row_num, column=headers.index('status') + 1, value=status)
                ws_att.cell(row=row_num, column=headers.index('notes') + 1, value=notes)
                ws_att.cell(row=row_num, column=headers.index('supervisor_id') + 1, value=session['supervisor_id'])
        else:
            new_id = _next_id(ws_att)
            ws_att.append([new_id, employee_id, session['supervisor_id'], record_time, status, notes])
        wb.save(EXCEL_PATH)
        wb.close()
    return jsonify({'message': 'OK', 'status': status})


# ===== EMPLOYEE ENDPOINTS =====

@app.route('/api/employees', methods=['GET'])
@login_required
def list_employees():
    with _excel_lock:
        wb = _load_wb()
        ws = wb['Employees']
        employees = _sheet_to_dicts(ws)
        wb.close()
    for e in employees:
        e['id'] = int(e['id'])
    employees.sort(key=lambda x: x['name'])
    return jsonify(employees)


@app.route('/api/employees', methods=['POST'])
@login_required
def create_employee():
    data = request.json
    nfc_uid = data.get('nfc_uid', '').strip().upper()
    name = data.get('name', '').strip()
    if not nfc_uid or not name:
        return jsonify({'error': 'NFC UID and name required'}), 400
    with _excel_lock:
        wb = _load_wb()
        ws = wb['Employees']
        # Check uniqueness
        for row in ws.iter_rows(min_row=2, values_only=True):
            if row[0] is not None and str(row[1]).upper() == nfc_uid:
                wb.close()
                return jsonify({'error': 'NFC UID already registered'}), 409
        new_id = _next_id(ws)
        ws.append([new_id, nfc_uid, name, data.get('birthdate', ''),
                   data.get('address', ''), data.get('phone', ''),
                   data.get('email', ''), data.get('class_name', ''),
                   data.get('parent_phone', ''), data.get('confession_father', ''),
                   '', datetime.now().isoformat()])
        wb.save(EXCEL_PATH)
        # Read back the employee
        employee = _row_to_dict(ws, ws.max_row)
        employee['id'] = int(employee['id'])
        wb.close()
    return jsonify({'message': 'OK', 'employee': employee}), 201


@app.route('/api/employees/<int:emp_id>', methods=['GET'])
@login_required
def get_employee(emp_id):
    with _excel_lock:
        wb = _load_wb()
        ws_emp = wb['Employees']
        row_num = _find_row_by_id(ws_emp, emp_id)
        if not row_num:
            wb.close()
            return jsonify({'error': 'Not found'}), 404
        employee = _row_to_dict(ws_emp, row_num)
        employee['id'] = int(employee['id'])
        # Get attendance records
        ws_att = wb['Attendance']
        all_att = _sheet_to_dicts(ws_att)
        ws_sup = wb['Supervisors']
        all_sup = _sheet_to_dicts(ws_sup)
        wb.close()
    sup_map = {int(s['id']): s['name'] for s in all_sup}
    attendance = []
    for a in all_att:
        if int(a['employee_id']) == emp_id:
            rec = dict(a)
            rec['id'] = int(rec['id'])
            rec['employee_id'] = int(rec['employee_id'])
            rec['supervisor_id'] = int(rec['supervisor_id'])
            rec['supervisor_name'] = sup_map.get(int(a['supervisor_id']), '')
            attendance.append(rec)
    attendance.sort(key=lambda x: str(x['scan_time']), reverse=True)
    total_records = len(attendance)
    present_count = sum(1 for a in attendance if a['status'] == 'present')
    absent_count = sum(1 for a in attendance if a['status'] == 'absent')
    # Weekly analytics: last 12 Fridays
    weekly = []
    today = date.today()
    for i in range(12):
        friday = get_nearest_friday(today - timedelta(weeks=i))
        fri_start = friday.isoformat() + ' 00:00:00'
        fri_end = friday.isoformat() + ' 23:59:59'
        record = None
        for a in attendance:
            if fri_start <= str(a['scan_time']) <= fri_end:
                record = a
                break
        weekly.append({
            'date': friday.isoformat(),
            'status': record['status'] if record else 'absent'
        })
    return jsonify({
        'employee': employee,
        'attendance': attendance,
        'stats': {
            'total_records': total_records, 'present': present_count, 'absent': absent_count,
            'rate': round((present_count / total_records * 100) if total_records > 0 else 0, 1)
        },
        'weekly': weekly
    })


@app.route('/api/employees/<int:emp_id>', methods=['PUT'])
@login_required
def update_employee(emp_id):
    data = request.json
    with _excel_lock:
        wb = _load_wb()
        ws = wb['Employees']
        row_num = _find_row_by_id(ws, emp_id)
        if not row_num:
            wb.close()
            return jsonify({'error': 'Not found'}), 404
        headers = _get_headers(ws)
        old = _row_to_dict(ws, row_num)
        field_map = {
            'name': data.get('name', old['name']),
            'birthdate': data.get('birthdate', old['birthdate']),
            'address': data.get('address', old['address']),
            'phone': data.get('phone', old['phone']),
            'parent_phone': data.get('parent_phone', old['parent_phone']),
            'confession_father': data.get('confession_father', old['confession_father']),
            'department': data.get('class_name', old['department']),
        }
        for field, value in field_map.items():
            if field in headers:
                ws.cell(row=row_num, column=headers.index(field) + 1, value=value)
        wb.save(EXCEL_PATH)
        updated = _row_to_dict(ws, row_num)
        updated['id'] = int(updated['id'])
        wb.close()
    return jsonify({'message': 'OK', 'employee': updated})


@app.route('/api/employees/<int:emp_id>', methods=['DELETE'])
@login_required
def delete_employee(emp_id):
    with _excel_lock:
        wb = _load_wb()
        # Delete attendance records
        ws_att = wb['Attendance']
        rows_to_delete = []
        for row_num in range(2, ws_att.max_row + 1):
            val = ws_att.cell(row=row_num, column=2).value
            if val is not None and int(val) == emp_id:
                rows_to_delete.append(row_num)
        for row_num in reversed(rows_to_delete):
            ws_att.delete_rows(row_num)
        # Delete employee
        ws_emp = wb['Employees']
        emp_row = _find_row_by_id(ws_emp, emp_id)
        if emp_row:
            ws_emp.delete_rows(emp_row)
        wb.save(EXCEL_PATH)
        wb.close()
    return jsonify({'message': 'OK'})


# ===== DASHBOARD =====

@app.route('/api/dashboard', methods=['GET'])
@login_required
def dashboard():
    target_date = request.args.get('date', date.today().isoformat())
    with _excel_lock:
        wb = _load_wb()
        employees = _sheet_to_dicts(wb['Employees'])
        attendance = _sheet_to_dicts(wb['Attendance'])
        supervisors = _sheet_to_dicts(wb['Supervisors'])
        wb.close()
    total_employees = len(employees)
    total_supervisors = len(supervisors)
    day_start = target_date + ' 00:00:00'
    day_end = target_date + ' 23:59:59'
    day_records = [a for a in attendance if day_start <= str(a['scan_time']) <= day_end]
    today_present = sum(1 for a in day_records if a['status'] == 'present')
    today_absent = sum(1 for a in day_records if a['status'] == 'absent')
    emp_map = {int(e['id']): e['name'] for e in employees}
    sup_map = {int(s['id']): s['name'] for s in supervisors}
    recent = []
    for a in sorted(day_records, key=lambda x: str(x['scan_time']), reverse=True)[:20]:
        recent.append({
            'employee_id': int(a['employee_id']),
            'employee_name': emp_map.get(int(a['employee_id']), ''),
            'nfc_uid': next((e.get('nfc_uid', '') for e in employees if int(e['id']) == int(a['employee_id'])), ''),
            'supervisor_name': sup_map.get(int(a['supervisor_id']), ''),
            'scan_time': a['scan_time'], 'status': a['status']
        })
    return jsonify({
        'total_employees': total_employees, 'today_present': today_present,
        'today_absent': today_absent,
        'today_not_scanned': max(0, total_employees - today_present - today_absent),
        'total_supervisors': total_supervisors,
        'recent_scans': recent, 'date': target_date
    })


# ===== ATTENDANCE BY DATE =====

@app.route('/api/attendance/date', methods=['GET'])
@login_required
def attendance_by_date():
    target_date = request.args.get('date', date.today().isoformat())
    with _excel_lock:
        wb = _load_wb()
        employees = _sheet_to_dicts(wb['Employees'])
        attendance = _sheet_to_dicts(wb['Attendance'])
        supervisors = _sheet_to_dicts(wb['Supervisors'])
        wb.close()
    day_start = target_date + ' 00:00:00'
    day_end = target_date + ' 23:59:59'
    sup_map = {int(s['id']): s['name'] for s in supervisors}
    result = []
    for emp in sorted(employees, key=lambda x: x['name']):
        record = None
        for a in attendance:
            if (int(a['employee_id']) == int(emp['id']) and
                    day_start <= str(a['scan_time']) <= day_end):
                record = a
                break
        emp_dict = dict(emp)
        emp_dict['id'] = int(emp_dict['id'])
        result.append({
            'employee': emp_dict,
            'status': record['status'] if record else 'not_scanned',
            'scan_time': record['scan_time'] if record else None,
            'supervisor': sup_map.get(int(record['supervisor_id']), '') if record else None
        })
    return jsonify(result)


@app.route('/api/attendance/today', methods=['GET'])
@login_required
def today_attendance():
    with _excel_lock:
        wb = _load_wb()
        employees = _sheet_to_dicts(wb['Employees'])
        attendance = _sheet_to_dicts(wb['Attendance'])
        supervisors = _sheet_to_dicts(wb['Supervisors'])
        wb.close()
    today_str = date.today().isoformat()
    day_start = today_str + ' 00:00:00'
    day_end = today_str + ' 23:59:59'
    sup_map = {int(s['id']): s['name'] for s in supervisors}
    result = []
    for emp in sorted(employees, key=lambda x: x['name']):
        record = None
        for a in attendance:
            if (int(a['employee_id']) == int(emp['id']) and
                    day_start <= str(a['scan_time']) <= day_end):
                record = a
                break
        emp_dict = dict(emp)
        emp_dict['id'] = int(emp_dict['id'])
        result.append({
            'employee': emp_dict,
            'status': record['status'] if record else 'not_scanned',
            'scan_time': record['scan_time'] if record else None,
            'supervisor': sup_map.get(int(record['supervisor_id']), '') if record else None
        })
    return jsonify(result)


# ===== ANALYTICS =====

@app.route('/api/analytics', methods=['GET'])
@login_required
def analytics():
    weeks = int(request.args.get('weeks', 12))
    with _excel_lock:
        wb = _load_wb()
        employees = _sheet_to_dicts(wb['Employees'])
        attendance = _sheet_to_dicts(wb['Attendance'])
        wb.close()
    total_employees = len(employees)
    # Weekly attendance trend
    weekly_trend = []
    today = date.today()
    for i in range(weeks):
        friday = get_nearest_friday(today - timedelta(weeks=i))
        fri_start = friday.isoformat() + ' 00:00:00'
        fri_end = friday.isoformat() + ' 23:59:59'
        day_records = [a for a in attendance if fri_start <= str(a['scan_time']) <= fri_end]
        present = sum(1 for a in day_records if a['status'] == 'present')
        absent = sum(1 for a in day_records if a['status'] == 'absent')
        weekly_trend.append({
            'date': friday.isoformat(), 'present': present, 'absent': absent, 'total': total_employees
        })
    # Per-attendee stats
    attendee_stats = []
    for emp in employees:
        emp_att = [a for a in attendance if int(a['employee_id']) == int(emp['id'])]
        present = sum(1 for a in emp_att if a['status'] == 'present')
        total = len(emp_att)
        rate = round((present / total * 100) if total > 0 else 0, 1)
        attendee_stats.append({
            'id': int(emp['id']), 'name': emp['name'], 'class_name': emp.get('department', ''),
            'present': present, 'total': total, 'rate': rate
        })
    attendee_stats.sort(key=lambda x: x['rate'], reverse=True)
    # Class breakdown
    classes = {}
    for emp in employees:
        cls = emp.get('department', '') or 'Other'
        if cls not in classes:
            classes[cls] = {'name': cls, 'count': 0, 'total_present': 0, 'total_records': 0}
        classes[cls]['count'] += 1
        emp_att = [a for a in attendance if int(a['employee_id']) == int(emp['id'])]
        present = sum(1 for a in emp_att if a['status'] == 'present')
        classes[cls]['total_present'] += present
        classes[cls]['total_records'] += len(emp_att)
    class_stats = []
    for cls_data in classes.values():
        rate = round((cls_data['total_present'] / cls_data['total_records'] * 100) if cls_data['total_records'] > 0 else 0, 1)
        class_stats.append({**cls_data, 'rate': rate})
    # Overall
    total_attendance = len(attendance)
    total_present = sum(1 for a in attendance if a['status'] == 'present')
    overall_rate = round((total_present / total_attendance * 100) if total_attendance > 0 else 0, 1)
    return jsonify({
        'total_employees': total_employees, 'overall_rate': overall_rate,
        'total_attendance_records': total_attendance, 'total_present': total_present,
        'weekly_trend': weekly_trend, 'attendee_stats': attendee_stats, 'class_stats': class_stats
    })


@app.route('/api/attendance/report', methods=['GET'])
@login_required
def attendance_report():
    start_date = request.args.get('start', (date.today() - timedelta(days=90)).isoformat())
    end_date = request.args.get('end', date.today().isoformat())
    with _excel_lock:
        wb = _load_wb()
        attendance = _sheet_to_dicts(wb['Attendance'])
        employees = _sheet_to_dicts(wb['Employees'])
        supervisors = _sheet_to_dicts(wb['Supervisors'])
        wb.close()
    emp_map = {int(e['id']): e for e in employees}
    sup_map = {int(s['id']): s['name'] for s in supervisors}
    records = []
    for a in attendance:
        scan_date_str = str(a['scan_time']).split(' ')[0] if a['scan_time'] else ''
        if start_date <= scan_date_str <= end_date:
            emp = emp_map.get(int(a['employee_id']), {})
            records.append({
                'id': int(a['id']), 'employee_id': int(a['employee_id']),
                'supervisor_id': int(a['supervisor_id']),
                'scan_time': a['scan_time'], 'status': a['status'],
                'notes': a.get('notes', ''),
                'employee_name': emp.get('name', ''),
                'nfc_uid': emp.get('nfc_uid', ''),
                'supervisor_name': sup_map.get(int(a['supervisor_id']), '')
            })
    records.sort(key=lambda x: str(x['scan_time']), reverse=True)
    return jsonify(records)


# ===== MAIN =====

if __name__ == '__main__':
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        local_ip = s.getsockname()[0]
    except Exception:
        local_ip = '0.0.0.0'
    finally:
        s.close()

    cert_file = os.path.join(RUN_DIR, 'cert.pem')
    key_file = os.path.join(RUN_DIR, 'key.pem')
    if not os.path.exists(cert_file) or not os.path.exists(key_file):
        from OpenSSL import crypto
        k = crypto.PKey()
        k.generate_key(crypto.TYPE_RSA, 2048)
        cert = crypto.X509()
        cert.get_subject().CN = local_ip
        cert.set_serial_number(1000)
        cert.gmtime_adj_notBefore(0)
        cert.gmtime_adj_notAfter(365 * 24 * 60 * 60)
        cert.set_issuer(cert.get_subject())
        cert.set_pubkey(k)
        cert.sign(k, 'sha256')
        with open(cert_file, 'wb') as f:
            f.write(crypto.dump_certificate(crypto.FILETYPE_PEM, cert))
        with open(key_file, 'wb') as f:
            f.write(crypto.dump_privatekey(crypto.FILETYPE_PEM, k))

    print("=" * 50)
    print("  NFC Attendance System")
    print("=" * 50)
    print(f"  Phone:   https://{local_ip}:5000")
    print("=" * 50)

    # Start Flask in a background thread
    flask_thread = threading.Thread(
        target=lambda: app.run(
            host='0.0.0.0', port=5000, debug=False,
            ssl_context=(cert_file, key_file),
            use_reloader=False
        ),
        daemon=True
    )
    flask_thread.start()

    # Open pywebview standalone window (desktop app)
    import webview
    webview.create_window(
        'خدمة اعدادي - NFC Attendance',
        'https://localhost:5000',
        width=420, height=780,
        resizable=True,
        min_size=(360, 600)
    )
    webview.start(ssl=True)

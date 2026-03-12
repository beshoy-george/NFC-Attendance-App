"""
NFC Attendance System - Backend
"""

from flask import Flask, jsonify, request, send_from_directory, session
from werkzeug.security import generate_password_hash, check_password_hash
from functools import wraps
import sqlite3
import os
from datetime import datetime, date, timedelta

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', 'nfc-attendance-secret-key-change-in-production')

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, 'attendance.db')


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    conn = get_db()
    cursor = conn.cursor()
    cursor.executescript('''
        CREATE TABLE IF NOT EXISTS supervisors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS employees (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nfc_uid TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            birthdate TEXT,
            address TEXT,
            phone TEXT,
            email TEXT,
            department TEXT,
            parent_phone TEXT,
            confession_father TEXT,
            photo_url TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS attendance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_id INTEGER NOT NULL,
            supervisor_id INTEGER NOT NULL,
            scan_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            status TEXT NOT NULL DEFAULT 'present',
            notes TEXT,
            FOREIGN KEY (employee_id) REFERENCES employees(id),
            FOREIGN KEY (supervisor_id) REFERENCES supervisors(id)
        );
        CREATE INDEX IF NOT EXISTS idx_attendance_employee ON attendance(employee_id);
        CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(scan_time);
        CREATE INDEX IF NOT EXISTS idx_employees_nfc ON employees(nfc_uid);
    ''')
    # Migration: add new columns if they don't exist
    existing_cols = [row['name'] for row in conn.execute("PRAGMA table_info(employees)").fetchall()]
    if 'parent_phone' not in existing_cols:
        conn.execute("ALTER TABLE employees ADD COLUMN parent_phone TEXT")
    if 'confession_father' not in existing_cols:
        conn.execute("ALTER TABLE employees ADD COLUMN confession_father TEXT")
    # Migration: supervisors email -> phone
    sup_cols = [row['name'] for row in conn.execute("PRAGMA table_info(supervisors)").fetchall()]
    if 'phone' not in sup_cols and 'email' in sup_cols:
        conn.execute("ALTER TABLE supervisors RENAME COLUMN email TO phone")
    conn.commit()
    conn.close()


init_db()


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


# STATIC FILE SERVING

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


# AUTH ENDPOINTS

@app.route('/api/auth/register', methods=['POST'])
def register():
    data = request.json
    name = data.get('name', '').strip()
    phone = data.get('phone', '').strip()
    password = data.get('password', '')
    if not name or not phone or not password:
        return jsonify({'error': 'All fields required'}), 400
    if len(password) < 4:
        return jsonify({'error': 'Password must be at least 4 characters'}), 400
    conn = get_db()
    try:
        conn.execute(
            'INSERT INTO supervisors (name, phone, password_hash) VALUES (?, ?, ?)',
            (name, phone, generate_password_hash(password))
        )
        conn.commit()
        supervisor = conn.execute(
            'SELECT id, name, phone FROM supervisors WHERE phone = ?', (phone,)
        ).fetchone()
        session['supervisor_id'] = supervisor['id']
        return jsonify({'message': 'OK', 'supervisor': dict(supervisor)}), 201
    except sqlite3.IntegrityError:
        return jsonify({'error': 'Phone already registered'}), 409
    finally:
        conn.close()


@app.route('/api/auth/login', methods=['POST'])
def login():
    data = request.json
    phone = data.get('phone', '').strip()
    password = data.get('password', '')
    conn = get_db()
    supervisor = conn.execute('SELECT * FROM supervisors WHERE phone = ?', (phone,)).fetchone()
    conn.close()
    if not supervisor or not check_password_hash(supervisor['password_hash'], password):
        return jsonify({'error': 'Invalid credentials'}), 401
    session['supervisor_id'] = supervisor['id']
    return jsonify({
        'message': 'OK',
        'supervisor': {'id': supervisor['id'], 'name': supervisor['name'], 'phone': supervisor['phone']}
    })


@app.route('/api/auth/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({'message': 'OK'})


@app.route('/api/auth/me', methods=['GET'])
def auth_me():
    if 'supervisor_id' not in session:
        return jsonify({'authenticated': False}), 401
    conn = get_db()
    supervisor = conn.execute(
        'SELECT id, name, phone FROM supervisors WHERE id = ?', (session['supervisor_id'],)
    ).fetchone()
    conn.close()
    if not supervisor:
        session.clear()
        return jsonify({'authenticated': False}), 401
    return jsonify({'authenticated': True, 'supervisor': dict(supervisor)})


@app.route('/api/supervisors', methods=['GET'])
@login_required
def list_supervisors():
    conn = get_db()
    supervisors = conn.execute('SELECT id, name, phone, created_at FROM supervisors ORDER BY name').fetchall()
    conn.close()
    return jsonify([dict(s) for s in supervisors])


# NFC SCAN

@app.route('/api/nfc/scan', methods=['POST'])
@login_required
def nfc_scan():
    data = request.json
    nfc_uid = data.get('nfc_uid', '').strip().upper()
    scan_date = data.get('date', date.today().isoformat())
    if not nfc_uid:
        return jsonify({'error': 'NFC UID required'}), 400
    conn = get_db()
    employee = conn.execute('SELECT * FROM employees WHERE nfc_uid = ?', (nfc_uid,)).fetchone()
    if not employee:
        conn.close()
        return jsonify({'status': 'unknown', 'nfc_uid': nfc_uid, 'message': 'Unknown card'})
    day_start = scan_date + ' 00:00:00'
    day_end = scan_date + ' 23:59:59'
    existing = conn.execute(
        'SELECT * FROM attendance WHERE employee_id = ? AND scan_time BETWEEN ? AND ?',
        (employee['id'], day_start, day_end)
    ).fetchone()
    if existing:
        conn.close()
        return jsonify({
            'status': 'already_scanned', 'employee': dict(employee),
            'scan_time': existing['scan_time'],
            'message': employee['name'] + ' already scanned'
        })
    now_time = datetime.now().strftime('%H:%M:%S')
    record_time = scan_date + ' ' + now_time
    conn.execute(
        'INSERT INTO attendance (employee_id, supervisor_id, scan_time, status) VALUES (?, ?, ?, ?)',
        (employee['id'], session['supervisor_id'], record_time, 'present')
    )
    conn.commit()
    conn.close()
    return jsonify({
        'status': 'recorded', 'employee': dict(employee),
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
    conn = get_db()
    day_start = record_date + ' 00:00:00'
    day_end = record_date + ' 23:59:59'
    existing = conn.execute(
        'SELECT id FROM attendance WHERE employee_id = ? AND scan_time BETWEEN ? AND ?',
        (employee_id, day_start, day_end)
    ).fetchone()
    now_time = datetime.now().strftime('%H:%M:%S')
    record_time = record_date + ' ' + now_time
    if existing:
        conn.execute(
            'UPDATE attendance SET status = ?, notes = ?, supervisor_id = ? WHERE id = ?',
            (status, notes, session['supervisor_id'], existing['id'])
        )
    else:
        conn.execute(
            'INSERT INTO attendance (employee_id, supervisor_id, scan_time, status, notes) VALUES (?, ?, ?, ?, ?)',
            (employee_id, session['supervisor_id'], record_time, status, notes)
        )
    conn.commit()
    conn.close()
    return jsonify({'message': 'OK', 'status': status})


# EMPLOYEE ENDPOINTS

@app.route('/api/employees', methods=['GET'])
@login_required
def list_employees():
    conn = get_db()
    employees = conn.execute('SELECT * FROM employees ORDER BY name').fetchall()
    conn.close()
    return jsonify([dict(e) for e in employees])


@app.route('/api/employees', methods=['POST'])
@login_required
def create_employee():
    data = request.json
    nfc_uid = data.get('nfc_uid', '').strip().upper()
    name = data.get('name', '').strip()
    if not nfc_uid or not name:
        return jsonify({'error': 'NFC UID and name required'}), 400
    conn = get_db()
    try:
        cursor = conn.execute(
            'INSERT INTO employees (nfc_uid, name, birthdate, address, phone, parent_phone, confession_father, department) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            (nfc_uid, name, data.get('birthdate', ''), data.get('address', ''),
             data.get('phone', ''), data.get('parent_phone', ''),
             data.get('confession_father', ''), data.get('class_name', ''))
        )
        conn.commit()
        employee = conn.execute('SELECT * FROM employees WHERE id = ?', (cursor.lastrowid,)).fetchone()
        conn.close()
        return jsonify({'message': 'OK', 'employee': dict(employee)}), 201
    except sqlite3.IntegrityError:
        conn.close()
        return jsonify({'error': 'NFC UID already registered'}), 409


@app.route('/api/employees/<int:emp_id>', methods=['GET'])
@login_required
def get_employee(emp_id):
    conn = get_db()
    employee = conn.execute('SELECT * FROM employees WHERE id = ?', (emp_id,)).fetchone()
    if not employee:
        conn.close()
        return jsonify({'error': 'Not found'}), 404
    attendance = conn.execute(
        'SELECT a.*, s.name as supervisor_name FROM attendance a '
        'JOIN supervisors s ON a.supervisor_id = s.id '
        'WHERE a.employee_id = ? ORDER BY a.scan_time DESC', (emp_id,)
    ).fetchall()
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
        record = conn.execute(
            'SELECT status FROM attendance WHERE employee_id = ? AND scan_time BETWEEN ? AND ?',
            (emp_id, fri_start, fri_end)
        ).fetchone()
        weekly.append({
            'date': friday.isoformat(),
            'status': record['status'] if record else 'absent'
        })
    conn.close()
    return jsonify({
        'employee': dict(employee),
        'attendance': [dict(a) for a in attendance],
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
    conn = get_db()
    employee = conn.execute('SELECT * FROM employees WHERE id = ?', (emp_id,)).fetchone()
    if not employee:
        conn.close()
        return jsonify({'error': 'Not found'}), 404
    conn.execute(
        'UPDATE employees SET name=?, birthdate=?, address=?, phone=?, parent_phone=?, confession_father=?, department=? WHERE id=?',
        (data.get('name', employee['name']), data.get('birthdate', employee['birthdate']),
         data.get('address', employee['address']), data.get('phone', employee['phone']),
         data.get('parent_phone', employee['parent_phone']),
         data.get('confession_father', employee['confession_father']),
         data.get('class_name', employee['department']), emp_id)
    )
    conn.commit()
    updated = conn.execute('SELECT * FROM employees WHERE id = ?', (emp_id,)).fetchone()
    conn.close()
    return jsonify({'message': 'OK', 'employee': dict(updated)})


@app.route('/api/employees/<int:emp_id>', methods=['DELETE'])
@login_required
def delete_employee(emp_id):
    conn = get_db()
    conn.execute('DELETE FROM attendance WHERE employee_id = ?', (emp_id,))
    conn.execute('DELETE FROM employees WHERE id = ?', (emp_id,))
    conn.commit()
    conn.close()
    return jsonify({'message': 'OK'})


# DASHBOARD

@app.route('/api/dashboard', methods=['GET'])
@login_required
def dashboard():
    target_date = request.args.get('date', date.today().isoformat())
    conn = get_db()
    total_employees = conn.execute('SELECT COUNT(*) as c FROM employees').fetchone()['c']
    day_start = target_date + ' 00:00:00'
    day_end = target_date + ' 23:59:59'
    today_present = conn.execute(
        "SELECT COUNT(*) as c FROM attendance WHERE scan_time BETWEEN ? AND ? AND status = 'present'",
        (day_start, day_end)
    ).fetchone()['c']
    today_absent = conn.execute(
        "SELECT COUNT(*) as c FROM attendance WHERE scan_time BETWEEN ? AND ? AND status = 'absent'",
        (day_start, day_end)
    ).fetchone()['c']
    recent = conn.execute(
        'SELECT a.*, e.name as employee_name, e.nfc_uid, s.name as supervisor_name '
        'FROM attendance a JOIN employees e ON a.employee_id = e.id '
        'JOIN supervisors s ON a.supervisor_id = s.id '
        'WHERE a.scan_time BETWEEN ? AND ? '
        'ORDER BY a.scan_time DESC LIMIT 20', (day_start, day_end)
    ).fetchall()
    total_supervisors = conn.execute('SELECT COUNT(*) as c FROM supervisors').fetchone()['c']
    conn.close()
    return jsonify({
        'total_employees': total_employees, 'today_present': today_present,
        'today_absent': today_absent,
        'today_not_scanned': max(0, total_employees - today_present - today_absent),
        'total_supervisors': total_supervisors,
        'recent_scans': [dict(r) for r in recent], 'date': target_date
    })


# ATTENDANCE BY DATE

@app.route('/api/attendance/date', methods=['GET'])
@login_required
def attendance_by_date():
    target_date = request.args.get('date', date.today().isoformat())
    conn = get_db()
    day_start = target_date + ' 00:00:00'
    day_end = target_date + ' 23:59:59'
    employees = conn.execute('SELECT * FROM employees ORDER BY name').fetchall()
    result = []
    for emp in employees:
        record = conn.execute(
            'SELECT a.*, s.name as supervisor_name FROM attendance a '
            'JOIN supervisors s ON a.supervisor_id = s.id '
            'WHERE a.employee_id = ? AND a.scan_time BETWEEN ? AND ?',
            (emp['id'], day_start, day_end)
        ).fetchone()
        result.append({
            'employee': dict(emp),
            'status': record['status'] if record else 'not_scanned',
            'scan_time': record['scan_time'] if record else None,
            'supervisor': record['supervisor_name'] if record else None
        })
    conn.close()
    return jsonify(result)


@app.route('/api/attendance/today', methods=['GET'])
@login_required
def today_attendance():
    conn = get_db()
    today_start = date.today().isoformat() + ' 00:00:00'
    today_end = date.today().isoformat() + ' 23:59:59'
    employees = conn.execute('SELECT * FROM employees ORDER BY name').fetchall()
    result = []
    for emp in employees:
        record = conn.execute(
            'SELECT a.*, s.name as supervisor_name FROM attendance a '
            'JOIN supervisors s ON a.supervisor_id = s.id '
            'WHERE a.employee_id = ? AND a.scan_time BETWEEN ? AND ?',
            (emp['id'], today_start, today_end)
        ).fetchone()
        result.append({
            'employee': dict(emp),
            'status': record['status'] if record else 'not_scanned',
            'scan_time': record['scan_time'] if record else None,
            'supervisor': record['supervisor_name'] if record else None
        })
    conn.close()
    return jsonify(result)


# ANALYTICS

@app.route('/api/analytics', methods=['GET'])
@login_required
def analytics():
    weeks = int(request.args.get('weeks', 12))
    conn = get_db()
    total_employees = conn.execute('SELECT COUNT(*) as c FROM employees').fetchone()['c']
    # Weekly attendance trend
    weekly_trend = []
    today = date.today()
    for i in range(weeks):
        friday = get_nearest_friday(today - timedelta(weeks=i))
        fri_start = friday.isoformat() + ' 00:00:00'
        fri_end = friday.isoformat() + ' 23:59:59'
        present = conn.execute(
            "SELECT COUNT(*) as c FROM attendance WHERE scan_time BETWEEN ? AND ? AND status = 'present'",
            (fri_start, fri_end)
        ).fetchone()['c']
        absent = conn.execute(
            "SELECT COUNT(*) as c FROM attendance WHERE scan_time BETWEEN ? AND ? AND status = 'absent'",
            (fri_start, fri_end)
        ).fetchone()['c']
        weekly_trend.append({
            'date': friday.isoformat(), 'present': present, 'absent': absent, 'total': total_employees
        })
    # Per-attendee stats
    employees = conn.execute('SELECT id, name, department FROM employees ORDER BY name').fetchall()
    attendee_stats = []
    for emp in employees:
        present = conn.execute(
            "SELECT COUNT(*) as c FROM attendance WHERE employee_id = ? AND status = 'present'",
            (emp['id'],)
        ).fetchone()['c']
        total = conn.execute(
            "SELECT COUNT(*) as c FROM attendance WHERE employee_id = ?",
            (emp['id'],)
        ).fetchone()['c']
        rate = round((present / total * 100) if total > 0 else 0, 1)
        attendee_stats.append({
            'id': emp['id'], 'name': emp['name'], 'class_name': emp['department'],
            'present': present, 'total': total, 'rate': rate
        })
    attendee_stats.sort(key=lambda x: x['rate'], reverse=True)
    # Class breakdown
    classes = {}
    for emp in employees:
        cls = emp['department'] or 'Other'
        if cls not in classes:
            classes[cls] = {'name': cls, 'count': 0, 'total_present': 0, 'total_records': 0}
        classes[cls]['count'] += 1
        present = conn.execute(
            "SELECT COUNT(*) as c FROM attendance WHERE employee_id = ? AND status = 'present'",
            (emp['id'],)
        ).fetchone()['c']
        total = conn.execute(
            "SELECT COUNT(*) as c FROM attendance WHERE employee_id = ?",
            (emp['id'],)
        ).fetchone()['c']
        classes[cls]['total_present'] += present
        classes[cls]['total_records'] += total
    class_stats = []
    for cls_data in classes.values():
        rate = round((cls_data['total_present'] / cls_data['total_records'] * 100) if cls_data['total_records'] > 0 else 0, 1)
        class_stats.append({**cls_data, 'rate': rate})
    # Overall
    total_attendance = conn.execute("SELECT COUNT(*) as c FROM attendance").fetchone()['c']
    total_present = conn.execute("SELECT COUNT(*) as c FROM attendance WHERE status = 'present'").fetchone()['c']
    overall_rate = round((total_present / total_attendance * 100) if total_attendance > 0 else 0, 1)
    conn.close()
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
    conn = get_db()
    records = conn.execute(
        'SELECT a.*, e.name as employee_name, e.nfc_uid, s.name as supervisor_name '
        'FROM attendance a JOIN employees e ON a.employee_id = e.id '
        'JOIN supervisors s ON a.supervisor_id = s.id '
        'WHERE DATE(a.scan_time) BETWEEN ? AND ? '
        'ORDER BY a.scan_time DESC', (start_date, end_date)
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in records])


if __name__ == '__main__':
    import ssl, socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        local_ip = s.getsockname()[0]
    except Exception:
        local_ip = '0.0.0.0'
    finally:
        s.close()
    cert_file = os.path.join(BASE_DIR, 'cert.pem')
    key_file = os.path.join(BASE_DIR, 'key.pem')
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
        print("SSL certificate generated.")
    print("=" * 50)
    print("  NFC Attendance System")
    print("=" * 50)
    print(f"  Local:   https://localhost:5000")
    print(f"  Phone:   https://{local_ip}:5000")
    print("=" * 50)
    app.run(host='0.0.0.0', port=5000, debug=True, ssl_context=(cert_file, key_file))

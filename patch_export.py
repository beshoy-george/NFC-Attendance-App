import os
import re

import os
import re

file_path = r'..\flutter app\lib\features\settings\settings_page.dart'
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

new_export = '''  Future<void> _exportReport(BuildContext context, WidgetRef ref) async {
    final DateTimeRange? range = await showDateRangePicker(
      context: context,
      firstDate: DateTime(2020),
      lastDate: DateTime.now(),
      builder: (context, child) => Theme(
        data: Theme.of(context).copyWith(
          colorScheme: const ColorScheme.light(
            primary: AppColors.primary,
          ),
        ),
        child: child!,
      ),
    );
    if (range == null) return;

    try {
      final dio = ref.read(dioProvider);
      final start = range.start.toIso8601String().split('T')[0];
      final end = range.end.toIso8601String().split('T')[0];
      final response = await dio.get('/api/attendance/report', queryParameters: {'start': start, 'end': end});
      final records = List<Map<String, dynamic>>.from(response.data as List);

      final buffer = StringBuffer();
      buffer.writeln('\\uFEFFالاسم,الحالة,التاريخ,الوقت,الخادم');
      for (final r in records) {
        final name = r['employee_name'] ?? '';
        final status = r['status'] == 'present' ? 'حاضر' : 'غائب';
        final scanTime = r['scan_time'] ?? '';
        final dateStr = scanTime.toString().split(' ').first;
        final supervisor = r['supervisor_name'] ?? '';
        buffer.writeln('\,\,\,\,\');
      }

      final dir = await getTemporaryDirectory();
      final file = File('\/attendance_report.csv');
      await file.writeAsString(buffer.toString());

      await Share.shareXFiles(
        [XFile(file.path, mimeType: 'text/csv')],
        subject: 'تقرير الحضور',
      );
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('خطأ في تصدير التقرير')),
        );
      }
    }
  }'''

# Replace old _exportReport
pattern = re.compile(r'Future<void> _exportReport\(BuildContext context, WidgetRef ref\) async \{.*?catch \(e\) \{.*?\}\s*\}', re.DOTALL)
content = content.replace(pattern.search(content).group(0), new_export)

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)
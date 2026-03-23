import os
import re

file_path = r'..\flutter app\lib\features\settings\settings_page.dart'
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Add _discoverServer method to SettingsPage
discover_method = '''
  Future<void> _showServerSettings(BuildContext context, WidgetRef ref) async {
    final curUrl = AppConfig.baseUrl;
    final ctrl = TextEditingController(text: curUrl);
    
    await showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('إعدادات الخادم'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('أدخل عنوان الـ IP الخاص بالكمبيوتر للربط:'),
            const SizedBox(height: 12),
            TextField(
              controller: ctrl,
              decoration: const InputDecoration(
                hintText: 'http://192.168.1.5:5000',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 16),
            ElevatedButton.icon(
              icon: const Icon(Icons.search),
              label: const Text('بحث تلقائي في الشبكة'),
              onPressed: () async {
                ScaffoldMessenger.of(ctx).showSnackBar(const SnackBar(content: Text('جاري البحث التلقائي عن الكمبيوتر...')));
                final dio = Dio(BaseOptions(connectTimeout: const Duration(milliseconds: 1500)));
                String? foundUrl;
                for (int i = 1; i < 255; i++) {
                  final testUrl = 'http://192.168.1.\';
                  try {
                    final res = await dio.get('\/api/ping');
                    if (res.statusCode == 200 && res.data['nfc_server'] == true) {
                      foundUrl = testUrl;
                      break;
                    }
                  } catch (_) {}
                }
                if (foundUrl != null) {
                  ctrl.text = foundUrl;
                  ScaffoldMessenger.of(ctx).showSnackBar(const SnackBar(content: Text('تم العثور على السيرفر!'), backgroundColor: Colors.green));
                } else {
                  ScaffoldMessenger.of(ctx).showSnackBar(const SnackBar(content: Text('لم يتم العثور على سيرفر مفتوح'), backgroundColor: Colors.red));
                }
              },
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('إلغاء')),
          ElevatedButton(
            onPressed: () async {
              await AppConfig.setBaseUrl(ctrl.text.trim());
              Navigator.pop(ctx);
              ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('تم حفظ الإعدادات بنجاح. يرجى إعادة تشغيل التطبيق لو واجهت مشاكل.')));
            },
            child: const Text('حفظ'),
          ),
        ],
      ),
    );
  }
'''

# Add imports
if 'import \'package:dio/dio.dart\';' not in content:
    content = content.replace('import \'package:flutter/material.dart\';', 'import \'package:flutter/material.dart\';\nimport \'package:dio/dio.dart\';\nimport \'../../core/config/app_config.dart\';')

# Add the UI button into the Column
new_item = '''                  _SettingsItem(
                    icon: Icons.wifi,
                    label: 'الاتصال بالسيرفر للمزامنة',
                    onTap: () => _showServerSettings(context, ref),
                  ),
                  const Divider(height: 1, color: AppColors.border),
'''

content = content.replace('_SettingsItem(\n                    icon: Icons.supervised_user_circle', new_item + '_SettingsItem(\n                    icon: Icons.supervised_user_circle')

# Insert method
content = content.replace('Future<void> _logout(BuildContext', discover_method + '\n  Future<void> _logout(BuildContext')

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print('Patched successfully!')
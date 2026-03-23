import os
import re

import os
import re

file_path = r'..\flutter app\lib\features\settings\settings_page.dart'
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Replace the search logic block
pattern = re.compile(r'final dio = Dio\(BaseOptions\(connectTimeout: const Duration\(milliseconds: 1500\)\)\);.*?(?:await Future\.wait\(futures\);|\}\n                if \(foundUrl != null\))', re.DOTALL)

new_logic = '''final dio = Dio(BaseOptions(connectTimeout: const Duration(milliseconds: 1000), receiveTimeout: const Duration(milliseconds: 1000)));
                try {
                  (dio.httpClientAdapter as dynamic).onHttpClientCreate = (HttpClient client) { client.badCertificateCallback = (cert, host, port) => true; return client; };
                } catch(e) {}
                String? foundUrl;
                final futures = <Future<void>>[];
                for (int i = 1; i < 255; i++) {
                  final testUrl = 'https://192.168.1.$i:5000';
                  futures.add(dio.get('$testUrl/api/ping').then((res) {
                    if (res.statusCode == 200 && res.data != null && res.data['nfc_server'] == true) {
                      foundUrl = testUrl;
                    }
                  }).catchError((_) {}));
                }
                await Future.wait(futures);
                if (foundUrl != null)'''

content = pattern.sub(new_logic, content)

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)
import 'format.dart';

class Logger {
  Logger(this.scope);

  final String scope;

  void info(String message) => _write('INFO', message);

  void warn(String message) => _write('WARN', message);

  Logger child(String name) => Logger('$scope:$name');

  void _write(String level, String message) {
    print(formatLine(scope, '$level $message'));
  }
}

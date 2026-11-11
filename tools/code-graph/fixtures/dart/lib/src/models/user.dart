import '../util/strings.dart';
import 'entity.dart';

class User extends Entity with Timestamped {
  User(super.id, this.name, String email) : email = normaliseEmail(email);

  final String name;
  final String email;

  @override
  String get kind => 'user';
}

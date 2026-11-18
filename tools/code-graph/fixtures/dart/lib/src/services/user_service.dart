import 'package:shop_app/src/core/logger.dart';
import 'package:shop_app/src/models/user.dart';
import 'package:shop_app/src/util/strings.dart' as strings;

import 'repository.dart';

class UserService {
  UserService(this._log);

  final Logger _log;
  final InMemoryRepository<User> _repo = InMemoryRepository<User>();

  User register(String name, String email) {
    final user = User(strings.slugify(name), name, email);
    _repo.save(user);
    _log.info('registered ${user.id}');
    return user;
  }

  User find(String id) => _repo.get(id);
}

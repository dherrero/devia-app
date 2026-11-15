import 'package:shop_app/src/core/errors.dart';
import 'package:shop_app/src/models/entity.dart';

abstract class Repository<T extends Entity> {
  T get(String id);
  void save(T item);
}

class InMemoryRepository<T extends Entity> implements Repository<T> {
  final Map<String, T> _items = {};

  @override
  T get(String id) {
    final found = _items[id];
    if (found == null) throw NotFoundException(id);
    return found;
  }

  @override
  void save(T item) {
    _items[item.id] = item;
  }

  List<T> all() => _items.values.toList();
}

import 'package:shop_app/src/core/events.dart';
import 'package:shop_app/src/core/logger.dart';
import 'package:shop_app/src/models/order.dart';
import 'package:shop_app/src/util/money.dart' show formatMoney;

import 'repository.dart';
import 'user_service.dart';

class OrderService {
  OrderService(this._users, this._log);

  final UserService _users;
  final Logger _log;
  final EventBus<String> events = EventBus<String>();
  final InMemoryRepository<Order> _repo = InMemoryRepository<Order>();

  Order open(String id, String userId, List<OrderLine> lines) {
    final owner = _users.find(userId);
    final order = Order(id, owner);
    for (final line in lines) {
      order.addLine(line);
    }
    _repo.save(order);
    events.publish('created $id');
    return order;
  }

  String pay(String id) {
    final order = _repo.get(id);
    order.markPaid();
    final amount = formatMoney(order.total());
    _log.warn('paid $amount');
    return amount;
  }
}

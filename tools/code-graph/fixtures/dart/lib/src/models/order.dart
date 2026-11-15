import 'entity.dart';
import 'user.dart';

enum OrderStatus { open, paid }

class OrderLine {
  const OrderLine(this.sku, this.quantity, this.unitPrice);

  final String sku;
  final int quantity;
  final int unitPrice;

  int total() => quantity * unitPrice;
}

class Order extends Entity with Timestamped, Auditable {
  Order(super.id, this.owner);

  final User owner;
  final List<OrderLine> lines = [];
  OrderStatus status = OrderStatus.open;

  @override
  String get kind => 'order';

  void addLine(OrderLine line) {
    lines.add(line);
  }

  int total() => lines.fold(0, (sum, l) => sum + l.total());

  void markPaid() {
    status = OrderStatus.paid;
    touch();
  }
}

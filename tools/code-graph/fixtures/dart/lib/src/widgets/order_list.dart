import 'package:flutter/material.dart';

import '../services/order_service.dart';
import 'order_tile.dart';

class OrderList extends StatelessWidget {
  const OrderList({super.key, required this.orders});

  final OrderService orders;

  @override
  Widget build(BuildContext context) {
    return ListView(
      children: [
        OrderTile(label: 'pay', onTap: () => orders.pay('o-1')),
      ],
    );
  }
}

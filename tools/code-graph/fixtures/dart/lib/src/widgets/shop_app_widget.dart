import 'package:flutter/material.dart';

import '../services/order_service.dart';
import '../services/user_service.dart';
import 'order_list.dart';
import 'register_form.dart';

class ShopAppWidget extends StatelessWidget {
  const ShopAppWidget({super.key, required this.users, required this.orders});

  final UserService users;
  final OrderService orders;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Scaffold(
        body: Column(
          children: [
            RegisterForm(onSubmit: (name, email) => users.register(name, email)),
            OrderList(orders: orders),
          ],
        ),
      ),
    );
  }
}

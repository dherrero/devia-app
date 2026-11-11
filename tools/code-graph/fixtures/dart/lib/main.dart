import 'package:flutter/material.dart';
import 'package:shop_app/shop_app.dart';

void main() {
  final log = Logger('app');
  final users = UserService(log.child('users'));
  final orders = OrderService(users, log.child('orders'));
  runApp(ShopAppWidget(users: users, orders: orders));
}

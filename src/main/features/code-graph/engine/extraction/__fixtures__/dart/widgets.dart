import 'package:flutter/material.dart' as m show Text;
import '../models/user.dart' hide Secret;
import 'package:lazy/lazy.dart' deferred as lazy;
import 'dart:async';
export 'src/api.dart' show Api;
part 'widgets.g.dart';

/// A counter widget.
/// Stateful.
class Counter extends StatefulWidget {
  const Counter({super.key});

  @override
  State<Counter> createState() => _CounterState();
}

class _CounterState extends State<Counter> {
  int _count = 0;
  static const int max = 10;

  @override
  Widget build(BuildContext context) {
    final label = Text('x');
    return m.Text('$_count');
  }
}

class Hello extends material.StatelessWidget {
  Widget build(BuildContext context) => const Text('hi');
}

class Theme2 extends InheritedWidget {}

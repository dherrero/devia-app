import 'package:flutter/material.dart';

import '../core/format.dart';

class RegisterForm extends StatefulWidget {
  const RegisterForm({super.key, required this.onSubmit});

  final void Function(String name, String email) onSubmit;

  @override
  State<RegisterForm> createState() => _RegisterFormState();
}

class _RegisterFormState extends State<RegisterForm> {
  final _name = TextEditingController();
  final _email = TextEditingController();

  void _submit() {
    widget.onSubmit(_name.text, _email.text);
    setState(_clear);
  }

  void _clear() {
    _name.clear();
    _email.clear();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        TextField(controller: _name),
        TextField(controller: _email),
        ElevatedButton(onPressed: _submit, child: Text(upper('register'))),
      ],
    );
  }
}

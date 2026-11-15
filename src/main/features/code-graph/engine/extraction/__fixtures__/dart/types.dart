mixin A {
  void a() {}
}

mixin M on A {
  void m() => a();
}

abstract class Base {
  void run();
}

class B extends Base with M implements Comparable<B>, Other {
  B();
  B.named(this.x);
  factory B.fromJson(Map<String, dynamic> json) => B.named(json['x']);
  final int x = 1;
  int _v = 0;

  @override
  void run() {
    this.go();
    other.work();
    sb..write('a')..writeln();
    final c = new Foo.named();
    final d = const Foo();
    helper(1);
    items.map((e) => convert(e));
  }

  Future<void> go() async {}
  Stream<int> gen() async* {}
  Iterable<int> it() sync* {}
  static int make() => 1;

  int get value => _v;
  set value(int v) => _v = v;
}

abstract class Shape {}

mixin class Both {}

extension StringExt on String {
  String shout() => toUpperCase();
}

enum Color { red, green }

typedef IntMap = Map<int, int>;
typedef void Callback(int x);

const pi = 3.14;
final version = compute();
var counter = 0;
int total = 5;

/// Greets.
void greet(String name) {
  print(name);
  void inner() {}
  inner();
}

String _hidden() => 'x';

@immutable
@JsonSerializable()
class Model {}

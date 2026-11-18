abstract class Entity {
  Entity(this.id);

  final String id;

  String get kind;

  String key() => '$kind:$id';
}

mixin Timestamped {
  DateTime? updatedAt;

  void touch() {
    updatedAt = DateTime.now();
  }
}

mixin Auditable on Entity {
  String audit() => 'audit ${key()}';
}

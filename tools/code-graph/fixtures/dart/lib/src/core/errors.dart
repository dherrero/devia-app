class DomainException implements Exception {
  DomainException(this.message, this.code);

  final String message;
  final String code;

  @override
  String toString() => '$code: $message';
}

class NotFoundException extends DomainException {
  NotFoundException(String what) : super(describeMissing(what), 'NOT_FOUND');
}

String describeMissing(String what) => '$what not found';

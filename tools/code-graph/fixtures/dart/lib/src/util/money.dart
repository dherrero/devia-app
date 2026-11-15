String formatMoney(int cents) => '${roundTo(cents / 100, 2)} EUR';

double roundTo(double value, int digits) {
  final factor = digits == 2 ? 100 : 10;
  return (value * factor).round() / factor;
}

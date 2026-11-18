export function formatMoney(cents: number): string {
  return `${roundTo(cents / 100, 2)} EUR`;
}

export function roundTo(value: number, digits: number): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

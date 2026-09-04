export function toClickHouseDateTime64(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid event timestamp: ${value}`);
  }
  return parsed.toISOString().replace('T', ' ').replace('Z', '');
}

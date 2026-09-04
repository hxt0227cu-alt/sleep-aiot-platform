export interface EventWithId {
  eventId: string;
}

export function partitionNewEvents<T extends EventWithId>(
  events: T[],
  existingEventIds: ReadonlySet<string>,
): { accepted: T[]; duplicates: T[] } {
  const seen = new Set(existingEventIds);
  const accepted: T[] = [];
  const duplicates: T[] = [];

  for (const event of events) {
    if (seen.has(event.eventId)) {
      duplicates.push(event);
      continue;
    }
    seen.add(event.eventId);
    accepted.push(event);
  }

  return { accepted, duplicates };
}

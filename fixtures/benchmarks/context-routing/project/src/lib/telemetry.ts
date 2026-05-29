export interface ProductEvent {
  name: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export function createEvent(
  name: string,
  payload: Record<string, unknown>,
  now = new Date(),
): ProductEvent {
  return {
    name,
    payload,
    timestamp: now.toISOString(),
  };
}

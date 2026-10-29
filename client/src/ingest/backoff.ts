export function backoffDelay(attempt: number) {
  // TODO: exponential growth: base * 2^attempt, capped at a maximum
  // TODO: "full jitter": random value between 0 and that ceiling, so clients don't all reconnect at once
}

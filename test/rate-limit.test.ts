import { expect, test } from "bun:test";
import { RateLimiter } from "../src/rate-limit";

test("rate limiter refuses past the max inside the window and recovers after it", () => {
  let now = 0;
  const limiter = new RateLimiter({ now: () => now } as never);
  limiter.hit("a", 2, 1000);
  limiter.hit("a", 2, 1000);
  expect(() => limiter.hit("a", 2, 1000)).toThrow("RATE_LIMITED");
  now = 1001;
  expect(() => limiter.hit("a", 2, 1000)).not.toThrow();
});

import { timingSafeEqual } from "node:crypto";

export function lifecycleControlAuthorized(req: Request, controlToken: string): boolean {
  const header = req.headers.get("authorization") ?? "";
  const expected = Buffer.from(`Bearer ${controlToken}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

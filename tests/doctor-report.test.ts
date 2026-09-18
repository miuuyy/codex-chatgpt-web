import { expect, test } from "bun:test";
import { formatDoctorReport, type DoctorReport } from "../src/doctor";

function report(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return {
    ok: true,
    mode: "full",
    checks: [{ id: "config", status: "ok", message: "Configuration is valid" }],
    unproven: [],
    ...overrides,
  };
}

test("an unproven connector is named instead of summarizing as fully ready", () => {
  const summary = formatDoctorReport(report({
    checks: [{
      id: "connector",
      status: "warning",
      unprovenLocally: true,
      message: "Local checks cannot prove connector attachment",
    }],
    unproven: ["connector"],
  })).trimEnd().split("\n").at(-1);

  expect(summary).toBe("Doctor result: ready for local checks; unproven from this machine: connector");
});

test("fully proven and failing doctor reports keep their existing summaries", () => {
  expect(formatDoctorReport(report({ mode: "browser-only" })).trimEnd().split("\n").at(-1))
    .toBe("Doctor result: ready");
  expect(formatDoctorReport(report({
    ok: false,
    checks: [{ id: "proxy", status: "error", message: "Responses proxy is not reachable" }],
    unproven: ["connector"],
  })).trimEnd().split("\n").at(-1)).toBe("Doctor result: not ready");
});

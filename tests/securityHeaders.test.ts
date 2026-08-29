import { describe, expect, test } from "bun:test";

import config from "../vercel.json";

const allRoutes = config.headers.find((entry) => entry.source === "/(.*)");
if (allRoutes === undefined) {
  throw new Error("vercel.json must apply security headers to every route");
}

const headers = new Map(
  allRoutes.headers.map(({ key, value }) => [key.toLowerCase(), value]),
);

function requiredHeader(name: string): string {
  const value = headers.get(name.toLowerCase());
  if (value === undefined) {
    throw new Error(`Missing required production header: ${name}`);
  }
  return value;
}

describe("production security headers", () => {
  test("sets browser hardening headers on every route", () => {
    expect(requiredHeader("Strict-Transport-Security")).toContain(
      "max-age=63072000",
    );
    expect(requiredHeader("X-Content-Type-Options")).toBe("nosniff");
    expect(requiredHeader("X-Frame-Options")).toBe("DENY");
    expect(requiredHeader("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(requiredHeader("Permissions-Policy")).toContain("camera=()");
    expect(requiredHeader("Cross-Origin-Opener-Policy")).toBe("same-origin");
  });

  test("enforces a deny-by-default content security policy", () => {
    const csp = requiredHeader("Content-Security-Policy");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-eval'");
  });

  test("allows only the external services used by the browser", () => {
    const csp = requiredHeader("Content-Security-Policy");
    expect(csp).toContain("https://fonts.googleapis.com");
    expect(csp).toContain("https://fonts.gstatic.com");
    expect(csp).toContain("https://grandiose-rook-292.convex.cloud");
    expect(csp).toContain("wss://grandiose-rook-292.convex.cloud");
    expect(csp).toContain("https://huggingface.co");
    expect(csp).not.toContain("https://*.convex.cloud");
    expect(csp).not.toContain("https://*.amazonaws.com");
  });
});

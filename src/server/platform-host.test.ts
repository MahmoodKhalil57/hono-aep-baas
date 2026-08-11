import { describe, expect, it } from "vitest";
import { platformFallbackProject } from "./platform-host";

const ZONE = "saastemly.com";

describe("the free fallback host (domains.md §1a)", () => {
  it("derives the project from the shipped one-label form", () => {
    expect(platformFallbackProject("saastarter2-api.saastemly.com", ZONE)).toBe("saastarter2");
  });

  it("accepts the two-label form so enabling ACM needs no code change", () => {
    expect(platformFallbackProject("saastarter2.api.saastemly.com", ZONE)).toBe("saastarter2");
  });

  it("ignores port and casing, as a Host header may carry both", () => {
    expect(platformFallbackProject("Acme-API.Saastemly.com:8787", ZONE)).toBe("acme");
  });

  it("stays off entirely when no platform zone is configured", () => {
    // The correct default for a deployment that owns no zone: without this,
    // an empty suffix would make EVERY host end with "." and match.
    expect(platformFallbackProject("acme-api.saastemly.com", "")).toBeNull();
    expect(platformFallbackProject("acme-api.saastemly.com", "  ")).toBeNull();
  });

  it("declines hosts outside the zone", () => {
    expect(platformFallbackProject("acme-api.example.com", ZONE)).toBeNull();
    // The giveaway suffix must be a LABEL boundary, not a string suffix —
    // otherwise an attacker registers evilsaastemly.com and is served as us.
    expect(platformFallbackProject("acme-api.evilsaastemly.com", ZONE)).toBeNull();
  });

  it("declines the zone apex and bare subdomains", () => {
    // `saastemly.com` and `api.saastemly.com` are the PLATFORM's own surfaces.
    // Resolving them to a project would hand the console's hostname away.
    expect(platformFallbackProject("saastemly.com", ZONE)).toBeNull();
    expect(platformFallbackProject("api.saastemly.com", ZONE)).toBeNull();
    // A site-shaped host is not an API host: only the API is served here.
    expect(platformFallbackProject("saastarter2.saastemly.com", ZONE)).toBeNull();
  });

  it("refuses labels that are not legal project ids", () => {
    expect(platformFallbackProject("-api.saastemly.com", ZONE)).toBeNull();
    expect(platformFallbackProject("-bad-api.saastemly.com", ZONE)).toBeNull();
    expect(platformFallbackProject("UPPER_SCORE-api.saastemly.com", ZONE)).toBeNull();
    expect(platformFallbackProject(`${"a".repeat(64)}-api.saastemly.com`, ZONE)).toBeNull();
  });

  it("does not let a deeper host smuggle itself in", () => {
    // `a.b-api.saastemly.com` would be a two-level name the wildcard record
    // never covers; accepting it here would mint documents for a host that
    // cannot resolve.
    expect(platformFallbackProject("a.b-api.saastemly.com", ZONE)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { decideImport, toUpstreamPermission } from "./policy";

const personal = { owner: "adam", ownerType: "User" as const };
const org = { owner: "vercel", ownerType: "Organization" as const };

describe("toUpstreamPermission", () => {
	it("collapses github's permission map, defaulting to read", () => {
		expect(toUpstreamPermission({ admin: true, push: true })).toBe("admin");
		expect(toUpstreamPermission({ admin: false, push: true })).toBe("write");
		expect(toUpstreamPermission({ admin: false, push: false })).toBe("read");
		expect(toUpstreamPermission(undefined)).toBe("read");
	});
});

describe("decideImport", () => {
	it("lets a user claim their own personal repo", () => {
		expect(
			decideImport({
				upstream: { ...personal, permission: "admin" },
				actorLogin: "Adam",
				canonicalExists: false,
			}),
		).toEqual({ kind: "create", owner: "adam" });
	});

	it("requires org admin to claim an org repo", () => {
		const upstream = { ...org, permission: "write" as const };
		expect(
			decideImport({ upstream, actorLogin: "adam", canonicalExists: false }),
		).toEqual({ kind: "fork", owner: "adam", source: "upstream" });
		expect(
			decideImport({
				upstream: { ...org, permission: "admin" },
				actorLogin: "adam",
				canonicalExists: false,
			}),
		).toEqual({ kind: "create", owner: "vercel" });
	});

	it("adds a writer to the repository someone already imported", () => {
		expect(
			decideImport({
				upstream: { ...org, permission: "write" },
				actorLogin: "adam",
				canonicalExists: true,
			}),
		).toEqual({ kind: "join", permission: "write" });
	});

	it("forks instead of joining when the user can only read", () => {
		expect(
			decideImport({
				upstream: { ...org, permission: "read" },
				actorLogin: "adam",
				canonicalExists: true,
			}),
		).toEqual({ kind: "fork", owner: "adam", source: "canonical" });
	});

	it("never lets someone else's personal repo become canonical", () => {
		expect(
			decideImport({
				upstream: { ...personal, permission: "write" },
				actorLogin: "someone-else",
				canonicalExists: false,
			}),
		).toEqual({ kind: "fork", owner: "someone-else", source: "upstream" });
	});
});

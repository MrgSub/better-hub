import { describe, expect, it, vi } from "vitest";
import type { Repository } from "@/generated/prisma/client";

vi.mock("@/lib/db", () => ({ prisma: { repository: { update: vi.fn() } } }));

import { isMetadataStale, parseLanguages, upstreamCoordinates } from "./upstream-metadata";

function record(overrides: Partial<Repository> = {}): Repository {
	return {
		id: "repo_1",
		upstreamHost: "github.com",
		upstreamOwner: "adam",
		upstreamName: "hello",
		languagesJson: null,
		metadataSyncedAt: null,
		...overrides,
	} as Repository;
}

describe("upstreamCoordinates", () => {
	it("is null once nothing upstream owns the read-only data", () => {
		expect(upstreamCoordinates(record({ upstreamHost: null }))).toBeNull();
		expect(upstreamCoordinates(record({ upstreamName: null }))).toBeNull();
	});

	it("points at the GitHub repo the import came from", () => {
		expect(upstreamCoordinates(record())).toEqual({ owner: "adam", repo: "hello" });
	});
});

describe("isMetadataStale", () => {
	const now = Date.parse("2026-01-01T12:00:00Z");

	it("is stale when never synced", () => {
		expect(isMetadataStale(record(), now)).toBe(true);
	});

	it("holds a recent copy and refreshes an hour-old one", () => {
		const at = (iso: string) => record({ metadataSyncedAt: new Date(iso) });
		expect(isMetadataStale(at("2026-01-01T11:30:00Z"), now)).toBe(false);
		expect(isMetadataStale(at("2026-01-01T10:30:00Z"), now)).toBe(true);
	});
});

describe("parseLanguages", () => {
	it("is empty rather than throwing on absent or corrupt json", () => {
		expect(parseLanguages(record())).toEqual({});
		expect(parseLanguages(record({ languagesJson: "{" }))).toEqual({});
	});

	it("returns the stored byte counts", () => {
		expect(parseLanguages(record({ languagesJson: '{"TypeScript":10}' }))).toEqual({
			TypeScript: 10,
		});
	});
});

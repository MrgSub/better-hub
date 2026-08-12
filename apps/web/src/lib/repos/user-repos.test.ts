import { describe, expect, it, vi } from "vitest";
import type { Repository } from "@/generated/prisma/client";

vi.mock("./registry", () => ({ listUserRepositories: vi.fn() }));

import { listUserRepositories } from "./registry";
import { hostedOnlyRepositories } from "./user-repos";

function record(overrides: Partial<Repository> = {}): Repository {
	return {
		id: "repo_1",
		owner: "adam",
		name: "hosted-lab",
		description: "ours",
		stars: 7,
		openIssues: 2,
		language: "TypeScript",
		isPrivate: true,
		archived: false,
		forkOfId: null,
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
		...overrides,
	} as Repository;
}

describe("hostedOnlyRepositories", () => {
	it("returns nothing for a viewer who is not signed in", async () => {
		expect(await hostedOnlyRepositories(undefined, [])).toEqual([]);
	});

	it("carries the upstream figures we copied, not zeroes", async () => {
		vi.mocked(listUserRepositories).mockResolvedValue([record()]);
		const [repo] = await hostedOnlyRepositories("user_1", []);
		expect(repo).toMatchObject({
			full_name: "adam/hosted-lab",
			stargazers_count: 7,
			open_issues_count: 2,
			language: "TypeScript",
			private: true,
			html_url: "/adam/hosted-lab",
		});
	});

	it("drops repositories github already reported, whatever the casing", async () => {
		vi.mocked(listUserRepositories).mockResolvedValue([record()]);
		expect(await hostedOnlyRepositories("user_1", ["Adam/Hosted-Lab"])).toEqual([]);
	});
});

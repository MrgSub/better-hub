import { describe, expect, it, vi } from "vitest";
import type { Repository } from "@/generated/prisma/client";

vi.mock("@/lib/db", () => ({
	prisma: {
		repositoryCollaborator: { findUnique: vi.fn().mockResolvedValue(null) },
		organizationMember: { findUnique: vi.fn().mockResolvedValue(null) },
	},
}));

import { writeRefusal } from "./registry";

function record(overrides: Partial<Repository> = {}): Repository {
	return {
		id: "repo_1",
		owner: "adam",
		name: "hello",
		archived: false,
		ownerUserId: "user_1",
		organizationId: null,
		...overrides,
	} as Repository;
}

describe("writeRefusal", () => {
	it("lets the owner write", async () => {
		expect(await writeRefusal(record(), "user_1")).toBeNull();
	});

	it("refuses a stranger", async () => {
		expect(await writeRefusal(record(), "stranger")).toBe(
			"You do not have write access to this repository",
		);
	});

	it("refuses everyone once the repository is archived", async () => {
		expect(await writeRefusal(record({ archived: true }), "user_1")).toBe(
			"This repository is archived",
		);
	});
});

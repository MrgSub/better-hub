import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConnection, Repository } from "@/generated/prisma/client";

vi.mock("@/lib/db", () => ({
	prisma: {
		agentConnection: {
			findUnique: vi.fn(),
			upsert: vi.fn(),
			deleteMany: vi.fn(),
		},
	},
}));

import { prisma } from "@/lib/db";
import { agentScope, connectionView, repositoryAgent, saveAgentConnection } from "./connection";

const repo = {
	id: "repo_1",
	owner: "orchid",
	name: "hub",
	organizationId: "org_1",
	ownerUserId: null,
} as unknown as Repository;

const personalRepo = {
	id: "repo_2",
	owner: "adam",
	name: "hub",
	organizationId: null,
	ownerUserId: "user_1",
} as unknown as Repository;

function connection(over: Partial<AgentConnection>): AgentConnection {
	return {
		id: "conn_1",
		organizationId: "org_1",
		userId: null,
		provider: "model",
		enabled: false,
		apiKeyEnc: null,
		accountId: null,
		connectedById: "user_1",
		createdAt: new Date(),
		updatedAt: new Date(),
		...over,
	} as AgentConnection;
}

beforeEach(() => {
	vi.clearAllMocks();
	process.env.BETTER_AUTH_SECRET = "test-secret";
});

describe("agentScope", () => {
	it("scopes an organization's repositories to the organization and a person's to them", () => {
		expect(agentScope(repo)).toEqual({ organizationId: "org_1" });
		expect(agentScope(personalRepo)).toEqual({ userId: "user_1" });
	});
});

describe("connectionView", () => {
	it("is off with no provider before anything is connected", () => {
		expect(connectionView(null)).toMatchObject({
			provider: "model",
			enabled: false,
			hasKey: false,
		});
	});

	it("reports that a key exists without exposing it", () => {
		const view = connectionView(
			connection({ provider: "devin", enabled: true, apiKeyEnc: "cipher" }),
		);
		expect(view).toMatchObject({ provider: "devin", enabled: true, hasKey: true });
		expect(JSON.stringify(view)).not.toContain("cipher");
	});
});

describe("saveAgentConnection", () => {
	it("stores the key encrypted, never in the clear", async () => {
		vi.mocked(prisma.agentConnection.upsert).mockResolvedValue(
			connection({ provider: "devin", enabled: true, apiKeyEnc: "cipher" }),
		);

		await saveAgentConnection(
			{ organizationId: "org_1" },
			{ provider: "devin", enabled: true, apiKey: "sk-secret" },
			"user_1",
		);

		const args = vi.mocked(prisma.agentConnection.upsert).mock.calls[0][0] as {
			create: { apiKeyEnc: string };
			update: { apiKeyEnc: string };
		};
		expect(args.create.apiKeyEnc).not.toContain("sk-secret");
		expect(args.create.apiKeyEnc.length).toBeGreaterThan(0);
		expect(args.update.apiKeyEnc).toBe(args.create.apiKeyEnc);
	});

	it("leaves the stored key alone when none is supplied", async () => {
		vi.mocked(prisma.agentConnection.upsert).mockResolvedValue(
			connection({ provider: "devin", apiKeyEnc: "cipher" }),
		);

		await saveAgentConnection(
			{ organizationId: "org_1" },
			{ provider: "devin", enabled: false },
			"user_1",
		);

		const args = vi.mocked(prisma.agentConnection.upsert).mock.calls[0][0] as {
			update: Record<string, unknown>;
		};
		expect(args.update).not.toHaveProperty("apiKeyEnc");
	});
});

describe("repositoryAgent", () => {
	it("resolves nothing when nobody has connected an agent", async () => {
		vi.mocked(prisma.agentConnection.findUnique).mockResolvedValue(null);
		expect(await repositoryAgent(repo)).toBeNull();
	});

	it("resolves nothing while the connection is off, key or not", async () => {
		vi.mocked(prisma.agentConnection.findUnique).mockResolvedValue(
			connection({ provider: "devin", enabled: false, apiKeyEnc: "cipher" }),
		);
		expect(await repositoryAgent(repo)).toBeNull();
	});

	it("refuses a third-party agent that has no key rather than calling it", async () => {
		vi.mocked(prisma.agentConnection.findUnique).mockResolvedValue(
			connection({ provider: "cursor", enabled: true, apiKeyEnc: null }),
		);
		expect(await repositoryAgent(repo)).toBeNull();
	});

	it("round-trips the key so the agent is called with what was entered", async () => {
		vi.mocked(prisma.agentConnection.upsert).mockResolvedValue(
			connection({ provider: "cursor", enabled: true, apiKeyEnc: "placeholder" }),
		);
		await saveAgentConnection(
			{ organizationId: "org_1" },
			{ provider: "cursor", enabled: true, apiKey: "key_abc" },
			"user_1",
		);
		const stored = (
			vi.mocked(prisma.agentConnection.upsert).mock.calls[0][0] as {
				create: { apiKeyEnc: string };
			}
		).create.apiKeyEnc;

		vi.mocked(prisma.agentConnection.findUnique).mockResolvedValue(
			connection({ provider: "cursor", enabled: true, apiKeyEnc: stored }),
		);

		expect(await repositoryAgent(repo)).toEqual({
			provider: "cursor",
			apiKey: "key_abc",
			accountId: null,
		});
	});

	it("keeps the built-in model usable with no key", async () => {
		vi.mocked(prisma.agentConnection.findUnique).mockResolvedValue(
			connection({ provider: "model", enabled: true, apiKeyEnc: null }),
		);
		expect(await repositoryAgent(repo)).toEqual({
			provider: "model",
			apiKey: null,
			accountId: null,
		});
	});

	// Devin's api is addressed per organization, so a key without one cannot
	// reach it — resolving would fail at the first request.
	it("refuses devin without the organization its key belongs to", async () => {
		vi.mocked(prisma.agentConnection.findUnique).mockResolvedValue(
			connection({ provider: "devin", enabled: true, apiKeyEnc: "cipher" }),
		);
		expect(await repositoryAgent(repo)).toBeNull();
	});

	it("passes the organization along once it is stored", async () => {
		vi.mocked(prisma.agentConnection.upsert).mockResolvedValue(
			connection({ provider: "devin", enabled: true, apiKeyEnc: "placeholder" }),
		);
		await saveAgentConnection(
			{ organizationId: "org_1" },
			{
				provider: "devin",
				enabled: true,
				apiKey: "cog_abc",
				accountId: "org_x",
			},
			"user_1",
		);
		const stored = (
			vi.mocked(prisma.agentConnection.upsert).mock.calls[0][0] as {
				create: { apiKeyEnc: string };
			}
		).create.apiKeyEnc;

		vi.mocked(prisma.agentConnection.findUnique).mockResolvedValue(
			connection({
				provider: "devin",
				enabled: true,
				apiKeyEnc: stored,
				accountId: "org_x",
			}),
		);

		expect(await repositoryAgent(repo)).toEqual({
			provider: "devin",
			apiKey: "cog_abc",
			accountId: "org_x",
		});
	});
});

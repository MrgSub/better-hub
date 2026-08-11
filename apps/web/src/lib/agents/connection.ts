import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import type { AgentConnection, Repository } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

/**
 * Which agent a namespace resolves conflicts with, and the key it does so on.
 *
 * Whose decision this is matters more than where it is stored: resolving spends
 * someone's money and lands someone's code, so it belongs to the organization
 * that owns the repositories rather than to the deployment's environment. It is
 * off until an admin turns it on.
 *
 * What is deliberately *not* here is a git credential. An agent is handed
 * conflicted text and answers with file contents; every ref is written by us
 * through `GitProvider`. So connecting one grants no push access, needs no
 * GitHub app installation, and keeps working while GitHub is down.
 */

export const AGENT_PROVIDERS = ["model", "devin", "cursor"] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

/** The app's own model needs no key; a third-party agent is useless without one. */
export function providerNeedsKey(provider: AgentProvider): boolean {
	return provider !== "model";
}

/**
 * Devin's api is addressed per organization, so its key is only usable
 * alongside the organization id it belongs to.
 */
export function providerNeedsAccount(provider: AgentProvider): boolean {
	return provider === "devin";
}

export function isAgentProvider(value: string): value is AgentProvider {
	return (AGENT_PROVIDERS as readonly string[]).includes(value);
}

/** A repository belongs to an organization or to a person, never both. */
export type AgentScope = { organizationId: string } | { userId: string };

export function agentScope(record: Repository): AgentScope | null {
	if (record.organizationId) return { organizationId: record.organizationId };
	if (record.ownerUserId) return { userId: record.ownerUserId };
	return null;
}

/** What the settings UI may show: the choice, but never the key. */
export interface AgentConnectionView {
	provider: AgentProvider;
	enabled: boolean;
	hasKey: boolean;
	accountId: string | null;
	updatedAt: Date | null;
}

export function connectionView(connection: AgentConnection | null): AgentConnectionView {
	if (!connection) {
		return {
			provider: "model",
			enabled: false,
			hasKey: false,
			accountId: null,
			updatedAt: null,
		};
	}
	return {
		provider: isAgentProvider(connection.provider) ? connection.provider : "model",
		enabled: connection.enabled,
		hasKey: !!connection.apiKeyEnc,
		accountId: connection.accountId,
		updatedAt: connection.updatedAt,
	};
}

export function findAgentConnection(scope: AgentScope): Promise<AgentConnection | null> {
	return prisma.agentConnection.findUnique({ where: scope });
}

function authSecret(): string {
	const secret = process.env.BETTER_AUTH_SECRET;
	if (!secret) throw new Error("BETTER_AUTH_SECRET is not set");
	return secret;
}

/**
 * Saves a connection. The key is encrypted with the same secret and helper the
 * OAuth tokens use, so it is never readable from the database alone, and an
 * omitted key leaves the stored one alone — the UI only ever sends a new one.
 */
export async function saveAgentConnection(
	scope: AgentScope,
	input: {
		provider: AgentProvider;
		enabled: boolean;
		apiKey?: string | null;
		accountId?: string | null;
	},
	connectedById: string,
): Promise<AgentConnectionView> {
	const apiKeyEnc =
		input.apiKey === undefined
			? undefined
			: input.apiKey
				? await symmetricEncrypt({ key: authSecret(), data: input.apiKey })
				: null;

	const connection = await prisma.agentConnection.upsert({
		where: scope,
		create: {
			...scope,
			provider: input.provider,
			enabled: input.enabled,
			apiKeyEnc: apiKeyEnc ?? null,
			accountId: input.accountId ?? null,
			connectedById,
		},
		update: {
			provider: input.provider,
			enabled: input.enabled,
			...(apiKeyEnc === undefined ? {} : { apiKeyEnc }),
			...(input.accountId === undefined ? {} : { accountId: input.accountId }),
			connectedById,
		},
	});
	return connectionView(connection);
}

export async function disconnectAgent(scope: AgentScope): Promise<void> {
	await prisma.agentConnection.deleteMany({ where: scope });
}

/** The connection as an agent needs it: provider plus decrypted key. */
export interface ResolvedAgentConnection {
	provider: AgentProvider;
	apiKey: string | null;
	accountId: string | null;
}

/**
 * The agent a repository's conflicts may be sent to, or null when nobody has
 * turned one on — which is the default, and is why callers must treat "no
 * agent" as an ordinary answer rather than a misconfiguration.
 */
export async function repositoryAgent(record: Repository): Promise<ResolvedAgentConnection | null> {
	const scope = agentScope(record);
	if (!scope) return null;

	const connection = await findAgentConnection(scope);
	if (!connection?.enabled) return null;

	const provider = isAgentProvider(connection.provider) ? connection.provider : "model";
	if (providerNeedsAccount(provider) && !connection.accountId) return null;
	if (!connection.apiKeyEnc) {
		return providerNeedsKey(provider)
			? null
			: { provider, apiKey: null, accountId: connection.accountId };
	}

	return {
		provider,
		apiKey: await symmetricDecrypt({ key: authSecret(), data: connection.apiKeyEnc }),
		accountId: connection.accountId,
	};
}

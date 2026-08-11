"use server";

import { revalidatePath } from "next/cache";
import { getServerSession } from "@/lib/auth";
import {
	disconnectAgent,
	findAgentConnection,
	isAgentProvider,
	providerNeedsKey,
	saveAgentConnection,
	connectionView,
	type AgentConnectionView,
} from "@/lib/agents/connection";
import { administeredNamespace, type AgentNamespace } from "@/lib/agents/namespace";

/**
 * Connecting a conflict-resolution agent to a namespace. Admin-only, because it
 * decides where that namespace's code is sent and whose bill it lands on.
 */

type ActionResult = { success: true; connection: AgentConnectionView } | { error: string };

type Administered =
	| { namespace: AgentNamespace; userId: string }
	| { error: string; namespace?: undefined };

async function administered(login: string): Promise<Administered> {
	const session = await getServerSession();
	const userId = session?.user?.id;
	if (!userId) return { error: "Not authenticated" };

	const namespace = await administeredNamespace(login, userId);
	if (!namespace) {
		return { error: `You need admin access to ${login} to change this` };
	}
	return { namespace, userId };
}

export async function updateAgentConnection(
	login: string,
	input: { provider: string; enabled: boolean; apiKey?: string },
): Promise<ActionResult> {
	const ctx = await administered(login);
	if ("error" in ctx) return { error: ctx.error };

	if (!isAgentProvider(input.provider)) {
		return { error: `${input.provider} is not an agent we support` };
	}

	// Turning it on without a key would look connected and refuse every
	// resolution, so it is rejected here rather than at merge time.
	const apiKey = input.apiKey?.trim();
	if (input.enabled && providerNeedsKey(input.provider) && !apiKey) {
		const existing = await findAgentConnection(ctx.namespace.scope);
		const stored = existing?.provider === input.provider && !!existing.apiKeyEnc;
		if (!stored) return { error: `Add a ${input.provider} API key first` };
	}

	// A key belongs to the provider it was entered for; switching provider and
	// keeping the old one would send a Devin key to Cursor.
	const existing = await findAgentConnection(ctx.namespace.scope);
	const providerChanged = !!existing && existing.provider !== input.provider;

	const connection = await saveAgentConnection(
		ctx.namespace.scope,
		{
			provider: input.provider,
			enabled: input.enabled,
			apiKey: apiKey ? apiKey : providerChanged ? null : undefined,
		},
		ctx.userId,
	);

	revalidatePath(`/orgs/${login}/settings`);
	return { success: true, connection };
}

export async function removeAgentConnection(login: string): Promise<ActionResult> {
	const ctx = await administered(login);
	if ("error" in ctx) return { error: ctx.error };

	await disconnectAgent(ctx.namespace.scope);
	revalidatePath(`/orgs/${login}/settings`);
	return { success: true, connection: connectionView(null) };
}

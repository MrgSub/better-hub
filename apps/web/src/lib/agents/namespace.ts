import { getServerSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import type { AgentScope } from "./connection";

/**
 * A namespace is whatever owns repositories: an organization, or a person's own
 * handle. Both connect an agent, so both resolve to the same scope here rather
 * than growing a second settings surface.
 */
export interface AgentNamespace {
	scope: AgentScope;
	/** The handle as it appears in URLs. */
	login: string;
	isOrganization: boolean;
}

/**
 * The namespace a handle names, and whether this user may change its settings.
 * Organizations answer to their admins; a personal namespace answers to no one
 * else, which is the same rule that governs importing a repository into it.
 */
export async function administeredNamespace(
	login: string,
	userId: string,
): Promise<AgentNamespace | null> {
	const handle = login.toLowerCase();

	const organization = await prisma.organization.findUnique({
		where: { githubLogin: handle },
		include: { members: { where: { userId } } },
	});
	if (organization) {
		if (organization.members[0]?.role !== "admin") return null;
		return {
			scope: { organizationId: organization.id },
			login: organization.githubLogin,
			isOrganization: true,
		};
	}

	const user = await prisma.user.findFirst({
		where: { id: userId, githubLogin: { equals: handle, mode: "insensitive" } },
		select: { id: true, githubLogin: true },
	});
	if (!user) return null;

	return {
		scope: { userId: user.id },
		login: user.githubLogin ?? handle,
		isOrganization: false,
	};
}

/** Whether to offer the settings link at all, for the signed-in user. */
export async function administersOrganization(login: string): Promise<boolean> {
	const session = await getServerSession();
	const userId = session?.user?.id;
	if (!userId) return false;
	return !!(await administeredNamespace(login, userId));
}

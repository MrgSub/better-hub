import type { Repository } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import type { RepoGitInfo } from "@/lib/git/types";
import type { UpstreamPermission } from "./policy";

/**
 * Postgres side of repository ownership: which upstream a repository came
 * from, who owns it, and who may write to it. Keyed by the upstream triple so
 * a second import of the same GitHub repo finds the first one.
 */

export interface UpstreamIdentity {
	host: string;
	owner: string;
	name: string;
}

/** GitHub owners and names are case-insensitive; our index is not. */
export function upstreamIdentity(
	owner: string,
	name: string,
	host = "github.com",
): UpstreamIdentity {
	return { host: host.toLowerCase(), owner: owner.toLowerCase(), name: name.toLowerCase() };
}

export function findCanonicalRepository(upstream: UpstreamIdentity): Promise<Repository | null> {
	return prisma.repository.findUnique({
		where: {
			upstreamHost_upstreamOwner_upstreamName: {
				upstreamHost: upstream.host,
				upstreamOwner: upstream.owner,
				upstreamName: upstream.name,
			},
		},
	});
}

export interface RecordRepositoryInput {
	repo: RepoGitInfo;
	backend: string;
	ownerUserId: string;
	/** Set on the canonical import only; forks inherit their parent's. */
	upstream?: UpstreamIdentity;
	organizationId?: string;
	forkOfId?: string;
}

export function recordRepository(input: RecordRepositoryInput): Promise<Repository> {
	return prisma.repository.create({
		data: {
			owner: input.repo.owner,
			name: input.repo.name,
			defaultBranch: input.repo.defaultBranch,
			gitBackend: input.backend,
			gitRepoId: input.repo.id,
			upstreamHost: input.upstream?.host ?? null,
			upstreamOwner: input.upstream?.owner ?? null,
			upstreamName: input.upstream?.name ?? null,
			organizationId: input.organizationId ?? null,
			forkOfId: input.forkOfId ?? null,
			ownerUserId: input.ownerUserId,
		},
	});
}

export async function grantCollaborator(
	repositoryId: string,
	userId: string,
	permission: UpstreamPermission,
): Promise<void> {
	await prisma.repositoryCollaborator.upsert({
		where: { repositoryId_userId: { repositoryId, userId } },
		create: { repositoryId, userId, permission },
		update: { permission },
	});
}

/**
 * Mirrors the GitHub organization the repo lives under so its members inherit
 * access here, and records the caller's role in it.
 */
export async function syncOrganizationMembership(
	githubLogin: string,
	userId: string,
	role: "admin" | "member",
): Promise<string> {
	const login = githubLogin.toLowerCase();
	const organization = await prisma.organization.upsert({
		where: { githubLogin: login },
		create: { githubLogin: login, slug: login },
		update: {},
	});
	await prisma.organizationMember.upsert({
		where: {
			organizationId_userId: { organizationId: organization.id, userId },
		},
		create: { organizationId: organization.id, userId, role },
		update: { role },
	});
	return organization.id;
}

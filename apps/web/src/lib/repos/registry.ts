import type { Repository } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import type { RepoGitInfo, RepoRef } from "@/lib/git/types";
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

/**
 * How the backend knows this repository, as opposed to how we display it.
 *
 * The backend named it at creation time and recorded that name in
 * `gitRepoId`; our `owner`/`name` are display coordinates that a rename or a
 * casing fix can move underneath it. Reads therefore go by the recorded id,
 * falling back to the display pair for rows written before it was stored.
 */
export function providerRef(record: Repository): RepoRef {
	const [owner, repo] = record.gitRepoId.split("/");
	return owner && repo ? { owner, repo } : { owner: record.owner, repo: record.name };
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

/**
 * Every repository the user can reach here: theirs, ones they collaborate on,
 * and ones owned by an organization they belong to. Newest activity first.
 */
export function listUserRepositories(userId: string): Promise<Repository[]> {
	return prisma.repository.findMany({
		where: {
			OR: [
				{ ownerUserId: userId },
				{ collaborators: { some: { userId } } },
				{ organization: { members: { some: { userId } } } },
			],
		},
		orderBy: { updatedAt: "desc" },
	});
}

/** Looks a repository up by its Better Hub coordinates, case-insensitively. */
export function findRepository(owner: string, name: string): Promise<Repository | null> {
	return prisma.repository.findFirst({
		where: {
			owner: { equals: owner, mode: "insensitive" },
			name: { equals: name, mode: "insensitive" },
		},
	});
}

export interface RepositoryMetadata {
	description?: string | null;
	homepage?: string | null;
	topics?: string[];
	isPrivate?: boolean;
	sizeKb?: number;
}

export interface RecordRepositoryInput {
	repo: RepoGitInfo;
	backend: string;
	ownerUserId: string;
	metadata?: RepositoryMetadata;
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
			description: input.metadata?.description ?? null,
			homepage: input.metadata?.homepage ?? null,
			topics: input.metadata?.topics ?? [],
			isPrivate: input.metadata?.isPrivate ?? false,
			sizeKb: input.metadata?.sizeKb ?? 0,
			upstreamHost: input.upstream?.host ?? null,
			upstreamOwner: input.upstream?.owner ?? null,
			upstreamName: input.upstream?.name ?? null,
			organizationId: input.organizationId ?? null,
			forkOfId: input.forkOfId ?? null,
			ownerUserId: input.ownerUserId,
		},
	});
}

/**
 * What the viewer may do here: owning it, or admin of the owning org, is
 * admin; org members and collaborators get their recorded permission.
 */
export async function repositoryPermission(
	repository: Repository,
	userId: string | null,
): Promise<UpstreamPermission | null> {
	if (!userId) return null;
	if (repository.ownerUserId === userId) return "admin";

	const [collaborator, membership] = await Promise.all([
		prisma.repositoryCollaborator.findUnique({
			where: { repositoryId_userId: { repositoryId: repository.id, userId } },
		}),
		repository.organizationId
			? prisma.organizationMember.findUnique({
					where: {
						organizationId_userId: {
							organizationId: repository.organizationId,
							userId,
						},
					},
				})
			: null,
	]);

	if (membership?.role === "admin") return "admin";
	if (collaborator) return collaborator.permission as UpstreamPermission;
	return membership ? "write" : null;
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

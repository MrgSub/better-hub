import { Octokit } from "@octokit/rest";
import { getGitProvider } from "@/lib/git";
import { GitError, type RepoGitInfo, type RepoRef } from "@/lib/git/types";
import {
	decideImport,
	type ImportDecision,
	toUpstreamPermission,
	type UpstreamPermission,
} from "@/lib/repos/policy";
import {
	findCanonicalRepository,
	grantCollaborator,
	recordRepository,
	syncOrganizationMembership,
	upstreamIdentity,
} from "@/lib/repos/registry";

export interface UpstreamTarget {
	owner: string;
	name: string;
}

export interface ResolvedUpstream extends UpstreamTarget {
	private: boolean;
	defaultBranch: string;
	description: string | null;
	homepage: string | null;
	topics: string[];
	sizeKb: number;
	ownerType: "User" | "Organization";
	/** The signed-in user's permission on the upstream. */
	permission: UpstreamPermission;
	/** Their role in the owning GitHub org, when the owner is one. */
	orgRole: "admin" | "member" | null;
}

/**
 * Where the user grants the repository access we are missing. GitHub Apps get
 * a per-installation picker; a plain OAuth app can only be re-authorised.
 */
export function grantAccessUrl(): string {
	const slug = process.env.GITHUB_APP_SLUG;
	return slug
		? `https://github.com/apps/${slug}/installations/new`
		: "https://github.com/settings/installations";
}

/**
 * Accepts `owner/repo`, a browser URL, an HTTPS clone URL, or an SSH remote.
 * Deep links are accepted too, since people paste the page they are looking at.
 */
export function parseRepoInput(input: string): UpstreamTarget | null {
	const trimmed = input.trim();
	if (!trimmed) return null;

	const isUrl = /^(https?:\/\/|git@|ssh:\/\/)/.test(trimmed);
	const path = trimmed
		.replace(/^git@[^:]+:/, "")
		.replace(/^ssh:\/\/git@[^/]+\//, "")
		.replace(/^https?:\/\/[^/]+\//, "");

	const segments = path.split("/").filter(Boolean);
	if (!isUrl && segments.length !== 2) return null;

	const [owner, rawName] = segments;
	const name = rawName?.replace(/\.git$/, "");
	if (!owner || !name) return null;
	if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return null;
	return { owner, name };
}

/** Null when the user is not a member, or the token lacks `read:org`. */
async function readOrgRole(octokit: Octokit, org: string): Promise<"admin" | "member" | null> {
	try {
		const { data } = await octokit.orgs.getMembershipForAuthenticatedUser({ org });
		return data.role === "admin" ? "admin" : "member";
	} catch {
		return null;
	}
}

/**
 * Reads the upstream with the user's own GitHub token. A miss is
 * indistinguishable from a private repo the token cannot see, which is exactly
 * the case the UI turns into a "grant access" prompt.
 */
export async function resolveUpstream(
	token: string,
	target: UpstreamTarget,
): Promise<ResolvedUpstream | null> {
	const octokit = new Octokit({ auth: token });
	try {
		const { data } = await octokit.repos.get({
			owner: target.owner,
			repo: target.name,
		});
		const ownerType = data.owner.type === "Organization" ? "Organization" : "User";
		return {
			owner: data.owner.login,
			name: data.name,
			private: data.private,
			defaultBranch: data.default_branch,
			description: data.description,
			homepage: data.homepage ?? null,
			topics: data.topics ?? [],
			sizeKb: data.size,
			ownerType,
			permission: toUpstreamPermission(data.permissions),
			orgRole:
				ownerType === "Organization"
					? await readOrgRole(octokit, data.owner.login)
					: null,
		};
	} catch (error) {
		if ((error as { status?: number }).status === 404) return null;
		throw error;
	}
}

export interface MigrateActor {
	userId: string;
	login: string;
	/** The user's GitHub token, forwarded only for private upstreams. */
	token: string;
}

export interface MigrateInput {
	upstream: ResolvedUpstream;
	actor: MigrateActor;
	/** Destination name; the namespace comes from the import decision. */
	name: string;
	defaultBranch: string;
}

export interface MigrationResult {
	outcome: ImportDecision["kind"];
	repo: RepoGitInfo;
	cloneUrl: string;
	agentPrompt: string;
}

const CLONE_URL_TTL_SECONDS = 3600;

async function resolvePlan(upstream: ResolvedUpstream, actorLogin: string) {
	const identity = upstreamIdentity(upstream.owner, upstream.name);
	const canonical = await findCanonicalRepository(identity);
	return {
		identity,
		canonical,
		decision: decideImport({
			upstream: {
				owner: upstream.owner,
				ownerType: upstream.ownerType,
				permission: upstream.permission,
			},
			actorLogin,
			canonicalExists: canonical !== null,
		}),
	};
}

export interface ImportPlan {
	decision: ImportDecision;
	/** Namespace the repository will live in. */
	destinationOwner: string;
	/** Set when someone already imported this upstream. */
	existing: { owner: string; name: string } | null;
}

/** What `migrateRepository` would do, so the confirm step can say so first. */
export async function planImport(
	upstream: ResolvedUpstream,
	actorLogin: string,
): Promise<ImportPlan> {
	const { canonical, decision } = await resolvePlan(upstream, actorLogin);
	return {
		decision,
		destinationOwner:
			decision.kind === "join"
				? (canonical?.owner ?? actorLogin)
				: decision.owner,
		existing: canonical ? { owner: canonical.owner, name: canonical.name } : null,
	};
}

/**
 * Resolves who owns the destination before touching the git backend: a second
 * import of an upstream we already hold joins or forks it rather than making
 * another full copy.
 */
export async function migrateRepository(input: MigrateInput): Promise<MigrationResult> {
	const git = getGitProvider();
	const { identity, canonical, decision } = await resolvePlan(
		input.upstream,
		input.actor.login,
	);

	// `join` is only decided when the canonical lookup hit.
	if (decision.kind === "join") {
		if (!canonical) throw new GitError("not_found", "Repository disappeared");
		await grantCollaborator(canonical.id, input.actor.userId, decision.permission);
		const target = { owner: canonical.owner, repo: canonical.name };
		const repo = (await git.getRepo(target)) ?? {
			id: canonical.gitRepoId,
			owner: canonical.owner,
			name: canonical.name,
			defaultBranch: canonical.defaultBranch,
			createdAt: canonical.createdAt.toISOString(),
			upstream: null,
		};
		return await finish(git, decision.kind, target, repo, input);
	}

	const target: RepoRef = { owner: decision.owner, repo: input.name };
	if (await git.getRepo(target)) {
		throw new GitError("conflict", `${target.owner}/${target.repo} already exists`);
	}

	const repo = await git.createRepo(target, {
		defaultBranch: input.defaultBranch,
		...(decision.kind === "fork" && decision.source === "canonical" && canonical
			? {
					forkOf: {
						repo: {
							owner: canonical.owner,
							repo: canonical.name,
						},
						ref: canonical.defaultBranch,
					},
				}
			: {
					baseRepo: {
						provider: "github" as const,
						owner: input.upstream.owner,
						name: input.upstream.name,
						defaultBranch: input.upstream.defaultBranch,
						auth: input.upstream.private
							? ("token" as const)
							: ("public" as const),
					},
					...(input.upstream.private
						? { credential: { password: input.actor.token } }
						: {}),
				}),
	});

	const organizationId =
		decision.kind === "create" && input.upstream.ownerType === "Organization"
			? await syncOrganizationMembership(
					input.upstream.owner,
					input.actor.userId,
					input.upstream.orgRole ?? "member",
				)
			: undefined;

	const record = await recordRepository({
		repo,
		backend: git.backend,
		ownerUserId: input.actor.userId,
		metadata: {
			description: input.upstream.description,
			homepage: input.upstream.homepage,
			topics: input.upstream.topics,
			isPrivate: input.upstream.private,
			sizeKb: input.upstream.sizeKb,
		},
		...(decision.kind === "create" ? { upstream: identity } : {}),
		...(organizationId ? { organizationId } : {}),
		...(decision.kind === "fork" && decision.source === "canonical" && canonical
			? { forkOfId: canonical.id }
			: {}),
	});
	await grantCollaborator(record.id, input.actor.userId, "admin");

	return await finish(git, decision.kind, target, repo, input);
}

async function finish(
	git: ReturnType<typeof getGitProvider>,
	outcome: ImportDecision["kind"],
	target: RepoRef,
	repo: RepoGitInfo,
	input: MigrateInput,
): Promise<MigrationResult> {
	const cloneUrl = await git.getRemoteUrl(target, ["read", "write"], CLONE_URL_TTL_SECONDS);
	return {
		outcome,
		repo,
		cloneUrl,
		agentPrompt: buildAgentPrompt(input, target, cloneUrl),
	};
}

/** Handed to the user's local coding agent so it repoints the checkout. */
export function buildAgentPrompt(input: MigrateInput, target: RepoRef, cloneUrl: string): string {
	const from = `${input.upstream.owner}/${input.upstream.name}`;
	const to = `${target.owner}/${target.repo}`;
	return `I moved this repository from GitHub (${from}) to Better Hub (${to}).

In my local clone, please:

1. Point the default remote at Better Hub:
   git remote set-url origin ${cloneUrl}
2. Keep GitHub reachable as a secondary remote:
   git remote add github https://github.com/${from}.git
3. Verify the new remote answers and has my branches:
   git ls-remote origin
4. Confirm the tracking branch still resolves:
   git fetch origin && git status -sb

Do not rewrite history, force-push, or delete branches. The clone URL above is
short-lived; if it has expired, tell me and I will issue a new one.`;
}

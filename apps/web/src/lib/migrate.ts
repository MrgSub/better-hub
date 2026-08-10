import { Octokit } from "@octokit/rest";
import { getGitProvider } from "@/lib/git";
import { GitError, type RepoGitInfo } from "@/lib/git/types";

export interface UpstreamTarget {
	owner: string;
	name: string;
}

export interface ResolvedUpstream extends UpstreamTarget {
	private: boolean;
	defaultBranch: string;
	description: string | null;
	sizeKb: number;
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
		return {
			owner: data.owner.login,
			name: data.name,
			private: data.private,
			defaultBranch: data.default_branch,
			description: data.description,
			sizeKb: data.size,
		};
	} catch (error) {
		if ((error as { status?: number }).status === 404) return null;
		throw error;
	}
}

export interface MigrateInput {
	upstream: ResolvedUpstream;
	/** Destination owner in Better Hub, usually the signed-in user's login. */
	owner: string;
	name: string;
	defaultBranch: string;
	/** The user's GitHub token, forwarded only for private upstreams. */
	token: string;
}

export interface MigrationResult {
	repo: RepoGitInfo;
	cloneUrl: string;
	agentPrompt: string;
}

const CLONE_URL_TTL_SECONDS = 3600;

export async function migrateRepository(input: MigrateInput): Promise<MigrationResult> {
	const git = getGitProvider();
	const target = { owner: input.owner, repo: input.name };

	if (await git.getRepo(target)) {
		throw new GitError("conflict", `${input.owner}/${input.name} already exists`);
	}

	const repo = await git.createRepo(target, {
		defaultBranch: input.defaultBranch,
		baseRepo: {
			provider: "github",
			owner: input.upstream.owner,
			name: input.upstream.name,
			defaultBranch: input.upstream.defaultBranch,
			auth: input.upstream.private ? "token" : "public",
		},
		...(input.upstream.private ? { credential: { password: input.token } } : {}),
	});

	const cloneUrl = await git.getRemoteUrl(target, ["read", "write"], CLONE_URL_TTL_SECONDS);
	return { repo, cloneUrl, agentPrompt: buildAgentPrompt(input, cloneUrl) };
}

/** Handed to the user's local coding agent so it repoints the checkout. */
export function buildAgentPrompt(input: MigrateInput, cloneUrl: string): string {
	const from = `${input.upstream.owner}/${input.upstream.name}`;
	const to = `${input.owner}/${input.name}`;
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

import type { Repository } from "@/generated/prisma/client";
import { listUserRepositories } from "./registry";

/**
 * A repository we host, shaped like the GitHub payload the repository lists
 * render. Stars and the rest are the read-only figures we copied from the
 * upstream, so a hosted row reads the same as a GitHub one.
 */
export interface HostedRepoItem {
	id: string;
	name: string;
	full_name: string;
	description: string | null;
	html_url: string;
	stargazers_count: number;
	forks_count: number;
	language: string | null;
	updated_at: string;
	pushed_at: string;
	private: boolean;
	fork: boolean;
	archived: boolean;
	open_issues_count: number;
	owner: { login: string; avatar_url: string };
}

function asRepoItem(record: Repository): HostedRepoItem {
	return {
		id: record.id,
		name: record.name,
		full_name: `${record.owner}/${record.name}`,
		description: record.description,
		html_url: `/${record.owner}/${record.name}`,
		stargazers_count: record.stars,
		forks_count: 0,
		language: record.language,
		updated_at: record.updatedAt.toISOString(),
		pushed_at: record.updatedAt.toISOString(),
		private: record.isPrivate,
		fork: record.forkOfId !== null,
		archived: record.archived,
		open_issues_count: record.openIssues,
		owner: {
			login: record.owner,
			avatar_url: `https://github.com/${record.owner}.png`,
		},
	};
}

/**
 * The repositories a viewer would otherwise never see in a list: ones that only
 * exist here — a fork, or an import of an upstream they can no longer read —
 * which GitHub cannot report. Every list that shows `getUserRepos` needs these
 * in front of it, or the repositories we host are invisible.
 */
export async function hostedOnlyRepositories(
	userId: string | undefined,
	githubFullNames: Iterable<string>,
): Promise<HostedRepoItem[]> {
	if (!userId) return [];
	const known = new Set([...githubFullNames].map((name) => name.toLowerCase()));
	const hosted = await listUserRepositories(userId);
	return hosted
		.filter((record) => !known.has(`${record.owner}/${record.name}`.toLowerCase()))
		.map(asRepoItem);
}

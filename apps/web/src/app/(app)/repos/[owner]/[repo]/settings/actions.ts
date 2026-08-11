"use server";

import { getOctokit } from "@/lib/github";
import { getServerSession } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { invalidateRepoCache } from "@/lib/repo-data-cache-vc";
import { hostedRepo } from "@/lib/repos/hosted-source";
import {
	deleteHostedRepository,
	type HostedSettingsPatch,
	updateHostedRepository,
} from "@/lib/repos/settings";

/**
 * A repository we host keeps its settings in our own row, so every write below
 * asks who owns the repository first and only falls through to GitHub for the
 * ones GitHub still owns.
 */
async function saveHosted(owner: string, repo: string, patch: HostedSettingsPatch) {
	const hosted = await hostedRepo(owner, repo);
	if (!hosted) return null;

	const session = await getServerSession();
	const result = await updateHostedRepository(hosted, session?.user?.id ?? null, patch);
	if (!result.ok) return { success: false as const, error: result.error };

	const name = result.record.name;
	invalidateRepoCache(owner, repo);
	if (name !== repo) invalidateRepoCache(owner, name);
	revalidatePath(`/repos/${owner}/${name}`, "layout");
	return { success: true as const, newName: name };
}

export async function updateRepoSettings(
	owner: string,
	repo: string,
	settings: {
		name?: string;
		description?: string;
		homepage?: string;
		private?: boolean;
		has_wiki?: boolean;
		has_issues?: boolean;
		has_projects?: boolean;
		has_discussions?: boolean;
		allow_merge_commit?: boolean;
		allow_squash_merge?: boolean;
		allow_rebase_merge?: boolean;
		delete_branch_on_merge?: boolean;
	},
) {
	const hosted = await saveHosted(owner, repo, {
		...(settings.name === undefined ? {} : { name: settings.name }),
		...(settings.description === undefined
			? {}
			: { description: settings.description || null }),
		...(settings.homepage === undefined ? {} : { homepage: settings.homepage || null }),
		...(settings.private === undefined ? {} : { isPrivate: settings.private }),
	});
	if (hosted) return hosted;

	const octokit = await getOctokit();
	if (!octokit) return { success: false, error: "Not authenticated" };
	try {
		const { data } = await octokit.repos.update({
			owner,
			repo,
			...settings,
		});
		invalidateRepoCache(owner, repo);
		if (settings.name && settings.name !== repo) {
			invalidateRepoCache(owner, settings.name);
		}
		revalidatePath(`/repos/${owner}/${data.name}`);
		return { success: true, newName: data.name };
	} catch (e: unknown) {
		const message = e instanceof Error ? e.message : "Failed to update repository";
		return { success: false, error: message };
	}
}

export async function updateRepoTopics(owner: string, repo: string, topics: string[]) {
	const hosted = await saveHosted(owner, repo, { topics });
	if (hosted) return hosted;

	const octokit = await getOctokit();
	if (!octokit) return { success: false, error: "Not authenticated" };
	try {
		await octokit.repos.replaceAllTopics({ owner, repo, names: topics });
		invalidateRepoCache(owner, repo);
		revalidatePath(`/repos/${owner}/${repo}`);
		return { success: true };
	} catch (e: unknown) {
		const message = e instanceof Error ? e.message : "Failed to update topics";
		return { success: false, error: message };
	}
}

export async function updateDefaultBranch(owner: string, repo: string, branch: string) {
	const hosted = await saveHosted(owner, repo, { defaultBranch: branch });
	if (hosted) return hosted;

	const octokit = await getOctokit();
	if (!octokit) return { success: false, error: "Not authenticated" };
	try {
		await octokit.repos.update({ owner, repo, default_branch: branch });
		invalidateRepoCache(owner, repo);
		revalidatePath(`/repos/${owner}/${repo}`);
		return { success: true };
	} catch (e: unknown) {
		const message = e instanceof Error ? e.message : "Failed to update default branch";
		return { success: false, error: message };
	}
}

/** Archiving is reversible here, unlike on GitHub, so it takes the new state. */
export async function setRepositoryArchived(owner: string, repo: string, archived: boolean) {
	const hosted = await saveHosted(owner, repo, { archived });
	if (hosted) return hosted;

	const octokit = await getOctokit();
	if (!octokit) return { success: false, error: "Not authenticated" };
	try {
		await octokit.repos.update({ owner, repo, archived });
		invalidateRepoCache(owner, repo);
		revalidatePath(`/repos/${owner}/${repo}`);
		return { success: true };
	} catch (e: unknown) {
		const message = e instanceof Error ? e.message : "Failed to archive repository";
		return { success: false, error: message };
	}
}

export async function deleteRepository(owner: string, repo: string) {
	const hosted = await hostedRepo(owner, repo);
	if (hosted) {
		const session = await getServerSession();
		const result = await deleteHostedRepository(hosted, session?.user?.id ?? null);
		if (!result.ok) return { success: false, error: result.error };
		invalidateRepoCache(owner, repo);
		return { success: true };
	}

	const octokit = await getOctokit();
	if (!octokit) return { success: false, error: "Not authenticated" };
	try {
		await octokit.repos.delete({ owner, repo });
		invalidateRepoCache(owner, repo);
		return { success: true };
	} catch (e: unknown) {
		const message = e instanceof Error ? e.message : "Failed to delete repository";
		return { success: false, error: message };
	}
}

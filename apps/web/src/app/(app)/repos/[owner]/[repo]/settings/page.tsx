import { Settings, ShieldAlert } from "lucide-react";
import { getRepo, getRepoBranches, extractRepoPermissions } from "@/lib/github";
import { getServerSession } from "@/lib/auth";
import { hostedRepo } from "@/lib/repos/hosted-source";
import { RepoSettings } from "@/components/repo/repo-settings";

function Notice({
	icon: Icon,
	title,
	detail,
}: {
	icon: typeof Settings;
	title: string;
	detail: string;
}) {
	return (
		<div className="py-16 text-center">
			<Icon className="w-6 h-6 text-muted-foreground/30 mx-auto mb-3" />
			<h2 className="text-sm font-medium text-muted-foreground/70">{title}</h2>
			<p className="text-xs text-muted-foreground/50 font-mono mt-1">{detail}</p>
		</div>
	);
}

export default async function SettingsPage({
	params,
}: {
	params: Promise<{ owner: string; repo: string }>;
}) {
	const { owner, repo } = await params;
	const session = await getServerSession();

	if (!session) {
		return (
			<Notice
				icon={Settings}
				title="Settings"
				detail="Sign in to access repository settings"
			/>
		);
	}

	// Repositories we host answer from our own record, so their settings load
	// and save with no GitHub call.
	const [hosted, repoData] = await Promise.all([
		hostedRepo(owner, repo),
		getRepo(owner, repo),
	]);

	if (!repoData) {
		return (
			<Notice
				icon={Settings}
				title="Settings"
				detail="Failed to load repository data"
			/>
		);
	}

	if (!extractRepoPermissions(repoData).admin) {
		return (
			<Notice
				icon={ShieldAlert}
				title="Access Denied"
				detail="You need admin permissions to access repository settings"
			/>
		);
	}

	const branchesData = await getRepoBranches(owner, repo);
	const branches = (branchesData ?? []).map((b: { name: string }) => b.name);

	return (
		<RepoSettings
			owner={owner}
			repo={repo}
			hosted={hosted !== null}
			repoData={{
				name: repoData.name,
				description: repoData.description ?? null,
				homepage: repoData.homepage ?? null,
				private: repoData.private,
				archived: repoData.archived,
				topics: repoData.topics ?? [],
				default_branch: repoData.default_branch,
				has_wiki: repoData.has_wiki ?? false,
				has_issues: repoData.has_issues ?? false,
				has_projects: repoData.has_projects ?? false,
				has_discussions: repoData.has_discussions ?? false,
				allow_merge_commit: repoData.allow_merge_commit ?? true,
				allow_squash_merge: repoData.allow_squash_merge ?? true,
				allow_rebase_merge: repoData.allow_rebase_merge ?? true,
				delete_branch_on_merge: repoData.delete_branch_on_merge ?? false,
			}}
			branches={branches}
		/>
	);
}

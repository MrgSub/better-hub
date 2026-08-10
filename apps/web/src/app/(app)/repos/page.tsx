import type { Metadata } from "next";
import { getUserRepos } from "@/lib/github";
import { getServerSession } from "@/lib/auth";
import { listUserRepositories } from "@/lib/repos/registry";
import { ReposContent } from "@/components/repos/repos-content";

export const metadata: Metadata = {
	title: "Repositories",
};

export default async function ReposPage() {
	const session = await getServerSession();
	const userId = session?.user?.id;

	const [repos, hosted] = await Promise.all([
		getUserRepos("updated", 50),
		userId ? listUserRepositories(userId) : Promise.resolve([]),
	]);

	// Repositories that only exist here (forks, imports of upstreams the viewer
	// can no longer see) would otherwise be invisible.
	const known = new Set(repos.map((r) => r.full_name.toLowerCase()));
	const extra = hosted
		.filter((r) => !known.has(`${r.owner}/${r.name}`.toLowerCase()))
		.map((r) => ({
			id: r.id,
			name: r.name,
			full_name: `${r.owner}/${r.name}`,
			description: r.description,
			html_url: `/${r.owner}/${r.name}`,
			stargazers_count: 0,
			forks_count: 0,
			language: null,
			updated_at: r.updatedAt.toISOString(),
			pushed_at: r.updatedAt.toISOString(),
			private: r.isPrivate,
			fork: r.forkOfId !== null,
			archived: r.archived,
			open_issues_count: 0,
			owner: { login: r.owner, avatar_url: `https://github.com/${r.owner}.png` },
		}));

	return <ReposContent repos={[...extra, ...repos]} />;
}

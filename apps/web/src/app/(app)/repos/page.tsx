import type { Metadata } from "next";
import { getUserRepos } from "@/lib/github";
import { getServerSession } from "@/lib/auth";
import { hostedOnlyRepositories } from "@/lib/repos/user-repos";
import { ReposContent } from "@/components/repos/repos-content";

export const metadata: Metadata = {
	title: "Repositories",
};

export default async function ReposPage() {
	const session = await getServerSession();
	const repos = await getUserRepos("updated", 50);
	const hosted = await hostedOnlyRepositories(
		session?.user?.id,
		repos.map((r) => r.full_name),
	);

	return <ReposContent repos={[...hosted, ...repos]} />;
}

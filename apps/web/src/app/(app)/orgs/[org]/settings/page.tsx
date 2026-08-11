import type { Metadata } from "next";
import { ShieldAlert } from "lucide-react";
import { AgentSettings } from "@/components/settings/agent-settings";
import { connectionView, findAgentConnection } from "@/lib/agents/connection";
import { administeredNamespace } from "@/lib/agents/namespace";
import { getServerSession } from "@/lib/auth";

/** Depends on who is asking, so it must not be cached across users. */
export const dynamic = "force-dynamic";

export async function generateMetadata({
	params,
}: {
	params: Promise<{ org: string }>;
}): Promise<Metadata> {
	const { org } = await params;
	return { title: `Settings · ${org}` };
}

function Denied({ message }: { message: string }) {
	return (
		<div className="py-16 text-center">
			<ShieldAlert className="w-6 h-6 text-muted-foreground/30 mx-auto mb-3" />
			<h2 className="text-sm font-medium text-muted-foreground/70">Settings</h2>
			<p className="text-xs text-muted-foreground/50 font-mono mt-1">{message}</p>
		</div>
	);
}

export default async function OrgSettingsPage({ params }: { params: Promise<{ org: string }> }) {
	const { org } = await params;
	const session = await getServerSession();
	const userId = session?.user?.id;
	if (!userId) return <Denied message="Sign in to access settings" />;

	const namespace = await administeredNamespace(org, userId);
	if (!namespace) {
		return (
			<Denied
				message={`You need admin access to ${org} to change its settings`}
			/>
		);
	}

	const connection = connectionView(await findAgentConnection(namespace.scope));

	return (
		<div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
			<div>
				<h1 className="text-sm font-medium text-foreground/90">{org}</h1>
				<p className="text-[10px] text-muted-foreground mt-0.5">
					{namespace.isOrganization
						? "Organization settings"
						: "Settings for your own repositories"}
				</p>
			</div>
			<AgentSettings login={org} connection={connection} />
		</div>
	);
}

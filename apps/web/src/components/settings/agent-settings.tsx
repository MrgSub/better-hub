"use client";

import { useState, useTransition } from "react";
import { KeyRound, Sparkles, Trash2 } from "lucide-react";
import {
	removeAgentConnection,
	updateAgentConnection,
} from "@/app/(app)/orgs/[org]/settings/actions";
import { SaveFooter, SectionCard, SectionHeader, Toggle } from "./primitives";
import { cn } from "@/lib/utils";
import type { AgentConnectionView, AgentProvider } from "@/lib/agents/connection";

/**
 * Connecting Devin or Cursor to resolve merge conflicts.
 *
 * The thing worth being explicit about in the UI is what is *not* being granted:
 * an agent is sent the conflicted text and answers with file contents, and every
 * branch and commit is written by us, so no repository access changes hands and
 * nothing lands without a human merging it.
 */

const PROVIDERS: {
	id: AgentProvider;
	label: string;
	detail: string;
	keyHint?: string;
	keyUrl?: string;
}[] = [
	{
		id: "model",
		label: "Built-in model",
		detail: "Resolves with Better Hub's own model, billed as usual.",
	},
	{
		id: "devin",
		label: "Devin",
		detail: "Resolves in a Devin session using your organization's API key.",
		keyHint: "Devin API key",
		keyUrl: "https://app.devin.ai/settings/api-keys",
	},
	{
		id: "cursor",
		label: "Cursor",
		detail: "Resolves in a Cursor cloud agent using your organization's API key.",
		keyHint: "Cursor API key",
		keyUrl: "https://cursor.com/dashboard/api",
	},
];

export function AgentSettings({
	login,
	connection,
}: {
	login: string;
	connection: AgentConnectionView;
}) {
	const [provider, setProvider] = useState<AgentProvider>(connection.provider);
	const [enabled, setEnabled] = useState(connection.enabled);
	const [apiKey, setApiKey] = useState("");
	const [hasKey, setHasKey] = useState(connection.hasKey);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState<string | null>(null);
	const [pending, startTransition] = useTransition();

	const selected = PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0];
	const needsKey = provider !== "model";
	// Switching provider invalidates the stored key, so the field is required again.
	const keyOnFile = hasKey && provider === connection.provider;

	function run(action: () => Promise<{ success: true } | { error: string }>, done: string) {
		setError(null);
		setSuccess(null);
		startTransition(async () => {
			const result = await action();
			if ("error" in result) {
				setError(result.error);
				return;
			}
			setSuccess(done);
		});
	}

	return (
		<SectionCard>
			<SectionHeader
				icon={Sparkles}
				title="Merge conflict resolution"
				description={`Let an agent propose a resolution when a pull request in ${login} conflicts.`}
			/>

			<div className="rounded-md border border-border/30 divide-y divide-border/20">
				{PROVIDERS.map((p) => (
					<label
						key={p.id}
						className={cn(
							"flex items-start gap-2.5 px-3 py-2.5 cursor-pointer transition-colors",
							provider === p.id
								? "bg-muted/40 dark:bg-white/[0.03]"
								: "hover:bg-muted/25",
						)}
					>
						<input
							type="radio"
							name="agent-provider"
							checked={provider === p.id}
							onChange={() => setProvider(p.id)}
							className="mt-0.5 accent-foreground"
						/>
						<span className="min-w-0">
							<span className="block text-xs font-medium text-foreground/85">
								{p.label}
							</span>
							<span className="block text-[10px] text-muted-foreground mt-0.5">
								{p.detail}
							</span>
						</span>
					</label>
				))}
			</div>

			{needsKey && (
				<div className="mt-3">
					<label className="flex items-center gap-1.5 text-[10px] text-muted-foreground mb-1.5">
						<KeyRound className="w-3 h-3" />
						{selected.keyHint}
						{selected.keyUrl && (
							<a
								href={selected.keyUrl}
								target="_blank"
								rel="noreferrer"
								className="underline hover:text-foreground/70"
							>
								get one
							</a>
						)}
					</label>
					<input
						type="password"
						value={apiKey}
						onChange={(e) => setApiKey(e.target.value)}
						autoComplete="off"
						placeholder={
							keyOnFile
								? "•••••••• stored"
								: "Paste the API key"
						}
						className="w-full rounded-md border border-border/40 bg-transparent px-2.5 py-1.5 text-xs font-mono outline-none focus:border-border"
					/>
					<p className="text-[10px] text-muted-foreground/70 mt-1.5 leading-relaxed">
						Stored encrypted and never shown again. The agent is
						sent only the conflicted text — it needs no access
						to your repositories, because the resolution branch
						is committed by Better Hub and still has to be
						merged by a person.
					</p>
				</div>
			)}

			<div className="mt-3 rounded-md border border-border/30 px-3 py-2.5 flex items-center justify-between gap-4">
				<div className="min-w-0">
					<span className="text-xs font-medium text-foreground/85">
						Resolve conflicts automatically
					</span>
					<p className="text-[10px] text-muted-foreground mt-0.5">
						Off by default. When on, anyone with write access
						can ask {selected.label} to propose a resolution.
					</p>
				</div>
				<Toggle
					checked={enabled}
					onChange={setEnabled}
					disabled={pending}
				/>
			</div>

			<SaveFooter
				onClick={() =>
					run(
						async () => {
							const result = await updateAgentConnection(
								login,
								{
									provider,
									enabled,
									apiKey: apiKey || undefined,
								},
							);
							if ("success" in result) {
								setHasKey(result.connection.hasKey);
								setApiKey("");
							}
							return result;
						},
						enabled
							? `${selected.label} connected`
							: "Saved, resolution off",
					)
				}
				pending={pending}
				error={error}
				success={success}
			/>

			{(connection.hasKey || connection.enabled) && (
				<button
					type="button"
					disabled={pending}
					onClick={() =>
						run(async () => {
							const result =
								await removeAgentConnection(login);
							if ("success" in result) {
								setProvider("model");
								setEnabled(false);
								setHasKey(false);
								setApiKey("");
							}
							return result;
						}, "Disconnected")
					}
					className="mt-3 inline-flex items-center gap-1.5 text-[10px] text-destructive/70 hover:text-destructive transition-colors cursor-pointer disabled:opacity-50"
				>
					<Trash2 className="w-3 h-3" />
					Disconnect and delete the stored key
				</button>
			)}
		</SectionCard>
	);
}

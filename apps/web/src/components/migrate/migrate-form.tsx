"use client";

import { AlertCircle, ArrowLeft, Check, Copy, ExternalLink, Lock } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";

interface Upstream {
	owner: string;
	name: string;
	private: boolean;
	defaultBranch: string;
	description: string | null;
	sizeKb: number;
}

/** What the server will do with this upstream, decided before we import. */
interface Plan {
	decision: { kind: "create" | "join" | "fork" };
	destinationOwner: string;
	existing: { owner: string; name: string } | null;
}

interface Migrated {
	outcome: Plan["decision"]["kind"];
	repo: { owner: string; name: string; defaultBranch: string };
	cloneUrl: string;
	agentPrompt: string;
}

const planCopy: Record<Plan["decision"]["kind"], { note: string; action: string }> = {
	create: {
		note: "",
		action: "Migrate to Orkd",
	},
	join: {
		note: "Someone already migrated this repository. You have write access on GitHub, so you'll be added to the existing one instead of copying it again.",
		action: "Join this repository",
	},
	fork: {
		note: "You can read this repository but not write to it, so it lands in your own namespace as a fork.",
		action: "Fork to your account",
	},
};

type Step = "input" | "confirm" | "migrating" | "done";

const inputClass =
	"w-full bg-transparent border border-border px-3 py-1.5 text-xs font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:border-foreground/20 focus:ring-[3px] focus:ring-ring/50 transition-colors rounded-md";

const labelClass =
	"text-[11px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5 block";

function CopyButton({ value, label }: { value: string; label: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			onClick={() => {
				void navigator.clipboard.writeText(value);
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			}}
			className="inline-flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
		>
			{copied ? <Check className="size-3" /> : <Copy className="size-3" />}
			{copied ? "Copied" : label}
		</button>
	);
}

export function MigrateForm() {
	const [step, setStep] = useState<Step>("input");
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [grantUrl, setGrantUrl] = useState<string | null>(null);

	const [upstream, setUpstream] = useState<Upstream | null>(null);
	const [plan, setPlan] = useState<Plan | null>(null);
	const [destinationOwner, setDestinationOwner] = useState("");
	const [name, setName] = useState("");
	const [defaultBranch, setDefaultBranch] = useState("");
	const [mirror, setMirror] = useState(false);
	const [result, setResult] = useState<Migrated | null>(null);

	const kind = plan?.decision.kind ?? "create";
	const joining = kind === "join";

	async function resolve() {
		setBusy(true);
		setError("");
		setGrantUrl(null);
		try {
			const res = await fetch(`/api/migrate?repo=${encodeURIComponent(input)}`);
			const data = await res.json();
			if (!res.ok) {
				setError(data.error ?? "Could not read that repository");
				return;
			}
			if (data.needsAccess) {
				setGrantUrl(data.grantUrl);
				setError(
					`We can't see ${data.target.owner}/${data.target.name}. If it's private, grant access to it on GitHub and try again.`,
				);
				return;
			}
			setUpstream(data.upstream);
			setPlan(data.plan);
			setDestinationOwner(data.plan.destinationOwner);
			setName(data.plan.existing?.name ?? data.upstream.name);
			setDefaultBranch(data.upstream.defaultBranch);
			setStep("confirm");
		} catch {
			setError("Network error. Please try again.");
		} finally {
			setBusy(false);
		}
	}

	async function migrate() {
		setStep("migrating");
		setError("");
		try {
			const res = await fetch("/api/migrate", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ repo: input, name, defaultBranch, mirror }),
			});
			const data = await res.json();
			if (!res.ok) {
				if (data.needsAccess) setGrantUrl(data.grantUrl);
				setError(data.error ?? "Migration failed");
				setStep("confirm");
				return;
			}
			setResult(data);
			setStep("done");
		} catch {
			setError("Network error. Please try again.");
			setStep("confirm");
		}
	}

	return (
		<div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
			<div className="max-w-2xl w-full mx-auto px-4 sm:px-0 py-6">
				<Link
					href="/repos"
					className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-4"
				>
					<ArrowLeft className="size-3" />
					Repositories
				</Link>

				<h1 className="text-xl font-medium tracking-tight mb-1">
					Migrate a repository
				</h1>
				<p className="text-xs text-muted-foreground mb-6">
					Paste a GitHub repository and we'll import its full history.
					Private repositories are read with your own GitHub access.
				</p>

				{(step === "input" || step === "confirm") && (
					<div className="space-y-4">
						<div>
							<label
								className={labelClass}
								htmlFor="migrate-source"
							>
								Repository
							</label>
							<input
								id="migrate-source"
								className={inputClass}
								placeholder="owner/name or https://github.com/owner/name"
								value={input}
								onChange={(e) => {
									setInput(e.target.value);
									setStep("input");
									setError("");
								}}
								onKeyDown={(e) => {
									if (
										e.key === "Enter" &&
										input.trim()
									)
										void resolve();
								}}
							/>
						</div>

						{step === "confirm" && upstream && (
							<div className="border border-border rounded-md divide-y divide-border">
								<div className="px-3 py-2.5 flex items-center gap-2">
									<span className="text-xs font-mono">
										{upstream.owner}/
										{upstream.name}
									</span>
									{upstream.private && (
										<span className="inline-flex items-center gap-1 text-[10px] font-mono text-muted-foreground">
											<Lock className="size-2.5" />
											private
										</span>
									)}
									<span className="ml-auto text-[10px] font-mono text-muted-foreground/60 tabular-nums">
										{Math.round(
											upstream.sizeKb /
												1024,
										)}{" "}
										MB
									</span>
								</div>
								<div className="px-3 py-3 grid gap-3 sm:grid-cols-2">
									<div>
										<label
											className={
												labelClass
											}
											htmlFor="migrate-name"
										>
											Destination
										</label>
										<div className="flex items-center gap-1">
											<span className="text-xs font-mono text-muted-foreground shrink-0">
												{
													destinationOwner
												}
												/
											</span>
											<input
												id="migrate-name"
												className={
													inputClass
												}
												value={
													name
												}
												disabled={
													joining
												}
												onChange={(
													e,
												) =>
													setName(
														e
															.target
															.value,
													)
												}
											/>
										</div>
									</div>
									<div>
										<label
											className={
												labelClass
											}
											htmlFor="migrate-branch"
										>
											Default
											branch
										</label>
										<input
											id="migrate-branch"
											className={
												inputClass
											}
											value={
												defaultBranch
											}
											disabled={
												joining
											}
											onChange={(
												e,
											) =>
												setDefaultBranch(
													e
														.target
														.value,
												)
											}
										/>
										<p className="text-[10px] text-muted-foreground/60 mt-1 font-mono">
											upstream:{" "}
											{
												upstream.defaultBranch
											}
										</p>
									</div>
								</div>
								{!joining && (
									<label className="flex items-start gap-2 px-3 py-2.5 border-t border-border cursor-pointer">
										<input
											type="checkbox"
											className="mt-0.5 size-3 accent-foreground"
											checked={
												mirror
											}
											onChange={(
												e,
											) =>
												setMirror(
													e
														.target
														.checked,
												)
											}
										/>
										<span className="space-y-1">
											<span className="block text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
												Mirror
												branches
												and
												tags
												back
												to
												GitHub
											</span>
											<span className="block text-[11px] text-muted-foreground">
												Keeps
												the
												GitHub
												repository
												up
												to
												date
												so
												its
												Actions
												and
												deploy
												hooks
												keep
												firing.
												Issues
												and
												pull
												requests
												are
												not
												mirrored,
												and
												this
												needs
												the
												GitHub
												App
												installed
												on
												the
												upstream.
											</span>
										</span>
									</label>
								)}
								{planCopy[kind].note && (
									<p className="px-3 py-2.5 text-[11px] text-muted-foreground">
										{
											planCopy[
												kind
											].note
										}
									</p>
								)}
							</div>
						)}

						{error && (
							<div className="flex items-start gap-2 px-3 py-2 rounded-md bg-destructive/5 border border-destructive/20">
								<AlertCircle className="size-3.5 text-destructive shrink-0 mt-0.5" />
								<div className="space-y-2">
									<p className="text-xs text-destructive">
										{error}
									</p>
									{grantUrl && (
										<a
											href={
												grantUrl
											}
											target="_blank"
											rel="noreferrer"
											className="inline-flex items-center gap-1.5 text-[11px] font-mono text-foreground hover:underline"
										>
											Grant access
											on GitHub
											<ExternalLink className="size-3" />
										</a>
									)}
								</div>
							</div>
						)}

						{step === "confirm" ? (
							<Button
								className="w-full"
								disabled={
									!name.trim() ||
									!defaultBranch.trim()
								}
								onClick={() => void migrate()}
							>
								{planCopy[kind].action}
							</Button>
						) : (
							<Button
								className="w-full"
								disabled={!input.trim() || busy}
								onClick={() => void resolve()}
							>
								{grantUrl
									? "Try again"
									: "Continue"}
							</Button>
						)}
					</div>
				)}

				{step === "migrating" && (
					<div className="space-y-3">
						<div className="h-9 rounded-md bg-muted/50 animate-pulse" />
						<div className="h-24 rounded-md bg-muted/50 animate-pulse" />
						<p className="text-xs text-muted-foreground">
							{joining
								? "Adding you to the existing repository."
								: "Importing history from GitHub. Large repositories take a moment."}
						</p>
					</div>
				)}

				{step === "done" && result && (
					<div className="space-y-5">
						<div className="flex items-center gap-2 px-3 py-2 rounded-md border border-border">
							<Check className="size-3.5 text-foreground" />
							<span className="text-xs font-mono">
								{result.repo.owner}/
								{result.repo.name}
							</span>
							{result.outcome !== "create" && (
								<span className="text-[10px] font-mono text-muted-foreground">
									{result.outcome === "join"
										? "joined"
										: "fork"}
								</span>
							)}
							<span className="ml-auto text-[10px] font-mono text-muted-foreground/60">
								default {result.repo.defaultBranch}
							</span>
						</div>

						<div>
							<div className="flex items-center justify-between mb-1.5">
								<span className={labelClass}>
									Point your clone at it
								</span>
								<CopyButton
									value={`git remote set-url origin ${result.cloneUrl}`}
									label="Copy command"
								/>
							</div>
							<pre className="text-[11px] font-mono bg-muted/40 p-3 rounded-md overflow-x-auto">
								git remote set-url origin{" "}
								{result.cloneUrl}
							</pre>
							<p className="text-[10px] text-muted-foreground/60 mt-1.5">
								This URL carries a short-lived
								credential and expires in an hour.
							</p>
						</div>

						<div>
							<div className="flex items-center justify-between mb-1.5">
								<span className={labelClass}>
									Prompt for your coding agent
								</span>
								<CopyButton
									value={result.agentPrompt}
									label="Copy prompt"
								/>
							</div>
							<pre className="text-[11px] font-mono bg-muted/40 p-3 rounded-md overflow-x-auto whitespace-pre-wrap">
								{result.agentPrompt}
							</pre>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

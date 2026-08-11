"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The shared vocabulary of a settings page: a card, its header, a switch and a
 * save footer. Repository and organization settings look the same because they
 * are the same components, not because two files were kept in step by hand.
 */

export function Toggle({
	checked,
	onChange,
	disabled,
}: {
	checked: boolean;
	onChange: (v: boolean) => void;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className={cn(
				"relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full transition-colors cursor-pointer",
				checked ? "bg-foreground" : "bg-muted-foreground/20",
				disabled && "opacity-40 cursor-not-allowed",
			)}
		>
			<span
				className={cn(
					"pointer-events-none block h-3 w-3 rounded-full transition-all duration-200",
					checked
						? "translate-x-[17px] bg-background"
						: "translate-x-[3px] bg-muted-foreground/60",
				)}
			/>
		</button>
	);
}

export function SectionCard({
	children,
	variant = "default",
	dashed = false,
	className,
}: {
	children: React.ReactNode;
	variant?: "default" | "danger";
	dashed?: boolean;
	className?: string;
}) {
	return (
		<section
			className={cn(
				"relative rounded-md p-4 overflow-hidden",
				dashed ? "border border-dashed" : "border",
				variant === "danger" ? "border-destructive/15" : "border-border/30",
				className,
			)}
		>
			{children}
		</section>
	);
}

export function SectionHeader({
	icon: Icon,
	title,
	description,
	variant = "default",
}: {
	icon: React.ComponentType<{ className?: string }>;
	title: string;
	description?: string;
	variant?: "default" | "danger";
}) {
	return (
		<div className="mb-4">
			<div className="flex items-center gap-2">
				<div
					className={cn(
						"flex items-center justify-center w-6 h-6 rounded border",
						variant === "danger"
							? "border-destructive/20 bg-destructive/5"
							: "border-border/40 bg-muted/50 dark:bg-white/[0.03]",
					)}
				>
					<Icon
						className={cn(
							"w-3 h-3",
							variant === "danger"
								? "text-destructive/60"
								: "text-muted-foreground/50",
						)}
					/>
				</div>
				<div>
					<h3
						className={cn(
							"text-xs font-medium",
							variant === "danger"
								? "text-destructive/80"
								: "text-foreground/90",
						)}
					>
						{title}
					</h3>
					{description && (
						<p className="text-[10px] text-muted-foreground mt-0.5">
							{description}
						</p>
					)}
				</div>
			</div>
		</div>
	);
}

export function SaveFooter({
	onClick,
	pending,
	disabled,
	error,
	success,
}: {
	onClick: () => void;
	pending: boolean;
	disabled?: boolean;
	error: string | null;
	success: string | null;
}) {
	return (
		<div className="flex items-center gap-3 mt-4 pt-3 border-t border-dashed border-border/25">
			<button
				onClick={onClick}
				disabled={pending || disabled}
				className={cn(
					"inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-xs font-medium transition-all cursor-pointer",
					pending || disabled
						? "bg-muted/50 text-muted-foreground/25 cursor-not-allowed"
						: "bg-foreground text-background hover:opacity-90 active:scale-[0.98]",
				)}
			>
				{pending ? (
					<>
						<svg
							className="w-3 h-3 animate-spin"
							viewBox="0 0 16 16"
							fill="none"
						>
							<circle
								cx="8"
								cy="8"
								r="6"
								stroke="currentColor"
								strokeWidth="2"
								strokeDasharray="28"
								strokeDashoffset="8"
								strokeLinecap="round"
							/>
						</svg>
						Saving...
					</>
				) : (
					"Save changes"
				)}
			</button>
			{error && <span className="text-[10px] text-destructive/80">{error}</span>}
			{success && (
				<span className="inline-flex items-center gap-1 text-[10px] text-emerald-500/80">
					<Check className="w-3 h-3" />
					{success}
				</span>
			)}
		</div>
	);
}

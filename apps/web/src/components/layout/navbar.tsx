"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
	LogOut,
	ExternalLink,
	Search,
	Sun,
	Moon,
	User,
	Command,
	Settings,
	Bell,
	Store,
	Book,
	Import,
} from "lucide-react";
import dynamic from "next/dynamic";

const CommandMenu = dynamic(() => import("@/components/command-menu").then((m) => m.CommandMenu));
import { useColorTheme } from "@/components/theme/theme-provider";
import { signOut } from "@/lib/auth-client";
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuGroup,
	DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import type { TabId } from "@/components/settings/settings-content";
import { NavbarGhostButton } from "@/components/shared/floating-ghost-button";
import { useMutationEvents } from "@/components/shared/mutation-event-provider";
import { useNavVisibility } from "@/components/shared/nav-visibility-provider";
import { cn } from "@/lib/utils";
import { NotificationSheet } from "@/components/layout/notification-sheet";
import { $Session } from "@/lib/auth";
import type { NotificationItem } from "@/lib/github-types";
import { APP_ROUTES } from "@/app-routes";
import { LogoGlyph } from "@/components/ui/logo";

interface AppNavbarProps {
	session: $Session;
	notifications: NotificationItem[];
}

export function AppNavbar({ session, notifications }: AppNavbarProps) {
	const { mode, toggleMode } = useColorTheme();
	const { subscribe } = useMutationEvents();
	const { isNavHidden } = useNavVisibility();
	const pathname = usePathname();
	const segments = pathname.split("/").filter(Boolean);
	const isRepoPage = segments.length >= 2 && !APP_ROUTES.has(segments[0]);
	const gh = session.githubUser;
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [settingsTab, setSettingsTab] = useState<TabId | undefined>();
	const [notifOpen, setNotifOpen] = useState(false);
	const [doneIds, setDoneIds] = useState<Set<string>>(new Set());

	useEffect(() => {
		return subscribe((event) => {
			if (event.type === "notification:read") {
				setDoneIds((prev) => new Set([...prev, event.id]));
			} else if (event.type === "notification:all-read") {
				setDoneIds((prev) => new Set([...prev, ...event.ids]));
			} else if (event.type === "settings:open") {
				setSettingsTab(event.tab as TabId | undefined);
				setSettingsOpen(true);
			}
		});
	}, [subscribe]);

	const visibleNotifs = notifications.filter((n) => !doneIds.has(n.id));
	const unreadCount = visibleNotifs.filter((n) => n.unread).length;

	return (
		<header
			className={cn(
				"fixed top-0 h-10 flex w-full flex-col bg-background backdrop-blur-lg z-10 transition-transform duration-200 ease-out",
				isNavHidden && "-translate-y-full",
			)}
		>
			<nav
				className={cn(
					"top-0 flex h-full items-center justify-between border-border px-2 sm:px-4",
					!isRepoPage && "border-b",
				)}
			>
				<div className="flex items-center gap-0" id="navbar-breadcrumb">
					<Link
						className="shrink-0 flex items-center text-foreground gap-1.5 transition-colors text-xs tracking-tight"
						href="/dashboard"
					>
						<LogoGlyph />

						<span className="text-sm tracking-tight text-foreground">
							ORKD.
						</span>
					</Link>
				</div>
				<CommandMenu />
				<div className="flex items-center gap-1.5">
					{/* Ghost AI button */}
					<NavbarGhostButton />

					{/* Notifications bell */}
					<button
						onClick={() => setNotifOpen(true)}
						className="relative shrink-0 p-1.5 text-muted-foreground hover:text-foreground transition-colors cursor-pointer outline-none"
						title="Notifications"
					>
						<Bell className="w-4 h-4" />
						{unreadCount > 0 && (
							<span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-primary" />
						)}
					</button>

					{/* User menu */}
					{session.user.image && (
						<DropdownMenu>
							<DropdownMenuTrigger
								id={`user-${session.user.id}`}
								asChild
							>
								<button
									className="relative shrink-0 cursor-pointer group p-1.5 outline-none"
									title={
										session.user.name
											? `Signed in as ${session.user.name}`
											: "Account"
									}
								>
									<img
										src={
											session.user
												.image
										}
										alt={
											session.user
												.name ||
											"User avatar"
										}
										className="w-6 h-6 rounded-full border border-border/60 dark:border-white/8 group-hover:border-foreground/20 transition-colors"
									/>
								</button>
							</DropdownMenuTrigger>
							<DropdownMenuContent
								align="end"
								className="w-64 p-0"
							>
								{/* Profile card */}
								<div className="px-3 py-3 bg-muted/30 dark:bg-white/[0.02]">
									<div className="flex items-start gap-3">
										<img
											src={
												session
													.user
													.image
											}
											alt=""
											className="w-9 h-9 rounded-full shrink-0 border border-border/40"
										/>
										<div className="flex flex-col min-w-0 gap-0.5">
											<span className="text-[12px] font-medium truncate leading-tight">
												{
													session
														.user
														.name
												}
											</span>
											{gh?.login && (
												<span className="text-[11px] font-mono text-muted-foreground truncate leading-tight">
													{
														gh.login
													}
												</span>
											)}
											{gh?.email && (
												<span className="text-[10px] text-muted-foreground/50 truncate leading-tight">
													{
														gh.email
													}
												</span>
											)}
										</div>
									</div>
									{gh && (
										<div className="flex items-center gap-3 mt-2.5 pt-2 border-t border-border/40">
											<span className="text-[10px] text-muted-foreground font-mono">
												<span className="text-foreground/80 font-medium">
													{gh.followers ??
														0}
												</span>{" "}
												followers
											</span>
											<span className="text-[10px] text-muted-foreground font-mono">
												<span className="text-foreground/80 font-medium">
													{gh.following ??
														0}
												</span>{" "}
												following
											</span>
											<span className="text-[10px] text-muted-foreground font-mono">
												<span className="text-foreground/80 font-medium">
													{gh.public_repos ??
														0}
												</span>{" "}
												repos
											</span>
										</div>
									)}
								</div>

								<DropdownMenuSeparator className="my-0" />

								{/* Navigation */}
								<DropdownMenuGroup className="p-1">
									<DropdownMenuLabel className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground/50 px-2 py-1">
										Navigation
									</DropdownMenuLabel>
									{gh?.login && (
										<DropdownMenuItem
											asChild
											className="text-[11px] gap-2 h-7"
										>
											<Link
												href={`/${gh.login}`}
											>
												<User className="w-3.5 h-3.5" />
												Your
												profile
											</Link>
										</DropdownMenuItem>
									)}
									<DropdownMenuItem
										onClick={() =>
											window.dispatchEvent(
												new CustomEvent(
													"open-cmdk-mode",
													{
														detail: "search",
													},
												),
											)
										}
										className="text-[11px] gap-2 h-7"
									>
										<Search className="w-3.5 h-3.5" />
										Search repos
										<DropdownMenuShortcut className="flex items-center gap-0.5 text-[10px] font-mono">
											<Command className="w-2 h-2" />
											/
										</DropdownMenuShortcut>
									</DropdownMenuItem>
									<DropdownMenuItem
										onClick={() =>
											window.dispatchEvent(
												new CustomEvent(
													"open-cmdk-mode",
													{
														detail: "commands",
													},
												),
											)
										}
										className="text-[11px] gap-2 h-7"
									>
										<Command className="w-3.5 h-3.5" />
										Command menu
										<DropdownMenuShortcut className="flex items-center gap-0.5 text-[10px] font-mono">
											<Command className="w-2 h-2" />
											K
										</DropdownMenuShortcut>
									</DropdownMenuItem>
									<DropdownMenuItem
										asChild
										className="text-[11px] gap-2 h-7"
									>
										<Link href="/repos">
											<Book className="w-3.5 h-3.5" />
											Your
											repositories
										</Link>
									</DropdownMenuItem>
									<DropdownMenuItem
										asChild
										className="text-[11px] gap-2 h-7"
									>
										<Link href="/migrate">
											<Import className="w-3.5 h-3.5" />
											Migrate a
											repo
										</Link>
									</DropdownMenuItem>
									<DropdownMenuItem
										asChild
										className="text-[11px] gap-2 h-7"
									>
										<Link href="/theme-store">
											<Store className="w-3.5 h-3.5" />
											Theme Store
										</Link>
									</DropdownMenuItem>
								</DropdownMenuGroup>

								<DropdownMenuSeparator className="my-0" />

								{/* Preferences */}
								<DropdownMenuGroup className="p-1">
									<DropdownMenuLabel className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground/50 px-2 py-1">
										Preferences
									</DropdownMenuLabel>
									<DropdownMenuItem
										onSelect={() =>
											setSettingsOpen(
												true,
											)
										}
										className="text-[11px] gap-2 h-7"
									>
										<Settings className="w-3.5 h-3.5" />
										Settings
									</DropdownMenuItem>
									<DropdownMenuItem
										onClick={(e) =>
											toggleMode(
												e,
											)
										}
										className="text-[11px] gap-2 h-7"
									>
										{mode === "dark" ? (
											<Sun className="w-3.5 h-3.5" />
										) : (
											<Moon className="w-3.5 h-3.5" />
										)}
										{mode === "dark"
											? "Light mode"
											: "Dark mode"}
									</DropdownMenuItem>
									{gh?.login && (
										<DropdownMenuItem
											onClick={() =>
												window.open(
													`https://github.com/${gh.login}`,
													"_blank",
												)
											}
											className="text-[11px] gap-2 h-7"
										>
											<ExternalLink className="w-3.5 h-3.5" />
											GitHub
											profile
										</DropdownMenuItem>
									)}
								</DropdownMenuGroup>

								<DropdownMenuSeparator className="my-0" />

								{/* Sign out */}
								<div className="p-1">
									<DropdownMenuItem
										onClick={() =>
											signOut({
												fetchOptions:
													{
														onSuccess: () => {
															window.location.href =
																"/";
														},
													},
											})
										}
										className="text-[11px] gap-2 h-7 text-destructive focus:text-destructive"
									>
										<LogOut className="w-3.5 h-3.5" />
										Sign out
									</DropdownMenuItem>
								</div>
							</DropdownMenuContent>
						</DropdownMenu>
					)}
				</div>
			</nav>

			<NotificationSheet
				open={notifOpen}
				onOpenChange={setNotifOpen}
				notifications={notifications}
				doneIds={doneIds}
				setDoneIds={setDoneIds}
			/>

			<SettingsDialog
				open={settingsOpen}
				onOpenChange={(open) => {
					setSettingsOpen(open);
					if (!open) setSettingsTab(undefined);
				}}
				initialTab={settingsTab}
				user={{
					name: session.user.name || "",
					email: session.user.email,
					image: session.user.image ?? null,
				}}
				githubProfile={{
					login: gh.login,
					avatar_url: gh.avatar_url,
					bio: gh.bio ?? null,
					company: gh.company ?? null,
					location: gh.location ?? null,
					blog: gh.blog ?? null,
					twitter_username: gh.twitter_username ?? null,
					public_repos: gh.public_repos ?? 0,
					followers: gh.followers ?? 0,
					following: gh.following ?? 0,
					created_at: gh.created_at ?? "",
				}}
			/>
		</header>
	);
}

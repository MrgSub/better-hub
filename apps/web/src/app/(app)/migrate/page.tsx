import type { Metadata } from "next";
import { MigrateForm } from "@/components/migrate/migrate-form";

export const metadata: Metadata = {
	title: "Migrate a repository",
};

export default function MigratePage() {
	return <MigrateForm />;
}

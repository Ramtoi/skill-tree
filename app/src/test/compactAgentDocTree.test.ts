import { describe, expect, it } from "vitest";
import { compactAgentDocTree } from "@/lib/compactAgentDocTree";
import type { AgentDocFile, AgentDocFolder } from "@/types/agentDocs";

function file(rel: string): AgentDocFile {
	return {
		rel,
		name: rel.split("/").pop() ?? rel,
		label: rel,
		absolute_path: `/p/${rel}`,
		exists: true,
		is_known: false,
		is_discovered: true,
		is_symlink: false,
		symlink_to: null,
		symlink_target_in_project: false,
		can_read: true,
		can_write: true,
		size: 1,
		modified_at: null,
		hash: "h",
		error: null,
	};
}

function dir(
	name: string,
	path: string,
	dirs: AgentDocFolder[] = [],
	files: AgentDocFile[] = [],
): AgentDocFolder {
	return { name, path, dirs, files };
}

describe("compactAgentDocTree", () => {
	it("collapses Java/Kotlin-style single-child path spines before feature branches", () => {
		const root = dir("", "", [
			dir("app", "app", [
				dir("src", "app/src", [
					dir("main", "app/src/main", [
						dir("java", "app/src/main/java", [
							dir("com", "app/src/main/java/com", [
								dir("mindpalace", "app/src/main/java/com/mindpalace", [
									dir(
										"presentation",
										"app/src/main/java/com/mindpalace/presentation",
										[
											dir(
												"board",
												"app/src/main/java/com/mindpalace/presentation/board",
												[],
												[
													file(
														"app/src/main/java/com/mindpalace/presentation/board/CLAUDE.md",
													),
												],
											),
											dir(
												"capture",
												"app/src/main/java/com/mindpalace/presentation/capture",
												[],
												[
													file(
														"app/src/main/java/com/mindpalace/presentation/capture/CLAUDE.md",
													),
												],
											),
										],
									),
								]),
							]),
						]),
					]),
				]),
			]),
		]);

		const compact = compactAgentDocTree(root);
		const spine = compact.dirs[0];

		expect(spine.displayName).toBe(
			"app/src/main/java/com/mindpalace/presentation",
		);
		expect(spine.fullPathTitle).toBe(
			"app/src/main/java/com/mindpalace/presentation",
		);
		expect(spine.dirs.map((d) => d.name)).toEqual(["board", "capture"]);
		expect(spine.dirs[0].fullPathTitle).toBe(
			"app/src/main/java/com/mindpalace/presentation/board",
		);
	});
});

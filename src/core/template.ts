import type { LinkContext } from "./types";

export function renderTemplate(template: string, context: LinkContext): string {
	return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: keyof LinkContext) => {
		const value = context[key];
		return value == null ? "" : String(value);
	});
}

export function ensureHeadingAndAppend(content: string, heading: string, renderedLink: string): string {
	const normalizedHeading = heading.trim().replace(/^#+\s*/, "") || "Links";
	const headingLine = `## ${normalizedHeading}`;
	const trimmedLink = renderedLink.trim();
	if (!trimmedLink) {
		return content;
	}
	if (content.includes(trimmedLink)) {
		return content;
	}

	const lines = content.split(/\r?\n/);
	const headingIndex = lines.findIndex((line) => line.trim() === headingLine);
	if (headingIndex === -1) {
		const separator = content.trim().length === 0 ? "" : "\n\n";
		return `${content.replace(/\s*$/, "")}${separator}${headingLine}\n\n${trimmedLink}\n`;
	}

	let insertIndex = lines.length;
	for (let i = headingIndex + 1; i < lines.length; i += 1) {
		if (/^#{1,6}\s+\S/.test(lines[i] ?? "")) {
			insertIndex = i;
			break;
		}
	}

	const before = lines.slice(0, insertIndex);
	const after = lines.slice(insertIndex);
	if ((before.at(-1) ?? "").trim() !== "") {
		before.push("");
	}
	before.push(trimmedLink);
	if (after.length > 0 && (after[0] ?? "").trim() !== "") {
		before.push("");
	}
	return [...before, ...after].join("\n");
}

export function hasExistingLink(content: string, candidates: readonly string[]): boolean {
	return candidates.some((candidate) => candidate.length > 0 && content.includes(candidate));
}

export interface LinkRemovalResult {
	content: string;
	removedCount: number;
}

export function removeLinksFromHeadingSection(content: string, heading: string, candidates: readonly string[]): LinkRemovalResult {
	const normalizedHeading = heading.trim().replace(/^#+\s*/, "") || "Links";
	const headingPattern = new RegExp(`^#{1,6}\\s+${escapeRegExp(normalizedHeading)}\\s*$`);
	const lines = content.split(/\r?\n/);
	const headingIndex = lines.findIndex((line) => headingPattern.test(line.trim()));
	if (headingIndex === -1) {
		return { content, removedCount: 0 };
	}

	let sectionEnd = lines.length;
	for (let i = headingIndex + 1; i < lines.length; i += 1) {
		if (/^#{1,6}\s+\S/.test(lines[i] ?? "")) {
			sectionEnd = i;
			break;
		}
	}

	const before = lines.slice(0, headingIndex + 1);
	const section = lines.slice(headingIndex + 1, sectionEnd);
	const after = lines.slice(sectionEnd);
	const needles = candidates.map((candidate) => candidate.trim()).filter(Boolean);
	const kept: string[] = [];
	let removedCount = 0;
	for (const line of section) {
		if (needles.some((candidate) => lineMatchesCandidate(line, candidate))) {
			removedCount += 1;
			continue;
		}
		kept.push(line);
	}

	if (removedCount === 0) {
		return { content, removedCount: 0 };
	}
	return {
		content: [...before, ...trimSectionBlankLines(kept), ...after].join("\n"),
		removedCount
	};
}

function trimSectionBlankLines(lines: string[]): string[] {
	const next = [...lines];
	while (next.length > 0 && (next[0] ?? "").trim() === "") {
		next.shift();
	}
	while (next.length > 0 && (next.at(-1) ?? "").trim() === "") {
		next.pop();
	}
	return next.length > 0 ? ["", ...next, ""] : [""];
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineMatchesCandidate(line: string, candidate: string): boolean {
	if (candidate.startsWith("[[") || candidate.startsWith("[") || candidate.startsWith("obsidian://")) {
		return line.includes(candidate);
	}
	const boundaryPattern = new RegExp(`(^|[\\s"'(<\\[]|%28)${escapeRegExp(candidate)}($|[\\s"')>\\]]|%29)`);
	return boundaryPattern.test(line);
}

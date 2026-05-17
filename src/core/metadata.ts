import type { IndexedDoc } from "./types";

export interface RawMetadata {
	path: string;
	basename: string;
	filename: string;
	ctime?: number;
	mtime: number;
	frontmatter?: Record<string, unknown>;
	outgoingLinks?: string[];
	incomingLinks?: string[];
}

export function buildIndexedDoc(id: number, raw: RawMetadata): IndexedDoc {
	const frontmatter = raw.frontmatter ?? {};
	const title = stringValue(frontmatter.title) || raw.basename;
	const tags = tagsValue(frontmatter.tags);
	return {
		id,
		path: raw.path,
		basename: raw.basename,
		filename: raw.filename,
		ctime: raw.ctime ?? raw.mtime,
		title,
		mtime: raw.mtime,
		type: stringValue(frontmatter.type),
		kind: stringValue(frontmatter.kind),
		tags,
		description: stringValue(frontmatter.description),
		url: stringValue(frontmatter.url),
		outgoingLinks: raw.outgoingLinks ?? [],
		incomingLinks: raw.incomingLinks ?? [],
		vectors: {}
	};
}

export function buildEmbeddingTexts(doc: IndexedDoc): Record<"titleFilename" | "tags" | "description", string> {
	return {
		titleFilename: [`title: ${doc.title}`, `filename: ${doc.basename}`].join("\n"),
		tags: `tags: ${doc.tags.join(", ")}`,
		description: `description: ${doc.description}`
	};
}

export function stringValue(value: unknown): string {
	if (typeof value === "string") {
		return value.trim();
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return "";
}

export function tagsValue(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.map(stringValue).filter(Boolean);
	}
	if (typeof value === "string") {
		return value.split(/[,\s]+/).map((tag) => tag.trim()).filter(Boolean);
	}
	return [];
}

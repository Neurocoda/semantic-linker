import { App, normalizePath, TFile } from "obsidian";
import type { IndexedDoc, LinkResolver } from "../core/types";
import { buildIndexedDoc } from "../core/metadata";

export class ObsidianLinkResolver implements LinkResolver {
	constructor(private readonly app: App) {}

	generateMarkdownLink(sourcePath: string, targetPath: string, alias?: string): string {
		const file = this.app.vault.getFileByPath(targetPath);
		const label = alias || file?.basename || targetPath.replace(/\.md$/i, "");
		const linktext = file
			? this.app.fileManager.generateMarkdownLink(file, sourcePath, undefined, label)
			: `[${label}](${targetPath})`;
		return linktext;
	}

	generateWikiLink(targetPath: string, alias?: string): string {
		const file = this.app.vault.getFileByPath(targetPath);
		const linktext = file
			? this.app.metadataCache.fileToLinktext(file, targetPath, true)
			: targetPath.replace(/\.md$/i, "");
		return alias ? `[[${linktext}|${alias}]]` : `[[${linktext}]]`;
	}

	getFrontmatterUrl(targetPath: string): string {
		const file = this.app.vault.getFileByPath(targetPath);
		if (!file) {
			return "";
		}
		const value = this.app.metadataCache.getFileCache(file)?.frontmatter?.url;
		return typeof value === "string" ? value : "";
	}
}

export function buildDocsFromVault(app: App): IndexedDoc[] {
	const markdownFiles = app.vault.getMarkdownFiles();
	const incoming = buildIncomingLinks(app);
	return markdownFiles.map((file, id) => {
		const cache = app.metadataCache.getFileCache(file);
		const outgoingLinks = Object.keys(app.metadataCache.resolvedLinks[file.path] ?? {});
		return buildIndexedDoc(id, {
			path: file.path,
			basename: file.basename,
			filename: file.name,
			ctime: file.stat.ctime,
			mtime: file.stat.mtime,
			frontmatter: cache?.frontmatter,
			outgoingLinks,
			incomingLinks: incoming.get(file.path) ?? []
		});
	});
}

export function getAlreadyLinkedPaths(app: App, source: TFile): Set<string> {
	const paths = new Set<string>(Object.keys(app.metadataCache.resolvedLinks[source.path] ?? {}));
	const cache = app.metadataCache.getFileCache(source);
	for (const link of cache?.links ?? []) {
		const target = app.metadataCache.getFirstLinkpathDest(link.link, source.path);
		if (target) {
			paths.add(target.path);
		}
	}
	for (const embed of cache?.embeds ?? []) {
		const target = app.metadataCache.getFirstLinkpathDest(embed.link, source.path);
		if (target) {
			paths.add(target.path);
		}
	}
	return paths;
}

export function isMarkdownFile(file: unknown): file is TFile {
	return file instanceof TFile && file.extension.toLowerCase() === "md";
}

export function pluginCachePath(filename: string): string {
	return normalizePath(`.obsidian/plugins/semantic-linker/cache/${filename}`);
}

function buildIncomingLinks(app: App): Map<string, string[]> {
	const incoming = new Map<string, string[]>();
	for (const [source, targets] of Object.entries(app.metadataCache.resolvedLinks)) {
		for (const target of Object.keys(targets)) {
			const list = incoming.get(target) ?? [];
			list.push(source);
			incoming.set(target, list);
		}
	}
	return incoming;
}

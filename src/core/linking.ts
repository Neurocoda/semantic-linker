import type { IndexedDoc, LinkResolver, UrlStrategy } from "./types";
import { renderTemplate } from "./template";

export function renderLinkForDoc(source: IndexedDoc, target: IndexedDoc, score: number, resolver: LinkResolver, template: string, strategy: UrlStrategy): string {
	const alias = target.description || target.title || target.basename;
	const markdownLink = resolver.generateMarkdownLink(source.path, target.path, alias);
	const wikiLink = resolver.generateWikiLink(target.path, alias);
	const obsidianUri = `obsidian://open?path=${encodeURIComponent(target.path)}`;
	const frontmatterUrl = resolver.getFrontmatterUrl(target.path);
	const url = selectUrl(strategy, markdownLink, wikiLink, obsidianUri, frontmatterUrl);
	return renderTemplate(template, {
		sourcePath: source.path,
		targetPath: target.path,
		title: target.title || target.basename,
		filename: target.filename,
		basename: target.basename,
		description: alias,
		url,
		wikiLink,
		markdownLink,
		obsidianUri,
		tags: target.tags.join(", "),
		score: score.toFixed(3)
	});
}

export function selectUrl(strategy: UrlStrategy, markdownLink: string, wikiLink: string, obsidianUri: string, frontmatterUrl: string): string {
	switch (strategy) {
		case "wiki-link":
			return wikiLink;
		case "obsidian-uri":
			return obsidianUri;
		case "frontmatter-url":
			return frontmatterUrl || markdownLinkTarget(markdownLink);
		case "relative-md-path":
		default:
			return markdownLinkTarget(markdownLink);
	}
}

function markdownLinkTarget(markdownLink: string): string {
	const match = markdownLink.match(/^\[[^\]]+\]\((.*)\)$/);
	return match?.[1] ?? markdownLink;
}

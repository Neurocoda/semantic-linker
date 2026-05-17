import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { DEFAULT_SETTINGS, normalizeSettings } from "./core/settings";
import type { FeedbackEvent, IndexedDoc, PluginSettings, RankingResult } from "./core/types";
import { ensureHeadingAndAppend, hasExistingLink, removeLinksFromHeadingSection } from "./core/template";
import { renderLinkForDoc } from "./core/linking";
import { recommend } from "./core/ranking";
import { RequestUrlEmbeddingProvider } from "./core/provider";
import { buildDocsFromVault, getAlreadyLinkedPaths, isMarkdownFile, ObsidianLinkResolver } from "./obsidian/adapter";
import { LocalIndexStore } from "./obsidian/indexStore";
import { SemanticLinkerSettingTab } from "./ui/settingsTab";
import { SemanticLinkerView, VIEW_TYPE_SEMANTIC_LINKER } from "./ui/view";

export interface InsertRecommendationResult {
	status: "inserted" | "existing";
	renderedLink: string;
	linkCandidates: string[];
}

export interface LinkRemovalResult {
	status: "removed" | "not-found" | "no-active-file" | "missing-target";
	removedCount: number;
	linkCandidates: string[];
	stillLinkedInContent: boolean;
}

export default class SemanticLinkerPlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;
	private indexStore!: LocalIndexStore;
	private linkResolver!: ObsidianLinkResolver;
	private syncTimer: number | null = null;
	private refreshTimer: number | null = null;
	private refreshPromise: Promise<void> | null = null;
	private syncInProgress = false;
	private pendingSync = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.indexStore = new LocalIndexStore(this.app);
		this.linkResolver = new ObsidianLinkResolver(this.app);
		await this.indexStore.load();

		this.registerView(VIEW_TYPE_SEMANTIC_LINKER, (leaf) => new SemanticLinkerView(leaf, this));
		this.addSettingTab(new SemanticLinkerSettingTab(this.app, this));

		this.addRibbonIcon("network", "Open Semantic Linker", () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open-view",
			name: "Open Semantic Linker",
			callback: () => {
				void this.activateView();
			}
		});

		this.addCommand({
			id: "rebuild-index",
			name: "Rebuild Semantic Linker index",
			callback: () => {
				void this.rebuildIndex();
			}
		});

		this.addCommand({
			id: "clear-cache",
			name: "Clear Semantic Linker cache",
			callback: () => {
				void this.clearCache();
			}
		});

		this.addCommand({
			id: "refresh-recommendations",
			name: "Refresh Semantic Linker recommendations",
			callback: () => {
				void this.refreshViews();
			}
		});

		this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
			this.scheduleIndexSync();
		}));
		this.registerEvent(this.app.vault.on("create", (file) => {
			if (isMarkdownFile(file)) this.scheduleIndexSync();
		}));
		this.registerEvent(this.app.vault.on("modify", (file) => {
			if (isMarkdownFile(file)) this.scheduleIndexSync();
		}));
		this.registerEvent(this.app.vault.on("delete", (file) => {
			if (isMarkdownFile(file)) this.scheduleIndexSync();
		}));
		this.registerEvent(this.app.vault.on("rename", (file) => {
			if (isMarkdownFile(file)) this.scheduleIndexSync();
		}));
		this.registerEvent(this.app.metadataCache.on("changed", () => {
			this.scheduleIndexSync();
		}));
		this.registerEvent(this.app.metadataCache.on("resolve", () => {
			this.scheduleIndexSync();
		}));
		this.registerEvent(this.app.metadataCache.on("resolved", () => {
			this.scheduleIndexSync();
		}));
	}

	onunload(): void {
		if (this.syncTimer !== null) {
			window.clearTimeout(this.syncTimer);
			this.syncTimer = null;
		}
		if (this.refreshTimer !== null) {
			window.clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	async loadSettings(): Promise<void> {
		this.settings = normalizeSettings(await this.loadData() as Partial<PluginSettings> | null);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async activateView(): Promise<void> {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_SEMANTIC_LINKER);
		let leaf: WorkspaceLeaf | null = leaves[0] ?? null;
		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(false);
			await leaf?.setViewState({ type: VIEW_TYPE_SEMANTIC_LINKER, active: true });
		}
		if (leaf) {
			await this.app.workspace.revealLeaf(leaf);
		}
	}

	async rebuildIndex(): Promise<void> {
		const provider = new RequestUrlEmbeddingProvider(this.settings);
		const docs = buildDocsFromVault(this.app);
		new Notice(`Semantic Linker indexing ${docs.length} notes...`);
		try {
			await this.indexStore.rebuild(docs, this.settings, provider, () => {
				this.scheduleRefreshViews(120);
			});
			new Notice("Semantic Linker index rebuilt.");
			await this.refreshViews();
		} catch (error) {
			console.error(error);
			new Notice("Semantic Linker index rebuild failed. Check provider settings and console.");
		}
	}

	async syncIndex(): Promise<void> {
		if (this.syncInProgress) {
			this.pendingSync = true;
			return;
		}
		this.syncInProgress = true;
		try {
			const provider = new RequestUrlEmbeddingProvider(this.settings);
			const docs = buildDocsFromVault(this.app);
			await this.indexStore.sync(docs, this.settings, provider, () => {
				this.scheduleRefreshViews(120);
			});
			await this.refreshViews();
		} catch (error) {
			console.error(error);
		} finally {
			this.syncInProgress = false;
			if (this.pendingSync) {
				this.pendingSync = false;
				this.scheduleIndexSync(250);
			}
		}
	}

	async clearCache(): Promise<void> {
		await this.indexStore.clearCache();
		await this.refreshViews();
	}

	async clearFeedback(): Promise<void> {
		await this.indexStore.clearFeedback();
		await this.refreshViews();
	}

	async refreshRecommendations(): Promise<void> {
		await this.refreshViews();
	}

	getIndexedDocs(): IndexedDoc[] {
		const snapshot = this.indexStore.getSnapshot();
		return snapshot.docs.length > 0 ? snapshot.docs : buildDocsFromVault(this.app);
	}

	getLinkedDocs(activeFile: TFile): IndexedDoc[] {
		const docs = this.getIndexedDocs();
		const byPath = new Map(docs.map((doc) => [doc.path, doc]));
		return [...getAlreadyLinkedPaths(this.app, activeFile)]
			.map((path) => byPath.get(path))
			.filter((doc): doc is IndexedDoc => Boolean(doc));
	}

	async getRecommendations(activeFile: TFile, options: { treatAsUnlinkedPaths?: Set<string> } = {}): Promise<RankingResult[]> {
		const docs = this.getIndexedDocs();
		const alreadyLinkedPaths = getAlreadyLinkedPaths(this.app, activeFile);
		for (const path of options.treatAsUnlinkedPaths ?? []) {
			alreadyLinkedPaths.delete(path);
		}
		return recommend({
			sourcePath: activeFile.path,
			docs,
			settings: this.settings,
			alreadyLinkedPaths,
			feedbackEvents: this.indexStore.getFeedbackEvents(),
			linkResolver: this.linkResolver
		});
	}

	async insertRecommendation(result: RankingResult): Promise<InsertRecommendationResult | null> {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice("Open a note before inserting a link.");
			return null;
		}
		const docs = this.indexStore.getSnapshot().docs.length > 0 ? this.indexStore.getSnapshot().docs : buildDocsFromVault(this.app);
		const sourceDoc = docs.find((doc) => doc.path === activeFile.path);
		if (!sourceDoc) {
			new Notice("Current note is not indexed yet.");
			return null;
		}
		const renderedLink = renderLinkForDoc(sourceDoc, result.doc, result.score, this.linkResolver, this.settings.linkTemplate, this.settings.urlStrategy);
		const linkCandidates = [renderedLink, result.doc.path, result.templateContext.wikiLink, result.templateContext.markdownLink];
		let status: "inserted" | "existing" = "inserted";
		await this.app.vault.process(activeFile, (content) => {
			if (hasExistingLink(content, linkCandidates)) {
				status = "existing";
				return content;
			}
			return ensureHeadingAndAppend(content, this.settings.linkHeading, renderedLink);
		});
		if (status === "inserted") {
			await this.saveFeedback("inserted", activeFile.path, result);
		}
		return { status, renderedLink, linkCandidates };
	}

	async unlinkFromLinksSection(targetPath: string): Promise<LinkRemovalResult> {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			return {
				status: "no-active-file",
				removedCount: 0,
				linkCandidates: [],
				stillLinkedInContent: false
			};
		}

		const docs = this.getIndexedDocs();
		const sourceDoc = docs.find((doc) => doc.path === activeFile.path);
		const targetDoc = docs.find((doc) => doc.path === targetPath);
		if (!sourceDoc || !targetDoc) {
			return {
				status: "missing-target",
				removedCount: 0,
				linkCandidates: targetPath ? [targetPath] : [],
				stillLinkedInContent: false
			};
		}

		const linkCandidates = this.buildLinkCandidates(sourceDoc, targetDoc, 0);
		let removedCount = 0;
		let updatedContent = "";
		await this.app.vault.process(activeFile, (content) => {
			const removal = removeLinksFromHeadingSection(content, this.settings.linkHeading, linkCandidates);
			removedCount = removal.removedCount;
			updatedContent = removal.content;
			return removal.content;
		});

		if (removedCount === 0) {
			return {
				status: "not-found",
				removedCount,
				linkCandidates,
				stillLinkedInContent: hasExistingLink(updatedContent, linkCandidates)
			};
		}

		await this.indexStore.saveFeedbackEvent({
			ts: Date.now(),
			event: "deletedFromLinks",
			source: activeFile.path,
			target: targetDoc.path
		}, this.settings.enableFeedbackRanking);

		return {
			status: "removed",
			removedCount,
			linkCandidates,
			stillLinkedInContent: hasExistingLink(updatedContent, linkCandidates)
		};
	}

	async openPath(path: string): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (file) {
			await this.app.workspace.getLeaf(false).openFile(file);
		}
	}

	async openRecommendation(result: RankingResult): Promise<void> {
		const sourceFile = this.app.workspace.getActiveFile();
		const file = this.app.vault.getFileByPath(result.doc.path);
		if (file) {
			await this.app.workspace.getLeaf(false).openFile(file);
			if (sourceFile) {
				await this.saveFeedback("opened", sourceFile.path, result);
			}
		}
	}

	async dismissRecommendation(result: RankingResult): Promise<void> {
		const activeFile = this.app.workspace.getActiveFile();
		if (activeFile) {
			await this.saveFeedback("dismissed", activeFile.path, result);
		}
	}

	private async saveFeedback(event: FeedbackEvent["event"], source: string, result: RankingResult): Promise<void> {
		await this.indexStore.saveFeedbackEvent({
			ts: Date.now(),
			event,
			source,
			target: result.doc.path,
			features: result.features
		}, this.settings.enableFeedbackRanking);
	}

	private buildLinkCandidates(sourceDoc: IndexedDoc, targetDoc: IndexedDoc, score: number): string[] {
		const alias = targetDoc.description || targetDoc.title || targetDoc.basename;
		const renderedLink = renderLinkForDoc(sourceDoc, targetDoc, score, this.linkResolver, this.settings.linkTemplate, this.settings.urlStrategy);
		const markdownLink = this.linkResolver.generateMarkdownLink(sourceDoc.path, targetDoc.path, alias);
		const wikiLink = this.linkResolver.generateWikiLink(targetDoc.path, alias);
		const wikiLinkWithoutAlias = this.linkResolver.generateWikiLink(targetDoc.path);
		const obsidianUri = `obsidian://open?path=${encodeURIComponent(targetDoc.path)}`;
		const frontmatterUrl = this.linkResolver.getFrontmatterUrl(targetDoc.path) || targetDoc.url;
		return uniqueNonEmpty([
			renderedLink,
			targetDoc.path,
			encodeURI(targetDoc.path),
			markdownLink,
			markdownLinkTarget(markdownLink),
			wikiLink,
			wikiLinkWithoutAlias,
			wikiTargetNeedle(wikiLink),
			wikiTargetNeedle(wikiLinkWithoutAlias),
			obsidianUri,
			frontmatterUrl
		]);
	}

	private scheduleIndexSync(delayMs = 800): void {
		if (this.syncTimer !== null) {
			window.clearTimeout(this.syncTimer);
		}
		this.syncTimer = window.setTimeout(() => {
			this.syncTimer = null;
			void this.syncIndex();
		}, delayMs);
	}

	private async refreshViews(): Promise<void> {
		if (this.refreshPromise) {
			return this.refreshPromise;
		}
		this.refreshPromise = this.refreshViewsNow();
		try {
			await this.refreshPromise;
		} finally {
			this.refreshPromise = null;
		}
	}

	private scheduleRefreshViews(delayMs: number): void {
		if (this.refreshTimer !== null) {
			window.clearTimeout(this.refreshTimer);
		}
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			void this.refreshViews();
		}, delayMs);
	}

	private async refreshViewsNow(): Promise<void> {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SEMANTIC_LINKER)) {
			const view = leaf.view;
			if (view instanceof SemanticLinkerView) {
				await view.refresh();
			}
		}
	}
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const normalized = value?.trim();
		if (!normalized || normalized.length < 3 || seen.has(normalized)) {
			continue;
		}
		seen.add(normalized);
		result.push(normalized);
	}
	return result;
}

function markdownLinkTarget(markdownLink: string): string {
	const match = markdownLink.match(/^\[[^\]]+\]\((.*)\)$/);
	if (!match?.[1]) {
		return "";
	}
	return match[1].replace(/^<|>$/g, "");
}

function wikiTargetNeedle(wikiLink: string): string {
	const match = wikiLink.match(/^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/);
	return match?.[1] ? `[[${match[1]}` : "";
}

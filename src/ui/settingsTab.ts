import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { defaultGraphDisplay, defaultWeights } from "../core/settings";
import type SemanticLinkerPlugin from "../main";
import type { GraphDisplaySettings, ProviderKind, RankingWeights, RecommendationPreset, UrlStrategy } from "../core/types";

type NumericGraphDisplayKey = {
	[K in keyof GraphDisplaySettings]: GraphDisplaySettings[K] extends number ? K : never
}[keyof GraphDisplaySettings];

export class SemanticLinkerSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: SemanticLinkerPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Provider")
			.setDesc("Embedding provider used when rebuilding the local index.")
			.addDropdown((dropdown) => dropdown
				.addOption("ollama", "Ollama Native")
				.addOption("openai-compatible", "OpenAI Compatible")
				.setValue(this.plugin.settings.provider)
				.onChange(async (value) => {
					this.plugin.settings.provider = value as ProviderKind;
					await this.plugin.saveSettings();
					this.display();
				}));

		new Setting(containerEl)
			.setName("API base URL")
			.setDesc("Ollama defaults to http://localhost:11434. OpenAI-compatible providers should use their API root.")
			.addText((text) => text
				.setValue(this.plugin.settings.baseUrl)
				.onChange(async (value) => {
					this.plugin.settings.baseUrl = value.trim();
					await this.plugin.saveSettings();
				}));

		if (this.plugin.settings.provider === "openai-compatible") {
			new Setting(containerEl)
				.setName("API key")
				.setDesc("Only used for OpenAI-compatible providers.")
				.addText((text) => {
					text.inputEl.type = "password";
					text.setValue(this.plugin.settings.apiKey)
						.onChange(async (value) => {
							this.plugin.settings.apiKey = value;
							await this.plugin.saveSettings();
						});
				});
		}

		new Setting(containerEl)
			.setName("Model")
			.setDesc("Embedding model name.")
			.addText((text) => text
				.setValue(this.plugin.settings.model)
				.onChange(async (value) => {
					this.plugin.settings.model = value.trim() || "bge-m3";
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Top K")
			.setDesc("Number of candidate nodes shown in the sidebar graph.")
			.addText((text) => text
				.setValue(String(this.plugin.settings.topK))
				.onChange(async (value) => {
					this.plugin.settings.topK = parsePositiveInteger(value, 10);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Ignored folders")
			.setDesc("Comma-separated folder prefixes. Default: templates.")
			.addText((text) => text
				.setValue(this.plugin.settings.ignoredFolders.join(", "))
				.onChange(async (value) => {
					this.plugin.settings.ignoredFolders = splitList(value);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Ignored frontmatter types")
			.setDesc("Comma-separated type values to exclude.")
			.addText((text) => text
				.setValue(this.plugin.settings.ignoredTypes.join(", "))
				.onChange(async (value) => {
					this.plugin.settings.ignoredTypes = splitList(value);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Link insertion")
			.setHeading();

		new Setting(containerEl)
			.setName("Link heading")
			.setDesc("Heading where selected links are inserted.")
			.addText((text) => text
				.setValue(this.plugin.settings.linkHeading)
				.onChange(async (value) => {
					this.plugin.settings.linkHeading = value.trim() || "Links";
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Link template")
			.setDesc("Variables: {{title}}, {{filename}}, {{basename}}, {{path}}, {{description}}, {{url}}, {{wikiLink}}, {{markdownLink}}, {{obsidianUri}}, {{tags}}, {{score}}.")
			.addTextArea((text) => {
				text.inputEl.rows = 3;
				text.setValue(this.plugin.settings.linkTemplate)
					.onChange(async (value) => {
						this.plugin.settings.linkTemplate = value.trim() || "- [{{description}}]({{url}})";
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("URL strategy")
			.setDesc("Controls the {{url}} variable.")
			.addDropdown((dropdown) => dropdown
				.addOption("relative-md-path", "Relative Markdown path")
				.addOption("wiki-link", "Wiki link")
				.addOption("obsidian-uri", "Obsidian URI")
				.addOption("frontmatter-url", "Frontmatter url")
				.setValue(this.plugin.settings.urlStrategy)
				.onChange(async (value) => {
					this.plugin.settings.urlStrategy = value as UrlStrategy;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Show link action notices")
			.setDesc("Show notices after inserting, removing, or skipping links from the graph.")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.showActionNotices)
				.onChange(async (value) => {
					this.plugin.settings.showActionNotices = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Ranking")
			.setHeading();

		new Setting(containerEl)
			.setName("Recommendation preset")
			.setDesc("A convenience label for future tuning. Balanced keeps the default weights.")
			.addDropdown((dropdown) => dropdown
				.addOption("strict", "Strict")
				.addOption("balanced", "Balanced")
				.addOption("exploratory", "Exploratory")
				.addOption("concept-first", "Concept-first")
				.addOption("literature-aware", "Literature-aware")
				.setValue(this.plugin.settings.recommendationPreset)
				.onChange(async (value) => {
					this.plugin.settings.recommendationPreset = value as RecommendationPreset;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Enable feedback-aware ranking")
			.setDesc("Disabled by default because user feedback can introduce sample bias before validation.")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.enableFeedbackRanking)
				.onChange(async (value) => {
					this.plugin.settings.enableFeedbackRanking = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Clear feedback records")
			.setDesc("Remove local feedback events used by feedback-aware ranking.")
			.addButton((button) => button
				.setButtonText("Clear")
				.setWarning()
				.onClick(async () => {
					await this.plugin.clearFeedback();
					new Notice("Semantic Linker feedback records cleared.");
				}));

		new Setting(containerEl)
			.setName("Ranking weights")
			.setHeading();
		addWeightSetting(containerEl, this.plugin, "Title / filename", "title");
		addWeightSetting(containerEl, this.plugin, "Description", "description");
		addWeightSetting(containerEl, this.plugin, "Tags embedding", "tagsEmbedding");
		addWeightSetting(containerEl, this.plugin, "Tag IDF", "tagIdf");
		addWeightSetting(containerEl, this.plugin, "Type / kind", "typeKind");
		addWeightSetting(containerEl, this.plugin, "BM25 lexical", "bm25");
		addWeightSetting(containerEl, this.plugin, "Two-hop graph", "twoHop");
		addWeightSetting(containerEl, this.plugin, "Shared backlinks", "sharedBacklink");
		addWeightSetting(containerEl, this.plugin, "Path context", "pathContext");
		addWeightSetting(containerEl, this.plugin, "Feedback", "feedback");

		new Setting(containerEl)
			.setName("Reset weights to defaults")
			.setDesc("Restore the general-purpose default ranking weights.")
			.addButton((button) => button
				.setButtonText("Reset")
				.onClick(async () => {
					this.plugin.settings.weights = defaultWeights();
					await this.plugin.saveSettings();
					await this.plugin.refreshRecommendations();
					this.display();
				}));

		new Setting(containerEl)
			.setName("Graph view")
			.setHeading();
		addGraphSetting(containerEl, this.plugin, "Node size", "nodeSize", 0.1, 0.4, 2.4);
		addGraphSetting(containerEl, this.plugin, "Link thickness", "linkThickness", 0.1, 0.4, 2.4);
		addGraphSetting(containerEl, this.plugin, "Text fade threshold", "textFadeThreshold", 0.05, 0, 1);
		new Setting(containerEl)
			.setName("Show linked nodes")
			.setDesc("Show notes already linked from the current note.")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.graphDisplay.showLinkedNodes)
				.onChange(async (value) => {
					this.plugin.settings.graphDisplay.showLinkedNodes = value;
					await this.plugin.saveSettings();
					await this.plugin.refreshRecommendations();
				}));
		new Setting(containerEl)
			.setName("Show candidate nodes")
			.setDesc("Show recommended notes that are not linked yet.")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.graphDisplay.showCandidateNodes)
				.onChange(async (value) => {
					this.plugin.settings.graphDisplay.showCandidateNodes = value;
					await this.plugin.saveSettings();
					await this.plugin.refreshRecommendations();
				}));
		new Setting(containerEl)
			.setName("Show arrows")
			.setDesc("Show link direction for connected context nodes.")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.graphDisplay.showArrows)
				.onChange(async (value) => {
					this.plugin.settings.graphDisplay.showArrows = value;
					await this.plugin.saveSettings();
					await this.plugin.refreshRecommendations();
				}));

		new Setting(containerEl)
			.setName("Graph forces")
			.setHeading();
		addGraphSetting(containerEl, this.plugin, "Center force", "centerForce", 0.05, 0, 2);
		addGraphSetting(containerEl, this.plugin, "Repel force", "repelForce", 0.05, 0.2, 2.5);
		addGraphSetting(containerEl, this.plugin, "Link force", "linkForce", 0.05, 0, 2);
		addGraphSetting(containerEl, this.plugin, "Link distance", "linkDistance", 0.05, 0.6, 1.8);

		new Setting(containerEl)
			.setName("Reset graph view to defaults")
			.setDesc("Restore the Obsidian-like graph display and force defaults.")
			.addButton((button) => button
				.setButtonText("Reset")
				.onClick(async () => {
					this.plugin.settings.graphDisplay = defaultGraphDisplay();
					await this.plugin.saveSettings();
					await this.plugin.refreshRecommendations();
					this.display();
				}));

		new Setting(containerEl)
			.setName("Index")
			.setHeading();

		new Setting(containerEl)
			.setName("Rebuild index")
			.setDesc("Recompute metadata embeddings and local recommendation cache.")
			.addButton((button) => button
				.setButtonText("Rebuild")
				.setCta()
				.onClick(async () => {
					await this.plugin.rebuildIndex();
				}));

		new Setting(containerEl)
			.setName("Clear index cache")
			.setDesc("Clear local docs, vector, graph, and pending job cache.")
			.addButton((button) => button
				.setButtonText("Clear cache")
				.setWarning()
				.onClick(async () => {
					await this.plugin.clearCache();
					new Notice("Semantic Linker cache cleared.");
				}));
	}
}

function parsePositiveInteger(value: string, fallback: number): number {
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function splitList(value: string): string[] {
	return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseNumber(value: string, fallback: number): number {
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function addWeightSetting(containerEl: HTMLElement, plugin: SemanticLinkerPlugin, name: string, key: keyof RankingWeights): void {
	new Setting(containerEl)
		.setName(name)
		.addText((text) => {
			text.inputEl.type = "number";
			text.inputEl.step = "0.01";
			text.setValue(String(plugin.settings.weights[key]))
				.onChange(async (value) => {
					plugin.settings.weights[key] = parseNumber(value, plugin.settings.weights[key]);
					await plugin.saveSettings();
					await plugin.refreshRecommendations();
				});
		});
}

function addGraphSetting(containerEl: HTMLElement, plugin: SemanticLinkerPlugin, name: string, key: NumericGraphDisplayKey, step: number, min: number, max: number): void {
	new Setting(containerEl)
		.setName(name)
		.addSlider((slider) => slider
			.setLimits(min, max, step)
			.setValue(plugin.settings.graphDisplay[key])
			.setDynamicTooltip()
			.onChange(async (value) => {
				plugin.settings.graphDisplay[key] = value;
				await plugin.saveSettings();
				await plugin.refreshRecommendations();
			}));
}

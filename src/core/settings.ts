import type { GraphDisplaySettings, PluginSettings, RankingWeights } from "./types";

export const DEFAULT_WEIGHTS: RankingWeights = {
	title: 0.25,
	description: 0.35,
	tagsEmbedding: 0.2,
	tagIdf: 0.15,
	typeKind: 0.05,
	bm25: 0.08,
	twoHop: 0.05,
	sharedBacklink: 0.04,
	pathContext: 0,
	feedback: 0.08
};

export function defaultWeights(): RankingWeights {
	return { ...DEFAULT_WEIGHTS };
}

export const DEFAULT_GRAPH_DISPLAY: GraphDisplaySettings = {
	nodeSize: 1,
	linkThickness: 1,
	textFadeThreshold: 0.62,
	showArrows: false,
	centerForce: 1,
	repelForce: 1,
	linkForce: 1,
	linkDistance: 1
};

export function defaultGraphDisplay(): GraphDisplaySettings {
	return { ...DEFAULT_GRAPH_DISPLAY };
}

export const DEFAULT_SETTINGS: PluginSettings = {
	provider: "ollama",
	baseUrl: "http://localhost:11434",
	apiKey: "",
	model: "bge-m3",
	batchSize: 16,
	topK: 10,
	ignoredFolders: ["templates"],
	ignoredTypes: ["template"],
	fieldSelection: {
		titleFilename: true,
		tags: true,
		description: true,
		typeKind: true
	},
	linkHeading: "Links",
	linkTemplate: "- [{{description}}]({{url}})",
	urlStrategy: "relative-md-path",
	recommendationPreset: "balanced",
	enableFeedbackRanking: false,
	showActionNotices: true,
	weights: DEFAULT_WEIGHTS,
	rrfK: 60,
	mmrLambda: 0.75,
	perChannelLimit: 100,
	minScore: 0,
	enableLexicalIndex: true,
	pendingJobConcurrency: 1,
	typeKindRelations: {
		"fleeting->permanent": 1,
		"literature->permanent": 1,
		"permanent->literature": 0.5,
		"permanent->permanent": 0.8,
		"template->*": -1
	},
	graphDisplay: DEFAULT_GRAPH_DISPLAY
};

export function normalizeSettings(raw: Partial<PluginSettings> | null | undefined): PluginSettings {
	return {
		...DEFAULT_SETTINGS,
		...raw,
		fieldSelection: {
			...DEFAULT_SETTINGS.fieldSelection,
			...raw?.fieldSelection
		},
		weights: {
			...DEFAULT_SETTINGS.weights,
			...raw?.weights
		},
		showActionNotices: booleanSetting(raw?.showActionNotices, DEFAULT_SETTINGS.showActionNotices),
		typeKindRelations: {
			...DEFAULT_SETTINGS.typeKindRelations,
			...raw?.typeKindRelations
		},
		graphDisplay: {
			nodeSize: numberSetting(raw?.graphDisplay?.nodeSize, DEFAULT_SETTINGS.graphDisplay.nodeSize),
			linkThickness: numberSetting(raw?.graphDisplay?.linkThickness, DEFAULT_SETTINGS.graphDisplay.linkThickness),
			textFadeThreshold: numberSetting(raw?.graphDisplay?.textFadeThreshold, DEFAULT_SETTINGS.graphDisplay.textFadeThreshold),
			showArrows: booleanSetting(raw?.graphDisplay?.showArrows, DEFAULT_SETTINGS.graphDisplay.showArrows),
			centerForce: numberSetting(raw?.graphDisplay?.centerForce, DEFAULT_SETTINGS.graphDisplay.centerForce),
			repelForce: numberSetting(raw?.graphDisplay?.repelForce, DEFAULT_SETTINGS.graphDisplay.repelForce),
			linkForce: numberSetting(raw?.graphDisplay?.linkForce, DEFAULT_SETTINGS.graphDisplay.linkForce),
			linkDistance: numberSetting(raw?.graphDisplay?.linkDistance, DEFAULT_SETTINGS.graphDisplay.linkDistance)
		}
	};
}

function numberSetting(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanSetting(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

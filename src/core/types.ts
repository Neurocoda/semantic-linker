export type ProviderKind = "ollama" | "openai-compatible";

export type UrlStrategy = "relative-md-path" | "wiki-link" | "obsidian-uri" | "frontmatter-url";

export type RecommendationPreset =
	| "strict"
	| "balanced"
	| "exploratory"
	| "concept-first"
	| "literature-aware";

export interface FieldSelection {
	titleFilename: boolean;
	tags: boolean;
	description: boolean;
	typeKind: boolean;
}

export interface RankingWeights {
	title: number;
	description: number;
	tagsEmbedding: number;
	tagIdf: number;
	typeKind: number;
	bm25: number;
	twoHop: number;
	sharedBacklink: number;
	pathContext: number;
	feedback: number;
}

export interface GraphDisplaySettings {
	nodeSize: number;
	linkThickness: number;
	textFadeThreshold: number;
	showLinkedNodes: boolean;
	showCandidateNodes: boolean;
	showArrows: boolean;
	centerForce: number;
	repelForce: number;
	linkForce: number;
	linkDistance: number;
}

export interface PluginSettings {
	provider: ProviderKind;
	baseUrl: string;
	apiKey: string;
	model: string;
	batchSize: number;
	topK: number;
	ignoredFolders: string[];
	ignoredTypes: string[];
	fieldSelection: FieldSelection;
	linkHeading: string;
	linkTemplate: string;
	urlStrategy: UrlStrategy;
	recommendationPreset: RecommendationPreset;
	enableFeedbackRanking: boolean;
	showActionNotices: boolean;
	weights: RankingWeights;
	rrfK: number;
	mmrLambda: number;
	perChannelLimit: number;
	minScore: number;
	enableLexicalIndex: boolean;
	pendingJobConcurrency: number;
	typeKindRelations: Record<string, number>;
	graphDisplay: GraphDisplaySettings;
}

export interface EmbeddingProvider {
	embed(input: string[]): Promise<number[][]>;
}

export type EmbeddingField = "titleFilename" | "tags" | "description";

export interface FieldVectors {
	titleFilename?: number[];
	tags?: number[];
	description?: number[];
}

export interface IndexedDoc {
	id: number;
	path: string;
	basename: string;
	filename: string;
	ctime: number;
	title: string;
	mtime: number;
	type: string;
	kind: string;
	tags: string[];
	description: string;
	url: string;
	outgoingLinks: string[];
	incomingLinks: string[];
	vectors: FieldVectors;
}

export interface IndexManifest {
	schemaVersion: number;
	provider: ProviderKind;
	model: string;
	dimension: number;
	fields: EmbeddingField[];
	createdAt: string;
	updatedAt: string;
}

export interface IndexSnapshot {
	manifest: IndexManifest | null;
	docs: IndexedDoc[];
}

export interface LinkContext {
	sourcePath: string;
	targetPath: string;
	title: string;
	filename: string;
	basename: string;
	description: string;
	url: string;
	wikiLink: string;
	markdownLink: string;
	obsidianUri: string;
	tags: string;
	score: string;
}

export interface RankingFeatures {
	titleSim: number;
	descriptionSim: number;
	tagsEmbeddingSim: number;
	tagIdfJaccard: number;
	bm25Score: number;
	sameType: number;
	sameKind: number;
	typeKindRelationScore: number;
	sharedBacklinkScore: number;
	twoHopScore: number;
	candidateDegree: number;
	personalFeedbackScore: number;
	pathContext: number;
	baseScore: number;
}

export interface RankingResult {
	doc: IndexedDoc;
	score: number;
	reasons: string[];
	features: RankingFeatures;
	templateContext: LinkContext;
}

export type FeedbackEventType = "inserted" | "opened" | "dismissed" | "manuallyAdded" | "deletedFromLinks";

export interface FeedbackEvent {
	ts: number;
	event: FeedbackEventType;
	source: string;
	target: string;
	features?: Partial<RankingFeatures>;
}

export interface EmbeddingJob {
	path: string;
	fields: EmbeddingField[];
	reason: "created" | "modified" | "renamed" | "rebuild";
}

export interface LinkResolver {
	generateMarkdownLink(sourcePath: string, targetPath: string, alias?: string): string;
	generateWikiLink(targetPath: string, alias?: string): string;
	getFrontmatterUrl(targetPath: string): string;
}

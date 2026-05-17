import MiniSearch from "minisearch";
import type { FeedbackEvent, IndexedDoc, LinkContext, LinkResolver, PluginSettings, RankingFeatures, RankingResult } from "./types";
import { cosineSimilarity, normalizeScore, reciprocalRankFusion, tagIdfJaccard } from "./math";

interface RecommendationOptions {
	sourcePath: string;
	docs: IndexedDoc[];
	settings: PluginSettings;
	alreadyLinkedPaths: Set<string>;
	feedbackEvents: FeedbackEvent[];
	linkResolver: LinkResolver;
}

export function recommend(options: RecommendationOptions): RankingResult[] {
	const source = options.docs.find((doc) => doc.path === options.sourcePath);
	if (!source) {
		return [];
	}

	const candidates = options.docs.filter((doc) => shouldKeepCandidate(source, doc, options.settings, options.alreadyLinkedPaths));
	if (candidates.length === 0) {
		return [];
	}

	const documentFrequencies = buildTagDocumentFrequencies(options.docs);
	const rankings = buildChannelRankings(source, candidates, options.settings, documentFrequencies);
	const rrfScores = reciprocalRankFusion(rankings, options.settings.rrfK);
	const feedbackScores = options.settings.enableFeedbackRanking
		? buildFeedbackScores(options.feedbackEvents, source.path)
		: new Map<string, number>();

	const scored = candidates.map((candidate) => {
		const features = buildFeatures(source, candidate, options.settings, documentFrequencies, rrfScores.get(candidate.path) ?? 0, feedbackScores.get(candidate.path) ?? 0, options.docs.length);
		const score = scoreFeatures(features, options.settings);
		return {
			doc: candidate,
			score,
			reasons: buildReasons(features, candidate),
			features,
			templateContext: buildLinkContext(source, candidate, score, options.linkResolver)
		};
	}).filter((result) => result.score >= options.settings.minScore)
		.sort((a, b) => b.score - a.score);

	return applyMmr(scored, options.settings.mmrLambda).slice(0, options.settings.topK);
}

function shouldKeepCandidate(source: IndexedDoc, candidate: IndexedDoc, settings: PluginSettings, alreadyLinkedPaths: Set<string>): boolean {
	if (source.path === candidate.path) {
		return false;
	}
	if (alreadyLinkedPaths.has(candidate.path)) {
		return false;
	}
	if (settings.ignoredFolders.some((folder) => candidate.path.toLowerCase().startsWith(stripSlashes(folder).toLowerCase() + "/"))) {
		return false;
	}
	if (settings.ignoredTypes.includes(candidate.type)) {
		return false;
	}
	return true;
}

function buildChannelRankings(source: IndexedDoc, candidates: IndexedDoc[], settings: PluginSettings, documentFrequencies: Map<string, number>): string[][] {
	const rankings: string[][] = [];
	const addRanking = (scores: Array<[string, number]>) => {
		rankings.push(scores.sort((a, b) => b[1] - a[1]).slice(0, settings.perChannelLimit).map(([path]) => path));
	};

	if (settings.fieldSelection.titleFilename) {
		addRanking(candidates.map((doc) => [doc.path, normalizeScore(cosineSimilarity(source.vectors.titleFilename, doc.vectors.titleFilename))]));
	}
	if (settings.fieldSelection.description) {
		addRanking(candidates.map((doc) => [doc.path, normalizeScore(cosineSimilarity(source.vectors.description, doc.vectors.description))]));
	}
	if (settings.fieldSelection.tags) {
		addRanking(candidates.map((doc) => [doc.path, normalizeScore(cosineSimilarity(source.vectors.tags, doc.vectors.tags))]));
		addRanking(candidates.map((doc) => [doc.path, tagIdfJaccard(source.tags, doc.tags, documentFrequencies, candidates.length + 1)]));
	}
	if (settings.enableLexicalIndex) {
		const lexicalScores = buildMiniSearchScores(source, candidates);
		addRanking(candidates.map((doc) => [doc.path, lexicalScores.get(doc.path) ?? lexicalSimilarity(source, doc)]));
	}
	if (settings.fieldSelection.typeKind) {
		addRanking(candidates.map((doc) => [doc.path, typeKindScore(source, doc, settings)]));
	}
	addRanking(candidates.map((doc) => [doc.path, twoHopScore(source, doc)]));
	return rankings;
}

function buildFeatures(source: IndexedDoc, candidate: IndexedDoc, settings: PluginSettings, documentFrequencies: Map<string, number>, bm25Score: number, feedbackScore: number, totalDocs: number): RankingFeatures {
	return {
		titleSim: normalizeScore(cosineSimilarity(source.vectors.titleFilename, candidate.vectors.titleFilename)),
		descriptionSim: normalizeScore(cosineSimilarity(source.vectors.description, candidate.vectors.description)),
		tagsEmbeddingSim: normalizeScore(cosineSimilarity(source.vectors.tags, candidate.vectors.tags)),
		tagIdfJaccard: tagIdfJaccard(source.tags, candidate.tags, documentFrequencies, totalDocs),
		bm25Score,
		sameType: source.type && source.type === candidate.type ? 1 : 0,
		sameKind: source.kind && source.kind === candidate.kind ? 1 : 0,
		typeKindRelationScore: typeKindScore(source, candidate, settings),
		sharedBacklinkScore: sharedBacklinkScore(source, candidate),
		twoHopScore: twoHopScore(source, candidate),
		candidateDegree: degreeScore(candidate, totalDocs),
		personalFeedbackScore: feedbackScore,
		pathContext: 0,
		baseScore: 0
	};
}

function scoreFeatures(features: RankingFeatures, settings: PluginSettings): number {
	const weights = settings.weights;
	const score = (
		weights.title * features.titleSim
		+ weights.description * features.descriptionSim
		+ weights.tagsEmbedding * features.tagsEmbeddingSim
		+ weights.tagIdf * features.tagIdfJaccard
		+ weights.typeKind * features.typeKindRelationScore
		+ weights.bm25 * features.bm25Score
		+ weights.twoHop * features.twoHopScore
		+ weights.sharedBacklink * features.sharedBacklinkScore
		+ weights.pathContext * features.pathContext
		+ (settings.enableFeedbackRanking ? weights.feedback * features.personalFeedbackScore : 0)
	);
	features.baseScore = score;
	return score;
}

function applyMmr(results: RankingResult[], lambda: number): RankingResult[] {
	const selected: RankingResult[] = [];
	const remaining = [...results];
	while (remaining.length > 0) {
		let bestIndex = 0;
		let bestScore = Number.NEGATIVE_INFINITY;
		for (let i = 0; i < remaining.length; i += 1) {
			const item = remaining[i];
			if (!item) {
				continue;
			}
			const similarityToSelected = selected.reduce((max, selectedItem) => Math.max(max, docSimilarity(item.doc, selectedItem.doc)), 0);
			const mmrScore = lambda * item.score - (1 - lambda) * similarityToSelected;
			if (mmrScore > bestScore) {
				bestIndex = i;
				bestScore = mmrScore;
			}
		}
		const [picked] = remaining.splice(bestIndex, 1);
		if (picked) {
			selected.push(picked);
		}
	}
	return selected;
}

function docSimilarity(a: IndexedDoc, b: IndexedDoc): number {
	return Math.max(
		normalizeScore(cosineSimilarity(a.vectors.titleFilename, b.vectors.titleFilename)),
		normalizeScore(cosineSimilarity(a.vectors.description, b.vectors.description)),
		normalizeScore(cosineSimilarity(a.vectors.tags, b.vectors.tags))
	);
}

function lexicalSimilarity(source: IndexedDoc, candidate: IndexedDoc): number {
	const sourceTerms = new Set(tokenize([source.title, source.basename, source.description, source.tags.join(" ")]));
	const candidateTerms = new Set(tokenize([candidate.title, candidate.basename, candidate.description, candidate.tags.join(" ")]));
	if (sourceTerms.size === 0 || candidateTerms.size === 0) {
		return 0;
	}
	let overlap = 0;
	for (const term of sourceTerms) {
		if (candidateTerms.has(term)) {
			overlap += 1;
		}
	}
	return overlap / Math.sqrt(sourceTerms.size * candidateTerms.size);
}

function buildMiniSearchScores(source: IndexedDoc, candidates: IndexedDoc[]): Map<string, number> {
	const miniSearch = new MiniSearch({
		fields: ["title", "basename", "description", "tagsText", "type", "kind"],
		storeFields: ["path"]
	});
	miniSearch.addAll(candidates.map((doc) => ({
		id: doc.path,
		path: doc.path,
		title: doc.title,
		basename: doc.basename,
		description: doc.description,
		tagsText: doc.tags.join(" "),
		type: doc.type,
		kind: doc.kind
	})));
	const query = [source.title, source.basename, source.description, source.tags.join(" "), source.type, source.kind].join(" ").trim();
	if (!query) {
		return new Map();
	}
	const results = miniSearch.search(query, { prefix: true, fuzzy: 0.2 });
	const maxScore = Math.max(...results.map((result) => result.score), 0);
	const scores = new Map<string, number>();
	for (const result of results) {
		if (typeof result.id === "string") {
			scores.set(result.id, maxScore > 0 ? result.score / maxScore : 0);
		}
	}
	return scores;
}

function tokenize(values: readonly string[]): string[] {
	return values.join(" ").toLowerCase().split(/[^\p{L}\p{N}_/-]+/u).map((term) => term.trim()).filter((term) => term.length > 1);
}

function typeKindScore(source: IndexedDoc, candidate: IndexedDoc, settings: PluginSettings): number {
	const pairs = [
		`${source.type}->${candidate.type}`,
		`${source.kind}->${candidate.kind}`,
		`${source.type}->${candidate.kind}`,
		`${source.kind}->${candidate.type}`,
		`${source.type}->*`,
		`${source.kind}->*`
	];
	for (const pair of pairs) {
		const value = settings.typeKindRelations[pair];
		if (typeof value === "number") {
			return Math.max(0, value);
		}
	}
	return source.type === candidate.type || source.kind === candidate.kind ? 0.5 : 0;
}

function twoHopScore(source: IndexedDoc, candidate: IndexedDoc): number {
	const sourceOutgoing = new Set(source.outgoingLinks);
	const candidateIncoming = new Set(candidate.incomingLinks);
	if (sourceOutgoing.size === 0 || candidateIncoming.size === 0) {
		return 0;
	}
	let overlap = 0;
	for (const path of sourceOutgoing) {
		if (candidateIncoming.has(path)) {
			overlap += 1;
		}
	}
	return overlap / Math.sqrt(sourceOutgoing.size * candidateIncoming.size);
}

function sharedBacklinkScore(source: IndexedDoc, candidate: IndexedDoc): number {
	const sourceIncoming = new Set(source.incomingLinks);
	const candidateIncoming = new Set(candidate.incomingLinks);
	if (sourceIncoming.size === 0 || candidateIncoming.size === 0) {
		return 0;
	}
	let overlap = 0;
	for (const path of sourceIncoming) {
		if (candidateIncoming.has(path)) {
			overlap += 1;
		}
	}
	return overlap / Math.sqrt(sourceIncoming.size * candidateIncoming.size);
}

function degreeScore(candidate: IndexedDoc, totalDocs: number): number {
	if (totalDocs <= 1) {
		return 0;
	}
	return Math.min(1, (candidate.incomingLinks.length + candidate.outgoingLinks.length) / totalDocs);
}

function buildFeedbackScores(events: FeedbackEvent[], sourcePath: string): Map<string, number> {
	const scores = new Map<string, number>();
	for (const event of events) {
		if (event.source !== sourcePath) {
			continue;
		}
		const delta = event.event === "inserted" || event.event === "opened" || event.event === "manuallyAdded"
			? 1
			: event.event === "dismissed" || event.event === "deletedFromLinks"
				? -1
				: 0;
		scores.set(event.target, (scores.get(event.target) ?? 0) + delta);
	}
	for (const [target, score] of scores) {
		scores.set(target, Math.max(0, Math.min(1, (score + 3) / 6)));
	}
	return scores;
}

function buildTagDocumentFrequencies(docs: IndexedDoc[]): Map<string, number> {
	const frequencies = new Map<string, number>();
	for (const doc of docs) {
		for (const tag of new Set(doc.tags.map((value) => value.toLowerCase()))) {
			frequencies.set(tag, (frequencies.get(tag) ?? 0) + 1);
		}
	}
	return frequencies;
}

function buildReasons(features: RankingFeatures, candidate: IndexedDoc): string[] {
	const reasons: string[] = [];
	if (features.descriptionSim > 0.75) {
		reasons.push("similar description");
	}
	if (features.tagIdfJaccard > 0.2) {
		reasons.push("shared tags");
	}
	if (features.typeKindRelationScore > 0.5) {
		reasons.push("related type/kind");
	}
	if (features.twoHopScore > 0) {
		reasons.push("nearby link graph");
	}
	if (reasons.length === 0 && candidate.type) {
		reasons.push(candidate.type);
	}
	return reasons;
}

function buildLinkContext(source: IndexedDoc, target: IndexedDoc, score: number, resolver: LinkResolver): LinkContext {
	const alias = target.description || target.title || target.basename;
	const markdownLink = resolver.generateMarkdownLink(source.path, target.path, alias);
	const wikiLink = resolver.generateWikiLink(target.path, alias);
	const obsidianUri = `obsidian://open?path=${encodeURIComponent(target.path)}`;
	const url = resolver.getFrontmatterUrl(target.path) || markdownLink.replace(/^\[[^\]]+\]\((.*)\)$/, "$1");
	return {
		sourcePath: source.path,
		targetPath: target.path,
		title: target.title || target.basename,
		filename: target.filename,
		basename: target.basename,
		description: target.description || target.title || target.basename,
		url,
		wikiLink,
		markdownLink,
		obsidianUri,
		tags: target.tags.join(", "),
		score: score.toFixed(3)
	};
}

function stripSlashes(value: string): string {
	return value.replace(/^\/+|\/+$/g, "");
}

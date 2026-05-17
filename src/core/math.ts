export function dot(a: readonly number[], b: readonly number[]): number {
	const length = Math.min(a.length, b.length);
	let total = 0;
	for (let i = 0; i < length; i += 1) {
		total += (a[i] ?? 0) * (b[i] ?? 0);
	}
	return total;
}

export function magnitude(a: readonly number[]): number {
	let total = 0;
	for (const value of a) {
		total += value * value;
	}
	return Math.sqrt(total);
}

export function cosineSimilarity(a: readonly number[] | undefined, b: readonly number[] | undefined): number {
	if (!a || !b || a.length === 0 || b.length === 0) {
		return 0;
	}
	const denominator = magnitude(a) * magnitude(b);
	if (denominator === 0) {
		return 0;
	}
	return dot(a, b) / denominator;
}

export function clamp(value: number, min = 0, max = 1): number {
	return Math.min(max, Math.max(min, value));
}

export function normalizeScore(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return clamp((value + 1) / 2);
}

export function tagIdfJaccard(sourceTags: readonly string[], targetTags: readonly string[], documentFrequencies: Map<string, number>, totalDocs: number): number {
	const source = new Set(sourceTags.map(normalizeTag).filter(Boolean));
	const target = new Set(targetTags.map(normalizeTag).filter(Boolean));
	const union = new Set([...source, ...target]);
	if (union.size === 0) {
		return 0;
	}

	let intersectionWeight = 0;
	let unionWeight = 0;
	for (const tag of union) {
		const idf = Math.log((totalDocs + 1) / ((documentFrequencies.get(tag) ?? 0) + 1));
		unionWeight += idf;
		if (source.has(tag) && target.has(tag)) {
			intersectionWeight += idf;
		}
	}

	return unionWeight === 0 ? 0 : intersectionWeight / unionWeight;
}

export function reciprocalRankFusion(rankings: Array<Array<string>>, k: number): Map<string, number> {
	const scores = new Map<string, number>();
	for (const ranking of rankings) {
		ranking.forEach((id, index) => {
			scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
		});
	}
	return scores;
}

export function normalizeTag(tag: string): string {
	return tag.trim().replace(/^#/, "").toLowerCase();
}

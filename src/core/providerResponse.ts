export function parseEmbeddingResponse(json: unknown): number[][] {
	if (isObject(json) && Array.isArray(json.embeddings)) {
		return json.embeddings.filter(isNumberArray);
	}
	if (isObject(json) && Array.isArray(json.data)) {
		return json.data.map((item) => {
			if (isObject(item) && isNumberArray(item.embedding)) {
				return item.embedding;
			}
			return [];
		}).filter((embedding) => embedding.length > 0);
	}
	return [];
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNumberArray(value: unknown): value is number[] {
	return Array.isArray(value) && value.every((item) => typeof item === "number");
}

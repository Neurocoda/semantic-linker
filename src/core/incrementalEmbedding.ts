import type { EmbeddingField, EmbeddingProvider, IndexedDoc, PluginSettings } from "./types";
import { buildEmbeddingTexts } from "./metadata";

export interface EmbedProgress {
	field: EmbeddingField;
	done: number;
	total: number;
}

export async function embedChangedVectors(
	docs: IndexedDoc[],
	settings: PluginSettings,
	provider: EmbeddingProvider,
	existingByPath: Map<string, IndexedDoc>,
	forceAll: boolean,
	onProgress?: (progress: EmbedProgress) => void | Promise<void>
): Promise<void> {
	const fields: EmbeddingField[] = ["titleFilename", "tags", "description"];
	for (const field of fields) {
		if (!isFieldEnabled(field, settings)) {
			continue;
		}
		const jobs = docs
			.map((doc) => ({ doc, text: buildEmbeddingTexts(doc)[field] }))
			.filter(({ doc, text }) => {
				const existing = existingByPath.get(doc.path);
				const previousText = existing ? buildEmbeddingTexts(existing)[field] : "";
				return forceAll || !doc.vectors[field] || text !== previousText;
			});
		for (let i = 0; i < jobs.length; i += settings.batchSize) {
			const batch = jobs.slice(i, i + settings.batchSize);
			const batchInputs = batch.map((job) => job.text);
			const embeddings = await provider.embed(batchInputs);
			embeddings.forEach((embedding, index) => {
				const job = batch[index];
				if (job) {
					job.doc.vectors[field] = embedding;
				}
			});
			await onProgress?.({
				field,
				done: Math.min(i + batch.length, jobs.length),
				total: jobs.length
			});
		}
	}
}

function isFieldEnabled(field: EmbeddingField, settings: PluginSettings): boolean {
	if (field === "titleFilename") {
		return settings.fieldSelection.titleFilename;
	}
	if (field === "tags") {
		return settings.fieldSelection.tags;
	}
	return settings.fieldSelection.description;
}

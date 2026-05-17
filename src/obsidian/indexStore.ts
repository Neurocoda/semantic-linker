import type { App } from "obsidian";
import type { FeedbackEvent, IndexManifest, IndexSnapshot, IndexedDoc, PluginSettings } from "../core/types";
import type { EmbeddingProvider } from "../core/types";
import { embedChangedVectors, type EmbedProgress } from "../core/incrementalEmbedding";
import { pluginCachePath } from "./adapter";

const SCHEMA_VERSION = 1;

export interface IndexProgress {
	phase: "embedding" | "persisted";
	field?: EmbedProgress["field"];
	done: number;
	total: number;
	docs: IndexedDoc[];
}

export class LocalIndexStore {
	private snapshot: IndexSnapshot = { manifest: null, docs: [] };
	private feedbackEvents: FeedbackEvent[] = [];

	constructor(private readonly app: App) {}

	getSnapshot(): IndexSnapshot {
		return this.snapshot;
	}

	getFeedbackEvents(): FeedbackEvent[] {
		return this.feedbackEvents;
	}

	async load(): Promise<void> {
		await this.ensureCacheFolder();
		const docsText = await this.readIfExists("docs.jsonl");
		const manifestText = await this.readIfExists("manifest.json");
		const feedbackText = await this.readIfExists("feedback.jsonl");
		const docs = docsText
			? docsText.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as IndexedDoc)
			: [];
		const manifest = manifestText ? JSON.parse(manifestText) as IndexManifest : null;
		this.snapshot = { manifest, docs };
		this.feedbackEvents = feedbackText
			? feedbackText.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as FeedbackEvent)
			: [];
	}

	async rebuild(docs: IndexedDoc[], settings: PluginSettings, provider: EmbeddingProvider, onProgress?: (progress: IndexProgress) => void | Promise<void>): Promise<IndexSnapshot> {
		await this.ensureCacheFolder();
		const existingByPath = new Map(this.snapshot.docs.map((doc) => [doc.path, doc]));
		const forceAll = this.snapshot.manifest?.provider !== settings.provider || this.snapshot.manifest?.model !== settings.model;
		const embeddedDocs = docs.map((doc) => ({
			...doc,
			vectors: {
				...existingByPath.get(doc.path)?.vectors,
				...doc.vectors
			}
		}));
		this.snapshot = { manifest: this.snapshot.manifest, docs: embeddedDocs };
		await onProgress?.({ phase: "embedding", done: 0, total: embeddedDocs.length, docs: this.snapshot.docs });
		await embedChangedVectors(embeddedDocs, settings, provider, existingByPath, forceAll, async (progress) => {
			this.snapshot = { manifest: this.snapshot.manifest, docs: embeddedDocs };
			await onProgress?.({
				phase: "embedding",
				field: progress.field,
				done: progress.done,
				total: progress.total,
				docs: this.snapshot.docs
			});
		});
		const dimension = inferDimension(embeddedDocs);
		const manifest: IndexManifest = {
			schemaVersion: SCHEMA_VERSION,
			provider: settings.provider,
			model: settings.model,
			dimension,
			fields: ["titleFilename", "tags", "description"],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString()
		};
		this.snapshot = { manifest, docs: embeddedDocs };
		await this.persistSnapshot();
		await onProgress?.({ phase: "persisted", done: embeddedDocs.length, total: embeddedDocs.length, docs: this.snapshot.docs });
		return this.snapshot;
	}

	async sync(docs: IndexedDoc[], settings: PluginSettings, provider: EmbeddingProvider, onProgress?: (progress: IndexProgress) => void | Promise<void>): Promise<IndexSnapshot> {
		await this.ensureCacheFolder();
		const existingByPath = new Map(this.snapshot.docs.map((doc) => [doc.path, doc]));
		const forceAll = this.snapshot.manifest?.provider !== settings.provider || this.snapshot.manifest?.model !== settings.model;
		const syncedDocs = docs.map((doc) => {
			const existing = existingByPath.get(doc.path);
			return {
				...doc,
				vectors: {
					...existing?.vectors
				}
			};
		});
		this.snapshot = { manifest: this.snapshot.manifest, docs: syncedDocs };
		await onProgress?.({ phase: "embedding", done: 0, total: syncedDocs.length, docs: this.snapshot.docs });
		await embedChangedVectors(syncedDocs, settings, provider, existingByPath, forceAll, async (progress) => {
			this.snapshot = { manifest: this.snapshot.manifest, docs: syncedDocs };
			await onProgress?.({
				phase: "embedding",
				field: progress.field,
				done: progress.done,
				total: progress.total,
				docs: this.snapshot.docs
			});
		});
		const now = new Date().toISOString();
		const dimension = inferDimension(syncedDocs);
		this.snapshot = {
			manifest: {
				schemaVersion: SCHEMA_VERSION,
				provider: settings.provider,
				model: settings.model,
				dimension,
				fields: ["titleFilename", "tags", "description"],
				createdAt: this.snapshot.manifest?.createdAt ?? now,
				updatedAt: now
			},
			docs: syncedDocs
		};
		await this.persistSnapshot();
		await onProgress?.({ phase: "persisted", done: syncedDocs.length, total: syncedDocs.length, docs: this.snapshot.docs });
		return this.snapshot;
	}

	async saveFeedbackEvent(event: FeedbackEvent, enabled: boolean): Promise<void> {
		if (!enabled) {
			return;
		}
		this.feedbackEvents.push(event);
		await this.ensureCacheFolder();
		await this.app.vault.adapter.append(pluginCachePath("feedback.jsonl"), `${JSON.stringify(event)}\n`);
	}

	async clearFeedback(): Promise<void> {
		this.feedbackEvents = [];
		await this.ensureCacheFolder();
		await this.app.vault.adapter.write(pluginCachePath("feedback.jsonl"), "");
	}

	async clearCache(): Promise<void> {
		this.snapshot = { manifest: null, docs: [] };
		this.feedbackEvents = [];
		for (const filename of ["manifest.json", "docs.jsonl", "feedback.jsonl", "graph.json", "pending-jobs.json"]) {
			await this.app.vault.adapter.write(pluginCachePath(filename), "");
		}
		for (const filename of ["vectors.title-filename.f32", "vectors.tags.f32", "vectors.description.f32"]) {
			await this.app.vault.adapter.writeBinary(pluginCachePath(filename), new ArrayBuffer(0));
		}
	}

	private async persistSnapshot(): Promise<void> {
		await this.ensureCacheFolder();
		if (this.snapshot.manifest) {
			await this.app.vault.adapter.write(pluginCachePath("manifest.json"), JSON.stringify(this.snapshot.manifest, null, 2));
		}
		await this.app.vault.adapter.write(pluginCachePath("docs.jsonl"), this.snapshot.docs.map((doc) => JSON.stringify(doc)).join("\n"));
		await this.app.vault.adapter.write(pluginCachePath("graph.json"), JSON.stringify(buildGraph(this.snapshot.docs), null, 2));
		await this.writeVectorFile("vectors.title-filename.f32", this.snapshot.docs.map((doc) => doc.vectors.titleFilename));
		await this.writeVectorFile("vectors.tags.f32", this.snapshot.docs.map((doc) => doc.vectors.tags));
		await this.writeVectorFile("vectors.description.f32", this.snapshot.docs.map((doc) => doc.vectors.description));
	}

	private async writeVectorFile(filename: string, vectors: Array<number[] | undefined>): Promise<void> {
		const flat = vectors.flatMap((vector) => vector ?? []);
		const data = new Float32Array(flat);
		await this.app.vault.adapter.writeBinary(pluginCachePath(filename), data.buffer);
	}

	private async readIfExists(filename: string): Promise<string> {
		const path = pluginCachePath(filename);
		if (!(await this.app.vault.adapter.exists(path))) {
			return "";
		}
		return this.app.vault.adapter.read(path);
	}

	private async ensureCacheFolder(): Promise<void> {
		const folder = pluginCachePath("").replace(/\/$/, "");
		if (!(await this.app.vault.adapter.exists(folder))) {
			await this.app.vault.adapter.mkdir(folder);
		}
	}
}

function inferDimension(docs: IndexedDoc[]): number {
	for (const doc of docs) {
		const vector = doc.vectors.titleFilename ?? doc.vectors.tags ?? doc.vectors.description;
		if (vector) {
			return vector.length;
		}
	}
	return 0;
}

function buildGraph(docs: IndexedDoc[]): { outgoing: Record<string, string[]>; incoming: Record<string, string[]> } {
	const outgoing: Record<string, string[]> = {};
	const incoming: Record<string, string[]> = {};
	for (const doc of docs) {
		outgoing[doc.path] = doc.outgoingLinks;
		incoming[doc.path] = doc.incomingLinks;
	}
	return { outgoing, incoming };
}

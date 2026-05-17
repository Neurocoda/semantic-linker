import { requestUrl } from "obsidian";
import type { EmbeddingProvider, PluginSettings } from "./types";
import { parseEmbeddingResponse } from "./providerResponse";

export class RequestUrlEmbeddingProvider implements EmbeddingProvider {
	constructor(private readonly settings: PluginSettings) {}

	async embed(input: string[]): Promise<number[][]> {
		const trimmedInput = input.map((value) => value.trim());
		if (trimmedInput.length === 0) {
			return [];
		}

		const url = this.buildUrl();
		const headers: Record<string, string> = {
			"Content-Type": "application/json"
		};
		if (this.settings.provider === "openai-compatible" && this.settings.apiKey.trim()) {
			headers.Authorization = `Bearer ${this.settings.apiKey.trim()}`;
		}

		const body = this.settings.provider === "ollama"
			? { model: this.settings.model, input: trimmedInput }
			: { model: this.settings.model, input: trimmedInput };

		const response = await requestUrl({
			url,
			method: "POST",
			headers,
			body: JSON.stringify(body)
		});

		return parseEmbeddingResponse(response.json);
	}

	private buildUrl(): string {
		const baseUrl = this.settings.baseUrl.replace(/\/+$/, "");
		if (this.settings.provider === "ollama") {
			return `${baseUrl}/api/embed`;
		}
		return `${baseUrl}/v1/embeddings`;
	}
}

export { parseEmbeddingResponse };

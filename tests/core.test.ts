import test from "node:test";
import assert from "node:assert/strict";
import { tagIdfJaccard, reciprocalRankFusion, cosineSimilarity } from "../src/core/math";
import { ensureHeadingAndAppend, removeLinksFromHeadingSection, renderTemplate } from "../src/core/template";
import { buildIndexedDoc, tagsValue } from "../src/core/metadata";
import { parseEmbeddingResponse } from "../src/core/providerResponse";
import { recommend } from "../src/core/ranking";
import { DEFAULT_SETTINGS, defaultGraphDisplay, defaultWeights, normalizeSettings } from "../src/core/settings";
import { embedChangedVectors } from "../src/core/incrementalEmbedding";
import { buildGraphModel, initializeForceLayout, runForceLayout, stabilizeCandidateCohort } from "../src/core/graph";
import { clientToGraphPoint, clientToSvgPoint, panTransform, zoomTransformAtSvgPoint } from "../src/core/viewport";
import type { EmbeddingProvider, IndexedDoc, LinkResolver, PluginSettings } from "../src/core/types";

const resolver: LinkResolver = {
	generateMarkdownLink(_sourcePath, targetPath, alias) {
		return `[${alias ?? targetPath}](${targetPath})`;
	},
	generateWikiLink(targetPath, alias) {
		const link = targetPath.replace(/\.md$/, "");
		return alias ? `[[${link}|${alias}]]` : `[[${link}]]`;
	},
	getFrontmatterUrl() {
		return "";
	}
};

test("frontmatter tags support strings and lists", () => {
	assert.deepEqual(tagsValue(["ai", "#agents", 12]), ["ai", "#agents", "12"]);
	assert.deepEqual(tagsValue("ai agents,#rag"), ["ai", "agents", "#rag"]);
});

test("buildIndexedDoc falls back to basename for missing title", () => {
	const doc = buildIndexedDoc(0, {
		path: "inbox/http.md",
		basename: "http",
		filename: "http.md",
		mtime: 1,
		frontmatter: {
			tags: ["web"],
			description: ""
		}
	});
	assert.equal(doc.title, "http");
	assert.equal(doc.description, "");
});

test("embedding provider response parser handles Ollama and OpenAI-compatible shapes", () => {
	assert.deepEqual(parseEmbeddingResponse({ embeddings: [[1, 2], [3, 4]] }), [[1, 2], [3, 4]]);
	assert.deepEqual(parseEmbeddingResponse({ data: [{ embedding: [1, 2] }, { embedding: [3, 4] }] }), [[1, 2], [3, 4]]);
});

test("cosine, RRF, and Tag IDF Jaccard produce useful scores", () => {
	assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
	assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
	const rrf = reciprocalRankFusion([["a", "b"], ["b", "c"]], 60);
	assert.ok((rrf.get("b") ?? 0) > (rrf.get("c") ?? 0));
	const freqs = new Map([["rare", 1], ["common", 10]]);
	assert.ok(tagIdfJaccard(["rare"], ["rare", "common"], freqs, 20) > 0);
});

test("template rendering and link append are idempotent", () => {
	const rendered = renderTemplate("- [{{description}}]({{url}})", {
		sourcePath: "a.md",
		targetPath: "b.md",
		title: "B",
		filename: "b.md",
		basename: "b",
		description: "Bee",
		url: "b.md",
		wikiLink: "[[b|Bee]]",
		markdownLink: "[Bee](b.md)",
		obsidianUri: "obsidian://open?path=b.md",
		tags: "x",
		score: "0.9"
	});
	assert.equal(rendered, "- [Bee](b.md)");
	const first = ensureHeadingAndAppend("# A\n", "Links", rendered);
	const second = ensureHeadingAndAppend(first, "Links", rendered);
	assert.equal(first, second);
	assert.ok(first.includes("## Links"));
});

test("link removal only edits the configured Links section", () => {
	const content = [
		"# A",
		"",
		"Body link stays: [Target](target.md)",
		"",
		"## Links",
		"",
		"- [Target](target.md)",
		"- [[Other]]",
		"",
		"## Notes",
		"",
		"- [Target](target.md)"
	].join("\n");
	const result = removeLinksFromHeadingSection(content, "Links", ["target.md"]);
	assert.equal(result.removedCount, 1);
	assert.ok(result.content.includes("Body link stays: [Target](target.md)"));
	assert.ok(result.content.includes("## Notes\n\n- [Target](target.md)"));
	assert.equal(result.content.includes("- [Target](target.md)\n- [[Other]]"), false);
	assert.ok(result.content.includes("- [[Other]]"));
});

test("link removal deletes duplicate target lines from Links section", () => {
	const content = [
		"# A",
		"",
		"## Links",
		"",
		"- [Target](target.md)",
		"- [[target|Target]]",
		"- [[Other]]"
	].join("\n");
	const result = removeLinksFromHeadingSection(content, "Links", ["target.md", "[[target"]);
	assert.equal(result.removedCount, 2);
	assert.equal(result.content.includes("target.md"), false);
	assert.equal(result.content.includes("[[target"), false);
	assert.ok(result.content.includes("- [[Other]]"));
});

test("link removal returns unchanged content when section or target is missing", () => {
	const withoutSection = "# A\n\n- [Target](target.md)";
	assert.deepEqual(removeLinksFromHeadingSection(withoutSection, "Links", ["target.md"]), {
		content: withoutSection,
		removedCount: 0
	});
	const withoutTarget = "# A\n\n## Links\n\n- [[Other]]";
	assert.deepEqual(removeLinksFromHeadingSection(withoutTarget, "Links", ["target.md"]), {
		content: withoutTarget,
		removedCount: 0
	});
});

test("recommend filters already linked notes and ignores feedback when disabled", () => {
	const source = makeDoc(0, "source.md", [1, 0], ["web"], ["linked.md"], []);
	const linked = makeDoc(1, "linked.md", [1, 0], ["web"], [], ["source.md"]);
	const candidate = makeDoc(2, "candidate.md", [0.9, 0.1], ["web"], [], []);
	const dismissed = makeDoc(3, "dismissed.md", [0.95, 0.05], ["web"], [], []);
	const settings = {
		...DEFAULT_SETTINGS,
		enableFeedbackRanking: false,
		topK: 10,
		ignoredFolders: [],
		ignoredTypes: []
	};
	const results = recommend({
		sourcePath: source.path,
		docs: [source, linked, candidate, dismissed],
		settings,
		alreadyLinkedPaths: new Set(["linked.md"]),
		feedbackEvents: [{ ts: 1, event: "dismissed", source: "source.md", target: "dismissed.md" }],
		linkResolver: resolver
	});
	assert.deepEqual(results.map((result) => result.doc.path).includes("linked.md"), false);
	assert.ok(results.some((result) => result.doc.path === "dismissed.md"));
});

test("incremental embedding only refreshes changed metadata fields", async () => {
	const existing = makeDoc(0, "source.md", [1, 0], ["web"], [], []);
	existing.description = "old description";
	existing.vectors.titleFilename = [1, 1];
	existing.vectors.tags = [2, 2];
	existing.vectors.description = [3, 3];
	const updated = makeDoc(0, "source.md", [1, 0], ["web"], [], []);
	updated.description = "new description";
	updated.vectors = { ...existing.vectors };
	const calls: string[] = [];
	const provider: EmbeddingProvider = {
		async embed(input: string[]) {
			calls.push(...input);
			return input.map((_value, index) => [9, index]);
		}
	};
	await embedChangedVectors([updated], { ...DEFAULT_SETTINGS, batchSize: 8 }, provider, new Map([[existing.path, existing]]), false);
	assert.equal(calls.length, 1);
	assert.match(calls[0] ?? "", /new description/);
	assert.deepEqual(updated.vectors.titleFilename, [1, 1]);
	assert.deepEqual(updated.vectors.tags, [2, 2]);
	assert.deepEqual(updated.vectors.description, [9, 0]);
});

test("incremental embedding reports progress after each completed batch", async () => {
	const docs = [
		makeDoc(0, "a.md", [], ["web"], [], []),
		makeDoc(1, "b.md", [], ["web"], [], []),
		makeDoc(2, "c.md", [], ["web"], [], [])
	];
	const progress: Array<{ done: number; total: number }> = [];
	const provider: EmbeddingProvider = {
		async embed(input: string[]) {
			return input.map((_value, index) => [index, input.length]);
		}
	};
	await embedChangedVectors(docs, {
		...DEFAULT_SETTINGS,
		batchSize: 2,
		fieldSelection: {
			titleFilename: true,
			tags: false,
			description: false,
			typeKind: true
		}
	}, provider, new Map(), true, (event) => {
		progress.push({ done: event.done, total: event.total });
	});
	assert.deepEqual(progress, [
		{ done: 2, total: 3 },
		{ done: 3, total: 3 }
	]);
});

test("default weights can be reset without sharing mutable references", () => {
	const first = defaultWeights();
	first.title = 99;
	const second = defaultWeights();
	assert.equal(second.title, DEFAULT_SETTINGS.weights.title);
});

test("default graph display can be reset without sharing mutable references", () => {
	const first = defaultGraphDisplay();
	first.nodeSize = 2;
	const second = defaultGraphDisplay();
	assert.equal(second.nodeSize, DEFAULT_SETTINGS.graphDisplay.nodeSize);
});

test("settings normalization repairs invalid graph display values", () => {
	const raw = {
		graphDisplay: {
			nodeSize: "large",
			showCandidateNodes: "yes",
			showArrows: "false",
			linkDistance: Number.NaN
		}
	} as Partial<PluginSettings>;
	const settings = normalizeSettings(raw);
	assert.equal(settings.graphDisplay.nodeSize, DEFAULT_SETTINGS.graphDisplay.nodeSize);
	assert.equal(settings.graphDisplay.showCandidateNodes, DEFAULT_SETTINGS.graphDisplay.showCandidateNodes);
	assert.equal(settings.graphDisplay.showArrows, DEFAULT_SETTINGS.graphDisplay.showArrows);
	assert.equal(settings.graphDisplay.linkDistance, DEFAULT_SETTINGS.graphDisplay.linkDistance);
});

test("settings normalization defaults action notices to enabled", () => {
	assert.equal(normalizeSettings({}).showActionNotices, true);
	assert.equal(normalizeSettings({ showActionNotices: false }).showActionNotices, false);
});

test("viewport transforms preserve graph point during zoom", () => {
	const rect = { left: 100, top: 50 };
	const transform = { x: 10, y: 20, scale: 1 };
	const svgPoint = clientToSvgPoint(150, 90, rect);
	assert.deepEqual(svgPoint, { x: 50, y: 40 });
	const before = clientToGraphPoint(150, 90, rect, transform);
	const zoomed = zoomTransformAtSvgPoint(transform, svgPoint, 2, 0.5, 3);
	const after = clientToGraphPoint(150, 90, rect, zoomed);
	assert.deepEqual(after, before);
	assert.deepEqual(panTransform(transform, 5, -3), { x: 15, y: 17, scale: 1 });
});

test("graph model separates center, linked, and candidate nodes", () => {
	const source = makeDoc(0, "source.md", [1, 0], ["web"], ["linked.md"], []);
	const linked = makeDoc(1, "linked.md", [1, 0], ["web"], [], ["source.md"]);
	const candidate = makeDoc(2, "candidate.md", [0.9, 0.1], ["web"], [], []);
	const result = makeResult(candidate, 0.82);
	const model = buildGraphModel(source, [linked], [result]);
	assert.equal(model.center.kind, "center");
	assert.ok(model.nodes.some((node) => node.kind === "linked" && node.path === "linked.md"));
	assert.ok(model.nodes.some((node) => node.kind === "candidate" && node.path === "candidate.md"));
	assert.equal(model.nodes.some((node) => node.kind === "candidate" && node.path === "linked.md"), false);
});

test("graph model respects linked and recommendation group visibility", () => {
	const source = makeDoc(0, "source.md", [1, 0], ["web"], ["linked.md"], []);
	const linked = makeDoc(1, "linked.md", [1, 0], ["web"], [], ["source.md"]);
	const candidate = makeDoc(2, "candidate.md", [0.9, 0.1], ["web"], [], []);
	const result = makeResult(candidate, 0.82);
	const hiddenLinked = buildGraphModel(source, [linked], [result], {
		...DEFAULT_SETTINGS.graphDisplay,
		showLinkedNodes: false
	});
	assert.equal(hiddenLinked.nodes.some((node) => node.kind === "linked"), false);
	assert.equal(hiddenLinked.nodes.some((node) => node.kind === "candidate"), true);

	const hiddenCandidates = buildGraphModel(source, [linked], [result], {
		...DEFAULT_SETTINGS.graphDisplay,
		showCandidateNodes: false
	});
	assert.equal(hiddenCandidates.nodes.some((node) => node.kind === "linked"), true);
	assert.equal(hiddenCandidates.nodes.some((node) => node.kind === "candidate"), false);
});

test("graph nodes carry document creation time for timelapse ordering", () => {
	const source = makeDoc(0, "source.md", [1, 0], ["web"], [], []);
	const linked = makeDoc(1, "linked.md", [1, 0], ["web"], [], ["source.md"]);
	const candidate = makeDoc(2, "candidate.md", [0.9, 0.1], ["web"], [], []);
	linked.ctime = 100;
	candidate.ctime = 50;
	const model = buildGraphModel(source, [linked], [makeResult(candidate, 0.82)]);
	assert.equal(model.nodes.find((node) => node.path === "linked.md")?.ctime, 100);
	assert.equal(model.nodes.find((node) => node.path === "candidate.md")?.ctime, 50);
});

test("graph node radius grows with degree and node size setting", () => {
	const source = makeDoc(0, "source.md", [1, 0], ["web"], ["hub.md"], []);
	const hub = makeDoc(1, "hub.md", [1, 0], ["web"], ["a.md", "b.md", "c.md"], ["x.md", "y.md", "z.md"]);
	const small = makeDoc(2, "small.md", [1, 0], ["web"], [], []);
	const model = buildGraphModel(source, [hub, small], [], {
		...DEFAULT_SETTINGS.graphDisplay,
		nodeSize: 1.2
	});
	const hubNode = model.nodes.find((node) => node.path === "hub.md");
	const smallNode = model.nodes.find((node) => node.path === "small.md");
	assert.ok(hubNode);
	assert.ok(smallNode);
	assert.ok(hubNode.radius > smallNode.radius);
});

test("candidate becomes linked when linked set includes it, and can return after deletion", () => {
	const source = makeDoc(0, "source.md", [1, 0], ["web"], ["candidate.md"], []);
	const candidate = makeDoc(2, "candidate.md", [0.9, 0.1], ["web"], [], ["source.md"]);
	const result = makeResult(candidate, 0.82);
	const linkedModel = buildGraphModel(source, [candidate], [result]);
	assert.equal(linkedModel.nodes.some((node) => node.kind === "candidate" && node.path === "candidate.md"), false);
	assert.equal(linkedModel.nodes.some((node) => node.kind === "linked" && node.path === "candidate.md"), true);
	const unlinkedModel = buildGraphModel(source, [], [result]);
	assert.equal(unlinkedModel.nodes.some((node) => node.kind === "candidate" && node.path === "candidate.md"), true);
});

test("candidate cohort does not backfill new notes after initial render", () => {
	const docs = [
		makeDoc(1, "a.md", [1, 0], ["web"], [], []),
		makeDoc(2, "b.md", [1, 0], ["web"], [], []),
		makeDoc(3, "c.md", [1, 0], ["web"], [], [])
	];
	const first = stabilizeCandidateCohort([makeResult(docs[0]!, 0.9), makeResult(docs[1]!, 0.8)], []);
	assert.deepEqual(first.results.map((result) => result.doc.path), ["a.md", "b.md"]);
	assert.deepEqual(first.cohortPaths, ["a.md", "b.md"]);
	const refreshed = stabilizeCandidateCohort([makeResult(docs[1]!, 0.8), makeResult(docs[2]!, 0.7)], first.cohortPaths);
	assert.deepEqual(refreshed.results.map((result) => result.doc.path), ["b.md"]);
	assert.deepEqual(refreshed.cohortPaths, ["a.md", "b.md"]);
});

test("force layout preserves node position when candidate becomes linked", () => {
	const source = makeDoc(0, "source.md", [1, 0], ["web"], [], []);
	const target = makeDoc(1, "target.md", [0.9, 0.1], ["web"], [], []);
	const candidateModel = initializeForceLayout(
		buildGraphModel(source, [], [makeResult(target, 0.82)]),
		{ width: 500, height: 400 }
	);
	const candidateNode = candidateModel.nodes.find((node) => node.path === "target.md");
	assert.ok(candidateNode);
	candidateNode.x = 123;
	candidateNode.y = 234;
	candidateNode.vx = 4;
	candidateNode.vy = -2;
	const linkedModel = initializeForceLayout(
		buildGraphModel(source, [target], []),
		{ width: 500, height: 400 },
		candidateModel
	);
	const linkedNode = linkedModel.nodes.find((node) => node.path === "target.md");
	assert.ok(linkedNode);
	assert.equal(linkedNode.kind, "linked");
	assert.equal(linkedNode.x, 123);
	assert.equal(linkedNode.y, 234);
	assert.equal(linkedNode.vx, 1);
	assert.equal(linkedNode.vy, -0.5);
	assert.equal(linkedNode.radius, candidateNode.radius);
	assert.equal(linkedNode.lockedDistance, distance(candidateModel.center, candidateNode));
});

test("force layout preserves node position when linked becomes candidate", () => {
	const source = makeDoc(0, "source.md", [1, 0], ["web"], ["target.md"], []);
	const target = makeDoc(1, "target.md", [0.9, 0.1], ["web"], [], ["source.md"]);
	const linkedModel = initializeForceLayout(
		buildGraphModel(source, [target], []),
		{ width: 500, height: 400 }
	);
	const linkedNode = linkedModel.nodes.find((node) => node.path === "target.md");
	assert.ok(linkedNode);
	linkedNode.x = 321;
	linkedNode.y = 111;
	linkedNode.vx = -3;
	linkedNode.vy = 2;
	const candidateModel = initializeForceLayout(
		buildGraphModel(source, [], [makeResult(target, 0.82)]),
		{ width: 500, height: 400 },
		linkedModel
	);
	const candidateNode = candidateModel.nodes.find((node) => node.path === "target.md");
	assert.ok(candidateNode);
	assert.equal(candidateNode.kind, "candidate");
	assert.equal(candidateNode.x, 321);
	assert.equal(candidateNode.y, 111);
	assert.equal(candidateNode.vx, -0.75);
	assert.equal(candidateNode.vy, 0.5);
	assert.equal(candidateNode.radius, linkedNode.radius);
	assert.equal(candidateNode.lockedDistance, distance(linkedModel.center, linkedNode));
});

test("candidate radial score uses local recommendation score range", () => {
	const source = makeDoc(0, "source.md", [1, 0], ["web"], [], []);
	const low = makeDoc(1, "low.md", [0.99, 0.01], ["web"], [], []);
	const high = makeDoc(2, "high.md", [0.98, 0.02], ["web"], [], []);
	const model = buildGraphModel(source, [], [makeResult(low, 0.801), makeResult(high, 0.802)]);
	const lowNode = model.nodes.find((node) => node.path === "low.md");
	const highNode = model.nodes.find((node) => node.path === "high.md");
	assert.ok(lowNode);
	assert.ok(highNode);
	assert.equal(lowNode.radialScore, 0);
	assert.equal(highNode.radialScore, 1);
});

test("candidate radial score is neutral when scores are equal", () => {
	const source = makeDoc(0, "source.md", [1, 0], ["web"], [], []);
	const first = makeDoc(1, "first.md", [0.99, 0.01], ["web"], [], []);
	const second = makeDoc(2, "second.md", [0.98, 0.02], ["web"], [], []);
	const model = buildGraphModel(source, [], [makeResult(first, 0.8), makeResult(second, 0.8)]);
	const candidates = model.nodes.filter((node) => node.kind === "candidate");
	assert.deepEqual(candidates.map((node) => node.radialScore), [0.5, 0.5]);
});

test("force layout keeps higher score candidates closer to center", () => {
	const source = makeDoc(0, "source.md", [1, 0], ["web"], [], []);
	const near = makeDoc(1, "near.md", [1, 0], ["web"], [], []);
	const far = makeDoc(2, "far.md", [0.2, 0.8], ["web"], [], []);
	const model = buildGraphModel(source, [], [makeResult(near, 0.95), makeResult(far, 0.2)]);
	const laidOut = runForceLayout(model, { width: 400, height: 400 }, 40);
	const center = laidOut.center;
	const nearNode = laidOut.nodes.find((node) => node.path === "near.md");
	const farNode = laidOut.nodes.find((node) => node.path === "far.md");
	assert.ok(nearNode);
	assert.ok(farNode);
	assert.ok(distance(center, nearNode) < distance(center, farNode));
});

function makeDoc(id: number, path: string, vector: number[], tags: string[], outgoingLinks: string[], incomingLinks: string[]): IndexedDoc {
	const basename = path.replace(/\.md$/, "");
	return {
		id,
		path,
		basename,
		filename: path,
		ctime: id,
		title: basename,
		mtime: id,
		type: "permanent",
		kind: "concept",
		tags,
		description: basename,
		url: "",
		outgoingLinks,
		incomingLinks,
		vectors: {
			titleFilename: vector,
			tags: vector,
			description: vector
		}
	};
}

function makeResult(doc: IndexedDoc, score: number) {
	return {
		doc,
		score,
		reasons: [],
		features: {
			titleSim: score,
			descriptionSim: score,
			tagsEmbeddingSim: score,
			tagIdfJaccard: score,
			bm25Score: score,
			sameType: 1,
			sameKind: 1,
			typeKindRelationScore: 1,
			sharedBacklinkScore: 0,
			twoHopScore: 0,
			candidateDegree: 0,
			personalFeedbackScore: 0,
			pathContext: 0,
			baseScore: score
		},
		templateContext: {
			sourcePath: "source.md",
			targetPath: doc.path,
			title: doc.title,
			filename: doc.filename,
			basename: doc.basename,
			description: doc.description,
			url: doc.path,
			wikiLink: `[[${doc.basename}]]`,
			markdownLink: `[${doc.title}](${doc.path})`,
			obsidianUri: `obsidian://open?path=${doc.path}`,
			tags: doc.tags.join(", "),
			score: score.toFixed(3)
		}
	};
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return Math.sqrt(dx * dx + dy * dy);
}

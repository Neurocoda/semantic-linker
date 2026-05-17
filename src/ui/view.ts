import { ItemView, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import {
	advanceForceLayout,
	buildGraphModel,
	initializeForceLayout,
	stabilizeCandidateCohort,
	type GraphBounds,
	type GraphEdge,
	type GraphModel,
	type GraphNode
} from "../core/graph";
import { hasExistingLink } from "../core/template";
import { clientToGraphPoint, clientToSvgPoint, panTransform, zoomTransformAtSvgPoint, type ViewTransform } from "../core/viewport";
import type { IndexedDoc, RankingResult } from "../core/types";
import type SemanticLinkerPlugin from "../main";

export const VIEW_TYPE_SEMANTIC_LINKER = "semantic-linker-view";

const SVG_NS = "http://www.w3.org/2000/svg";
const OPTIMISTIC_LINK_TTL_MS = 3000;
const OPTIMISTIC_LINK_CONTENT_CHECK_DELAY_MS = 250;
const DRAG_CLICK_TOLERANCE_PX = 8;
const TIMELAPSE_STEP_MS = 220;

interface OptimisticLinkedPath {
	createdAt: number;
	expiresAt: number;
	linkCandidates: string[];
}

interface OptimisticUnlinkedPath {
	createdAt: number;
	expiresAt: number;
	score: number;
	result?: RankingResult;
}

interface SettingsModalLike {
	open(): void;
	openTabById(id: string): void;
}

export class SemanticLinkerView extends ItemView {
	private statusEl: HTMLElement | null = null;
	private graphEl: SVGSVGElement | null = null;
	private graphHostEl: HTMLElement | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private activeSourcePath: string | null = null;
	private lastModel: GraphModel | null = null;
	private layoutModel: GraphModel | null = null;
	private graphStructureKey = "";
	private animationFrameId: number | null = null;
	private draggedNodeId: string | null = null;
	private hoveredNodeId: string | null = null;
	private dragMoved = false;
	private isPanning = false;
	private pendingRefreshAfterInteraction = false;
	private clickedNodeIds = new Set<string>();
	private transform: ViewTransform = { x: 0, y: 0, scale: 1 };
	private visibleCandidatePaths: string[] = [];
	private optimisticLinkedPathsBySource = new Map<string, Map<string, OptimisticLinkedPath>>();
	private optimisticUnlinkedPathsBySource = new Map<string, Map<string, OptimisticUnlinkedPath>>();
	private optimisticRefreshTimer: number | null = null;
	private timelapseTimer: number | null = null;
	private timelapseButtonEl: HTMLButtonElement | null = null;
	private timelapseSourceModel: GraphModel | null = null;

	constructor(leaf: WorkspaceLeaf, private readonly plugin: SemanticLinkerPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_SEMANTIC_LINKER;
	}

	getDisplayText(): string {
		return "Semantic Linker";
	}

	getIcon(): string {
		return "network";
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1];
		if (!(container instanceof HTMLElement)) {
			return;
		}
		container.empty();
		container.addClass("semantic-linker-view");

		this.statusEl = container.createDiv({ cls: "semantic-linker-status" });
		this.graphHostEl = container.createDiv({ cls: "semantic-linker-graph-host" });
		this.graphEl = document.createElementNS(SVG_NS, "svg");
		this.graphEl.addClass("semantic-linker-graph");
		this.graphEl.setAttr("tabindex", "0");
		this.graphHostEl.appendChild(this.graphEl);
		this.createGraphControls(this.graphHostEl);
		this.registerGraphViewportEvents();
		this.resizeObserver = new ResizeObserver(() => {
			if (this.lastModel) {
				this.startGraph(this.lastModel);
			}
		});
		this.resizeObserver.observe(this.graphHostEl);
		await this.refresh();
	}

	async onClose(): Promise<void> {
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		if (this.optimisticRefreshTimer !== null) {
			window.clearTimeout(this.optimisticRefreshTimer);
			this.optimisticRefreshTimer = null;
		}
		this.stopTimelapse();
		this.cleanupPointerInteraction();
		this.stopSimulation();
	}

	async refresh(): Promise<void> {
		if (!this.statusEl || !this.graphEl || !this.graphHostEl) {
			return;
		}
		if (this.isPointerInteractionActive()) {
			this.pendingRefreshAfterInteraction = true;
			return;
		}
		this.statusEl.removeAttribute("aria-label");
		if (!this.layoutModel) {
			this.statusEl.setText("Loading graph...");
		}
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			this.clearGraph();
			this.statusEl.setText("Open a note to see related notes.");
			return;
		}

		try {
			const docs = this.plugin.getIndexedDocs();
			const source = docs.find((doc) => doc.path === activeFile.path);
			if (!source) {
				this.clearGraph();
				this.statusEl.setText("Current note is not indexed yet.");
				return;
			}
			if (this.activeSourcePath !== activeFile.path) {
				this.activeSourcePath = activeFile.path;
				this.resetInteractionState();
			}
			const optimisticUnlinkedPaths = this.optimisticUnlinkedPathsBySource.get(activeFile.path) ?? new Map<string, OptimisticUnlinkedPath>();
			const now = Date.now();
			for (const [path, optimistic] of optimisticUnlinkedPaths) {
				if (optimistic.expiresAt <= now) {
					optimisticUnlinkedPaths.delete(path);
				}
			}
			const linkedDocs = this.plugin.getLinkedDocs(activeFile)
				.filter((doc) => !optimisticUnlinkedPaths.has(doc.path));
			const results = await this.plugin.getRecommendations(activeFile, {
				treatAsUnlinkedPaths: new Set(optimisticUnlinkedPaths.keys())
			});
			const stableResults = this.stabilizeVisibleCandidateResults(results);
			for (const result of results) {
				optimisticUnlinkedPaths.delete(result.doc.path);
			}
			const resultsWithOptimisticCandidates = this.addOptimisticCandidateResults(stableResults, docs, source, optimisticUnlinkedPaths);
			const optimisticLinkedPaths = this.optimisticLinkedPathsBySource.get(activeFile.path) ?? new Map<string, OptimisticLinkedPath>();
			const linkedPaths = new Set(linkedDocs.map((doc) => doc.path));
			const content = optimisticLinkedPaths.size > 0 ? await this.app.vault.cachedRead(activeFile) : "";
			for (const [path, optimistic] of optimisticLinkedPaths) {
				const shouldCheckContent = now - optimistic.createdAt >= OPTIMISTIC_LINK_CONTENT_CHECK_DELAY_MS;
				if (linkedPaths.has(path) || optimistic.expiresAt <= now || (shouldCheckContent && !hasExistingLink(content, optimistic.linkCandidates))) {
					optimisticLinkedPaths.delete(path);
				}
			}
			const optimisticLinkedDocs = this.plugin.getIndexedDocs()
				.filter((doc) => optimisticLinkedPaths.has(doc.path) && doc.path !== activeFile.path && !linkedPaths.has(doc.path));
			const model = buildGraphModel(source, [...linkedDocs, ...optimisticLinkedDocs], resultsWithOptimisticCandidates, this.plugin.settings.graphDisplay);
			const linkedCount = model.nodes.filter((node) => node.kind === "linked").length;
			const candidateCount = model.nodes.filter((node) => node.kind === "candidate").length;
			this.lastModel = model;
			this.startGraph(model);
			this.statusEl.setAttr("aria-label", `${linkedCount} linked / ${candidateCount} candidates`);
			this.statusEl.setText("");
		} catch (error) {
			console.error(error);
			this.statusEl.setText("Unable to render graph. Check the console for details.");
		}
	}

	private startGraph(model: GraphModel): void {
		if (!this.graphEl || !this.graphHostEl) {
			return;
		}
		const bounds = this.getGraphBounds();
		this.layoutModel = initializeForceLayout(model, bounds, this.layoutModel, this.plugin.settings.graphDisplay);
		this.renderGraph(this.layoutModel, bounds);
		this.startSimulation();
	}

	private createGraphControls(parentEl: HTMLElement): void {
		const controlsEl = parentEl.createDiv({ cls: "semantic-linker-graph-controls" });
		controlsEl.appendChild(this.createGraphControlButton("settings", "Open Semantic Linker settings", () => {
			this.openPluginSettings();
		}));
		this.timelapseButtonEl = this.createGraphControlButton("wand-sparkles", "Play timelapse animation", () => {
			this.playTimelapseAnimation();
		});
		controlsEl.appendChild(this.timelapseButtonEl);
	}

	private createGraphControlButton(icon: string, label: string, onClick: () => void): HTMLButtonElement {
		const button = document.createElement("button");
		button.type = "button";
		button.addClass("clickable-icon");
		button.addClass("semantic-linker-graph-control");
		button.setAttr("aria-label", label);
		button.setAttr("title", label);
		setIcon(button, icon);
		button.addEventListener("pointerdown", (event) => {
			event.stopPropagation();
		});
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			onClick();
		});
		return button;
	}

	private openPluginSettings(): void {
		const appWithSettings = this.app as typeof this.app & { setting?: SettingsModalLike };
		appWithSettings.setting?.open();
		appWithSettings.setting?.openTabById(this.plugin.manifest.id);
	}

	private playTimelapseAnimation(): void {
		if (!this.lastModel) {
			return;
		}
		this.stopTimelapse();
		this.timelapseSourceModel = this.lastModel;
		this.timelapseButtonEl?.addClass("is-active");
		const orderedNodes = getTimelapseOrbitNodes(this.lastModel);
		let visibleCount = 0;
		this.showTimelapseFrame(orderedNodes, visibleCount);
		const tick = () => {
			visibleCount += 1;
			this.showTimelapseFrame(orderedNodes, visibleCount);
			if (visibleCount >= orderedNodes.length) {
				this.stopTimelapse(false);
				return;
			}
			this.timelapseTimer = window.setTimeout(tick, TIMELAPSE_STEP_MS);
		};
		this.timelapseTimer = window.setTimeout(tick, TIMELAPSE_STEP_MS);
	}

	private showTimelapseFrame(orderedNodes: GraphNode[], visibleCount: number): void {
		if (!this.timelapseSourceModel) {
			return;
		}
		const visibleIds = new Set([
			this.timelapseSourceModel.center.id,
			...orderedNodes.slice(0, visibleCount).map((node) => node.id)
		]);
		const model: GraphModel = {
			center: this.timelapseSourceModel.center,
			nodes: this.timelapseSourceModel.nodes.filter((node) => visibleIds.has(node.id)),
			edges: this.timelapseSourceModel.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
		};
		if (!this.layoutModel || !this.layoutModel.nodes.every((node) => visibleIds.has(node.id))) {
			this.layoutModel = null;
		}
		this.graphStructureKey = "";
		this.startGraph(model);
	}

	private stopTimelapse(renderFinal = true): void {
		if (this.timelapseTimer !== null) {
			window.clearTimeout(this.timelapseTimer);
			this.timelapseTimer = null;
		}
		const finalModel = this.timelapseSourceModel;
		this.timelapseSourceModel = null;
		this.timelapseButtonEl?.removeClass("is-active");
		if (renderFinal && finalModel) {
			this.graphStructureKey = "";
			this.startGraph(finalModel);
		}
	}

	private addOptimisticCandidateResults(
		results: RankingResult[],
		docs: IndexedDoc[],
		source: IndexedDoc,
		optimisticUnlinkedPaths: Map<string, OptimisticUnlinkedPath>
	): RankingResult[] {
		if (optimisticUnlinkedPaths.size === 0) {
			return results;
		}
		const existingPaths = new Set(results.map((result) => result.doc.path));
		const nextResults = [...results];
		for (const [path, optimistic] of optimisticUnlinkedPaths) {
			if (existingPaths.has(path)) {
				continue;
			}
			const doc = docs.find((item) => item.path === path);
			if (!doc || doc.path === source.path) {
				continue;
			}
			nextResults.push(optimistic.result ?? createOptimisticResult(source, doc, optimistic.score));
		}
		return nextResults.sort((a, b) => b.score - a.score);
	}

	private stabilizeVisibleCandidateResults(results: RankingResult[]): RankingResult[] {
		const stabilized = stabilizeCandidateCohort(results, this.visibleCandidatePaths);
		this.visibleCandidatePaths = stabilized.cohortPaths;
		return stabilized.results;
	}

	private renderGraph(model: GraphModel, bounds = this.getGraphBounds()): void {
		if (!this.graphEl) {
			return;
		}
		const { width, height } = bounds;
		const nextStructureKey = this.graphStructureKeyFor(model);
		if (this.graphEl.childElementCount > 0 && this.graphStructureKey === nextStructureKey) {
			this.updateGraphPositions(model, bounds);
			return;
		}
		this.graphEl.empty();
		this.graphStructureKey = nextStructureKey;
		this.graphEl.setAttr("viewBox", `0 0 ${width} ${height}`);
		this.graphEl.setAttr("width", "100%");
		this.graphEl.setAttr("height", "100%");
		this.graphEl.style.setProperty("--semantic-linker-link-thickness", String(this.plugin.settings.graphDisplay.linkThickness));
		this.graphEl.appendChild(this.renderDefinitions());
		const edgeLayer = document.createElementNS(SVG_NS, "g");
		edgeLayer.addClass("semantic-linker-edge-layer");
		const nodeLayer = document.createElementNS(SVG_NS, "g");
		nodeLayer.addClass("semantic-linker-node-layer");
		const viewportLayer = document.createElementNS(SVG_NS, "g");
		viewportLayer.addClass("semantic-linker-viewport-layer");
		viewportLayer.setAttr("transform", `translate(${this.transform.x}, ${this.transform.y}) scale(${this.transform.scale})`);
		viewportLayer.append(edgeLayer, nodeLayer);
		this.graphEl.appendChild(viewportLayer);
		for (const edge of model.edges) {
			edgeLayer.appendChild(this.renderEdge(edge, model));
		}
		for (const node of model.nodes) {
			nodeLayer.appendChild(this.renderNode(node));
		}
	}

	private updateGraphPositions(model: GraphModel, bounds = this.getGraphBounds()): void {
		if (!this.graphEl) {
			return;
		}
		const { width, height } = bounds;
		this.graphEl.setAttr("viewBox", `0 0 ${width} ${height}`);
		const viewportLayer = this.graphEl.querySelector<SVGGElement>(".semantic-linker-viewport-layer");
		viewportLayer?.setAttr("transform", `translate(${this.transform.x}, ${this.transform.y}) scale(${this.transform.scale})`);
		for (const edge of model.edges) {
			const line = Array.from(this.graphEl.querySelectorAll<SVGLineElement>("line[data-edge-id]"))
				.find((item) => item.dataset.edgeId === edgeId(edge));
			const source = model.nodes.find((node) => node.id === edge.source);
			const target = model.nodes.find((node) => node.id === edge.target);
			if (line && source && target) {
				line.setAttr("x1", source.x);
				line.setAttr("y1", source.y);
				line.setAttr("x2", target.x);
				line.setAttr("y2", target.y);
			}
		}
		for (const node of model.nodes) {
			const group = Array.from(this.graphEl.querySelectorAll<SVGGElement>("g[data-node-id]"))
				.find((item) => item.dataset.nodeId === node.id);
			group?.setAttr("transform", `translate(${node.x}, ${node.y})`);
		}
	}

	private graphStructureKeyFor(model: GraphModel): string {
		const nodeKey = model.nodes.map((node) => `${node.id}:${node.kind}:${node.radius.toFixed(2)}`).join("|");
		const edgeKey = model.edges.map(edgeId).join("|");
		const labelState = this.transform.scale < this.plugin.settings.graphDisplay.textFadeThreshold ? "labels-faded" : "labels-visible";
		return `${nodeKey}::${edgeKey}::${this.hoveredNodeId ?? ""}::${this.plugin.settings.graphDisplay.showArrows}::${labelState}`;
	}

	private startSimulation(): void {
		if (this.animationFrameId !== null) {
			return;
		}
		const tick = () => {
			if (!this.layoutModel || !this.graphEl) {
				this.animationFrameId = null;
				return;
			}
			const energy = advanceForceLayout(this.layoutModel, this.getGraphBounds(), {
				draggedNodeId: this.draggedNodeId,
				display: this.plugin.settings.graphDisplay
			});
			this.renderGraph(this.layoutModel);
			if (this.draggedNodeId || energy > 0.02) {
				this.animationFrameId = window.requestAnimationFrame(tick);
			} else {
				this.animationFrameId = null;
			}
		};
		this.animationFrameId = window.requestAnimationFrame(tick);
	}

	private stopSimulation(): void {
		if (this.animationFrameId !== null) {
			window.cancelAnimationFrame(this.animationFrameId);
			this.animationFrameId = null;
		}
	}

	private clearGraph(): void {
		this.lastModel = null;
		this.layoutModel = null;
		this.graphStructureKey = "";
		this.hoveredNodeId = null;
		this.graphEl?.empty();
		this.stopTimelapse();
		this.stopSimulation();
	}

	private resetInteractionState(): void {
		this.hoveredNodeId = null;
		this.cleanupPointerInteraction();
		this.dragMoved = false;
		this.transform = { x: 0, y: 0, scale: 1 };
		this.visibleCandidatePaths = [];
		this.layoutModel = null;
		this.graphStructureKey = "";
		this.stopSimulation();
	}

	private getGraphBounds(): GraphBounds {
		const bounds = this.graphHostEl?.getBoundingClientRect();
		return {
			width: Math.max(240, bounds?.width || 320),
			height: Math.max(220, bounds?.height || 320)
		};
	}

	private renderEdge(edge: GraphEdge, model: GraphModel): SVGLineElement {
		const source = model.nodes.find((node) => node.id === edge.source);
		const target = model.nodes.find((node) => node.id === edge.target);
		const line = document.createElementNS(SVG_NS, "line");
		line.addClass("semantic-linker-edge");
		line.addClass(`semantic-linker-edge-${edge.kind}`);
		line.setAttr("data-edge-id", edgeId(edge));
		if (this.hoveredNodeId && edge.source !== this.hoveredNodeId && edge.target !== this.hoveredNodeId) {
			line.addClass("semantic-linker-dimmed");
		}
		if (this.hoveredNodeId && (edge.source === this.hoveredNodeId || edge.target === this.hoveredNodeId)) {
			line.addClass("semantic-linker-highlighted");
		}
		if (source && target) {
			line.setAttr("x1", source.x);
			line.setAttr("y1", source.y);
			line.setAttr("x2", target.x);
			line.setAttr("y2", target.y);
			if (this.plugin.settings.graphDisplay.showArrows) {
				line.setAttr("marker-end", "url(#semantic-linker-arrow)");
			}
		}
		return line;
	}

	private renderDefinitions(): SVGDefsElement {
		const defs = document.createElementNS(SVG_NS, "defs");
		const marker = document.createElementNS(SVG_NS, "marker");
		marker.setAttr("id", "semantic-linker-arrow");
		marker.setAttr("viewBox", "0 0 10 10");
		marker.setAttr("refX", 9);
		marker.setAttr("refY", 5);
		marker.setAttr("markerWidth", 4);
		marker.setAttr("markerHeight", 4);
		marker.setAttr("orient", "auto-start-reverse");
		const path = document.createElementNS(SVG_NS, "path");
		path.setAttr("d", "M 0 0 L 10 5 L 0 10 z");
		path.addClass("semantic-linker-arrow");
		marker.appendChild(path);
		defs.appendChild(marker);
		return defs;
	}

	private renderNode(node: GraphNode): SVGGElement {
		const group = document.createElementNS(SVG_NS, "g");
		group.addClass("semantic-linker-node");
		group.addClass(`semantic-linker-node-${node.kind}`);
		group.setAttr("data-node-id", node.id);
		if (this.hoveredNodeId && this.hoveredNodeId !== node.id && !this.isConnectedToHoveredNode(node.id)) {
			group.addClass("semantic-linker-dimmed");
		}
		group.setAttr("transform", `translate(${node.x}, ${node.y})`);
		group.setAttr("tabindex", "0");
		group.setAttr("role", "button");
		group.setAttr("aria-label", `${node.title} ${node.score.toFixed(3)}`);
		group.appendChild(svgTitle(`${node.title}${node.kind === "candidate" ? ` / score ${node.score.toFixed(3)}` : ""}`));

		const hitArea = document.createElementNS(SVG_NS, "circle");
		hitArea.addClass("semantic-linker-node-hit-area");
		hitArea.setAttr("r", Math.max(12, node.radius + 8));
		group.appendChild(hitArea);

		const circle = document.createElementNS(SVG_NS, "circle");
		circle.addClass("semantic-linker-node-dot");
		circle.setAttr("r", node.radius);
		group.appendChild(circle);

		const label = document.createElementNS(SVG_NS, "text");
		label.addClass("semantic-linker-node-label");
		if (node.kind !== "center" && this.transform.scale < this.plugin.settings.graphDisplay.textFadeThreshold) {
			label.addClass("semantic-linker-node-label-faded");
		}
		label.setAttr("x", 0);
		label.setAttr("y", -node.radius - 8);
		label.setAttr("text-anchor", "middle");
		label.setText(truncateTitle(node.title));
		group.appendChild(label);

		group.addEventListener("pointerdown", (event) => {
			this.handleNodePointerDown(event, node);
		});
		group.addEventListener("pointerenter", (event) => {
			event.stopPropagation();
			if (this.draggedNodeId || this.isPanning) {
				return;
			}
			this.setHoveredNode(node.id);
		});
		group.addEventListener("pointerleave", (event) => {
			event.stopPropagation();
			if (this.draggedNodeId || this.isPanning) {
				return;
			}
			if (this.hoveredNodeId === node.id) {
				this.setHoveredNode(null);
			}
		});
		group.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				void this.handleNodeClick(node);
			}
		});
		return group;
	}

	private registerGraphViewportEvents(): void {
		if (!this.graphEl) {
			return;
		}
		this.graphEl.addEventListener("wheel", (event) => {
			event.preventDefault();
			const factor = event.deltaY < 0 ? 1.12 : 0.89;
			this.zoomAt(event.clientX, event.clientY, factor);
		}, { passive: false });
		this.graphEl.addEventListener("pointerdown", (event) => {
			if (event.button !== 0 || this.isNodeEventTarget(event.target)) {
				return;
			}
			event.preventDefault();
			this.isPanning = true;
			this.graphEl?.setPointerCapture(event.pointerId);
			this.graphEl?.addClass("semantic-linker-graph-panning");
			const start = {
				x: event.clientX,
				y: event.clientY,
				transformX: this.transform.x,
				transformY: this.transform.y
			};
			const handlePointerMove = (moveEvent: PointerEvent) => {
				if (!this.isPanning) {
					return;
				}
				this.transform = {
					...this.transform,
					x: start.transformX + moveEvent.clientX - start.x,
					y: start.transformY + moveEvent.clientY - start.y
				};
				this.renderLayout();
			};
			const handlePointerUp = (upEvent: PointerEvent) => {
				this.releasePointerCapture(upEvent.pointerId);
				this.endPanning();
				this.graphEl?.removeEventListener("pointermove", handlePointerMove);
				this.graphEl?.removeEventListener("pointerup", handlePointerUp);
				this.graphEl?.removeEventListener("pointercancel", handlePointerUp);
				this.graphEl?.removeEventListener("lostpointercapture", handlePointerUp);
				this.flushPendingRefreshAfterInteraction();
			};
			this.graphEl?.addEventListener("pointermove", handlePointerMove);
			this.graphEl?.addEventListener("pointerup", handlePointerUp);
			this.graphEl?.addEventListener("pointercancel", handlePointerUp);
			this.graphEl?.addEventListener("lostpointercapture", handlePointerUp);
		});
		this.graphEl.addEventListener("keydown", (event) => {
			if (event.key === "+" || event.key === "=") {
				event.preventDefault();
				this.zoomAtCenter(1.12);
			} else if (event.key === "-" || event.key === "_") {
				event.preventDefault();
				this.zoomAtCenter(0.89);
			} else if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "ArrowLeft" || event.key === "ArrowRight") {
				event.preventDefault();
				this.panWithKeyboard(event.key, event.shiftKey ? 80 : 28);
			}
		});
	}

	private renderLayout(): void {
		if (this.layoutModel) {
			this.renderGraph(this.layoutModel);
		}
	}

	private setHoveredNode(nodeId: string | null): void {
		if (this.hoveredNodeId === nodeId) {
			return;
		}
		this.hoveredNodeId = nodeId;
		this.renderLayout();
	}

	private zoomAtCenter(factor: number): void {
		const bounds = this.getGraphBounds();
		this.zoomAt(bounds.width / 2, bounds.height / 2, factor);
	}

	private zoomAt(clientX: number, clientY: number, factor: number): void {
		if (!this.graphEl) {
			return;
		}
		const rect = this.graphEl.getBoundingClientRect();
		const svgPoint = clientToSvgPoint(clientX, clientY, rect);
		this.transform = zoomTransformAtSvgPoint(this.transform, svgPoint, factor, 0.55, 2.8);
		this.renderLayout();
	}

	private clientPointToGraphPoint(clientX: number, clientY: number): { x: number; y: number } {
		const rect = this.graphEl?.getBoundingClientRect() ?? { left: 0, top: 0 };
		return clientToGraphPoint(clientX, clientY, rect, this.transform);
	}

	private panWithKeyboard(key: string, amount: number): void {
		if (key === "ArrowUp") this.transform = panTransform(this.transform, 0, amount);
		if (key === "ArrowDown") this.transform = panTransform(this.transform, 0, -amount);
		if (key === "ArrowLeft") this.transform = panTransform(this.transform, amount, 0);
		if (key === "ArrowRight") this.transform = panTransform(this.transform, -amount, 0);
		this.renderLayout();
	}

	private isNodeEventTarget(target: EventTarget | null): boolean {
		return target instanceof Element && Boolean(target.closest(".semantic-linker-node"));
	}

	private isConnectedToHoveredNode(nodeId: string): boolean {
		return Boolean(this.layoutModel?.edges.some((edge) =>
			(edge.source === this.hoveredNodeId && edge.target === nodeId)
			|| (edge.target === this.hoveredNodeId && edge.source === nodeId)
		));
	}

	private isPointerInteractionActive(): boolean {
		return this.isPanning || this.draggedNodeId !== null;
	}

	private releasePointerCapture(pointerId: number): void {
		if (this.graphEl?.hasPointerCapture(pointerId)) {
			this.graphEl.releasePointerCapture(pointerId);
		}
	}

	private endPanning(): void {
		this.isPanning = false;
		this.graphEl?.removeClass("semantic-linker-graph-panning");
	}

	private endNodeDragging(): void {
		this.draggedNodeId = null;
		this.dragMoved = false;
		this.graphEl?.removeClass("semantic-linker-graph-dragging");
	}

	private cleanupPointerInteraction(): void {
		this.endPanning();
		this.endNodeDragging();
	}

	private flushPendingRefreshAfterInteraction(): void {
		if (!this.pendingRefreshAfterInteraction || this.isPointerInteractionActive()) {
			return;
		}
		this.pendingRefreshAfterInteraction = false;
		void this.refresh();
	}

	private handleNodePointerDown(event: PointerEvent, node: GraphNode): void {
		if (!this.graphEl || node.kind === "center") {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		this.dragMoved = false;
		const startPoint = { x: event.clientX, y: event.clientY };
		this.graphEl.setPointerCapture(event.pointerId);
		this.graphEl.addClass("semantic-linker-graph-dragging");
		const handlePointerMove = (moveEvent: PointerEvent) => {
			if (Math.hypot(moveEvent.clientX - startPoint.x, moveEvent.clientY - startPoint.y) > DRAG_CLICK_TOLERANCE_PX) {
				this.dragMoved = true;
				this.draggedNodeId = node.id;
			}
			const draggedNode = this.layoutModel?.nodes.find((item) => item.id === this.draggedNodeId);
			if (draggedNode && this.dragMoved) {
				this.moveNodeToPointer(moveEvent, draggedNode);
			}
			this.startSimulation();
		};
		const handlePointerUp = (upEvent: PointerEvent) => {
			this.releasePointerCapture(upEvent.pointerId);
			this.graphEl?.removeEventListener("pointermove", handlePointerMove);
			this.graphEl?.removeEventListener("pointerup", handlePointerUp);
			this.graphEl?.removeEventListener("pointercancel", handlePointerUp);
			this.graphEl?.removeEventListener("lostpointercapture", handlePointerUp);
			const shouldClick = !this.dragMoved;
			this.endNodeDragging();
			if (shouldClick) {
				void this.handleNodeClick(node);
			}
			this.startSimulation();
			if (!shouldClick) {
				this.flushPendingRefreshAfterInteraction();
			}
		};
		this.graphEl.addEventListener("pointermove", handlePointerMove);
		this.graphEl.addEventListener("pointerup", handlePointerUp);
		this.graphEl.addEventListener("pointercancel", handlePointerUp);
		this.graphEl.addEventListener("lostpointercapture", handlePointerUp);
		this.startSimulation();
	}

	private moveNodeToPointer(event: PointerEvent, node: GraphNode): void {
		if (!this.graphEl) {
			return;
		}
		const localPoint = this.clientPointToGraphPoint(event.clientX, event.clientY);
		const bounds = this.getGraphBounds();
		node.x = Math.max(node.radius + 14, Math.min(bounds.width - node.radius - 14, localPoint.x));
		node.y = Math.max(node.radius + 14, Math.min(bounds.height - node.radius - 14, localPoint.y));
		node.vx = 0;
		node.vy = 0;
	}

	private async handleNodeClick(node: GraphNode): Promise<void> {
		if (this.clickedNodeIds.has(node.id)) {
			return;
		}
		this.clickedNodeIds.add(node.id);
		try {
			if (node.kind === "candidate" && node.result) {
				const insertResult = await this.plugin.insertRecommendation(node.result);
				if (insertResult?.status === "inserted") {
					this.addOptimisticLinkedPath(node.path, insertResult.linkCandidates);
					this.showActionNotice(`Inserted link to ${node.title}`);
				} else if (insertResult?.status === "existing") {
					this.showActionNotice(`Link to ${node.title} already exists.`);
				}
				await this.refresh();
				return;
			}
			if (node.kind === "linked") {
				const removal = await this.plugin.unlinkFromLinksSection(node.path);
				if (removal.status === "removed") {
					this.clearOptimisticLinkedPath(node.path);
					if (!removal.stillLinkedInContent) {
						this.addOptimisticUnlinkedPath(node);
					}
					this.showActionNotice(`Removed link to ${node.title}`);
				} else if (removal.status === "not-found") {
					this.showActionNotice("No link found in Links section.");
				} else if (removal.status === "no-active-file") {
					this.showActionNotice("Open a note before removing a link.");
				} else {
					this.showActionNotice("Target note is not indexed yet.");
				}
				await this.refresh();
			}
		} finally {
			this.clickedNodeIds.delete(node.id);
			this.flushPendingRefreshAfterInteraction();
		}
	}

	private addOptimisticLinkedPath(path: string, linkCandidates: string[]): void {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			return;
		}
		const linkedPaths = this.optimisticLinkedPathsBySource.get(activeFile.path) ?? new Map<string, OptimisticLinkedPath>();
		const now = Date.now();
		linkedPaths.set(path, {
			createdAt: now,
			expiresAt: now + OPTIMISTIC_LINK_TTL_MS,
			linkCandidates
		});
		this.optimisticLinkedPathsBySource.set(activeFile.path, linkedPaths);
		this.scheduleOptimisticRefresh();
	}

	private showActionNotice(message: string): void {
		if (this.plugin.settings.showActionNotices) {
			new Notice(message);
		}
	}

	private clearOptimisticLinkedPath(path: string): void {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			return;
		}
		this.optimisticLinkedPathsBySource.get(activeFile.path)?.delete(path);
	}

	private addOptimisticUnlinkedPath(node: GraphNode): void {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			return;
		}
		const unlinkedPaths = this.optimisticUnlinkedPathsBySource.get(activeFile.path) ?? new Map<string, OptimisticUnlinkedPath>();
		const now = Date.now();
		unlinkedPaths.set(node.path, {
			createdAt: now,
			expiresAt: now + OPTIMISTIC_LINK_TTL_MS,
			score: node.result?.score ?? node.score,
			result: node.result
		});
		this.optimisticUnlinkedPathsBySource.set(activeFile.path, unlinkedPaths);
		this.scheduleOptimisticRefresh();
	}

	private scheduleOptimisticRefresh(): void {
		if (this.optimisticRefreshTimer !== null) {
			window.clearTimeout(this.optimisticRefreshTimer);
		}
		this.optimisticRefreshTimer = window.setTimeout(() => {
			this.optimisticRefreshTimer = null;
			void this.refresh();
		}, OPTIMISTIC_LINK_TTL_MS + 100);
	}
}

function svgTitle(text: string): SVGTitleElement {
	const title = document.createElementNS(SVG_NS, "title");
	title.setText(text);
	return title;
}

function truncateTitle(title: string): string {
	return title.length > 22 ? `${title.slice(0, 21)}...` : title;
}

function edgeId(edge: GraphEdge): string {
	return `${edge.source}->${edge.target}`;
}

function getTimelapseOrbitNodes(model: GraphModel): GraphNode[] {
	return model.nodes
		.filter((node) => node.kind !== "center")
		.sort((a, b) => {
			if (a.ctime !== b.ctime) {
				return a.ctime - b.ctime;
			}
			return a.title.localeCompare(b.title);
		});
}

function createOptimisticResult(source: IndexedDoc, doc: IndexedDoc, score: number): RankingResult {
	const safeScore = Number.isFinite(score) ? score : 0.5;
	return {
		doc,
		score: safeScore,
		reasons: ["recently unlinked"],
		features: {
			titleSim: safeScore,
			descriptionSim: safeScore,
			tagsEmbeddingSim: safeScore,
			tagIdfJaccard: 0,
			bm25Score: 0,
			sameType: source.type && source.type === doc.type ? 1 : 0,
			sameKind: source.kind && source.kind === doc.kind ? 1 : 0,
			typeKindRelationScore: source.type === doc.type || source.kind === doc.kind ? 0.5 : 0,
			sharedBacklinkScore: 0,
			twoHopScore: 0,
			candidateDegree: 0,
			personalFeedbackScore: 0,
			pathContext: 0,
			baseScore: safeScore
		},
		templateContext: {
			sourcePath: source.path,
			targetPath: doc.path,
			title: doc.title || doc.basename,
			filename: doc.filename,
			basename: doc.basename,
			description: doc.description || doc.title || doc.basename,
			url: doc.path,
			wikiLink: `[[${doc.basename}]]`,
			markdownLink: `[${doc.description || doc.title || doc.basename}](${doc.path})`,
			obsidianUri: `obsidian://open?path=${encodeURIComponent(doc.path)}`,
			tags: doc.tags.join(", "),
			score: safeScore.toFixed(3)
		}
	};
}

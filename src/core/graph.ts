import type { GraphDisplaySettings, IndexedDoc, RankingResult } from "./types";

export type GraphNodeKind = "center" | "linked" | "candidate";
export type GraphEdgeKind = "linked" | "candidate";

export interface GraphNode {
	id: string;
	path: string;
	title: string;
	ctime: number;
	score: number;
	radialScore?: number;
	lockedDistance?: number;
	lockedRadius?: number;
	kind: GraphNodeKind;
	x: number;
	y: number;
	vx: number;
	vy: number;
	radius: number;
	result?: RankingResult;
}

export interface GraphEdge {
	source: string;
	target: string;
	kind: GraphEdgeKind;
}

export interface GraphModel {
	center: GraphNode;
	nodes: GraphNode[];
	edges: GraphEdge[];
}

export interface GraphBounds {
	width: number;
	height: number;
}

export interface ForceLayoutOptions {
	draggedNodeId?: string | null;
	display?: GraphDisplaySettings;
}

export interface StabilizedCandidateCohort {
	results: RankingResult[];
	cohortPaths: string[];
}

export function buildGraphModel(source: IndexedDoc, linkedDocs: IndexedDoc[], rankingResults: RankingResult[], display?: GraphDisplaySettings): GraphModel {
	const nodeSize = display?.nodeSize ?? 1;
	const center = createNode(source.path, source.path, source.title || source.basename, source.ctime ?? source.mtime, 1, "center", nodeRadius(source, "center", 1, nodeSize));
	const linkedPaths = new Set(linkedDocs.map((doc) => doc.path));
	const unlinkedResults = rankingResults.filter((result) => !linkedPaths.has(result.doc.path) && result.doc.path !== source.path);
	const scoreRange = scoreStats(unlinkedResults.map((result) => result.score));
	const linkedNodes = linkedDocs
		.filter((doc) => doc.path !== source.path)
		.map((doc) => createNode(`linked:${doc.path}`, doc.path, doc.title || doc.basename, doc.ctime ?? doc.mtime, 1, "linked", nodeRadius(doc, "linked", 1, nodeSize)));
	const candidateNodes = unlinkedResults
		.map((result) => ({
			...createNode(
				`candidate:${result.doc.path}`,
				result.doc.path,
				result.doc.title || result.doc.basename,
				result.doc.ctime ?? result.doc.mtime,
				result.score,
				"candidate",
				nodeRadius(result.doc, "candidate", result.score, nodeSize)
			),
			radialScore: relativeScore(result.score, scoreRange.min, scoreRange.max),
			result
		}));
	const nodes = [center, ...linkedNodes, ...candidateNodes];
	const linkedNodeIds = new Map(linkedNodes.map((node) => [node.path, node.id]));
	const peerEdges: GraphEdge[] = [];
	const peerEdgeKeys = new Set<string>();
	for (const doc of linkedDocs) {
		const sourceId = linkedNodeIds.get(doc.path);
		if (!sourceId) {
			continue;
		}
		for (const targetPath of doc.outgoingLinks) {
			const targetId = linkedNodeIds.get(targetPath);
			if (!targetId) {
				continue;
			}
			const key = [sourceId, targetId].sort().join("->");
			if (peerEdgeKeys.has(key)) {
				continue;
			}
			peerEdgeKeys.add(key);
			peerEdges.push({ source: sourceId, target: targetId, kind: "linked" });
		}
	}
	const edges: GraphEdge[] = [
		...linkedNodes.map((node) => ({ source: center.id, target: node.id, kind: "linked" as const })),
		...peerEdges
	];
	return { center, nodes, edges };
}

export function stabilizeCandidateCohort(results: RankingResult[], cohortPaths: readonly string[]): StabilizedCandidateCohort {
	if (cohortPaths.length === 0) {
		return {
			results,
			cohortPaths: results.map((result) => result.doc.path)
		};
	}
	const visiblePaths = new Set(cohortPaths);
	return {
		results: results.filter((result) => visiblePaths.has(result.doc.path)),
		cohortPaths: [...cohortPaths]
	};
}

export function runForceLayout(model: GraphModel, bounds: GraphBounds, iterations = 90): GraphModel {
	const layout = initializeForceLayout(model, bounds);
	for (let step = 0; step < iterations; step += 1) {
		advanceForceLayout(layout, bounds);
	}
	return layout;
}

export function initializeForceLayout(model: GraphModel, bounds: GraphBounds, previousModel?: GraphModel | null, display?: GraphDisplaySettings): GraphModel {
	const width = Math.max(bounds.width, 240);
	const height = Math.max(bounds.height, 220);
	const centerX = width / 2;
	const centerY = height / 2;
	const previousNodes = new Map(previousModel?.nodes.map((node) => [node.id, node]) ?? []);
	const previousNodesByPath = new Map(previousModel?.nodes.map((node) => [node.path, node]) ?? []);
	const nodes = model.nodes.map((node) => ({ ...node }));
	const center = nodes.find((node) => node.kind === "center") ?? nodes[0];
	if (!center) {
		return model;
	}

	center.x = centerX;
	center.y = centerY;
	center.vx = 0;
	center.vy = 0;
	const orbitNodes = nodes.filter((node) => node.kind !== "center");
	const minDimension = Math.min(width, height);
	orbitNodes.forEach((node, index) => {
		const previous = previousNodes.get(node.id) ?? previousNodesByPath.get(node.path);
		if (previous && isFinitePoint(previous.x, previous.y)) {
			node.lockedDistance = previous.lockedDistance;
			node.lockedRadius = previous.lockedRadius;
			node.x = clamp(previous.x, node.radius + 14, width - node.radius - 14);
			node.y = clamp(previous.y, node.radius + 14, height - node.radius - 14);
			node.vx = previous.vx * 0.25;
			node.vy = previous.vy * 0.25;
			if (node.lockedDistance == null && previous.kind !== node.kind) {
				node.lockedDistance = distanceToPoint(previous, centerX, centerY);
			}
			if (node.lockedRadius == null && previous.kind !== node.kind) {
				node.lockedRadius = previous.radius;
			}
			if (node.lockedRadius != null) {
				node.radius = node.lockedRadius;
			}
			return;
		}
		const spiralTurn = index * 2.399963229728653;
		const fallbackAngle = spiralTurn + hashToRange(`${node.id}:fallback`, -0.85, 0.85);
		const angle = hashToUnit(`${node.id}:angle`) * Math.PI * 2 || fallbackAngle;
		const distanceJitter = 0.72 + hashToUnit(`${node.id}:distance`) * 0.56;
		const distance = targetDistance(node, minDimension, display) * distanceJitter;
		node.x = centerX + Math.cos(angle) * distance;
		node.y = centerY + Math.sin(angle) * distance;
		node.vx = 0;
		node.vy = 0;
	});
	const nextCenter = nodes.find((node) => node.kind === "center") ?? center;
	const edges = model.edges.map((edge) => ({ ...edge }));
	return { center: nextCenter, nodes, edges };
}

export function advanceForceLayout(model: GraphModel, bounds: GraphBounds, options: ForceLayoutOptions = {}): number {
	const width = Math.max(bounds.width, 240);
	const height = Math.max(bounds.height, 220);
	const centerX = width / 2;
	const centerY = height / 2;
	const center = model.nodes.find((node) => node.kind === "center") ?? model.nodes[0];
	if (!center) {
		return 0;
	}

	center.x = centerX;
	center.y = centerY;
	center.vx = 0;
	center.vy = 0;
	const minDimension = Math.min(width, height);
	const orbitNodes = model.nodes.filter((node) => node.kind !== "center");
	for (let i = 0; i < orbitNodes.length; i += 1) {
		const a = orbitNodes[i];
		if (!a) continue;
		for (let j = i + 1; j < orbitNodes.length; j += 1) {
			const b = orbitNodes[j];
			if (!b) continue;
			applyRepulsion(a, b, options.draggedNodeId, options.display?.repelForce ?? 1);
		}
	}
	for (const edge of model.edges) {
		applyEdgeSpring(edge, model.nodes, centerX, centerY, minDimension, options.draggedNodeId, options.display);
	}
	let energy = 0;
	for (const node of orbitNodes) {
		if (node.id === options.draggedNodeId) {
			node.vx = 0;
			node.vy = 0;
			continue;
		}
		const desired = targetDistance(node, minDimension, options.display);
		const dx = node.x - centerX;
		const dy = node.y - centerY;
		const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
		const tangentialDrift = hashToRange(`${node.id}:drift`, -0.0018, 0.0018);
		const centerForce = options.display?.centerForce ?? 1;
		const pull = (distance - desired) * 0.011 * centerForce;
		node.vx -= (dx / distance) * pull;
		node.vy -= (dy / distance) * pull;
		node.vx += (-dy / distance) * tangentialDrift;
		node.vy += (dx / distance) * tangentialDrift;
		node.vx *= 0.88;
		node.vy *= 0.88;
		node.x = clamp(node.x + node.vx, node.radius + 14, width - node.radius - 14);
		node.y = clamp(node.y + node.vy, node.radius + 14, height - node.radius - 14);
		energy += Math.abs(node.vx) + Math.abs(node.vy);
	}
	return energy;
}

function createNode(id: string, path: string, title: string, ctime: number, score: number, kind: GraphNodeKind, radius: number): GraphNode {
	return {
		id,
		path,
		title,
		ctime,
		score,
		kind,
		x: 0,
		y: 0,
		vx: 0,
		vy: 0,
		radius
	};
}

function nodeRadius(doc: IndexedDoc, kind: GraphNodeKind, score: number, nodeSize: number): number {
	const degree = doc.incomingLinks.length + doc.outgoingLinks.length;
	const degreeBoost = Math.log1p(degree) * 0.45;
	const scoreBoost = kind === "candidate" ? score * 1.35 : 0;
	const base = kind === "center" ? 4.4 : kind === "linked" ? 3.1 : 2.8;
	return clamp((base + degreeBoost + scoreBoost) * nodeSize, 2.4, kind === "center" ? 8.5 : 7.5);
}

function targetDistance(node: GraphNode, minDimension: number, display?: GraphDisplaySettings): number {
	if (node.lockedDistance != null) {
		return node.lockedDistance;
	}
	const linkDistance = display?.linkDistance ?? 1;
	const maxRadius = Math.max(94, minDimension * 0.5) * linkDistance;
	if (node.kind === "linked") {
		return maxRadius * hashToRange(`${node.id}:linked-radius`, 0.58, 0.92);
	}
	const closeness = clamp(node.radialScore ?? node.score, 0, 1);
	return maxRadius * (0.96 - closeness * 0.5);
}

function scoreStats(scores: number[]): { min: number; max: number } {
	const finiteScores = scores.filter(Number.isFinite);
	if (finiteScores.length === 0) {
		return { min: 0, max: 0 };
	}
	return {
		min: Math.min(...finiteScores),
		max: Math.max(...finiteScores)
	};
}

function relativeScore(score: number, min: number, max: number): number {
	if (!Number.isFinite(score) || !Number.isFinite(min) || !Number.isFinite(max)) {
		return 0.5;
	}
	const range = max - min;
	if (Math.abs(range) < 1e-6) {
		return 0.5;
	}
	return clamp((score - min) / range, 0, 1);
}

function applyRepulsion(a: GraphNode, b: GraphNode, draggedNodeId?: string | null, repelForce = 1): void {
	let dx = b.x - a.x;
	let dy = b.y - a.y;
	let distanceSquared = dx * dx + dy * dy;
	if (distanceSquared < 0.01) {
		dx = 1;
		dy = 0;
		distanceSquared = 1;
	}
	const distance = Math.sqrt(distanceSquared);
	const minimum = a.radius + b.radius + 22 * repelForce;
	if (distance >= minimum) {
		return;
	}
	const force = (minimum - distance) * 0.045 * repelForce;
	const fx = (dx / distance) * force;
	const fy = (dy / distance) * force;
	if (a.id !== draggedNodeId) {
		a.vx -= fx;
		a.vy -= fy;
	}
	if (b.id !== draggedNodeId) {
		b.vx += fx;
		b.vy += fy;
	}
}

function applyEdgeSpring(edge: GraphEdge, nodes: GraphNode[], centerX: number, centerY: number, minDimension: number, draggedNodeId?: string | null, display?: GraphDisplaySettings): void {
	const source = nodes.find((node) => node.id === edge.source);
	const target = nodes.find((node) => node.id === edge.target);
	if (!source || !target || target.kind === "center") {
		return;
	}
	const sourceX = source.kind === "center" ? centerX : source.x;
	const sourceY = source.kind === "center" ? centerY : source.y;
	const dx = target.x - sourceX;
	const dy = target.y - sourceY;
	const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
	const linkDistance = display?.linkDistance ?? 1;
	const linkForce = display?.linkForce ?? 1;
	const desired = target.kind === "linked" ? Math.max(62, minDimension * 0.32) * linkDistance : targetDistance(target, minDimension, display);
	const force = (distance - desired) * 0.006 * linkForce;
	if (target.id !== draggedNodeId) {
		target.vx -= (dx / distance) * force;
		target.vy -= (dy / distance) * force;
	}
	if (source.kind !== "center" && source.id !== draggedNodeId) {
		source.vx += (dx / distance) * force * 0.5;
		source.vy += (dy / distance) * force * 0.5;
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function isFinitePoint(x: number, y: number): boolean {
	return Number.isFinite(x) && Number.isFinite(y);
}

function distanceToPoint(node: GraphNode, x: number, y: number): number {
	const dx = node.x - x;
	const dy = node.y - y;
	return Math.max(1, Math.sqrt(dx * dx + dy * dy));
}

function hashToUnit(value: string): number {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0) / 4294967295;
}

function hashToRange(value: string, min: number, max: number): number {
	return min + hashToUnit(value) * (max - min);
}

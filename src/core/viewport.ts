export interface ViewTransform {
	x: number;
	y: number;
	scale: number;
}

export interface ViewPoint {
	x: number;
	y: number;
}

export interface ViewRect {
	left: number;
	top: number;
}

export function clientToSvgPoint(clientX: number, clientY: number, rect: ViewRect): ViewPoint {
	return {
		x: clientX - rect.left,
		y: clientY - rect.top
	};
}

export function svgToGraphPoint(point: ViewPoint, transform: ViewTransform): ViewPoint {
	return {
		x: (point.x - transform.x) / transform.scale,
		y: (point.y - transform.y) / transform.scale
	};
}

export function clientToGraphPoint(clientX: number, clientY: number, rect: ViewRect, transform: ViewTransform): ViewPoint {
	return svgToGraphPoint(clientToSvgPoint(clientX, clientY, rect), transform);
}

export function zoomTransformAtSvgPoint(transform: ViewTransform, point: ViewPoint, factor: number, minScale: number, maxScale: number): ViewTransform {
	const graphPoint = svgToGraphPoint(point, transform);
	const scale = clamp(transform.scale * factor, minScale, maxScale);
	return {
		x: point.x - graphPoint.x * scale,
		y: point.y - graphPoint.y * scale,
		scale
	};
}

export function panTransform(transform: ViewTransform, dx: number, dy: number): ViewTransform {
	return {
		...transform,
		x: transform.x + dx,
		y: transform.y + dy
	};
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

// Minimal typings for ui/flow.js so the vitest suite can import the renderer under tsc --noEmit.
import type { FlowGraph } from "../src/flow/types.ts";

export type FlowLayoutNode = {
  id: string; x: number; y: number; w: number; h: number; layer: number; cluster: string | null;
  kind: string; role: string; part: number; seed: boolean; terminal: boolean; floor: boolean; rich: boolean; spine: boolean;
  text: { title: string; titleFont: string; role: string; sub: string; lines: string[] };
};
export type FlowLayoutCluster = { id: string; title: string; x: number; y: number; w: number; h: number; floor: boolean };
export type FlowLayoutLabel = { x: number; y: number; text: string; anchor: string; w: number; h: number; shown: boolean };
export type FlowLayoutEdge = {
  from: string; to: string; kind: string; back: boolean; carries: number; names: string[]; at: string; via?: string[];
  d: string; points: [number, number][]; arrow: { x: number; y: number; dir: "down" | "up" | "left" | "right" };
  spine: boolean; side: boolean; floor: boolean; label?: FlowLayoutLabel;
};
export type FlowLayout = {
  width: number; height: number; layers: number; spine: string[];
  nodes: FlowLayoutNode[]; clusters: FlowLayoutCluster[]; edges: FlowLayoutEdge[];
  stages: { y: number; h: number; text: string }[];
};
export type FlowLayoutOptions = { measure?: (text: string, fontKey: string) => number; debug?: boolean } & Record<string, unknown>;
export type FlowRenderOptions = FlowLayoutOptions & {
  onSelect?: (id: string | null) => void;
  onOpen?: (path: string, line: number) => void;
  walkthrough?: HTMLElement;
  walkthroughCollapsed?: boolean;
};
export type FlowApi = { destroy(): void; select(id: string | null, opts?: { reveal?: boolean }): void; fit(): void; layout: FlowLayout };

export const FLOW_ROLE_ORDER: readonly string[];
export function approxMeasure(text: string, fontKey: string): number;
export function layoutFlow(graph: FlowGraph, opts?: FlowLayoutOptions): FlowLayout;
export function renderFlow(container: HTMLElement, graph: FlowGraph, opts?: FlowRenderOptions): FlowApi;

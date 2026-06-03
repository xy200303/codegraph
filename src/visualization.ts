/**
 * Static HTML graph visualization support for the CLI.
 */

import {
  EDGE_KINDS,
  Edge,
  EdgeKind,
  GraphStats,
  NODE_KINDS,
  Node,
  NodeKind,
  SearchOptions,
  SearchResult,
  Subgraph,
  TraversalOptions,
} from './types';

export const DEFAULT_VISUALIZATION_LIMIT = 300;
export const DEFAULT_VISUALIZATION_DEPTH = 2;

export const DEFAULT_VISUALIZATION_NODE_KINDS: NodeKind[] = [
  'file',
  'module',
  'namespace',
  'class',
  'struct',
  'interface',
  'trait',
  'protocol',
  'enum',
  'type_alias',
  'function',
  'method',
  'route',
  'component',
];

export const DEFAULT_VISUALIZATION_EDGE_KINDS: EdgeKind[] = [...EDGE_KINDS];

export interface VisualizationDataSource {
  getStats(): GraphStats;
  getNodesByKind(kind: NodeKind): Node[];
  getOutgoingEdges(nodeId: string): Edge[];
  getIncomingEdges(nodeId: string): Edge[];
  searchNodes(query: string, options?: SearchOptions): SearchResult[];
  traverse(startId: string, options?: TraversalOptions): Subgraph;
}

export interface BuildVisualizationOptions {
  projectRoot: string;
  symbol?: string;
  limit?: number;
  depth?: number;
  direction?: 'incoming' | 'outgoing' | 'both';
  nodeKinds?: NodeKind[];
  edgeKinds?: EdgeKind[];
}

export interface VisualizationNode {
  id: string;
  label: string;
  kind: NodeKind;
  qualifiedName: string;
  filePath: string;
  language: string;
  line: number;
  signature?: string;
  exported: boolean;
  root: boolean;
  incoming: number;
  outgoing: number;
  size: number;
}

export interface VisualizationEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  line?: number;
  provenance?: Edge['provenance'];
}

export interface VisualizationGraph {
  title: string;
  projectRoot: string;
  mode: 'overview' | 'symbol';
  query?: string;
  generatedAt: number;
  nodes: VisualizationNode[];
  edges: VisualizationEdge[];
  rootIds: string[];
  stats: {
    totalNodes: number;
    totalEdges: number;
    includedNodes: number;
    includedEdges: number;
    truncated: boolean;
  };
}

const KIND_WEIGHT: Record<NodeKind, number> = {
  file: 110,
  route: 105,
  module: 100,
  namespace: 98,
  class: 96,
  struct: 94,
  interface: 92,
  trait: 91,
  protocol: 91,
  component: 90,
  function: 86,
  method: 84,
  enum: 78,
  type_alias: 76,
  property: 50,
  field: 48,
  constant: 46,
  variable: 40,
  enum_member: 34,
  import: 24,
  export: 24,
  parameter: 10,
};

const OVERVIEW_POOL_MULTIPLIER = 8;
const OVERVIEW_POOL_MIN = 500;
const OVERVIEW_POOL_MAX = 4000;

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value!), min), max);
}

function edgeKey(edge: Edge): string {
  return `${edge.source}\u0000${edge.target}\u0000${edge.kind}\u0000${edge.line ?? ''}`;
}

function isExactSymbolMatch(node: Node, symbol: string): boolean {
  return (
    node.name === symbol ||
    node.qualifiedName === symbol ||
    node.name.endsWith(`.${symbol}`) ||
    node.name.endsWith(`::${symbol}`) ||
    node.qualifiedName.endsWith(`.${symbol}`) ||
    node.qualifiedName.endsWith(`::${symbol}`)
  );
}

function nodeBaseScore(node: Node): number {
  return (
    KIND_WEIGHT[node.kind] +
    (node.isExported ? 20 : 0) +
    (node.visibility === 'public' ? 8 : 0) +
    (node.kind === 'file' ? 6 : 0)
  );
}

function collectOverviewCandidates(
  source: VisualizationDataSource,
  nodeKinds: NodeKind[],
  limit: number
): Node[] {
  const seen = new Set<string>();
  const nodes: Node[] = [];

  for (const kind of nodeKinds) {
    for (const node of source.getNodesByKind(kind)) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      nodes.push(node);
    }
  }

  const poolSize = Math.min(
    nodes.length,
    Math.max(OVERVIEW_POOL_MIN, Math.min(OVERVIEW_POOL_MAX, limit * OVERVIEW_POOL_MULTIPLIER))
  );

  return nodes
    .sort((a, b) => {
      const score = nodeBaseScore(b) - nodeBaseScore(a);
      if (score !== 0) return score;
      const file = a.filePath.localeCompare(b.filePath);
      return file !== 0 ? file : a.name.localeCompare(b.name);
    })
    .slice(0, poolSize);
}

function buildOverviewSubgraph(
  source: VisualizationDataSource,
  options: Required<Pick<BuildVisualizationOptions, 'limit' | 'nodeKinds' | 'edgeKinds'>>
): Subgraph {
  const candidates = collectOverviewCandidates(source, options.nodeKinds, options.limit);
  const candidateById = new Map(candidates.map((node) => [node.id, node]));
  const candidateIds = new Set(candidateById.keys());
  const edgeKinds = new Set(options.edgeKinds);
  const edgesByKey = new Map<string, Edge>();
  const degree = new Map<string, number>();

  for (const node of candidates) {
    const outgoing = source.getOutgoingEdges(node.id);
    for (const edge of outgoing) {
      if (!edgeKinds.has(edge.kind)) continue;
      if (!candidateIds.has(edge.target)) continue;
      edgesByKey.set(edgeKey(edge), edge);
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }
  }

  const selected = candidates
    .sort((a, b) => {
      const aScore = (degree.get(a.id) ?? 0) * 100 + nodeBaseScore(a);
      const bScore = (degree.get(b.id) ?? 0) * 100 + nodeBaseScore(b);
      if (bScore !== aScore) return bScore - aScore;
      const file = a.filePath.localeCompare(b.filePath);
      return file !== 0 ? file : a.name.localeCompare(b.name);
    })
    .slice(0, options.limit);

  const nodes = new Map(selected.map((node) => [node.id, node]));
  const edges = Array.from(edgesByKey.values()).filter(
    (edge) => nodes.has(edge.source) && nodes.has(edge.target)
  );

  return { nodes, edges, roots: [] };
}

function mergeSubgraphs(subgraphs: Subgraph[]): Subgraph {
  const nodes = new Map<string, Node>();
  const edgesByKey = new Map<string, Edge>();
  const roots: string[] = [];

  for (const subgraph of subgraphs) {
    for (const [id, node] of subgraph.nodes) {
      nodes.set(id, node);
    }
    for (const edge of subgraph.edges) {
      edgesByKey.set(edgeKey(edge), edge);
    }
    roots.push(...subgraph.roots);
  }

  return {
    nodes,
    edges: Array.from(edgesByKey.values()),
    roots: unique(roots),
  };
}

function findSymbolRoots(
  source: VisualizationDataSource,
  symbol: string,
  nodeKinds: NodeKind[]
): Node[] {
  const matches = source.searchNodes(symbol, {
    limit: 50,
    kinds: nodeKinds.length > 0 ? nodeKinds : undefined,
  });
  const exact = matches.filter((match) => isExactSymbolMatch(match.node, symbol));
  const roots = exact.length > 0 ? exact : matches.slice(0, 1);
  return unique(roots.map((match) => match.node.id))
    .map((id) => roots.find((match) => match.node.id === id)!.node)
    .slice(0, 5);
}

function buildSymbolSubgraph(
  source: VisualizationDataSource,
  symbol: string,
  options: Required<
    Pick<BuildVisualizationOptions, 'limit' | 'depth' | 'direction' | 'nodeKinds' | 'edgeKinds'>
  >
): Subgraph {
  const roots = findSymbolRoots(source, symbol, options.nodeKinds);
  if (roots.length === 0) return { nodes: new Map(), edges: [], roots: [] };

  const perRootLimit = Math.max(options.limit, Math.ceil(options.limit / roots.length));
  const subgraphs = roots.map((root) =>
    source.traverse(root.id, {
      maxDepth: options.depth,
      direction: options.direction,
      edgeKinds: options.edgeKinds,
      nodeKinds: options.nodeKinds,
      limit: perRootLimit,
      includeStart: true,
    })
  );

  return mergeSubgraphs(subgraphs);
}

export function buildVisualizationGraphFromSubgraph(args: {
  subgraph: Subgraph;
  projectRoot: string;
  title: string;
  mode: VisualizationGraph['mode'];
  query?: string;
  limit?: number;
  totalNodes?: number;
  totalEdges?: number;
}): VisualizationGraph {
  const limit = clampInt(args.limit, DEFAULT_VISUALIZATION_LIMIT, 1, 2000);
  const originalNodes = Array.from(args.subgraph.nodes.values());
  const originalEdges = args.subgraph.edges;
  const rootIds = unique(args.subgraph.roots);
  const rootIdSet = new Set(rootIds);
  const degree = new Map<string, { incoming: number; outgoing: number }>();

  for (const edge of originalEdges) {
    const sourceDegree = degree.get(edge.source) ?? { incoming: 0, outgoing: 0 };
    sourceDegree.outgoing++;
    degree.set(edge.source, sourceDegree);

    const targetDegree = degree.get(edge.target) ?? { incoming: 0, outgoing: 0 };
    targetDegree.incoming++;
    degree.set(edge.target, targetDegree);
  }

  const selected = originalNodes
    .sort((a, b) => {
      const aDegree = degree.get(a.id);
      const bDegree = degree.get(b.id);
      const aScore =
        (rootIdSet.has(a.id) ? 100000 : 0) +
        ((aDegree?.incoming ?? 0) + (aDegree?.outgoing ?? 0)) * 100 +
        nodeBaseScore(a);
      const bScore =
        (rootIdSet.has(b.id) ? 100000 : 0) +
        ((bDegree?.incoming ?? 0) + (bDegree?.outgoing ?? 0)) * 100 +
        nodeBaseScore(b);
      if (bScore !== aScore) return bScore - aScore;
      const file = a.filePath.localeCompare(b.filePath);
      return file !== 0 ? file : a.name.localeCompare(b.name);
    })
    .slice(0, Math.max(limit, rootIds.length));

  const selectedIds = new Set(selected.map((node) => node.id));
  const edges = originalEdges.filter(
    (edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target)
  );
  const includedDegree = new Map<string, { incoming: number; outgoing: number }>();

  for (const edge of edges) {
    const sourceDegree = includedDegree.get(edge.source) ?? { incoming: 0, outgoing: 0 };
    sourceDegree.outgoing++;
    includedDegree.set(edge.source, sourceDegree);

    const targetDegree = includedDegree.get(edge.target) ?? { incoming: 0, outgoing: 0 };
    targetDegree.incoming++;
    includedDegree.set(edge.target, targetDegree);
  }

  const nodes: VisualizationNode[] = selected.map((node) => {
    const nodeDegree = includedDegree.get(node.id) ?? { incoming: 0, outgoing: 0 };
    const totalDegree = nodeDegree.incoming + nodeDegree.outgoing;
    return {
      id: node.id,
      label: node.name || node.qualifiedName || node.filePath,
      kind: node.kind,
      qualifiedName: node.qualifiedName,
      filePath: node.filePath,
      language: node.language,
      line: node.startLine,
      signature: node.signature,
      exported: node.isExported === true,
      root: rootIdSet.has(node.id),
      incoming: nodeDegree.incoming,
      outgoing: nodeDegree.outgoing,
      size: Math.min(22, 6 + Math.sqrt(totalDegree + 1) * 2 + (rootIdSet.has(node.id) ? 4 : 0)),
    };
  });

  return {
    title: args.title,
    projectRoot: args.projectRoot,
    mode: args.mode,
    query: args.query,
    generatedAt: Date.now(),
    nodes,
    edges: edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      line: edge.line,
      provenance: edge.provenance,
    })),
    rootIds,
    stats: {
      totalNodes: args.totalNodes ?? originalNodes.length,
      totalEdges: args.totalEdges ?? originalEdges.length,
      includedNodes: nodes.length,
      includedEdges: edges.length,
      truncated: originalNodes.length > nodes.length || originalEdges.length > edges.length,
    },
  };
}

export function buildVisualizationGraph(
  source: VisualizationDataSource,
  options: BuildVisualizationOptions
): VisualizationGraph {
  const limit = clampInt(options.limit, DEFAULT_VISUALIZATION_LIMIT, 1, 2000);
  const depth = clampInt(options.depth, DEFAULT_VISUALIZATION_DEPTH, 1, 10);
  const direction = options.direction ?? 'both';
  const nodeKinds = options.nodeKinds?.length
    ? options.nodeKinds
    : DEFAULT_VISUALIZATION_NODE_KINDS;
  const edgeKinds = options.edgeKinds?.length
    ? options.edgeKinds
    : DEFAULT_VISUALIZATION_EDGE_KINDS;
  const stats = source.getStats();

  if (options.symbol) {
    const subgraph = buildSymbolSubgraph(source, options.symbol, {
      limit,
      depth,
      direction,
      nodeKinds,
      edgeKinds,
    });

    return buildVisualizationGraphFromSubgraph({
      subgraph,
      projectRoot: options.projectRoot,
      title: `CodeGraph: ${options.symbol}`,
      mode: 'symbol',
      query: options.symbol,
      limit,
      totalNodes: stats.nodeCount,
      totalEdges: stats.edgeCount,
    });
  }

  const subgraph = buildOverviewSubgraph(source, {
    limit,
    nodeKinds,
    edgeKinds,
  });

  return buildVisualizationGraphFromSubgraph({
    subgraph,
    projectRoot: options.projectRoot,
    title: 'CodeGraph project map',
    mode: 'overview',
    limit,
    totalNodes: stats.nodeCount,
    totalEdges: stats.edgeCount,
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function isNodeKind(value: string): value is NodeKind {
  return (NODE_KINDS as readonly string[]).includes(value);
}

export function isEdgeKind(value: string): value is EdgeKind {
  return (EDGE_KINDS as readonly string[]).includes(value);
}

export function renderVisualizationHtml(graph: VisualizationGraph): string {
  const title = escapeHtml(graph.title);
  const dataJson = serializeForInlineScript(graph);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --ink: #20242a;
      --muted: #69717d;
      --line: #d9dde4;
      --accent: #2266aa;
      --accent-2: #c75136;
      --good: #277a58;
      --shadow: 0 12px 34px rgba(32, 36, 42, 0.12);
    }

    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: var(--bg);
      overflow: hidden;
    }

    .app {
      display: grid;
      grid-template-columns: minmax(260px, 310px) minmax(0, 1fr) minmax(260px, 330px);
      height: 100vh;
      min-height: 560px;
    }

    .panel, .details {
      background: var(--panel);
      border-color: var(--line);
      overflow: auto;
      min-width: 0;
    }

    .panel {
      border-right: 1px solid var(--line);
      padding: 18px;
    }

    .details {
      border-left: 1px solid var(--line);
      padding: 18px;
    }

    .stage {
      position: relative;
      min-width: 0;
      background:
        linear-gradient(rgba(32, 36, 42, 0.045) 1px, transparent 1px),
        linear-gradient(90deg, rgba(32, 36, 42, 0.045) 1px, transparent 1px),
        #fbfcfd;
      background-size: 28px 28px;
    }

    .brand {
      display: flex;
      gap: 12px;
      align-items: center;
      margin-bottom: 16px;
    }

    .mark {
      width: 36px;
      height: 36px;
      border-radius: 8px;
      background: conic-gradient(from 30deg, #2266aa, #277a58, #c69232, #c75136, #2266aa);
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.65);
      flex: none;
    }

    h1 {
      margin: 0;
      font-size: 18px;
      line-height: 1.2;
      overflow-wrap: anywhere;
    }

    h2 {
      margin: 18px 0 8px;
      font-size: 12px;
      color: var(--muted);
      text-transform: uppercase;
      font-weight: 700;
    }

    p { margin: 0; color: var(--muted); }
    .meta { font-size: 12px; overflow-wrap: anywhere; }

    .stats {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin: 16px 0;
    }

    .stat {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: #fbfcfd;
      min-width: 0;
    }

    .stat strong {
      display: block;
      font-size: 18px;
      line-height: 1.1;
    }

    .stat span {
      color: var(--muted);
      font-size: 12px;
    }

    label.search span {
      display: block;
      margin-bottom: 6px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
    }

    input[type="search"] {
      width: 100%;
      height: 36px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 0 10px;
      color: var(--ink);
      background: #fff;
      outline: none;
    }

    input[type="search"]:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(34, 102, 170, 0.14);
    }

    .actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-top: 10px;
    }

    button {
      height: 34px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      color: var(--ink);
      font: inherit;
      cursor: pointer;
    }

    button:hover { border-color: var(--accent); color: var(--accent); }

    .filters {
      display: grid;
      gap: 6px;
    }

    .check {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 7px 8px;
      background: #fbfcfd;
      min-width: 0;
    }

    .check > span {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .swatch {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex: none;
      background: var(--accent);
    }

    .check small { color: var(--muted); }
    .check input { width: 16px; height: 16px; flex: none; }

    svg {
      display: block;
      width: 100%;
      height: 100%;
      touch-action: none;
      user-select: none;
    }

    .edge {
      stroke: #8b949e;
      stroke-opacity: 0.48;
      stroke-width: 1.4;
      vector-effect: non-scaling-stroke;
    }

    .edge.calls { stroke: #2266aa; stroke-width: 1.8; }
    .edge.imports { stroke: #277a58; }
    .edge.extends, .edge.implements { stroke: #7b4ea3; stroke-width: 1.8; }
    .edge.contains { stroke: #9aa1aa; stroke-dasharray: 3 5; }
    .edge.references { stroke: #c69232; }
    .edge.instantiates { stroke: #c75136; }

    .node circle {
      stroke: #fff;
      stroke-width: 2;
      filter: drop-shadow(0 3px 8px rgba(32, 36, 42, 0.20));
    }

    .node.root circle {
      stroke: #20242a;
      stroke-width: 3;
    }

    .node text {
      pointer-events: none;
      font-size: 11px;
      fill: #20242a;
      paint-order: stroke;
      stroke: rgba(255,255,255,0.9);
      stroke-width: 4px;
      stroke-linejoin: round;
    }

    .node.dimmed { opacity: 0.22; }
    .edge.dimmed { opacity: 0.12; }

    .detail-empty {
      min-height: 120px;
      display: grid;
      place-items: center;
      color: var(--muted);
      border: 1px dashed var(--line);
      border-radius: 8px;
      text-align: center;
      padding: 16px;
    }

    .detail-title {
      display: flex;
      gap: 10px;
      align-items: center;
      min-width: 0;
    }

    .detail-title strong {
      font-size: 17px;
      overflow-wrap: anywhere;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 3px 8px;
      color: var(--muted);
      background: #fbfcfd;
      font-size: 12px;
      max-width: 100%;
      overflow-wrap: anywhere;
    }

    .detail-grid {
      display: grid;
      gap: 8px;
      margin-top: 14px;
    }

    .detail-row {
      display: grid;
      grid-template-columns: 86px minmax(0, 1fr);
      gap: 10px;
      padding: 8px 0;
      border-bottom: 1px solid var(--line);
    }

    .detail-row span:first-child {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }

    .detail-row span:last-child {
      overflow-wrap: anywhere;
    }

    .connection {
      display: grid;
      grid-template-columns: 70px minmax(0, 1fr);
      gap: 8px;
      padding: 7px 0;
      border-bottom: 1px solid var(--line);
    }

    .connection strong {
      color: var(--muted);
      font-size: 12px;
    }

    .connection span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    @media (max-width: 980px) {
      body { overflow: auto; }
      .app {
        grid-template-columns: 1fr;
        grid-template-rows: auto minmax(560px, 72vh) auto;
        height: auto;
        min-height: 100vh;
      }
      .panel, .details {
        border: 0;
        border-bottom: 1px solid var(--line);
      }
      .details { border-top: 1px solid var(--line); }
      .stats { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    }

    @media (max-width: 620px) {
      .stats { grid-template-columns: 1fr 1fr; }
      .actions { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside class="panel">
      <div class="brand">
        <div class="mark" aria-hidden="true"></div>
        <div>
          <h1>${title}</h1>
          <p class="meta" id="projectRoot"></p>
        </div>
      </div>
      <div class="stats">
        <div class="stat"><strong id="visibleNodeCount">0</strong><span>nodes</span></div>
        <div class="stat"><strong id="visibleEdgeCount">0</strong><span>edges</span></div>
        <div class="stat"><strong id="totalNodeCount">0</strong><span>indexed nodes</span></div>
        <div class="stat"><strong id="totalEdgeCount">0</strong><span>indexed edges</span></div>
      </div>
      <label class="search">
        <span>Search</span>
        <input id="search" type="search" autocomplete="off" placeholder="name, file, kind">
      </label>
      <div class="actions">
        <button id="fit" type="button">Fit</button>
        <button id="reset" type="button">Reset</button>
      </div>
      <h2>Nodes</h2>
      <div id="nodeFilters" class="filters"></div>
      <h2>Edges</h2>
      <div id="edgeFilters" class="filters"></div>
    </aside>

    <main class="stage">
      <svg id="graph" role="img" aria-label="CodeGraph visualization">
        <g id="viewport">
          <g id="edgeLayer"></g>
          <g id="nodeLayer"></g>
        </g>
      </svg>
    </main>

    <aside class="details">
      <div id="detailEmpty" class="detail-empty">Select a node</div>
      <div id="detailContent" hidden>
        <div class="detail-title">
          <span id="detailSwatch" class="swatch"></span>
          <strong id="detailName"></strong>
        </div>
        <div style="margin-top: 10px;"><span id="detailKind" class="pill"></span></div>
        <div class="detail-grid" id="detailGrid"></div>
        <h2>Connections</h2>
        <div id="connections"></div>
      </div>
      <h2>Generated</h2>
      <p class="meta" id="generatedAt"></p>
      <p class="meta" id="truncatedNote" style="margin-top: 8px;"></p>
    </aside>
  </div>

  <script>
    const GRAPH_DATA = ${dataJson};
    (function () {
      const NS = 'http://www.w3.org/2000/svg';
      const colors = {
        file: '#5f6b7a',
        module: '#2266aa',
        namespace: '#2266aa',
        class: '#7b4ea3',
        struct: '#7b4ea3',
        interface: '#9a5a2f',
        trait: '#9a5a2f',
        protocol: '#9a5a2f',
        enum: '#c75136',
        type_alias: '#c69232',
        function: '#277a58',
        method: '#118ab2',
        route: '#d64f3f',
        component: '#d7872f',
        property: '#6d7785',
        field: '#6d7785',
        variable: '#6d7785',
        constant: '#6d7785',
        import: '#89919c',
        export: '#89919c',
        parameter: '#a2a8b1',
        enum_member: '#a2a8b1'
      };
      const fallbackColor = '#5f6b7a';
      const svg = document.getElementById('graph');
      const viewport = document.getElementById('viewport');
      const edgeLayer = document.getElementById('edgeLayer');
      const nodeLayer = document.getElementById('nodeLayer');
      const searchInput = document.getElementById('search');
      const nodeFilters = document.getElementById('nodeFilters');
      const edgeFilters = document.getElementById('edgeFilters');
      const detailEmpty = document.getElementById('detailEmpty');
      const detailContent = document.getElementById('detailContent');
      const detailGrid = document.getElementById('detailGrid');
      const connections = document.getElementById('connections');
      const visibleNodeCount = document.getElementById('visibleNodeCount');
      const visibleEdgeCount = document.getElementById('visibleEdgeCount');
      const totalNodeCount = document.getElementById('totalNodeCount');
      const totalEdgeCount = document.getElementById('totalEdgeCount');
      const projectRoot = document.getElementById('projectRoot');
      const generatedAt = document.getElementById('generatedAt');
      const truncatedNote = document.getElementById('truncatedNote');
      const detailSwatch = document.getElementById('detailSwatch');
      const detailName = document.getElementById('detailName');
      const detailKind = document.getElementById('detailKind');
      let width = 900;
      let height = 700;
      let zoom = 1;
      let pan = { x: 0, y: 0 };
      let alpha = 1;
      let animationFrame = 0;
      let dragNode = null;
      let panning = false;
      let lastPointer = null;
      let selectedId = null;
      let query = '';

      function text(value) {
        return value == null ? '' : String(value);
      }

      function unique(values) {
        return Array.from(new Set(values));
      }

      function colorFor(kind) {
        return colors[kind] || fallbackColor;
      }

      function resize() {
        const rect = svg.getBoundingClientRect();
        width = Math.max(320, rect.width || width);
        height = Math.max(360, rect.height || height);
        svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
      }

      resize();

      const nodes = GRAPH_DATA.nodes.map(function (node, index) {
        const ring = 80 + Math.floor(index / 32) * 58;
        const angle = (index * 2.399963229728653) % (Math.PI * 2);
        return Object.assign({}, node, {
          x: width / 2 + Math.cos(angle) * ring,
          y: height / 2 + Math.sin(angle) * ring,
          vx: 0,
          vy: 0,
          r: node.size || 8,
          visible: true,
          el: null,
          circle: null,
          labelEl: null
        });
      });
      const nodeById = new Map(nodes.map(function (node) { return [node.id, node]; }));
      const edges = GRAPH_DATA.edges
        .map(function (edge) {
          const source = nodeById.get(edge.source);
          const target = nodeById.get(edge.target);
          if (!source || !target) return null;
          return Object.assign({}, edge, {
            sourceNode: source,
            targetNode: target,
            visible: true,
            el: null
          });
        })
        .filter(Boolean);
      const visibleNodeKinds = new Set(unique(nodes.map(function (node) { return node.kind; })));
      const visibleEdgeKinds = new Set(unique(edges.map(function (edge) { return edge.kind; })));

      totalNodeCount.textContent = text(GRAPH_DATA.stats.totalNodes);
      totalEdgeCount.textContent = text(GRAPH_DATA.stats.totalEdges);
      projectRoot.textContent = GRAPH_DATA.projectRoot;
      generatedAt.textContent = new Date(GRAPH_DATA.generatedAt).toLocaleString();
      truncatedNote.textContent = GRAPH_DATA.stats.truncated
        ? 'Showing ' + GRAPH_DATA.stats.includedNodes + ' of ' + GRAPH_DATA.stats.totalNodes + ' nodes.'
        : 'Full selected graph included.';

      function makeSvg(tag, attrs) {
        const el = document.createElementNS(NS, tag);
        Object.keys(attrs || {}).forEach(function (key) {
          el.setAttribute(key, attrs[key]);
        });
        return el;
      }

      edges.forEach(function (edge) {
        const line = makeSvg('line', { class: 'edge ' + edge.kind });
        edge.el = line;
        edgeLayer.appendChild(line);
      });

      nodes.forEach(function (node) {
        const group = makeSvg('g', { class: node.root ? 'node root' : 'node' });
        const circle = makeSvg('circle', {
          r: String(node.r),
          fill: colorFor(node.kind)
        });
        const label = makeSvg('text', {
          x: String(node.r + 5),
          y: '4'
        });
        const titleEl = makeSvg('title', {});
        titleEl.textContent = node.qualifiedName + ' - ' + node.filePath + ':' + node.line;
        label.textContent = node.label;
        group.appendChild(circle);
        group.appendChild(label);
        group.appendChild(titleEl);
        group.addEventListener('pointerdown', function (event) {
          dragNode = node;
          lastPointer = graphPoint(event);
          node.vx = 0;
          node.vy = 0;
          svg.setPointerCapture(event.pointerId);
          selectNode(node.id);
          event.stopPropagation();
        });
        group.addEventListener('dblclick', function () {
          zoomToNode(node);
        });
        node.el = group;
        node.circle = circle;
        node.labelEl = label;
        nodeLayer.appendChild(group);
      });

      function createFilter(container, values, activeSet, counts, colorFn, onChange) {
        values.sort().forEach(function (value) {
          const label = document.createElement('label');
          label.className = 'check';
          const left = document.createElement('span');
          const swatch = document.createElement('i');
          swatch.className = 'swatch';
          swatch.style.background = colorFn(value);
          const name = document.createElement('span');
          name.textContent = value;
          left.appendChild(swatch);
          left.appendChild(name);
          const right = document.createElement('span');
          const count = document.createElement('small');
          count.textContent = text(counts.get(value) || 0);
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.checked = true;
          input.addEventListener('change', function () {
            if (input.checked) activeSet.add(value);
            else activeSet.delete(value);
            onChange();
          });
          right.appendChild(count);
          right.appendChild(input);
          label.appendChild(left);
          label.appendChild(right);
          container.appendChild(label);
        });
      }

      function countsBy(values) {
        const counts = new Map();
        values.forEach(function (value) {
          counts.set(value, (counts.get(value) || 0) + 1);
        });
        return counts;
      }

      createFilter(
        nodeFilters,
        unique(nodes.map(function (node) { return node.kind; })),
        visibleNodeKinds,
        countsBy(nodes.map(function (node) { return node.kind; })),
        colorFor,
        applyFilters
      );
      createFilter(
        edgeFilters,
        unique(edges.map(function (edge) { return edge.kind; })),
        visibleEdgeKinds,
        countsBy(edges.map(function (edge) { return edge.kind; })),
        function () { return '#8b949e'; },
        applyFilters
      );

      function nodeMatches(node) {
        if (!visibleNodeKinds.has(node.kind)) return false;
        if (!query) return true;
        const haystack = [
          node.label,
          node.kind,
          node.qualifiedName,
          node.filePath,
          node.language,
          node.signature
        ].map(text).join(' ').toLowerCase();
        return haystack.indexOf(query) !== -1;
      }

      function applyFilters() {
        query = searchInput.value.trim().toLowerCase();
        const visibleIds = new Set();
        nodes.forEach(function (node) {
          node.visible = nodeMatches(node);
          node.el.style.display = node.visible ? '' : 'none';
          if (node.visible) visibleIds.add(node.id);
        });
        edges.forEach(function (edge) {
          edge.visible =
            visibleEdgeKinds.has(edge.kind) &&
            visibleIds.has(edge.source) &&
            visibleIds.has(edge.target);
          edge.el.style.display = edge.visible ? '' : 'none';
        });
        visibleNodeCount.textContent = text(Array.from(visibleIds).length);
        visibleEdgeCount.textContent = text(edges.filter(function (edge) { return edge.visible; }).length);
        if (selectedId && (!visibleIds.has(selectedId))) clearSelection();
        reheat();
      }

      function updateTransform() {
        viewport.setAttribute('transform', 'translate(' + pan.x + ' ' + pan.y + ') scale(' + zoom + ')');
      }

      function graphPoint(event) {
        const rect = svg.getBoundingClientRect();
        return {
          x: (event.clientX - rect.left - pan.x) / zoom,
          y: (event.clientY - rect.top - pan.y) / zoom
        };
      }

      function tick() {
        const activeNodes = nodes.filter(function (node) { return node.visible; });
        const activeEdges = edges.filter(function (edge) { return edge.visible; });
        const centerX = (width / 2 - pan.x) / zoom;
        const centerY = (height / 2 - pan.y) / zoom;
        const edgeForce = 0.008 * alpha;
        const centerForce = 0.004 * alpha;
        const repelForce = 620 * alpha;

        activeEdges.forEach(function (edge) {
          const source = edge.sourceNode;
          const target = edge.targetNode;
          const dx = target.x - source.x;
          const dy = target.y - source.y;
          const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
          const ideal = edge.kind === 'contains' ? 58 : edge.kind === 'calls' ? 86 : 112;
          const force = (dist - ideal) * edgeForce;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          source.vx += fx;
          source.vy += fy;
          target.vx -= fx;
          target.vy -= fy;
        });

        for (let i = 0; i < activeNodes.length; i++) {
          const a = activeNodes[i];
          for (let j = i + 1; j < activeNodes.length; j++) {
            const b = activeNodes[j];
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let distSq = dx * dx + dy * dy;
            if (distSq < 0.01) {
              dx = 0.1;
              dy = 0.1;
              distSq = 0.02;
            }
            const dist = Math.sqrt(distSq);
            const minDist = a.r + b.r + 20;
            const force = (repelForce / Math.max(distSq, 80)) + (dist < minDist ? (minDist - dist) * 0.025 : 0);
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            a.vx -= fx;
            a.vy -= fy;
            b.vx += fx;
            b.vy += fy;
          }
        }

        activeNodes.forEach(function (node) {
          node.vx += (centerX - node.x) * centerForce;
          node.vy += (centerY - node.y) * centerForce;
          node.vx *= 0.82;
          node.vy *= 0.82;
          if (node !== dragNode) {
            node.x += node.vx;
            node.y += node.vy;
          }
        });
      }

      function draw() {
        edges.forEach(function (edge) {
          edge.el.setAttribute('x1', String(edge.sourceNode.x));
          edge.el.setAttribute('y1', String(edge.sourceNode.y));
          edge.el.setAttribute('x2', String(edge.targetNode.x));
          edge.el.setAttribute('y2', String(edge.targetNode.y));
        });
        nodes.forEach(function (node) {
          node.el.setAttribute('transform', 'translate(' + node.x + ' ' + node.y + ')');
        });
      }

      function animate() {
        animationFrame = 0;
        if (alpha < 0.018) {
          draw();
          return;
        }
        tick();
        tick();
        draw();
        alpha *= 0.955;
        animationFrame = requestAnimationFrame(animate);
      }

      function reheat() {
        alpha = 1;
        if (!animationFrame) animationFrame = requestAnimationFrame(animate);
      }

      function addDetail(label, value) {
        const row = document.createElement('div');
        row.className = 'detail-row';
        const key = document.createElement('span');
        const val = document.createElement('span');
        key.textContent = label;
        val.textContent = value;
        row.appendChild(key);
        row.appendChild(val);
        detailGrid.appendChild(row);
      }

      function selectNode(id) {
        const node = nodeById.get(id);
        if (!node) return;
        selectedId = id;
        detailEmpty.hidden = true;
        detailContent.hidden = false;
        detailSwatch.style.background = colorFor(node.kind);
        detailName.textContent = node.label;
        detailKind.textContent = node.kind + ' - ' + node.language;
        detailGrid.replaceChildren();
        connections.replaceChildren();
        addDetail('File', node.filePath + ':' + node.line);
        addDetail('Name', node.qualifiedName);
        if (node.signature) addDetail('Signature', node.signature);
        addDetail('Degree', node.incoming + ' in / ' + node.outgoing + ' out');
        addDetail('Exported', node.exported ? 'yes' : 'no');

        const related = edges.filter(function (edge) {
          return edge.source === id || edge.target === id;
        }).slice(0, 24);
        if (related.length === 0) {
          const empty = document.createElement('p');
          empty.className = 'meta';
          empty.textContent = 'No visible connections.';
          connections.appendChild(empty);
        } else {
          related.forEach(function (edge) {
            const row = document.createElement('div');
            row.className = 'connection';
            const kind = document.createElement('strong');
            const target = document.createElement('span');
            const otherId = edge.source === id ? edge.target : edge.source;
            const other = nodeById.get(otherId);
            kind.textContent = edge.source === id ? edge.kind + ' ->' : '<- ' + edge.kind;
            target.textContent = other ? other.label + ' (' + other.filePath + ':' + other.line + ')' : otherId;
            row.appendChild(kind);
            row.appendChild(target);
            connections.appendChild(row);
          });
        }

        nodes.forEach(function (candidate) {
          const connected = candidate.id === id || edges.some(function (edge) {
            return (
              edge.visible &&
              ((edge.source === id && edge.target === candidate.id) ||
               (edge.target === id && edge.source === candidate.id))
            );
          });
          candidate.el.classList.toggle('dimmed', !connected);
        });
        edges.forEach(function (edge) {
          edge.el.classList.toggle('dimmed', !(edge.source === id || edge.target === id));
        });
      }

      function clearSelection() {
        selectedId = null;
        detailEmpty.hidden = false;
        detailContent.hidden = true;
        nodes.forEach(function (node) { node.el.classList.remove('dimmed'); });
        edges.forEach(function (edge) { edge.el.classList.remove('dimmed'); });
      }

      function fitGraph() {
        const activeNodes = nodes.filter(function (node) { return node.visible; });
        if (activeNodes.length === 0) return;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        activeNodes.forEach(function (node) {
          minX = Math.min(minX, node.x - node.r);
          minY = Math.min(minY, node.y - node.r);
          maxX = Math.max(maxX, node.x + node.r);
          maxY = Math.max(maxY, node.y + node.r);
        });
        const graphW = Math.max(1, maxX - minX);
        const graphH = Math.max(1, maxY - minY);
        zoom = Math.min(2.4, Math.max(0.18, Math.min(width / graphW, height / graphH) * 0.82));
        pan.x = width / 2 - ((minX + maxX) / 2) * zoom;
        pan.y = height / 2 - ((minY + maxY) / 2) * zoom;
        updateTransform();
      }

      function zoomToNode(node) {
        zoom = Math.min(2.8, Math.max(zoom, 1.45));
        pan.x = width / 2 - node.x * zoom;
        pan.y = height / 2 - node.y * zoom;
        updateTransform();
      }

      svg.addEventListener('pointerdown', function (event) {
        if (event.target !== svg) return;
        panning = true;
        lastPointer = { x: event.clientX, y: event.clientY };
        svg.setPointerCapture(event.pointerId);
        clearSelection();
      });

      svg.addEventListener('pointermove', function (event) {
        if (dragNode) {
          const point = graphPoint(event);
          dragNode.x = point.x;
          dragNode.y = point.y;
          dragNode.vx = 0;
          dragNode.vy = 0;
          draw();
          return;
        }
        if (panning && lastPointer) {
          pan.x += event.clientX - lastPointer.x;
          pan.y += event.clientY - lastPointer.y;
          lastPointer = { x: event.clientX, y: event.clientY };
          updateTransform();
        }
      });

      svg.addEventListener('pointerup', function () {
        dragNode = null;
        panning = false;
        lastPointer = null;
      });

      svg.addEventListener('pointercancel', function () {
        dragNode = null;
        panning = false;
        lastPointer = null;
      });

      svg.addEventListener('wheel', function (event) {
        event.preventDefault();
        const rect = svg.getBoundingClientRect();
        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;
        const before = {
          x: (mouseX - pan.x) / zoom,
          y: (mouseY - pan.y) / zoom
        };
        const scale = event.deltaY < 0 ? 1.12 : 0.89;
        zoom = Math.min(4, Math.max(0.12, zoom * scale));
        pan.x = mouseX - before.x * zoom;
        pan.y = mouseY - before.y * zoom;
        updateTransform();
      }, { passive: false });

      searchInput.addEventListener('input', applyFilters);
      document.getElementById('fit').addEventListener('click', fitGraph);
      document.getElementById('reset').addEventListener('click', function () {
        zoom = 1;
        pan = { x: 0, y: 0 };
        searchInput.value = '';
        clearSelection();
        updateTransform();
        applyFilters();
      });
      window.addEventListener('resize', function () {
        resize();
        updateTransform();
        draw();
      });

      applyFilters();
      updateTransform();
      reheat();
      setTimeout(fitGraph, 180);
    })();
  </script>
</body>
</html>
`;
}

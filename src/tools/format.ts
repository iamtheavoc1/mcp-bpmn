import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import ELKModule, { type ElkNode, type ElkExtendedEdge } from "elkjs";
// elkjs ESM/CJS interop: constructor may be on .default or directly exported
const ELK = (ELKModule as any).default || ELKModule;
if (typeof ELK !== "function") {
  throw new Error("Failed to import ELK constructor from elkjs — check package version");
}
import {
  parseBpmn,
  serializeBpmn,
  moddle,
  getAllProcesses,
  categorizeElements,
  BpmnDefinitions,
  BpmnProcess,
  BpmnElement,
  SequenceFlow,
  ELEMENT_TYPES,
} from "../bpmn-utils.js";
import * as fs from "fs/promises";

// Element dimension constants (standard BPMN visual sizes)
const SIZES = {
  EVENT: { width: 36, height: 36 },
  TASK: { width: 100, height: 80 },
  GATEWAY: { width: 50, height: 50 },
};

// ─── ID Normalization ───────────────────────────────────────────────

interface IdMapping {
  oldId: string;
  newId: string;
}

function normalizeIds(
  process: BpmnProcess,
  counters: Record<string, number> = {}
): IdMapping[] {
  const mappings: IdMapping[] = [];
  const elements = process.flowElements || [];

  function nextId(prefix: string): string {
    counters[prefix] = (counters[prefix] || 0) + 1;
    return `${prefix}_${String(counters[prefix]).padStart(4, "0")}`;
  }

  // Map for quick lookup when rewiring refs
  const idMap = new Map<string, string>();

  // Assign new IDs to non-flow elements first
  for (const el of elements) {
    if (el.$type === ELEMENT_TYPES.SEQUENCE_FLOW) continue;
    const oldId = el.id;
    if (!oldId) continue;

    let prefix: string;
    switch (el.$type) {
      case ELEMENT_TYPES.START_EVENT:
        prefix = "StartEvent";
        break;
      case ELEMENT_TYPES.END_EVENT:
        prefix = "EndEvent";
        break;
      case ELEMENT_TYPES.INTERMEDIATE_CATCH_EVENT:
        prefix = "CatchEvent";
        break;
      case ELEMENT_TYPES.INTERMEDIATE_THROW_EVENT:
        prefix = "ThrowEvent";
        break;
      case ELEMENT_TYPES.BOUNDARY_EVENT:
        prefix = "BoundaryEvent";
        break;
      case ELEMENT_TYPES.TASK:
        prefix = "Task";
        break;
      case ELEMENT_TYPES.USER_TASK:
        prefix = "UserTask";
        break;
      case ELEMENT_TYPES.SERVICE_TASK:
        prefix = "ServiceTask";
        break;
      case ELEMENT_TYPES.SCRIPT_TASK:
        prefix = "ScriptTask";
        break;
      case ELEMENT_TYPES.SEND_TASK:
        prefix = "SendTask";
        break;
      case ELEMENT_TYPES.RECEIVE_TASK:
        prefix = "ReceiveTask";
        break;
      case ELEMENT_TYPES.MANUAL_TASK:
        prefix = "ManualTask";
        break;
      case ELEMENT_TYPES.BUSINESS_RULE_TASK:
        prefix = "BRTask";
        break;
      case ELEMENT_TYPES.SUB_PROCESS:
        prefix = "SubProcess";
        break;
      case ELEMENT_TYPES.CALL_ACTIVITY:
        prefix = "CallActivity";
        break;
      case ELEMENT_TYPES.EXCLUSIVE_GATEWAY:
        prefix = "ExclGateway";
        break;
      case ELEMENT_TYPES.PARALLEL_GATEWAY:
        prefix = "ParallelGateway";
        break;
      case ELEMENT_TYPES.INCLUSIVE_GATEWAY:
        prefix = "InclGateway";
        break;
      case ELEMENT_TYPES.EVENT_BASED_GATEWAY:
        prefix = "EventGateway";
        break;
      case ELEMENT_TYPES.COMPLEX_GATEWAY:
        prefix = "ComplexGateway";
        break;
      default:
        prefix = el.$type.replace("bpmn:", "");
    }

    const newId = nextId(prefix);
    idMap.set(oldId, newId);
    mappings.push({ oldId, newId });
    el.id = newId;
  }

  // Assign new IDs to flows
  for (const el of elements) {
    if (el.$type !== ELEMENT_TYPES.SEQUENCE_FLOW) continue;
    const oldId = el.id;
    if (!oldId) continue;
    const newId = nextId("Flow");
    idMap.set(oldId, newId);
    mappings.push({ oldId, newId });
    el.id = newId;
  }

  // Rewire incoming/outgoing references on elements (these reference flow objects, not IDs directly)
  // The bpmn-moddle already holds object references, so the IDs propagate automatically.
  // But we also need to update the process ID itself.

  return mappings;
}

// ─── Element Sorting ────────────────────────────────────────────────

function sortFlowElements(process: BpmnProcess): void {
  if (!process.flowElements) return;

  const ORDER: Record<string, number> = {
    [ELEMENT_TYPES.START_EVENT]: 0,
    [ELEMENT_TYPES.INTERMEDIATE_CATCH_EVENT]: 1,
    [ELEMENT_TYPES.INTERMEDIATE_THROW_EVENT]: 1,
    [ELEMENT_TYPES.BOUNDARY_EVENT]: 1,
    [ELEMENT_TYPES.TASK]: 2,
    [ELEMENT_TYPES.USER_TASK]: 2,
    [ELEMENT_TYPES.SERVICE_TASK]: 2,
    [ELEMENT_TYPES.SCRIPT_TASK]: 2,
    [ELEMENT_TYPES.SEND_TASK]: 2,
    [ELEMENT_TYPES.RECEIVE_TASK]: 2,
    [ELEMENT_TYPES.MANUAL_TASK]: 2,
    [ELEMENT_TYPES.BUSINESS_RULE_TASK]: 2,
    [ELEMENT_TYPES.SUB_PROCESS]: 2,
    [ELEMENT_TYPES.CALL_ACTIVITY]: 2,
    [ELEMENT_TYPES.EXCLUSIVE_GATEWAY]: 3,
    [ELEMENT_TYPES.PARALLEL_GATEWAY]: 3,
    [ELEMENT_TYPES.INCLUSIVE_GATEWAY]: 3,
    [ELEMENT_TYPES.EVENT_BASED_GATEWAY]: 3,
    [ELEMENT_TYPES.COMPLEX_GATEWAY]: 3,
    [ELEMENT_TYPES.END_EVENT]: 4,
    [ELEMENT_TYPES.SEQUENCE_FLOW]: 5,
  };

  process.flowElements.sort((a, b) => {
    const oa = ORDER[a.$type] ?? 10;
    const ob = ORDER[b.$type] ?? 10;
    if (oa !== ob) return oa - ob;
    return (a.id || "").localeCompare(b.id || "");
  });
}

// ─── Remove orphaned flows ─────────────────────────────────────────

function removeOrphanedFlows(process: BpmnProcess): number {
  if (!process.flowElements) return 0;

  const elementIds = new Set(
    process.flowElements
      .filter((e) => e.$type !== ELEMENT_TYPES.SEQUENCE_FLOW)
      .map((e) => e.id)
      .filter(Boolean)
  );

  const before = process.flowElements.length;
  process.flowElements = process.flowElements.filter((el) => {
    if (el.$type !== ELEMENT_TYPES.SEQUENCE_FLOW) return true;
    const flow = el as SequenceFlow;
    const srcOk = flow.sourceRef?.id && elementIds.has(flow.sourceRef.id);
    const tgtOk = flow.targetRef?.id && elementIds.has(flow.targetRef.id);
    return srcOk && tgtOk;
  });

  return before - process.flowElements.length;
}

// ─── Auto-Layout using ELK (Eclipse Layout Kernel) ─────────────────

const elk = new ELK();

function isEvent(el: BpmnElement): boolean {
  return [
    ELEMENT_TYPES.START_EVENT,
    ELEMENT_TYPES.END_EVENT,
    ELEMENT_TYPES.INTERMEDIATE_CATCH_EVENT,
    ELEMENT_TYPES.INTERMEDIATE_THROW_EVENT,
    ELEMENT_TYPES.BOUNDARY_EVENT,
  ].includes(el.$type as any);
}

function isGateway(el: BpmnElement): boolean {
  return [
    ELEMENT_TYPES.EXCLUSIVE_GATEWAY,
    ELEMENT_TYPES.PARALLEL_GATEWAY,
    ELEMENT_TYPES.INCLUSIVE_GATEWAY,
    ELEMENT_TYPES.EVENT_BASED_GATEWAY,
    ELEMENT_TYPES.COMPLEX_GATEWAY,
  ].includes(el.$type as any);
}

function getElementSize(el: BpmnElement) {
  if (isEvent(el)) return SIZES.EVENT;
  if (isGateway(el)) return SIZES.GATEWAY;
  return SIZES.TASK;
}

/**
 * Use ELK's layered algorithm to compute positions for all nodes and
 * orthogonal routes for all edges.
 */
async function computeLayout(process: BpmnProcess): Promise<ElkNode> {
  const elements = process.flowElements || [];
  const nodes = elements.filter(
    (e) => e.$type !== ELEMENT_TYPES.SEQUENCE_FLOW
  );
  const flows = elements.filter(
    (e) => e.$type === ELEMENT_TYPES.SEQUENCE_FLOW
  ) as SequenceFlow[];

  // Build ELK graph
  const elkGraph: ElkNode = {
    id: "root",
    layoutOptions: {
      // Core algorithm
      "elk.algorithm": "layered",
      // Left-to-right flow (standard BPMN direction)
      "elk.direction": "RIGHT",
      // Spacing — generous for clean reading and edge routing
      "elk.spacing.nodeNode": "40",
      "elk.layered.spacing.nodeNodeBetweenLayers": "70",
      "elk.spacing.edgeNode": "30",
      "elk.spacing.edgeEdge": "20",
      "elk.layered.spacing.edgeNodeBetweenLayers": "30",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "20",
      // Crossing minimisation
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.crossingMinimization.greedySwitch.type": "TWO_SIDED",
      // Orthogonal edge routing
      "elk.layered.edgeRouting": "ORTHOGONAL",
      // NETWORK_SIMPLEX keeps the longest/main path as straight as possible
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.nodePlacement.networkSimplex.nodeFlexibility.default":
        "NODE_SIZE",
      // Layering: longest path keeps the happy path horizontal
      "elk.layered.layering.strategy": "LONGEST_PATH",
      // Post-layout compaction
      "elk.layered.compaction.postCompaction.strategy": "EDGE_LENGTH",
      "elk.layered.compaction.connectedComponents": "true",
      // Feedback/backward edges get routed cleanly
      "elk.layered.feedbackEdges": "true",
      // Padding
      "elk.padding": "[top=30,left=30,bottom=30,right=30]",
      // Preserve model element order
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    },
    children: nodes
      .filter((n) => n.id)
      .map((n) => {
        const size = getElementSize(n);
        return {
          id: n.id!,
          width: size.width,
          height: size.height,
        };
      }),
    edges: flows
      .filter((f) => f.id && f.sourceRef?.id && f.targetRef?.id)
      .map((f) => ({
        id: f.id!,
        sources: [f.sourceRef!.id!],
        targets: [f.targetRef!.id!],
      })),
  };

  return elk.layout(elkGraph);
}

// ─── Post-layout overlap detection & correction ─────────────────────

interface Rect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Segment {
  edgeId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const LABEL_PAD = 25; // extra padding below nodes for labels
const OVERLAP_PAD = 10; // minimum gap between shapes

/**
 * Expand a rect to include estimated label space below.
 */
function withLabelPad(r: Rect): Rect {
  return { ...r, h: r.h + LABEL_PAD };
}

/**
 * Check if two rects overlap (with padding).
 */
function rectsOverlap(a: Rect, b: Rect, pad = OVERLAP_PAD): boolean {
  return (
    a.x - pad < b.x + b.w &&
    a.x + a.w + pad > b.x &&
    a.y - pad < b.y + b.h &&
    a.y + a.h + pad > b.y
  );
}

/**
 * Check if an orthogonal edge segment passes through a rect.
 */
function segmentCrossesRect(seg: Segment, rect: Rect, pad = 5): boolean {
  const r = {
    x: rect.x - pad,
    y: rect.y - pad,
    w: rect.w + 2 * pad,
    h: rect.h + 2 * pad,
  };

  // Vertical segment
  if (Math.abs(seg.x1 - seg.x2) < 1) {
    const x = seg.x1;
    const yMin = Math.min(seg.y1, seg.y2);
    const yMax = Math.max(seg.y1, seg.y2);
    return x > r.x && x < r.x + r.w && yMax > r.y && yMin < r.y + r.h;
  }

  // Horizontal segment
  if (Math.abs(seg.y1 - seg.y2) < 1) {
    const y = seg.y1;
    const xMin = Math.min(seg.x1, seg.x2);
    const xMax = Math.max(seg.x1, seg.x2);
    return y > r.y && y < r.y + r.h && xMax > r.x && xMin < r.x + r.w;
  }

  return false; // diagonal — shouldn't happen with orthogonal routing
}

/**
 * Extract edge segments from ELK layout result.
 */
function extractEdgeSegments(
  layoutResult: ElkNode
): Segment[] {
  const segments: Segment[] = [];
  for (const edge of (layoutResult.edges || []) as ElkExtendedEdge[]) {
    for (const section of edge.sections || []) {
      const pts = [
        section.startPoint,
        ...(section.bendPoints || []),
        section.endPoint,
      ];
      for (let i = 0; i < pts.length - 1; i++) {
        segments.push({
          edgeId: edge.id,
          x1: pts[i].x,
          y1: pts[i].y,
          x2: pts[i + 1].x,
          y2: pts[i + 1].y,
        });
      }
    }
  }
  return segments;
}

/**
 * Post-process ELK layout to fix overlaps.
 *
 * Strategy:
 * 1. Detect shape-shape overlaps → nudge apart vertically
 * 2. Detect edge-through-shape crossings → increase spacing and re-layout
 *
 * Returns the (possibly re-laid-out) result and a list of fixes applied.
 */
async function fixOverlaps(
  process: BpmnProcess,
  layoutResult: ElkNode,
  maxRetries = 2
): Promise<{ result: ElkNode; fixes: string[] }> {
  const fixes: string[] = [];
  let result = layoutResult;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const children = result.children || [];
    const rects: Rect[] = children
      .filter((c) => c.x != null && c.y != null)
      .map((c) => ({
        id: c.id,
        x: c.x!,
        y: c.y!,
        w: c.width ?? 100,
        h: c.height ?? 80,
      }));

    let hasOverlap = false;

    // ── 1. Shape-shape overlap detection + vertical nudge ──
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = withLabelPad(rects[i]);
        const b = withLabelPad(rects[j]);
        if (rectsOverlap(a, b)) {
          hasOverlap = true;
          fixes.push(
            `Shape overlap: '${a.id}' and '${b.id}' — nudged apart`
          );

          // Nudge the lower one down
          const overlap =
            Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          const nudge = overlap + OVERLAP_PAD;
          const lower = a.y < b.y ? j : i;
          const child = children.find((c) => c.id === rects[lower].id);
          if (child && child.y != null) {
            child.y += nudge;
            rects[lower].y += nudge;
          }
        }
      }
    }

    // ── 2. Edge-through-shape crossing detection ──
    const segments = extractEdgeSegments(result);
    const edgesWithSrc = new Map<string, Set<string>>();
    for (const edge of (result.edges || []) as ElkExtendedEdge[]) {
      const srcTgt = new Set<string>();
      for (const s of (edge as any).sources || []) srcTgt.add(s);
      for (const t of (edge as any).targets || []) srcTgt.add(t);
      edgesWithSrc.set(edge.id, srcTgt);
    }

    let crossingCount = 0;
    for (const seg of segments) {
      const connected = edgesWithSrc.get(seg.edgeId) || new Set();
      for (const rect of rects) {
        // Skip the edge's own source/target nodes
        if (connected.has(rect.id)) continue;
        if (segmentCrossesRect(seg, rect)) {
          crossingCount++;
          if (crossingCount <= 3) {
            fixes.push(
              `Edge '${seg.edgeId}' crosses through '${rect.id}'`
            );
          }
        }
      }
    }

    if (crossingCount > 0 && attempt < maxRetries - 1) {
      fixes.push(
        `${crossingCount} edge-shape crossing(s) detected — re-laying out with wider spacing`
      );
      // Re-layout with increased spacing
      const elements = process.flowElements || [];
      const nodes = elements.filter(
        (e) => e.$type !== ELEMENT_TYPES.SEQUENCE_FLOW
      );
      const flows = elements.filter(
        (e) => e.$type === ELEMENT_TYPES.SEQUENCE_FLOW
      ) as SequenceFlow[];

      const spacingIncrease = 20 * (attempt + 1);
      const elkGraph: ElkNode = {
        id: "root",
        layoutOptions: {
          "elk.algorithm": "layered",
          "elk.direction": "RIGHT",
          "elk.spacing.nodeNode": String(35 + spacingIncrease),
          "elk.layered.spacing.nodeNodeBetweenLayers": String(
            60 + spacingIncrease
          ),
          "elk.spacing.edgeNode": String(25 + spacingIncrease),
          "elk.spacing.edgeEdge": String(15 + spacingIncrease / 2),
          "elk.layered.spacing.edgeNodeBetweenLayers": String(
            25 + spacingIncrease
          ),
          "elk.layered.spacing.edgeEdgeBetweenLayers": String(
            15 + spacingIncrease / 2
          ),
          "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
          "elk.layered.crossingMinimization.greedySwitch.type": "TWO_SIDED",
          "elk.layered.edgeRouting": "ORTHOGONAL",
          "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
          "elk.layered.nodePlacement.networkSimplex.nodeFlexibility.default":
            "NODE_SIZE",
          "elk.layered.layering.strategy": "LONGEST_PATH",
          "elk.layered.compaction.postCompaction.strategy": "EDGE_LENGTH",
          "elk.layered.compaction.connectedComponents": "true",
          "elk.layered.feedbackEdges": "true",
          "elk.padding": "[top=30,left=30,bottom=30,right=30]",
          "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
        },
        children: nodes
          .filter((n) => n.id)
          .map((n) => ({
            id: n.id!,
            width: getElementSize(n).width,
            height: getElementSize(n).height,
          })),
        edges: flows
          .filter((f) => f.id && f.sourceRef?.id && f.targetRef?.id)
          .map((f) => ({
            id: f.id!,
            sources: [f.sourceRef!.id!],
            targets: [f.targetRef!.id!],
          })),
      };

      result = await elk.layout(elkGraph);
      continue; // re-check after re-layout
    }

    if (!hasOverlap && crossingCount === 0) break;
  }

  return { result, fixes };
}

/**
 * Turn ELK layout results into BPMNDI elements on the definitions.
 */
function generateDiagram(
  definitions: BpmnDefinitions,
  process: BpmnProcess,
  layoutResult: ElkNode
): void {
  const elMap = new Map<string, BpmnElement>();
  for (const el of process.flowElements || []) {
    if (el.id) elMap.set(el.id, el);
  }

  const planeElements: any[] = [];

  // ── Shapes ──
  for (const child of layoutResult.children || []) {
    const bpmnElement = elMap.get(child.id);
    if (!bpmnElement || child.x == null || child.y == null) continue;

    const bounds = moddle.create("dc:Bounds", {
      x: Math.round(child.x),
      y: Math.round(child.y),
      width: child.width,
      height: child.height,
    });

    const shapeProps: Record<string, any> = {
      id: `${child.id}_di`,
      bpmnElement,
      bounds,
    };

    // Mark gateways with the marker diamond visible
    if (isGateway(bpmnElement)) {
      shapeProps.isMarkerVisible = true;
    }

    planeElements.push(moddle.create("bpmndi:BPMNShape", shapeProps));
  }

  // ── Edges ──
  // Build a quick lookup from node id to its laid-out bounds
  const nodeBounds = new Map<
    string,
    { x: number; y: number; w: number; h: number }
  >();
  for (const child of layoutResult.children || []) {
    if (child.x != null && child.y != null) {
      nodeBounds.set(child.id, {
        x: child.x,
        y: child.y,
        w: child.width ?? 0,
        h: child.height ?? 0,
      });
    }
  }

  for (const elkEdge of (layoutResult.edges || []) as ElkExtendedEdge[]) {
    const bpmnElement = elMap.get(elkEdge.id);
    if (!bpmnElement) continue;

    const waypoints: Array<{ x: number; y: number }> = [];

    for (const section of elkEdge.sections || []) {
      waypoints.push({
        x: Math.round(section.startPoint.x),
        y: Math.round(section.startPoint.y),
      });
      for (const bp of section.bendPoints || []) {
        waypoints.push({ x: Math.round(bp.x), y: Math.round(bp.y) });
      }
      waypoints.push({
        x: Math.round(section.endPoint.x),
        y: Math.round(section.endPoint.y),
      });
    }

    // Fallback: if ELK returned no sections, draw straight line
    if (waypoints.length === 0) {
      const srcId = (elkEdge as any).sources?.[0];
      const tgtId = (elkEdge as any).targets?.[0];
      const src = srcId ? nodeBounds.get(srcId) : null;
      const tgt = tgtId ? nodeBounds.get(tgtId) : null;
      if (src && tgt) {
        waypoints.push({
          x: Math.round(src.x + src.w),
          y: Math.round(src.y + src.h / 2),
        });
        waypoints.push({
          x: Math.round(tgt.x),
          y: Math.round(tgt.y + tgt.h / 2),
        });
      }
    }

    if (waypoints.length < 2) continue;

    const diWaypoints = waypoints.map((wp) =>
      moddle.create("dc:Point", { x: wp.x, y: wp.y })
    );

    planeElements.push(
      moddle.create("bpmndi:BPMNEdge", {
        id: `${elkEdge.id}_di`,
        bpmnElement,
        waypoint: diWaypoints,
      })
    );
  }

  // ── Assemble diagram (accumulate — caller must clear definitions.diagrams beforehand) ──
  const diagramIndex = (definitions.diagrams || []).length + 1;
  const plane = moddle.create("bpmndi:BPMNPlane", {
    id: `BPMNPlane_${diagramIndex}`,
    bpmnElement: process,
    planeElement: planeElements,
  });

  const diagram = moddle.create("bpmndi:BPMNDiagram", {
    id: `BPMNDiagram_${diagramIndex}`,
    plane,
  });

  if (!definitions.diagrams) definitions.diagrams = [];
  definitions.diagrams.push(diagram);
}

// ─── Tool Registration ──────────────────────────────────────────────

export function registerFormatTool(server: McpServer) {
  server.tool(
    "bpmn_format",
    "Reformat a BPMN 2.0 diagram: pretty-print XML, normalize element IDs, sort elements logically, remove orphaned flows, and auto-generate diagram layout (BPMNDI) so it renders cleanly in visual editors like bpmn.io or Camunda Modeler.",
    {
      source: z
        .string()
        .describe(
          "Either a file path to a .bpmn file, or raw BPMN XML content"
        ),
      sourceType: z
        .enum(["file", "xml"])
        .default("xml")
        .describe("Whether source is a file path or raw XML string"),
      normalizeIds: z
        .boolean()
        .default(true)
        .describe(
          "Rename element IDs to readable, consistent names (e.g., Task_0001, ExclGateway_0001)"
        ),
      sortElements: z
        .boolean()
        .default(true)
        .describe(
          "Sort flow elements logically: start events, tasks, gateways, end events, then flows"
        ),
      removeOrphans: z
        .boolean()
        .default(true)
        .describe(
          "Remove sequence flows that reference non-existent source or target elements"
        ),
      autoLayout: z
        .boolean()
        .default(true)
        .describe(
          "Generate BPMNDI diagram layout with computed positions so the diagram renders in visual editors"
        ),
      outputPath: z
        .string()
        .optional()
        .describe(
          "Optional file path to write the formatted BPMN XML"
        ),
    },
    async ({
      source,
      sourceType,
      normalizeIds: doNormalize,
      sortElements: doSort,
      removeOrphans: doRemoveOrphans,
      autoLayout: doAutoLayout,
      outputPath,
    }) => {
      try {
        let xml: string;
        if (sourceType === "file") {
          xml = await fs.readFile(source, "utf-8");
        } else {
          xml = source;
        }

        const { rootElement } = await parseBpmn(xml);
        const definitions = rootElement as BpmnDefinitions;
        const processes = getAllProcesses(definitions);

        if (processes.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: No processes found in the BPMN document",
              },
            ],
            isError: true,
          };
        }

        const changes: string[] = [];
        // Shared counters so IDs are unique across all processes
        const idCounters: Record<string, number> = {};

        // Clear existing diagrams before regenerating
        if (doAutoLayout) {
          definitions.diagrams = [];
        }

        for (const process of processes) {
          // 1. Remove orphaned flows
          if (doRemoveOrphans) {
            const removed = removeOrphanedFlows(process);
            if (removed > 0) {
              changes.push(
                `Removed ${removed} orphaned flow(s) from process '${process.id}'`
              );
            }
          }

          // 2. Normalize IDs (shared counters prevent duplicates across processes)
          if (doNormalize) {
            const oldProcId = process.id;
            const mappings = normalizeIds(process, idCounters);
            // Normalize process ID using shared counter
            idCounters["Process"] = (idCounters["Process"] || 0) + 1;
            process.id = `Process_${String(idCounters["Process"]).padStart(4, "0")}`;
            changes.push(
              `Normalized ${mappings.length} element ID(s) in process '${oldProcId}' -> '${process.id}'`
            );
          }

          // 3. Sort elements
          if (doSort) {
            sortFlowElements(process);
            changes.push(`Sorted elements in process '${process.id}'`);
          }

          // 4. Auto-layout via ELK + overlap correction (accumulates diagrams)
          if (doAutoLayout) {
            const rawLayout = await computeLayout(process);
            const { result: layoutResult, fixes } = await fixOverlaps(
              process,
              rawLayout
            );
            generateDiagram(definitions, process, layoutResult);
            const shapeCount = (layoutResult.children || []).length;
            const edgeCount = (layoutResult.edges || []).length;
            changes.push(
              `Generated diagram layout (ELK layered): ${shapeCount} shapes, ${edgeCount} edges`
            );
            if (fixes.length > 0) {
              changes.push(`Overlap corrections: ${fixes.join("; ")}`);
            }
          }
        }

        // Serialize with pretty-print
        const outputXml = await serializeBpmn(definitions, { format: true });

        if (outputPath) {
          await fs.writeFile(outputPath, outputXml, "utf-8");
          changes.push(`Written to: ${outputPath}`);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Formatting applied:\n${changes.map((c) => `  - ${c}`).join("\n")}\n\n${outputXml}`,
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error formatting BPMN: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

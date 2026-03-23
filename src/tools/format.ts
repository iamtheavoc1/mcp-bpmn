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
      // Spacing — generous enough to prevent edge-through-element crossings
      // on complex processes with feedback loops and 3-way gateways
      "elk.spacing.nodeNode": "35",
      "elk.layered.spacing.nodeNodeBetweenLayers": "60",
      "elk.spacing.edgeNode": "25",
      "elk.spacing.edgeEdge": "15",
      "elk.layered.spacing.edgeNodeBetweenLayers": "25",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "15",
      // Crossing minimisation — LAYER_SWEEP is the strongest strategy
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.crossingMinimization.greedySwitch.type": "TWO_SIDED",
      // Orthogonal edge routing (clean right-angle bends)
      "elk.layered.edgeRouting": "ORTHOGONAL",
      // Brandes/Köpf with BALANCED alignment – symmetric parallel blocks
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
      // Post-layout compaction for tightness without overlaps
      "elk.layered.compaction.postCompaction.strategy": "EDGE_LENGTH",
      "elk.layered.compaction.connectedComponents": "true",
      // Feedback/backward edges get routed cleanly
      "elk.layered.feedbackEdges": "true",
      // Padding inside the graph
      "elk.padding": "[top=30,left=30,bottom=30,right=30]",
      // Preserve model element order where possible
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

          // 4. Auto-layout via ELK (accumulates diagrams)
          if (doAutoLayout) {
            const layoutResult = await computeLayout(process);
            generateDiagram(definitions, process, layoutResult);
            const shapeCount = (layoutResult.children || []).length;
            const edgeCount = (layoutResult.edges || []).length;
            changes.push(
              `Generated diagram layout (ELK layered): ${shapeCount} shapes, ${edgeCount} edges`
            );
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

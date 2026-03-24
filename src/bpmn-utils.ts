import { BpmnModdle } from "bpmn-moddle";
import { layoutProcess } from "bpmn-auto-layout";

// Re-export a singleton instance
export const moddle = new BpmnModdle();

// Common BPMN element types
export const ELEMENT_TYPES = {
  PROCESS: "bpmn:Process",
  START_EVENT: "bpmn:StartEvent",
  END_EVENT: "bpmn:EndEvent",
  TASK: "bpmn:Task",
  USER_TASK: "bpmn:UserTask",
  SERVICE_TASK: "bpmn:ServiceTask",
  SCRIPT_TASK: "bpmn:ScriptTask",
  SEND_TASK: "bpmn:SendTask",
  RECEIVE_TASK: "bpmn:ReceiveTask",
  MANUAL_TASK: "bpmn:ManualTask",
  BUSINESS_RULE_TASK: "bpmn:BusinessRuleTask",
  CALL_ACTIVITY: "bpmn:CallActivity",
  SUB_PROCESS: "bpmn:SubProcess",
  EXCLUSIVE_GATEWAY: "bpmn:ExclusiveGateway",
  PARALLEL_GATEWAY: "bpmn:ParallelGateway",
  INCLUSIVE_GATEWAY: "bpmn:InclusiveGateway",
  EVENT_BASED_GATEWAY: "bpmn:EventBasedGateway",
  COMPLEX_GATEWAY: "bpmn:ComplexGateway",
  SEQUENCE_FLOW: "bpmn:SequenceFlow",
  INTERMEDIATE_CATCH_EVENT: "bpmn:IntermediateCatchEvent",
  INTERMEDIATE_THROW_EVENT: "bpmn:IntermediateThrowEvent",
  BOUNDARY_EVENT: "bpmn:BoundaryEvent",
  DEFINITIONS: "bpmn:Definitions",
  COLLABORATION: "bpmn:Collaboration",
  PARTICIPANT: "bpmn:Participant",
  LANE: "bpmn:Lane",
  LANE_SET: "bpmn:LaneSet",
  DATA_OBJECT: "bpmn:DataObject",
  DATA_STORE: "bpmn:DataStoreReference",
  TEXT_ANNOTATION: "bpmn:TextAnnotation",
  ASSOCIATION: "bpmn:Association",
  MESSAGE_FLOW: "bpmn:MessageFlow",
} as const;

export interface BpmnElement {
  $type: string;
  id?: string;
  name?: string;
  [key: string]: unknown;
}

export interface BpmnProcess extends BpmnElement {
  flowElements?: BpmnElement[];
  laneSets?: BpmnElement[];
}

export interface BpmnDefinitions extends BpmnElement {
  rootElements?: BpmnElement[];
  diagrams?: BpmnElement[];
}

export interface SequenceFlow extends BpmnElement {
  sourceRef?: BpmnElement;
  targetRef?: BpmnElement;
  conditionExpression?: BpmnElement;
}

/**
 * Parse BPMN XML string into a moddle tree
 */
export async function parseBpmn(xml: string): Promise<{ rootElement: BpmnElement; references: any[]; warnings: any[]; elementsById: Record<string, BpmnElement> }> {
  const result = await moddle.fromXML(xml);
  return result as any;
}

/**
 * Serialize a moddle element tree back to BPMN XML
 */
export async function serializeBpmn(
  element: BpmnElement,
  options?: { format?: boolean }
) {
  const result = await moddle.toXML(element as any, {
    format: options?.format !== false,
  });
  return result.xml;
}

/**
 * Get all flow elements from all processes in a definitions element
 */
export function getAllProcesses(definitions: BpmnDefinitions): BpmnProcess[] {
  return (
    (definitions.rootElements?.filter(
      (el) => el.$type === ELEMENT_TYPES.PROCESS
    ) as BpmnProcess[]) || []
  );
}

/**
 * Get all flow elements of a specific type from a process
 */
export function getElementsOfType(
  process: BpmnProcess,
  type: string
): BpmnElement[] {
  return process.flowElements?.filter((el) => el.$type === type) || [];
}

/**
 * Get all flow elements from a process, categorized
 */
export function categorizeElements(process: BpmnProcess) {
  const elements = process.flowElements || [];

  const tasks = elements.filter((el) =>
    [
      ELEMENT_TYPES.TASK,
      ELEMENT_TYPES.USER_TASK,
      ELEMENT_TYPES.SERVICE_TASK,
      ELEMENT_TYPES.SCRIPT_TASK,
      ELEMENT_TYPES.SEND_TASK,
      ELEMENT_TYPES.RECEIVE_TASK,
      ELEMENT_TYPES.MANUAL_TASK,
      ELEMENT_TYPES.BUSINESS_RULE_TASK,
    ].includes(el.$type as any)
  );

  const gateways = elements.filter((el) =>
    [
      ELEMENT_TYPES.EXCLUSIVE_GATEWAY,
      ELEMENT_TYPES.PARALLEL_GATEWAY,
      ELEMENT_TYPES.INCLUSIVE_GATEWAY,
      ELEMENT_TYPES.EVENT_BASED_GATEWAY,
      ELEMENT_TYPES.COMPLEX_GATEWAY,
    ].includes(el.$type as any)
  );

  const events = elements.filter((el) =>
    [
      ELEMENT_TYPES.START_EVENT,
      ELEMENT_TYPES.END_EVENT,
      ELEMENT_TYPES.INTERMEDIATE_CATCH_EVENT,
      ELEMENT_TYPES.INTERMEDIATE_THROW_EVENT,
      ELEMENT_TYPES.BOUNDARY_EVENT,
    ].includes(el.$type as any)
  );

  const flows = elements.filter(
    (el) => el.$type === ELEMENT_TYPES.SEQUENCE_FLOW
  ) as SequenceFlow[];

  const other = elements.filter(
    (el) =>
      !tasks.includes(el) &&
      !gateways.includes(el) &&
      !events.includes(el) &&
      !flows.includes(el)
  );

  return { tasks, gateways, events, flows, other };
}

/**
 * Generate a unique ID for a BPMN element
 */
let idCounter = 0;
export function generateId(prefix: string = "Element"): string {
  idCounter++;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

/**
 * Summarize a BPMN element for display
 */
export function summarizeElement(el: BpmnElement): Record<string, unknown> {
  return {
    id: el.id,
    type: el.$type.replace("bpmn:", ""),
    name: el.name || undefined,
  };
}

// ─── Shared type maps ────────────────────────────────────────────────

export const TASK_TYPE_MAP: Record<string, string> = {
  task: "bpmn:Task",
  userTask: "bpmn:UserTask",
  serviceTask: "bpmn:ServiceTask",
  scriptTask: "bpmn:ScriptTask",
  sendTask: "bpmn:SendTask",
  receiveTask: "bpmn:ReceiveTask",
  manualTask: "bpmn:ManualTask",
  businessRuleTask: "bpmn:BusinessRuleTask",
};

export const GATEWAY_TYPE_MAP: Record<string, string> = {
  exclusive: "bpmn:ExclusiveGateway",
  parallel: "bpmn:ParallelGateway",
  inclusive: "bpmn:InclusiveGateway",
  eventBased: "bpmn:EventBasedGateway",
  complex: "bpmn:ComplexGateway",
};

export const EVENT_TYPE_MAP: Record<string, string> = {
  startEvent: "bpmn:StartEvent",
  endEvent: "bpmn:EndEvent",
  intermediateCatchEvent: "bpmn:IntermediateCatchEvent",
  intermediateThrowEvent: "bpmn:IntermediateThrowEvent",
};

/**
 * Apply auto-layout to BPMN XML so diagrams render properly in viewers.
 * Takes raw BPMN XML (with or without BPMNDI) and returns XML with
 * a full diagram layout: horizontal happy path, grid-based positioning,
 * and Manhattan edge routing.
 *
 * After layout, runs a label-placement pass that positions all labels
 * (gateway names, event names, flow labels) in clear space away from
 * edges and shapes.
 *
 * Falls back to raw XML if the layout engine fails (e.g. complex cycles
 * that bpmn-auto-layout cannot handle).
 */
export async function applyAutoLayout(xml: string): Promise<string> {
  try {
    // Detect if this is a collaboration (multi-pool) diagram
    const { rootElement } = (await moddle.fromXML(xml)) as any;
    const hasCollab = rootElement.rootElements?.some(
      (el: any) => el.$type === "bpmn:Collaboration"
    );
    if (hasCollab) {
      return await layoutCollaboration(xml);
    }
    const layoutXml = await layoutProcess(xml);
    return await positionLabels(layoutXml);
  } catch {
    // Layout can fail on complex topologies (back-edges, cycles).
    // Return the raw XML so the caller still gets valid BPMN — it just
    // won't have BPMNDI positioning until the user runs bpmn_format.
    return xml;
  }
}

// ─── Multi-pool layout engine ────────────────────────────────────────

const POOL_LABEL_W = 30;
const POOL_PAD_LEFT = 50;
const POOL_PAD_RIGHT = 30;
const POOL_PAD_TOP = 15;
const POOL_PAD_BOTTOM = 15;
const POOL_GAP = 60;
const MIN_POOL_H = 100;

interface ShapeInfo {
  elementId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface EdgeInfo {
  elementId: string;
  waypoints: Array<{ x: number; y: number }>;
}

interface PoolLayout {
  participantId: string;
  processId: string;
  shapes: ShapeInfo[];
  edges: EdgeInfo[];
  poolX: number;
  poolY: number;
  poolW: number;
  poolH: number;
}

/**
 * Build a standalone BPMN XML containing just one process,
 * suitable for running through bpmn-auto-layout.
 * Uses regex extraction from the original XML to preserve
 * incoming/outgoing tags that bpmn-auto-layout needs.
 */
function buildStandaloneXml(originalXml: string, processId: string): string {
  // Extract the <bpmn:process> block for this processId from the original XML
  // Match <bpmn:process id="processId" ...>...</bpmn:process>
  const procRegex = new RegExp(
    `<bpmn:process\\s+[^>]*id="${processId}"[\\s\\S]*?<\\/bpmn:process>`,
    "m"
  );
  const match = originalXml.match(procRegex);
  if (!match) return "";

  const processBlock = match[0];

  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  id="TempDefs" targetNamespace="http://bpmn.io/schema/bpmn">
  ${processBlock}
</bpmn:definitions>`;
}

/**
 * Extract shape and edge positions from BPMNDI in parsed moddle tree.
 */
function extractDiPositions(definitions: any): {
  shapes: ShapeInfo[];
  edges: EdgeInfo[];
} {
  const shapes: ShapeInfo[] = [];
  const edges: EdgeInfo[] = [];
  const diagrams = definitions.diagrams || [];

  for (const diagram of diagrams) {
    const plane = diagram.plane;
    if (!plane?.planeElement) continue;
    for (const el of plane.planeElement) {
      if (el.$type === "bpmndi:BPMNShape" && el.bounds) {
        const b = el.bounds;
        shapes.push({
          elementId: el.bpmnElement?.id || "",
          x: b.x || 0,
          y: b.y || 0,
          w: b.width || 0,
          h: b.height || 0,
        });
      } else if (el.$type === "bpmndi:BPMNEdge") {
        const wps = el.waypoint || [];
        edges.push({
          elementId: el.bpmnElement?.id || "",
          waypoints: wps.map((wp: any) => ({
            x: wp.x || 0,
            y: wp.y || 0,
          })),
        });
      }
    }
  }
  return { shapes, edges };
}

/**
 * Layout a collaboration (multi-pool) BPMN diagram.
 * 1. Layout each process independently with bpmn-auto-layout
 * 2. Stack pools vertically
 * 3. Route message flows between pools
 * 4. Position labels
 */
async function layoutCollaboration(xml: string): Promise<string> {
  const { rootElement } = (await moddle.fromXML(xml)) as any;
  const definitions = rootElement;

  // Wire up incoming/outgoing references on all flow elements,
  // then re-serialize. bpmn-auto-layout needs these tags to
  // determine flow direction (horizontal vs vertical).
  for (const rootEl of definitions.rootElements || []) {
    if (rootEl.$type !== "bpmn:Process") continue;
    const flowElements = rootEl.flowElements || [];
    // Build element map
    const elMap = new Map<string, any>();
    for (const el of flowElements) {
      if (el.id) elMap.set(el.id, el);
    }
    // Wire incoming/outgoing from sequence flows
    for (const el of flowElements) {
      if (el.$type !== "bpmn:SequenceFlow") continue;
      const src = el.sourceRef;
      const tgt = el.targetRef;
      if (src) {
        if (!src.outgoing) src.outgoing = [];
        if (!src.outgoing.includes(el)) src.outgoing.push(el);
      }
      if (tgt) {
        if (!tgt.incoming) tgt.incoming = [];
        if (!tgt.incoming.includes(el)) tgt.incoming.push(el);
      }
    }
  }
  const enrichedResult = await moddle.toXML(definitions, { format: true });
  const enrichedXml: string = (enrichedResult as any).xml;

  // Find collaboration
  const collab = definitions.rootElements?.find(
    (el: any) => el.$type === "bpmn:Collaboration"
  );
  if (!collab) {
    // Fallback: no collaboration found
    return await positionLabels(await layoutProcess(xml));
  }

  const participants: any[] = collab.participants || [];
  const messageFlows: any[] = collab.messageFlows || [];

  // Build process map: processId -> process element
  const processMap = new Map<string, any>();
  for (const el of definitions.rootElements || []) {
    if (el.$type === "bpmn:Process" && el.id) {
      processMap.set(el.id, el);
    }
  }

  // Build participant -> process mapping
  const participantProcessMap = new Map<string, string>(); // participantId -> processId
  const processParticipantMap = new Map<string, string>(); // processId -> participantId
  for (const p of participants) {
    if (p.processRef?.id) {
      participantProcessMap.set(p.id, p.processRef.id);
      processParticipantMap.set(p.processRef.id, p.id);
    }
  }

  // Build element -> participantId mapping (for message flow routing)
  const elementToParticipant = new Map<string, string>();
  for (const p of participants) {
    const proc = p.processRef;
    if (!proc) continue;
    elementToParticipant.set(p.id, p.id);
    for (const el of proc.flowElements || []) {
      if (el.id) elementToParticipant.set(el.id, p.id);
    }
  }

  // Layout each process independently
  const poolLayouts: PoolLayout[] = [];
  let uniformWidth = 0;

  for (const participant of participants) {
    const proc = participant.processRef;
    const processId = proc?.id || participant.id;
    const participantId = participant.id;

    if (!proc || !proc.flowElements || proc.flowElements.length === 0) {
      // Empty / black-box pool
      poolLayouts.push({
        participantId,
        processId,
        shapes: [],
        edges: [],
        poolX: 0,
        poolY: 0,
        poolW: 400,
        poolH: MIN_POOL_H,
      });
      continue;
    }

    try {
      // Create standalone XML and layout it
      const standaloneXml = buildStandaloneXml(enrichedXml, processId);
      const layoutXml = await layoutProcess(standaloneXml);

      // Parse the result to get positions
      const { rootElement: layoutDefs } = (await moddle.fromXML(
        layoutXml
      )) as any;
      const { shapes, edges } = extractDiPositions(layoutDefs);

      // Compute extents
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const s of shapes) {
        minX = Math.min(minX, s.x);
        minY = Math.min(minY, s.y);
        maxX = Math.max(maxX, s.x + s.w);
        maxY = Math.max(maxY, s.y + s.h);
      }
      for (const e of edges) {
        for (const wp of e.waypoints) {
          minX = Math.min(minX, wp.x);
          minY = Math.min(minY, wp.y);
          maxX = Math.max(maxX, wp.x);
          maxY = Math.max(maxY, wp.y);
        }
      }

      if (minX === Infinity) {
        // No shapes found
        poolLayouts.push({
          participantId,
          processId,
          shapes: [],
          edges: [],
          poolX: 0,
          poolY: 0,
          poolW: 400,
          poolH: MIN_POOL_H,
        });
        continue;
      }

      // Normalize positions: offset so content starts at (POOL_PAD_LEFT, POOL_PAD_TOP)
      const offsetX = POOL_LABEL_W + POOL_PAD_LEFT - minX;
      const offsetY = POOL_PAD_TOP - minY;

      for (const s of shapes) {
        s.x += offsetX;
        s.y += offsetY;
      }
      for (const e of edges) {
        for (const wp of e.waypoints) {
          wp.x += offsetX;
          wp.y += offsetY;
        }
      }

      const contentW = maxX - minX;
      const contentH = maxY - minY;
      const poolW =
        POOL_LABEL_W + POOL_PAD_LEFT + contentW + POOL_PAD_RIGHT;
      const poolH = Math.max(
        MIN_POOL_H,
        POOL_PAD_TOP + contentH + POOL_PAD_BOTTOM
      );

      uniformWidth = Math.max(uniformWidth, poolW);

      poolLayouts.push({
        participantId,
        processId,
        shapes,
        edges,
        poolX: 0,
        poolY: 0, // will be set during stacking
        poolW,
        poolH,
      });
    } catch {
      // Layout failed for this process — empty pool
      poolLayouts.push({
        participantId,
        processId,
        shapes: [],
        edges: [],
        poolX: 0,
        poolY: 0,
        poolW: 400,
        poolH: MIN_POOL_H,
      });
    }
  }

  // Make all pools the same width
  uniformWidth = Math.max(uniformWidth, 600);
  for (const pl of poolLayouts) {
    pl.poolW = uniformWidth;
  }

  // Stack pools vertically
  let currentY = 0;
  for (const pl of poolLayouts) {
    pl.poolY = currentY;
    // Offset all shapes and edges by pool Y
    for (const s of pl.shapes) {
      s.y += currentY;
    }
    for (const e of pl.edges) {
      for (const wp of e.waypoints) {
        wp.y += currentY;
      }
    }
    currentY += pl.poolH + POOL_GAP;
  }

  // Build shape lookup for message flow routing
  const allShapes = new Map<string, ShapeInfo>();
  for (const pl of poolLayouts) {
    // Add pool itself as a shape (for message flows targeting a participant)
    allShapes.set(pl.participantId, {
      elementId: pl.participantId,
      x: pl.poolX,
      y: pl.poolY,
      w: pl.poolW,
      h: pl.poolH,
    });
    for (const s of pl.shapes) {
      allShapes.set(s.elementId, s);
    }
  }

  // Pool Y bounds for routing
  const poolBounds = new Map<
    string,
    { top: number; bottom: number }
  >();
  for (const pl of poolLayouts) {
    poolBounds.set(pl.participantId, {
      top: pl.poolY,
      bottom: pl.poolY + pl.poolH,
    });
  }

  // ─── Build BPMNDI ────────────────────────────────────────────────

  const planeElements: any[] = [];

  // Pool shapes
  for (const pl of poolLayouts) {
    planeElements.push(
      moddle.create("bpmndi:BPMNShape", {
        id: `${pl.participantId}_di`,
        bpmnElement: participants.find((p: any) => p.id === pl.participantId),
        isHorizontal: true,
        bounds: moddle.create("dc:Bounds", {
          x: pl.poolX,
          y: pl.poolY,
          width: pl.poolW,
          height: pl.poolH,
        }),
      })
    );
  }

  // Element shapes
  for (const pl of poolLayouts) {
    const proc = processMap.get(pl.processId);
    if (!proc) continue;
    const flowElements = proc.flowElements || [];

    for (const shape of pl.shapes) {
      const bpmnEl = flowElements.find(
        (e: any) => e.id === shape.elementId
      );
      if (!bpmnEl) continue;

      const diShape: any = {
        id: `${shape.elementId}_di`,
        bpmnElement: bpmnEl,
        bounds: moddle.create("dc:Bounds", {
          x: shape.x,
          y: shape.y,
          width: shape.w,
          height: shape.h,
        }),
      };

      // Exclusive gateways need isMarkerVisible
      if (bpmnEl.$type === "bpmn:ExclusiveGateway") {
        diShape.isMarkerVisible = true;
      }

      planeElements.push(moddle.create("bpmndi:BPMNShape", diShape));
    }
  }

  // Sequence flow edges
  for (const pl of poolLayouts) {
    for (const edge of pl.edges) {
      const proc = processMap.get(pl.processId);
      if (!proc) continue;
      const bpmnEl = (proc.flowElements || []).find(
        (e: any) => e.id === edge.elementId
      );
      if (!bpmnEl) continue;

      planeElements.push(
        moddle.create("bpmndi:BPMNEdge", {
          id: `${edge.elementId}_di`,
          bpmnElement: bpmnEl,
          waypoint: edge.waypoints.map((wp) =>
            moddle.create("dc:Point", { x: wp.x, y: wp.y })
          ),
        })
      );
    }
  }

  // Message flow edges
  for (const mf of messageFlows) {
    const srcId = mf.sourceRef?.id;
    const tgtId = mf.targetRef?.id;
    if (!srcId || !tgtId) continue;

    const srcShape = allShapes.get(srcId);
    const tgtShape = allShapes.get(tgtId);
    if (!srcShape || !tgtShape) continue;

    const srcCx = srcShape.x + srcShape.w / 2;
    const tgtCx = tgtShape.x + tgtShape.w / 2;
    const goingDown = srcShape.y < tgtShape.y;

    const srcDockY = goingDown
      ? srcShape.y + srcShape.h
      : srcShape.y;
    const tgtDockY = goingDown ? tgtShape.y : tgtShape.y + tgtShape.h;

    let waypoints: Array<{ x: number; y: number }>;

    if (Math.abs(srcCx - tgtCx) < 10) {
      // Nearly aligned — straight vertical
      waypoints = [
        { x: srcCx, y: srcDockY },
        { x: tgtCx, y: tgtDockY },
      ];
    } else {
      // Manhattan routing: vertical → horizontal → vertical
      // Find the gap between the two pools for the horizontal segment
      const srcPart = elementToParticipant.get(srcId);
      const tgtPart = elementToParticipant.get(tgtId);
      const srcBounds = srcPart ? poolBounds.get(srcPart) : null;
      const tgtBounds = tgtPart ? poolBounds.get(tgtPart) : null;

      let midY: number;
      if (srcBounds && tgtBounds) {
        midY = goingDown
          ? (srcBounds.bottom + tgtBounds.top) / 2
          : (tgtBounds.bottom + srcBounds.top) / 2;
      } else {
        midY = (srcDockY + tgtDockY) / 2;
      }

      waypoints = [
        { x: srcCx, y: srcDockY },
        { x: srcCx, y: midY },
        { x: tgtCx, y: midY },
        { x: tgtCx, y: tgtDockY },
      ];
    }

    planeElements.push(
      moddle.create("bpmndi:BPMNEdge", {
        id: `${mf.id}_di`,
        bpmnElement: mf,
        waypoint: waypoints.map((wp) =>
          moddle.create("dc:Point", { x: wp.x, y: wp.y })
        ),
      })
    );
  }

  // Build the diagram
  const plane = moddle.create("bpmndi:BPMNPlane", {
    id: "CollabPlane",
    bpmnElement: collab,
    planeElement: planeElements,
  });

  const diagram = moddle.create("bpmndi:BPMNDiagram", {
    id: "CollabDiagram",
    plane,
  });

  // Replace diagrams in definitions
  definitions.diagrams = [diagram];

  // Serialize and run label positioning
  const result = await moddle.toXML(definitions, { format: true });
  return await positionLabels((result as any).xml);
}

// ─── Label positioning (post-layout pass) ────────────────────────────

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const LABEL_H = 14;
const LABEL_PAD = 4; // padding around labels for collision checks
const CHAR_W = 7; // approximate width per character

function estimateLabelSize(text: string): { w: number; h: number } {
  return { w: Math.max(20, text.length * CHAR_W), h: LABEL_H };
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

function rectIntersectsSegment(r: Rect, s: Seg): boolean {
  // Check if a rectangle (with padding) intersects a line segment
  const pad = LABEL_PAD;
  const rx = r.x - pad;
  const ry = r.y - pad;
  const rw = r.w + pad * 2;
  const rh = r.h + pad * 2;

  // Quick AABB check
  const segMinX = Math.min(s.x1, s.x2);
  const segMaxX = Math.max(s.x1, s.x2);
  const segMinY = Math.min(s.y1, s.y2);
  const segMaxY = Math.max(s.y1, s.y2);

  if (segMaxX < rx || segMinX > rx + rw || segMaxY < ry || segMinY > ry + rh) {
    return false;
  }

  // Check if segment endpoints are inside rect
  if (
    (s.x1 >= rx && s.x1 <= rx + rw && s.y1 >= ry && s.y1 <= ry + rh) ||
    (s.x2 >= rx && s.x2 <= rx + rw && s.y2 >= ry && s.y2 <= ry + rh)
  ) {
    return true;
  }

  // Check segment against all 4 edges of the rect
  const edges: Seg[] = [
    { x1: rx, y1: ry, x2: rx + rw, y2: ry },
    { x1: rx + rw, y1: ry, x2: rx + rw, y2: ry + rh },
    { x1: rx + rw, y1: ry + rh, x2: rx, y2: ry + rh },
    { x1: rx, y1: ry + rh, x2: rx, y2: ry },
  ];
  for (const e of edges) {
    if (segmentsIntersect(s, e)) return true;
  }
  return false;
}

function segmentsIntersect(a: Seg, b: Seg): boolean {
  const d1x = a.x2 - a.x1,
    d1y = a.y2 - a.y1;
  const d2x = b.x2 - b.x1,
    d2y = b.y2 - b.y1;
  const cross = d1x * d2y - d1y * d2x;
  if (Math.abs(cross) < 1e-10) return false;
  const t = ((b.x1 - a.x1) * d2y - (b.y1 - a.y1) * d2x) / cross;
  const u = ((b.x1 - a.x1) * d1y - (b.y1 - a.y1) * d1x) / cross;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

function isLabelClear(
  labelRect: Rect,
  shapes: Rect[],
  edgeSegments: Seg[]
): boolean {
  // Check against shapes
  for (const shape of shapes) {
    if (rectsOverlap(labelRect, shape)) return false;
  }
  // Check against edge segments
  for (const seg of edgeSegments) {
    if (rectIntersectsSegment(labelRect, seg)) return false;
  }
  return true;
}

/**
 * Post-process BPMN XML to add explicit BPMNLabel bounds for all
 * named elements (gateways, events, sequence flows). Labels are
 * positioned to avoid overlapping edges and shapes.
 */
async function positionLabels(xml: string): Promise<string> {
  const { rootElement, elementsById } = (await moddle.fromXML(xml)) as any;
  const definitions = rootElement;
  const diagrams = definitions.diagrams || [];
  if (diagrams.length === 0) return xml;

  const plane = diagrams[0].plane;
  if (!plane?.planeElement) return xml;

  // Collect all occupied space: shape rects and edge segments
  const shapeRects: Rect[] = [];
  const edgeSegments: Seg[] = [];
  const shapeMap = new Map<string, Rect>(); // elementId -> bounds
  const edgeDiMap = new Map<
    string,
    Array<{ x: number; y: number }>
  >(); // elementId -> waypoints

  for (const el of plane.planeElement) {
    if (el.$type === "bpmndi:BPMNShape" && el.bounds) {
      const b = el.bounds;
      const rect = { x: b.x, y: b.y, w: b.width, h: b.height };
      shapeRects.push(rect);
      if (el.bpmnElement?.id) shapeMap.set(el.bpmnElement.id, rect);
    } else if (el.$type === "bpmndi:BPMNEdge") {
      const wps = el.waypoint || [];
      const pts = wps.map((wp: any) => ({ x: wp.x, y: wp.y }));
      for (let i = 0; i < pts.length - 1; i++) {
        edgeSegments.push({
          x1: pts[i].x,
          y1: pts[i].y,
          x2: pts[i + 1].x,
          y2: pts[i + 1].y,
        });
      }
      if (el.bpmnElement?.id) edgeDiMap.set(el.bpmnElement.id, pts);
    }
  }

  // Track placed labels as additional obstacles
  const placedLabels: Rect[] = [];

  function findClearPosition(
    candidates: Array<{ x: number; y: number }>,
    labelSize: { w: number; h: number }
  ): { x: number; y: number } | null {
    for (const pos of candidates) {
      const rect: Rect = { x: pos.x, y: pos.y, w: labelSize.w, h: labelSize.h };
      if (
        isLabelClear(rect, [...shapeRects, ...placedLabels], edgeSegments)
      ) {
        return pos;
      }
    }
    return null;
  }

  // Process each DI element and add labels
  for (const el of plane.planeElement) {
    const bpmnEl = el.bpmnElement;
    if (!bpmnEl?.name) continue;
    const name: string = bpmnEl.name;
    if (!name.trim()) continue;

    const labelSize = estimateLabelSize(name);

    if (el.$type === "bpmndi:BPMNShape") {
      const b = el.bounds;
      const cx = b.x + b.width / 2;
      const isGateway = bpmnEl.$type?.includes("Gateway");
      const isEvent =
        bpmnEl.$type?.includes("Event") && !bpmnEl.$type?.includes("Boundary");

      if (isGateway || isEvent) {
        // For gateways and events, try positions around the shape
        // Priority: below-centered, above-centered, left, right
        const candidates = [
          // Below, centered
          { x: cx - labelSize.w / 2, y: b.y + b.height + 6 },
          // Above, centered
          { x: cx - labelSize.w / 2, y: b.y - labelSize.h - 6 },
          // Below-left
          { x: b.x - labelSize.w / 2, y: b.y + b.height + 6 },
          // Below-right
          { x: b.x + b.width - labelSize.w / 2, y: b.y + b.height + 6 },
          // Above-left
          { x: b.x - labelSize.w / 2, y: b.y - labelSize.h - 6 },
          // Left of shape
          { x: b.x - labelSize.w - 8, y: b.y + b.height / 2 - labelSize.h / 2 },
          // Right of shape
          { x: b.x + b.width + 8, y: b.y + b.height / 2 - labelSize.h / 2 },
          // Further below
          { x: cx - labelSize.w / 2, y: b.y + b.height + 20 },
          // Further above
          { x: cx - labelSize.w / 2, y: b.y - labelSize.h - 20 },
        ];

        const pos = findClearPosition(candidates, labelSize);
        if (pos) {
          el.label = moddle.create("bpmndi:BPMNLabel", {
            bounds: moddle.create("dc:Bounds", {
              x: Math.round(pos.x),
              y: Math.round(pos.y),
              width: Math.round(labelSize.w),
              height: labelSize.h,
            }),
          });
          placedLabels.push({
            x: pos.x,
            y: pos.y,
            w: labelSize.w,
            h: labelSize.h,
          });
        }
      }
    } else if (el.$type === "bpmndi:BPMNEdge") {
      // Sequence flow labels — position near the midpoint of the edge
      const wps = edgeDiMap.get(bpmnEl.id) || [];
      if (wps.length < 2) continue;

      // Find the midpoint segment
      let totalLen = 0;
      const segLens: number[] = [];
      for (let i = 0; i < wps.length - 1; i++) {
        const dx = wps[i + 1].x - wps[i].x;
        const dy = wps[i + 1].y - wps[i].y;
        const len = Math.sqrt(dx * dx + dy * dy);
        segLens.push(len);
        totalLen += len;
      }

      // Find the midpoint
      let halfLen = totalLen / 2;
      let midX = wps[0].x,
        midY = wps[0].y;
      let midSegIdx = 0;
      for (let i = 0; i < segLens.length; i++) {
        if (halfLen <= segLens[i]) {
          const t = halfLen / segLens[i];
          midX = wps[i].x + t * (wps[i + 1].x - wps[i].x);
          midY = wps[i].y + t * (wps[i + 1].y - wps[i].y);
          midSegIdx = i;
          break;
        }
        halfLen -= segLens[i];
      }

      // Determine if the mid-segment is horizontal or vertical
      const seg = {
        x1: wps[midSegIdx].x,
        y1: wps[midSegIdx].y,
        x2: wps[midSegIdx + 1].x,
        y2: wps[midSegIdx + 1].y,
      };
      const isHorizontal = Math.abs(seg.y2 - seg.y1) < Math.abs(seg.x2 - seg.x1);

      // For horizontal edges: try above then below
      // For vertical edges: try left then right
      const candidates: Array<{ x: number; y: number }> = [];
      if (isHorizontal) {
        candidates.push(
          // Above the edge, centered on midpoint
          { x: midX - labelSize.w / 2, y: midY - labelSize.h - 4 },
          // Below the edge
          { x: midX - labelSize.w / 2, y: midY + 4 },
          // Above, shifted left
          { x: midX - labelSize.w - 4, y: midY - labelSize.h - 4 },
          // Above, shifted right
          { x: midX + 4, y: midY - labelSize.h - 4 },
          // Below, shifted
          { x: midX - labelSize.w - 4, y: midY + 4 },
          { x: midX + 4, y: midY + 4 },
        );
      } else {
        candidates.push(
          // Left of the edge
          { x: midX - labelSize.w - 4, y: midY - labelSize.h / 2 },
          // Right of the edge
          { x: midX + 4, y: midY - labelSize.h / 2 },
          // Further left
          { x: midX - labelSize.w - 16, y: midY - labelSize.h / 2 },
          // Further right
          { x: midX + 16, y: midY - labelSize.h / 2 },
          // Above
          { x: midX - labelSize.w / 2, y: midY - labelSize.h - 8 },
          // Below
          { x: midX - labelSize.w / 2, y: midY + 8 },
        );
      }

      const pos = findClearPosition(candidates, labelSize);
      if (pos) {
        el.label = moddle.create("bpmndi:BPMNLabel", {
          bounds: moddle.create("dc:Bounds", {
            x: Math.round(pos.x),
            y: Math.round(pos.y),
            width: Math.round(labelSize.w),
            height: labelSize.h,
          }),
        });
        placedLabels.push({
          x: pos.x,
          y: pos.y,
          w: labelSize.w,
          h: labelSize.h,
        });
      }
    }
  }

  const result = await moddle.toXML(definitions, { format: true });
  return (result as any).xml;
}

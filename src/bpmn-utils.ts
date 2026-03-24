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
    const layoutXml = await layoutProcess(xml);
    return await positionLabels(layoutXml);
  } catch {
    // bpmn-auto-layout can fail on complex topologies (back-edges, cycles).
    // Return the raw XML so the caller still gets valid BPMN — it just
    // won't have BPMNDI positioning until the user runs bpmn_format.
    return xml;
  }
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

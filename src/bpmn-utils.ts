import { BpmnModdle } from "bpmn-moddle";

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

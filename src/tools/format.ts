import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  parseBpmn,
  serializeBpmn,
  getAllProcesses,
  applyAutoLayout,
  BpmnDefinitions,
  BpmnProcess,
  BpmnElement,
  SequenceFlow,
  ELEMENT_TYPES,
} from "../bpmn-utils.js";
import * as fs from "fs/promises";

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
    mappings.push({ oldId, newId });
    el.id = newId;
  }

  // Assign new IDs to flows
  for (const el of elements) {
    if (el.$type !== ELEMENT_TYPES.SEQUENCE_FLOW) continue;
    const oldId = el.id;
    if (!oldId) continue;
    const newId = nextId("Flow");
    mappings.push({ oldId, newId });
    el.id = newId;
  }

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

// ─── Tool Registration ──────────────────────────────────────────────

export function registerFormatTool(server: McpServer) {
  server.tool(
    "bpmn_format",
    "Reformat a BPMN 2.0 diagram: pretty-print XML, normalize element IDs, sort elements logically, remove orphaned flows, and auto-generate diagram layout (BPMNDI) using the official bpmn.io grid-based layout engine. Produces professional BPMN diagrams with horizontal happy path, clean branching, and proper edge routing.",
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
        const idCounters: Record<string, number> = {};

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

          // 2. Normalize IDs
          if (doNormalize) {
            const oldProcId = process.id;
            const mappings = normalizeIds(process, idCounters);
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
        }

        // 4. Auto-layout using bpmn-auto-layout (grid-based, BPMN-aware)
        // First serialize the (possibly modified) definitions back to XML,
        // then run the layout engine on the XML, which produces new XML with BPMNDI.
        let outputXml: string;
        if (doAutoLayout) {
          // Serialize current state (without BPMNDI)
          definitions.diagrams = [];
          const intermediateXml = await serializeBpmn(definitions, {
            format: true,
          });

          // Run auto-layout (handles both single-process and multi-pool collaborations)
          try {
            outputXml = await applyAutoLayout(intermediateXml);
            changes.push(
              `Generated diagram layout: horizontal happy path, Manhattan edge routing`
            );
          } catch {
            // Layout can fail on complex topologies (back-edges, cycles)
            outputXml = intermediateXml;
            changes.push(
              `Auto-layout skipped: the diagram topology is not supported by the layout engine. The XML is valid but has no visual positioning — open it in a BPMN editor to arrange elements manually.`
            );
          }
        } else {
          outputXml = await serializeBpmn(definitions, { format: true });
        }

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

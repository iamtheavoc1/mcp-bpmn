import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  parseBpmn,
  getAllProcesses,
  categorizeElements,
  BpmnDefinitions,
  BpmnProcess,
  SequenceFlow,
  ELEMENT_TYPES,
} from "../bpmn-utils.js";
import * as fs from "fs/promises";

interface ValidationIssue {
  severity: "error" | "warning" | "info";
  message: string;
  elementId?: string;
  elementType?: string;
}

function validateProcess(process: BpmnProcess): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { tasks, gateways, events, flows } = categorizeElements(process);

  const startEvents = events.filter(
    (e) => e.$type === ELEMENT_TYPES.START_EVENT
  );
  const endEvents = events.filter((e) => e.$type === ELEMENT_TYPES.END_EVENT);

  // Check for start events
  if (startEvents.length === 0) {
    issues.push({
      severity: "error",
      message: `Process '${process.id}' has no start event`,
    });
  } else if (startEvents.length > 1) {
    issues.push({
      severity: "warning",
      message: `Process '${process.id}' has ${startEvents.length} start events (typically should have one)`,
    });
  }

  // Check for end events
  if (endEvents.length === 0) {
    issues.push({
      severity: "error",
      message: `Process '${process.id}' has no end event`,
    });
  }

  // Check start events have no incoming flows
  for (const se of startEvents) {
    const incoming = (se as any).incoming || [];
    if (incoming.length > 0) {
      issues.push({
        severity: "error",
        message: `Start event '${se.id}' should not have incoming sequence flows`,
        elementId: se.id,
        elementType: "StartEvent",
      });
    }
    const outgoing = (se as any).outgoing || [];
    if (outgoing.length === 0) {
      issues.push({
        severity: "warning",
        message: `Start event '${se.id}' has no outgoing sequence flow`,
        elementId: se.id,
        elementType: "StartEvent",
      });
    }
  }

  // Check end events have no outgoing flows
  for (const ee of endEvents) {
    const outgoing = (ee as any).outgoing || [];
    if (outgoing.length > 0) {
      issues.push({
        severity: "error",
        message: `End event '${ee.id}' should not have outgoing sequence flows`,
        elementId: ee.id,
        elementType: "EndEvent",
      });
    }
    const incoming = (ee as any).incoming || [];
    if (incoming.length === 0) {
      issues.push({
        severity: "warning",
        message: `End event '${ee.id}' has no incoming sequence flow`,
        elementId: ee.id,
        elementType: "EndEvent",
      });
    }
  }

  // Check tasks have both incoming and outgoing
  for (const task of tasks) {
    const incoming = (task as any).incoming || [];
    const outgoing = (task as any).outgoing || [];
    if (incoming.length === 0) {
      issues.push({
        severity: "warning",
        message: `Task '${task.id}' (${task.name || "unnamed"}) has no incoming sequence flow - may be unreachable`,
        elementId: task.id,
        elementType: task.$type.replace("bpmn:", ""),
      });
    }
    if (outgoing.length === 0) {
      issues.push({
        severity: "warning",
        message: `Task '${task.id}' (${task.name || "unnamed"}) has no outgoing sequence flow - dead end`,
        elementId: task.id,
        elementType: task.$type.replace("bpmn:", ""),
      });
    }
  }

  // Check gateways
  for (const gw of gateways) {
    const incoming = (gw as any).incoming || [];
    const outgoing = (gw as any).outgoing || [];

    if (incoming.length === 0) {
      issues.push({
        severity: "warning",
        message: `Gateway '${gw.id}' (${gw.name || "unnamed"}) has no incoming flows`,
        elementId: gw.id,
        elementType: gw.$type.replace("bpmn:", ""),
      });
    }
    if (outgoing.length === 0) {
      issues.push({
        severity: "warning",
        message: `Gateway '${gw.id}' (${gw.name || "unnamed"}) has no outgoing flows`,
        elementId: gw.id,
        elementType: gw.$type.replace("bpmn:", ""),
      });
    }

    // Splitting gateways should have 2+ outgoing
    if (outgoing.length === 1 && incoming.length > 0) {
      issues.push({
        severity: "info",
        message: `Gateway '${gw.id}' has only one outgoing flow - consider if gateway is needed`,
        elementId: gw.id,
        elementType: gw.$type.replace("bpmn:", ""),
      });
    }

    // Exclusive gateways with multiple outgoing should have conditions (except default)
    if (
      gw.$type === ELEMENT_TYPES.EXCLUSIVE_GATEWAY &&
      outgoing.length > 1
    ) {
      const defaultFlow = (gw as any).default;
      for (const flow of outgoing as SequenceFlow[]) {
        if (
          flow !== defaultFlow &&
          !flow.conditionExpression &&
          flow.id !== defaultFlow?.id
        ) {
          issues.push({
            severity: "warning",
            message: `Sequence flow '${flow.id}' from exclusive gateway '${gw.id}' has no condition expression`,
            elementId: flow.id,
            elementType: "SequenceFlow",
          });
        }
      }
    }
  }

  // Check for sequence flows with missing source/target
  for (const flow of flows) {
    if (!flow.sourceRef) {
      issues.push({
        severity: "error",
        message: `Sequence flow '${flow.id}' has no source reference`,
        elementId: flow.id,
        elementType: "SequenceFlow",
      });
    }
    if (!flow.targetRef) {
      issues.push({
        severity: "error",
        message: `Sequence flow '${flow.id}' has no target reference`,
        elementId: flow.id,
        elementType: "SequenceFlow",
      });
    }
  }

  // Check for duplicate IDs
  const allElements = process.flowElements || [];
  const ids = new Set<string>();
  for (const el of allElements) {
    if (el.id) {
      if (ids.has(el.id)) {
        issues.push({
          severity: "error",
          message: `Duplicate element ID: '${el.id}'`,
          elementId: el.id,
        });
      }
      ids.add(el.id);
    } else {
      issues.push({
        severity: "warning",
        message: `Element of type '${el.$type}' has no ID`,
        elementType: el.$type.replace("bpmn:", ""),
      });
    }
  }

  // Check that process has at least some elements
  if (allElements.length === 0) {
    issues.push({
      severity: "warning",
      message: `Process '${process.id}' has no flow elements`,
    });
  }

  return issues;
}

export function registerValidateTool(server: McpServer) {
  server.tool(
    "bpmn_validate",
    "Validate a BPMN 2.0 diagram for correctness and best practices. Checks for missing start/end events, disconnected elements, invalid flows, duplicate IDs, and other common issues.",
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
    },
    async ({ source, sourceType }) => {
      try {
        let xml: string;
        if (sourceType === "file") {
          xml = await fs.readFile(source, "utf-8");
        } else {
          xml = source;
        }

        const { rootElement, warnings: parseWarnings } = await parseBpmn(xml);
        const definitions = rootElement as BpmnDefinitions;
        const processes = getAllProcesses(definitions);

        const allIssues: ValidationIssue[] = [];

        // Add parse warnings
        if (parseWarnings && parseWarnings.length > 0) {
          for (const w of parseWarnings) {
            allIssues.push({
              severity: "warning",
              message: `Parse warning: ${(w as any).message || String(w)}`,
            });
          }
        }

        // Check we have at least one process
        if (processes.length === 0) {
          allIssues.push({
            severity: "error",
            message: "No process elements found in definitions",
          });
        }

        // Validate each process
        for (const process of processes) {
          allIssues.push(...validateProcess(process));
        }

        // Cross-process: check for duplicate IDs across the entire Definitions scope
        const globalIds = new Map<string, string>(); // id -> processId
        for (const process of processes) {
          if (process.id) {
            if (globalIds.has(process.id)) {
              allIssues.push({
                severity: "error",
                message: `Duplicate process ID: '${process.id}'`,
              });
            }
            globalIds.set(process.id, process.id);
          }
          for (const el of process.flowElements || []) {
            if (el.id) {
              const existing = globalIds.get(el.id);
              if (existing) {
                allIssues.push({
                  severity: "error",
                  message: `Duplicate ID '${el.id}' found in process '${process.id}' (also in '${existing}')`,
                  elementId: el.id,
                });
              }
              globalIds.set(el.id, process.id || "unknown");
            }
          }
        }

        const errors = allIssues.filter((i) => i.severity === "error");
        const warnings = allIssues.filter((i) => i.severity === "warning");
        const info = allIssues.filter((i) => i.severity === "info");

        const result = {
          valid: errors.length === 0,
          summary: {
            errors: errors.length,
            warnings: warnings.length,
            info: info.length,
          },
          issues: allIssues,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error validating BPMN: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  parseBpmn,
  serializeBpmn,
  moddle,
  generateId,
  getAllProcesses,
  BpmnDefinitions,
  BpmnProcess,
  BpmnElement,
} from "../bpmn-utils.js";
import * as fs from "fs/promises";

const TASK_TYPE_MAP: Record<string, string> = {
  task: "bpmn:Task",
  userTask: "bpmn:UserTask",
  serviceTask: "bpmn:ServiceTask",
  scriptTask: "bpmn:ScriptTask",
  sendTask: "bpmn:SendTask",
  receiveTask: "bpmn:ReceiveTask",
  manualTask: "bpmn:ManualTask",
  businessRuleTask: "bpmn:BusinessRuleTask",
};

const GATEWAY_TYPE_MAP: Record<string, string> = {
  exclusive: "bpmn:ExclusiveGateway",
  parallel: "bpmn:ParallelGateway",
  inclusive: "bpmn:InclusiveGateway",
  eventBased: "bpmn:EventBasedGateway",
  complex: "bpmn:ComplexGateway",
};

const EVENT_TYPE_MAP: Record<string, string> = {
  startEvent: "bpmn:StartEvent",
  endEvent: "bpmn:EndEvent",
  intermediateCatchEvent: "bpmn:IntermediateCatchEvent",
  intermediateThrowEvent: "bpmn:IntermediateThrowEvent",
};

function findElementById(
  processes: BpmnProcess[],
  id: string
): { element: BpmnElement; process: BpmnProcess } | null {
  for (const proc of processes) {
    for (const el of proc.flowElements || []) {
      if (el.id === id) {
        return { element: el, process: proc };
      }
    }
  }
  return null;
}

export function registerModifyTool(server: McpServer) {
  server.tool(
    "bpmn_modify",
    "Modify an existing BPMN 2.0 diagram. Supports adding elements, removing elements, renaming elements, and connecting elements with sequence flows.",
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
      processId: z
        .string()
        .optional()
        .describe(
          "ID of the process to modify (defaults to first process if not specified)"
        ),
      operations: z
        .array(
          z.object({
            action: z
              .enum(["addTask", "addGateway", "addEvent", "addFlow", "removeElement", "renameElement"])
              .describe("The modification action to perform"),
            id: z
              .string()
              .optional()
              .describe("Element ID (for remove/rename) or custom ID (for add)"),
            name: z
              .string()
              .optional()
              .describe("Element name (for add/rename)"),
            type: z
              .string()
              .optional()
              .describe("Element subtype (e.g., 'userTask', 'exclusive', 'endEvent')"),
            from: z
              .string()
              .optional()
              .describe("Source element ID (for addFlow)"),
            to: z
              .string()
              .optional()
              .describe("Target element ID (for addFlow)"),
            condition: z
              .string()
              .optional()
              .describe("Condition expression (for addFlow)"),
          })
        )
        .describe("List of modification operations to apply in order"),
      outputPath: z
        .string()
        .optional()
        .describe(
          "Optional file path to write the modified BPMN XML (if not provided, returns XML in response)"
        ),
    },
    async ({ source, sourceType, processId, operations, outputPath }) => {
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

        // Find target process
        let targetProcess = processId
          ? processes.find((p) => p.id === processId)
          : processes[0];

        if (!targetProcess) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Process '${processId}' not found. Available: ${processes.map((p) => p.id).join(", ")}`,
              },
            ],
            isError: true,
          };
        }

        if (!targetProcess.flowElements) {
          targetProcess.flowElements = [];
        }

        const results: string[] = [];

        for (const op of operations) {
          switch (op.action) {
            case "addTask": {
              const taskType = TASK_TYPE_MAP[op.type || "task"] || "bpmn:Task";
              const id = op.id || generateId(op.type || "Task");
              const element = moddle.create(taskType, {
                id,
                name: op.name || "New Task",
              });
              targetProcess.flowElements!.push(element);
              results.push(`Added ${taskType.replace("bpmn:", "")} '${id}' (${op.name || "New Task"})`);
              break;
            }

            case "addGateway": {
              const gwType =
                GATEWAY_TYPE_MAP[op.type || "exclusive"] ||
                "bpmn:ExclusiveGateway";
              const id = op.id || generateId(op.type || "Gateway");
              const element = moddle.create(gwType, {
                id,
                name: op.name,
              });
              targetProcess.flowElements!.push(element);
              results.push(`Added ${gwType.replace("bpmn:", "")} '${id}'`);
              break;
            }

            case "addEvent": {
              const evtType =
                EVENT_TYPE_MAP[op.type || "startEvent"] || "bpmn:StartEvent";
              const id = op.id || generateId(op.type || "Event");
              const element = moddle.create(evtType, {
                id,
                name: op.name,
              });
              targetProcess.flowElements!.push(element);
              results.push(`Added ${evtType.replace("bpmn:", "")} '${id}'`);
              break;
            }

            case "addFlow": {
              if (!op.from || !op.to) {
                results.push(
                  "Error: addFlow requires 'from' and 'to' element IDs"
                );
                continue;
              }
              const sourceResult = findElementById(processes, op.from);
              const targetResult = findElementById(processes, op.to);

              if (!sourceResult) {
                results.push(
                  `Error: Source element '${op.from}' not found`
                );
                continue;
              }
              if (!targetResult) {
                results.push(
                  `Error: Target element '${op.to}' not found`
                );
                continue;
              }

              const flowId = op.id || generateId("Flow");
              const flowProps: any = {
                id: flowId,
                name: op.name,
                sourceRef: sourceResult.element,
                targetRef: targetResult.element,
              };

              if (op.condition) {
                flowProps.conditionExpression = moddle.create(
                  "bpmn:FormalExpression",
                  { body: op.condition }
                );
              }

              const seqFlow = moddle.create("bpmn:SequenceFlow", flowProps);
              targetProcess.flowElements!.push(seqFlow);

              // Wire references
              const src = sourceResult.element as any;
              const tgt = targetResult.element as any;
              if (!src.outgoing) src.outgoing = [];
              src.outgoing.push(seqFlow);
              if (!tgt.incoming) tgt.incoming = [];
              tgt.incoming.push(seqFlow);

              results.push(
                `Added SequenceFlow '${flowId}' from '${op.from}' to '${op.to}'`
              );
              break;
            }

            case "removeElement": {
              if (!op.id) {
                results.push("Error: removeElement requires an element 'id'");
                continue;
              }

              const found = findElementById(processes, op.id);
              if (!found) {
                results.push(`Error: Element '${op.id}' not found`);
                continue;
              }

              // Remove from flow elements
              const idx = found.process.flowElements!.indexOf(found.element);
              if (idx !== -1) {
                found.process.flowElements!.splice(idx, 1);
              }

              // Also remove any sequence flows referencing this element
              const toRemove: BpmnElement[] = [];
              for (const el of found.process.flowElements || []) {
                if (el.$type === "bpmn:SequenceFlow") {
                  const flow = el as any;
                  if (
                    flow.sourceRef?.id === op.id ||
                    flow.targetRef?.id === op.id
                  ) {
                    toRemove.push(el);
                  }
                }
              }
              for (const el of toRemove) {
                const rmIdx = found.process.flowElements!.indexOf(el);
                if (rmIdx !== -1) {
                  found.process.flowElements!.splice(rmIdx, 1);
                }
              }

              results.push(
                `Removed element '${op.id}'${toRemove.length > 0 ? ` and ${toRemove.length} connected flow(s)` : ""}`
              );
              break;
            }

            case "renameElement": {
              if (!op.id) {
                results.push(
                  "Error: renameElement requires an element 'id'"
                );
                continue;
              }
              const found = findElementById(processes, op.id);
              if (!found) {
                results.push(`Error: Element '${op.id}' not found`);
                continue;
              }
              const oldName = found.element.name;
              found.element.name = op.name || "";
              results.push(
                `Renamed element '${op.id}' from '${oldName || "(unnamed)"}' to '${op.name || "(unnamed)"}'`
              );
              break;
            }
          }
        }

        const outputXml = await serializeBpmn(definitions);

        if (outputPath) {
          await fs.writeFile(outputPath, outputXml, "utf-8");
          results.push(`\nModified BPMN written to: ${outputPath}`);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Modifications applied:\n${results.join("\n")}\n\n${outputPath ? "" : outputXml}`,
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error modifying BPMN: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

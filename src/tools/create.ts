import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  moddle,
  generateId,
  serializeBpmn,
  applyAutoLayout,
  TASK_TYPE_MAP,
  GATEWAY_TYPE_MAP,
  EVENT_TYPE_MAP,
} from "../bpmn-utils.js";

const TaskSchema = z.object({
  id: z.string().optional().describe("Optional custom ID for the task"),
  name: z.string().describe("Display name of the task"),
  type: z
    .enum([
      "task",
      "userTask",
      "serviceTask",
      "scriptTask",
      "sendTask",
      "receiveTask",
      "manualTask",
      "businessRuleTask",
    ])
    .default("task")
    .describe("Type of task"),
});

const GatewaySchema = z.object({
  id: z.string().optional().describe("Optional custom ID for the gateway"),
  name: z.string().optional().describe("Display name of the gateway"),
  type: z
    .enum(["exclusive", "parallel", "inclusive", "eventBased", "complex"])
    .default("exclusive")
    .describe("Type of gateway"),
});

const EventSchema = z.object({
  id: z.string().optional().describe("Optional custom ID for the event"),
  name: z.string().optional().describe("Display name of the event"),
  type: z
    .enum([
      "startEvent",
      "endEvent",
      "intermediateCatchEvent",
      "intermediateThrowEvent",
    ])
    .default("startEvent")
    .describe("Type of event"),
});

const FlowSchema = z.object({
  id: z.string().optional().describe("Optional custom ID for the flow"),
  name: z.string().optional().describe("Optional label for the flow"),
  from: z.string().describe("Source element ID"),
  to: z.string().describe("Target element ID"),
  condition: z
    .string()
    .optional()
    .describe("Optional condition expression for the flow"),
});

export function registerCreateTool(server: McpServer) {
  server.tool(
    "bpmn_create",
    "Create a new BPMN 2.0 process diagram from a structured definition of tasks, gateways, events, and sequence flows. Returns valid BPMN XML.",
    {
      processId: z
        .string()
        .optional()
        .describe(
          "ID for the process element (auto-generated if not provided)"
        ),
      processName: z.string().describe("Name of the process"),
      isExecutable: z
        .boolean()
        .default(true)
        .describe("Whether the process is executable"),
      tasks: z.array(TaskSchema).default([]).describe("Task elements"),
      gateways: z
        .array(GatewaySchema)
        .default([])
        .describe("Gateway elements"),
      events: z.array(EventSchema).default([]).describe("Event elements"),
      flows: z.array(FlowSchema).default([]).describe("Sequence flows connecting elements"),
    },
    async ({ processId, processName, isExecutable, tasks, gateways, events, flows }) => {
      try {
        // Build element registry for lookups
        const elementMap = new Map<string, any>();
        const flowElements: any[] = [];

        // Pre-check for duplicate custom IDs
        const allCustomIds = [
          ...events.filter(e => e.id).map(e => e.id!),
          ...tasks.filter(t => t.id).map(t => t.id!),
          ...gateways.filter(g => g.id).map(g => g.id!),
          ...flows.filter(f => f.id).map(f => f.id!),
        ];
        const dupes = allCustomIds.filter((id, i) => allCustomIds.indexOf(id) !== i);
        if (dupes.length > 0) {
          return {
            content: [{ type: "text" as const, text: `Error: Duplicate element IDs: ${[...new Set(dupes)].join(", ")}` }],
            isError: true,
          };
        }

        // Create events
        for (const evt of events) {
          const id = evt.id || generateId(evt.type);
          const bpmnType = EVENT_TYPE_MAP[evt.type];
          const element = moddle.create(bpmnType, {
            id,
            name: evt.name,
          });
          elementMap.set(id, element);
          flowElements.push(element);
        }

        // Create tasks
        for (const task of tasks) {
          const id = task.id || generateId(task.type);
          const bpmnType = TASK_TYPE_MAP[task.type];
          const element = moddle.create(bpmnType, {
            id,
            name: task.name,
          });
          elementMap.set(id, element);
          flowElements.push(element);
        }

        // Create gateways
        for (const gw of gateways) {
          const id = gw.id || generateId(gw.type);
          const bpmnType = GATEWAY_TYPE_MAP[gw.type];
          const element = moddle.create(bpmnType, {
            id,
            name: gw.name,
          });
          elementMap.set(id, element);
          flowElements.push(element);
        }

        // Create sequence flows
        for (const flow of flows) {
          const sourceRef = elementMap.get(flow.from);
          const targetRef = elementMap.get(flow.to);

          if (!sourceRef) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error: Source element '${flow.from}' not found. Available elements: ${Array.from(elementMap.keys()).join(", ")}`,
                },
              ],
              isError: true,
            };
          }
          if (!targetRef) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error: Target element '${flow.to}' not found. Available elements: ${Array.from(elementMap.keys()).join(", ")}`,
                },
              ],
              isError: true,
            };
          }

          const flowId = flow.id || generateId("Flow");
          const flowProps: any = {
            id: flowId,
            name: flow.name,
            sourceRef,
            targetRef,
          };

          if (flow.condition) {
            flowProps.conditionExpression = moddle.create(
              "bpmn:FormalExpression",
              {
                body: flow.condition,
              }
            );
          }

          const seqFlow = moddle.create("bpmn:SequenceFlow", flowProps);
          flowElements.push(seqFlow);

          // Wire up incoming/outgoing references
          if (!sourceRef.outgoing) sourceRef.outgoing = [];
          sourceRef.outgoing.push(seqFlow);
          if (!targetRef.incoming) targetRef.incoming = [];
          targetRef.incoming.push(seqFlow);
        }

        // Create process
        const pId = processId || generateId("Process");
        const process = moddle.create("bpmn:Process", {
          id: pId,
          name: processName,
          isExecutable,
          flowElements,
        });

        // Create definitions
        const definitions = moddle.create("bpmn:Definitions", {
          id: generateId("Definitions"),
          targetNamespace: "http://bpmn.io/schema/bpmn",
          rootElements: [process],
        });

        const rawXml = await serializeBpmn(definitions);
        const xml = await applyAutoLayout(rawXml);

        return {
          content: [
            {
              type: "text" as const,
              text: xml,
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error creating BPMN: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

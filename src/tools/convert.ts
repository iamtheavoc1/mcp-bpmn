import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  parseBpmn,
  serializeBpmn,
  moddle,
  getAllProcesses,
  categorizeElements,
  generateId,
  BpmnDefinitions,
  BpmnProcess,
  BpmnElement,
  SequenceFlow,
  ELEMENT_TYPES,
} from "../bpmn-utils.js";
import * as fs from "fs/promises";

/**
 * Convert BPMN process to Mermaid flowchart syntax
 */
function toMermaid(processes: BpmnProcess[]): string {
  const lines: string[] = ["flowchart TD"];

  for (const process of processes) {
    const { tasks, gateways, events, flows } = categorizeElements(process);

    if (processes.length > 1) {
      lines.push(`  subgraph ${process.id}["${process.name || process.id}"]`);
    }

    const indent = processes.length > 1 ? "    " : "  ";

    // Render events
    for (const evt of events) {
      const label = evt.name || evt.$type.replace("bpmn:", "");
      if (evt.$type === ELEMENT_TYPES.START_EVENT) {
        lines.push(`${indent}${evt.id}(("${label}"))`);
      } else if (evt.$type === ELEMENT_TYPES.END_EVENT) {
        lines.push(`${indent}${evt.id}(("${label}"))`);
      } else {
        lines.push(`${indent}${evt.id}(("${label}"))`);
      }
    }

    // Render tasks
    for (const task of tasks) {
      const label = task.name || task.id || "Task";
      lines.push(`${indent}${task.id}["${label}"]`);
    }

    // Render gateways
    for (const gw of gateways) {
      const label = gw.name || gw.$type.replace("bpmn:", "");
      lines.push(`${indent}${gw.id}{"${label}"}`);
    }

    // Render flows
    for (const flow of flows as SequenceFlow[]) {
      const src = flow.sourceRef?.id;
      const tgt = flow.targetRef?.id;
      if (src && tgt) {
        const label = flow.name || (flow.conditionExpression as any)?.body;
        if (label) {
          lines.push(`${indent}${src} -->|"${label}"| ${tgt}`);
        } else {
          lines.push(`${indent}${src} --> ${tgt}`);
        }
      }
    }

    if (processes.length > 1) {
      lines.push("  end");
    }
  }

  return lines.join("\n");
}

/**
 * Convert BPMN process to a simplified JSON structure
 */
function toSimplifiedJson(processes: BpmnProcess[]) {
  return processes.map((process) => {
    const { tasks, gateways, events, flows } = categorizeElements(process);

    return {
      id: process.id,
      name: process.name,
      elements: [
        ...events.map((e) => ({
          id: e.id,
          type: e.$type.replace("bpmn:", ""),
          name: e.name,
          category: "event" as const,
        })),
        ...tasks.map((t) => ({
          id: t.id,
          type: t.$type.replace("bpmn:", ""),
          name: t.name,
          category: "task" as const,
        })),
        ...gateways.map((g) => ({
          id: g.id,
          type: g.$type.replace("bpmn:", ""),
          name: g.name,
          category: "gateway" as const,
        })),
      ],
      connections: (flows as SequenceFlow[]).map((f) => ({
        id: f.id,
        from: f.sourceRef?.id,
        to: f.targetRef?.id,
        label: f.name,
        condition: (f.conditionExpression as any)?.body,
      })),
    };
  });
}

/**
 * Convert BPMN to a plain text description
 */
function toTextDescription(processes: BpmnProcess[]): string {
  const lines: string[] = [];

  for (const process of processes) {
    lines.push(`Process: ${process.name || process.id}`);
    lines.push("=".repeat(40));

    const { tasks, gateways, events, flows } = categorizeElements(process);

    const startEvents = events.filter(
      (e) => e.$type === ELEMENT_TYPES.START_EVENT
    );
    const endEvents = events.filter(
      (e) => e.$type === ELEMENT_TYPES.END_EVENT
    );
    const intermediateEvents = events.filter(
      (e) =>
        e.$type !== ELEMENT_TYPES.START_EVENT &&
        e.$type !== ELEMENT_TYPES.END_EVENT
    );

    if (startEvents.length > 0) {
      lines.push(
        `\nStart: ${startEvents.map((e) => e.name || e.id).join(", ")}`
      );
    }

    if (tasks.length > 0) {
      lines.push("\nTasks:");
      for (const task of tasks) {
        const type = task.$type.replace("bpmn:", "");
        lines.push(`  - [${type}] ${task.name || task.id}`);
      }
    }

    if (gateways.length > 0) {
      lines.push("\nDecision Points:");
      for (const gw of gateways) {
        const type = gw.$type.replace("bpmn:", "");
        lines.push(`  - [${type}] ${gw.name || gw.id}`);
      }
    }

    if (intermediateEvents.length > 0) {
      lines.push("\nIntermediate Events:");
      for (const evt of intermediateEvents) {
        const type = evt.$type.replace("bpmn:", "");
        lines.push(`  - [${type}] ${evt.name || evt.id}`);
      }
    }

    if (flows.length > 0) {
      lines.push("\nFlow:");
      for (const flow of flows as SequenceFlow[]) {
        const srcName = flow.sourceRef?.name || flow.sourceRef?.id || "?";
        const tgtName = flow.targetRef?.name || flow.targetRef?.id || "?";
        const label = flow.name || (flow.conditionExpression as any)?.body;
        if (label) {
          lines.push(`  ${srcName} --[${label}]--> ${tgtName}`);
        } else {
          lines.push(`  ${srcName} --> ${tgtName}`);
        }
      }
    }

    if (endEvents.length > 0) {
      lines.push(
        `\nEnd: ${endEvents.map((e) => e.name || e.id).join(", ")}`
      );
    }

    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Convert simplified JSON back to BPMN XML
 */
async function fromSimplifiedJson(json: any): Promise<string> {
  const processesData = Array.isArray(json) ? json : [json];

  const rootElements: any[] = [];

  for (const procData of processesData) {
    const flowElements: any[] = [];
    const elementMap = new Map<string, any>();

    // Create elements
    for (const elem of procData.elements || []) {
      const bpmnType = `bpmn:${elem.type}`;
      const el = moddle.create(bpmnType, {
        id: elem.id || generateId(elem.type),
        name: elem.name,
      });
      elementMap.set(el.id!, el);
      flowElements.push(el);
    }

    // Create connections
    for (const conn of procData.connections || []) {
      const sourceRef = elementMap.get(conn.from);
      const targetRef = elementMap.get(conn.to);
      if (sourceRef && targetRef) {
        const flowProps: any = {
          id: conn.id || generateId("Flow"),
          name: conn.label,
          sourceRef,
          targetRef,
        };
        if (conn.condition) {
          flowProps.conditionExpression = moddle.create(
            "bpmn:FormalExpression",
            { body: conn.condition }
          );
        }
        const seqFlow = moddle.create("bpmn:SequenceFlow", flowProps);
        flowElements.push(seqFlow);

        if (!sourceRef.outgoing) sourceRef.outgoing = [];
        sourceRef.outgoing.push(seqFlow);
        if (!targetRef.incoming) targetRef.incoming = [];
        targetRef.incoming.push(seqFlow);
      }
    }

    const process = moddle.create("bpmn:Process", {
      id: procData.id || generateId("Process"),
      name: procData.name,
      isExecutable: true,
      flowElements,
    });

    rootElements.push(process);
  }

  const definitions = moddle.create("bpmn:Definitions", {
    id: generateId("Definitions"),
    targetNamespace: "http://bpmn.io/schema/bpmn",
    rootElements,
  });

  return (await serializeBpmn(definitions))!;
}

export function registerConvertTool(server: McpServer) {
  server.tool(
    "bpmn_convert",
    "Convert BPMN diagrams to/from other formats: Mermaid flowchart syntax, simplified JSON, or plain text description. Also supports creating BPMN from simplified JSON.",
    {
      source: z
        .string()
        .describe(
          "The source content: BPMN XML (or file path), Mermaid text, or JSON"
        ),
      sourceType: z
        .enum(["file", "xml", "json"])
        .default("xml")
        .describe("Source format type"),
      targetFormat: z
        .enum(["mermaid", "json", "text", "bpmn"])
        .describe(
          "Target format to convert to. 'bpmn' converts from JSON to BPMN XML."
        ),
      outputPath: z
        .string()
        .optional()
        .describe("Optional file path to write the output"),
    },
    async ({ source, sourceType, targetFormat, outputPath }) => {
      try {
        let output: string;

        if (targetFormat === "bpmn") {
          // Convert from JSON to BPMN
          if (sourceType === "json") {
            const json =
              typeof source === "string" ? JSON.parse(source) : source;
            output = await fromSimplifiedJson(json);
          } else if (sourceType === "file") {
            const content = await fs.readFile(source, "utf-8");
            const json = JSON.parse(content);
            output = await fromSimplifiedJson(json);
          } else {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: Converting to BPMN requires JSON source (sourceType='json' or 'file')",
                },
              ],
              isError: true,
            };
          }
        } else {
          // Convert from BPMN to target format
          let xml: string;
          if (sourceType === "file") {
            xml = await fs.readFile(source, "utf-8");
          } else if (sourceType === "xml") {
            xml = source;
          } else {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: Converting from BPMN requires XML source (sourceType='xml' or 'file')",
                },
              ],
              isError: true,
            };
          }

          const { rootElement } = await parseBpmn(xml);
          const definitions = rootElement as BpmnDefinitions;
          const processes = getAllProcesses(definitions);

          switch (targetFormat) {
            case "mermaid":
              output = toMermaid(processes);
              break;
            case "json":
              output = JSON.stringify(toSimplifiedJson(processes), null, 2);
              break;
            case "text":
              output = toTextDescription(processes);
              break;
            default:
              output = "Unknown target format";
          }
        }

        if (outputPath) {
          await fs.writeFile(outputPath, output, "utf-8");
        }

        return {
          content: [
            {
              type: "text" as const,
              text: outputPath
                ? `Converted output written to: ${outputPath}\n\n${output}`
                : output,
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error converting BPMN: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

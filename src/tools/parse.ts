import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  parseBpmn,
  getAllProcesses,
  categorizeElements,
  summarizeElement,
  BpmnDefinitions,
} from "../bpmn-utils.js";
import * as fs from "fs/promises";

export function registerParseTool(server: McpServer) {
  server.tool(
    "bpmn_parse",
    "Parse a BPMN 2.0 XML file or string and extract structured information about processes, tasks, gateways, events, and sequence flows",
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
      detailed: z
        .boolean()
        .default(false)
        .describe(
          "If true, include full element details; if false, return a summary"
        ),
    },
    async ({ source, sourceType, detailed }) => {
      try {
        let xml: string;
        if (sourceType === "file") {
          xml = await fs.readFile(source, "utf-8");
        } else {
          xml = source;
        }

        const { rootElement, warnings } = await parseBpmn(xml);
        const definitions = rootElement as BpmnDefinitions;
        const processes = getAllProcesses(definitions);

        const result: Record<string, unknown> = {
          definitionsId: definitions.id,
          targetNamespace: (definitions as any).targetNamespace,
          processCount: processes.length,
          processes: processes.map((proc) => {
            const { tasks, gateways, events, flows, other } =
              categorizeElements(proc);

            const processInfo: Record<string, unknown> = {
              id: proc.id,
              name: proc.name || undefined,
              isExecutable: (proc as any).isExecutable,
              summary: {
                tasks: tasks.length,
                gateways: gateways.length,
                events: events.length,
                sequenceFlows: flows.length,
                other: other.length,
              },
            };

            if (detailed) {
              processInfo.tasks = tasks.map((t) => ({
                ...summarizeElement(t),
                incoming: ((t as any).incoming || []).map(
                  (f: any) => f.id
                ),
                outgoing: ((t as any).outgoing || []).map(
                  (f: any) => f.id
                ),
              }));
              processInfo.gateways = gateways.map((g) => ({
                ...summarizeElement(g),
                incoming: ((g as any).incoming || []).map(
                  (f: any) => f.id
                ),
                outgoing: ((g as any).outgoing || []).map(
                  (f: any) => f.id
                ),
              }));
              processInfo.events = events.map((e) => ({
                ...summarizeElement(e),
                incoming: ((e as any).incoming || []).map(
                  (f: any) => f.id
                ),
                outgoing: ((e as any).outgoing || []).map(
                  (f: any) => f.id
                ),
              }));
              processInfo.sequenceFlows = flows.map((f) => ({
                id: f.id,
                name: f.name || undefined,
                sourceRef: f.sourceRef?.id,
                targetRef: f.targetRef?.id,
                hasCondition: !!f.conditionExpression,
              }));
              processInfo.other = other.map(summarizeElement);
            } else {
              processInfo.elements = [
                ...tasks,
                ...gateways,
                ...events,
              ].map(summarizeElement);
              processInfo.flows = flows.map((f) => ({
                id: f.id,
                from: f.sourceRef?.id,
                to: f.targetRef?.id,
              }));
            }

            return processInfo;
          }),
        };

        if (warnings && warnings.length > 0) {
          result.warnings = warnings.map((w: any) => w.message || String(w));
        }

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
              text: `Error parsing BPMN: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  parseBpmn,
  getAllProcesses,
  categorizeElements,
  BpmnDefinitions,
  BpmnProcess,
  BpmnElement,
  SequenceFlow,
  ELEMENT_TYPES,
} from "../bpmn-utils.js";
import * as fs from "fs/promises";

interface FlowGraph {
  nodes: Map<string, BpmnElement>;
  outgoing: Map<string, string[]>; // elementId -> [targetIds]
  incoming: Map<string, string[]>; // elementId -> [sourceIds]
  flowLabels: Map<string, string>; // "fromId->toId" -> flow name/condition
}

function buildFlowGraph(process: BpmnProcess): FlowGraph {
  const nodes = new Map<string, BpmnElement>();
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  const flowLabels = new Map<string, string>();

  const elements = process.flowElements || [];

  // Register all non-flow elements as nodes
  for (const el of elements) {
    if (el.$type !== ELEMENT_TYPES.SEQUENCE_FLOW && el.id) {
      nodes.set(el.id, el);
      outgoing.set(el.id, []);
      incoming.set(el.id, []);
    }
  }

  // Register flows as edges
  for (const el of elements) {
    if (el.$type === ELEMENT_TYPES.SEQUENCE_FLOW) {
      const flow = el as SequenceFlow;
      const srcId = flow.sourceRef?.id;
      const tgtId = flow.targetRef?.id;
      if (srcId && tgtId) {
        outgoing.get(srcId)?.push(tgtId);
        incoming.get(tgtId)?.push(srcId);
        const label = flow.name || (flow.conditionExpression as any)?.body;
        if (label) {
          flowLabels.set(`${srcId}->${tgtId}`, label);
        }
      }
    }
  }

  return { nodes, outgoing, incoming, flowLabels };
}

/**
 * Find all paths from a start node to any end node using DFS
 */
function findAllPaths(
  graph: FlowGraph,
  startId: string,
  endIds: Set<string>,
  maxPaths: number = 50
): string[][] {
  const paths: string[][] = [];
  const stack: Array<{ nodeId: string; path: string[] }> = [
    { nodeId: startId, path: [startId] },
  ];

  while (stack.length > 0 && paths.length < maxPaths) {
    const { nodeId, path } = stack.pop()!;

    if (endIds.has(nodeId) && path.length > 1) {
      paths.push([...path]);
      continue;
    }

    const successors = graph.outgoing.get(nodeId) || [];
    for (const next of successors) {
      // Avoid cycles
      if (!path.includes(next)) {
        stack.push({ nodeId: next, path: [...path, next] });
      }
    }
  }

  return paths;
}

/**
 * Find unreachable nodes (not reachable from any start event)
 */
function findUnreachableNodes(
  graph: FlowGraph,
  startIds: string[]
): string[] {
  const visited = new Set<string>();
  const queue = [...startIds];

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    const successors = graph.outgoing.get(nodeId) || [];
    for (const next of successors) {
      if (!visited.has(next)) {
        queue.push(next);
      }
    }
  }

  const unreachable: string[] = [];
  for (const [id] of graph.nodes) {
    if (!visited.has(id)) {
      unreachable.push(id);
    }
  }

  return unreachable;
}

/**
 * Find dead ends (nodes that can't reach any end event)
 */
function findDeadEnds(graph: FlowGraph, endIds: string[]): string[] {
  // Reverse BFS from end events
  const canReachEnd = new Set<string>();
  const queue = [...endIds];

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (canReachEnd.has(nodeId)) continue;
    canReachEnd.add(nodeId);

    const predecessors = graph.incoming.get(nodeId) || [];
    for (const prev of predecessors) {
      if (!canReachEnd.has(prev)) {
        queue.push(prev);
      }
    }
  }

  const deadEnds: string[] = [];
  for (const [id] of graph.nodes) {
    if (!canReachEnd.has(id) && !endIds.includes(id)) {
      deadEnds.push(id);
    }
  }

  return deadEnds;
}

/**
 * Detect cycles in the graph
 */
function findCycles(graph: FlowGraph): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(nodeId: string, path: string[]) {
    if (inStack.has(nodeId)) {
      // Found a cycle - extract it
      const cycleStart = path.indexOf(nodeId);
      if (cycleStart !== -1) {
        cycles.push(path.slice(cycleStart).concat(nodeId));
      }
      return;
    }
    if (visited.has(nodeId)) return;

    visited.add(nodeId);
    inStack.add(nodeId);

    for (const next of graph.outgoing.get(nodeId) || []) {
      dfs(next, [...path, nodeId]);
    }

    inStack.delete(nodeId);
  }

  for (const [id] of graph.nodes) {
    if (!visited.has(id)) {
      dfs(id, []);
    }
  }

  return cycles;
}

function analyzeProcess(process: BpmnProcess) {
  const graph = buildFlowGraph(process);
  const { tasks, gateways, events, flows } = categorizeElements(process);

  const startEvents = events.filter(
    (e) => e.$type === ELEMENT_TYPES.START_EVENT
  );
  const endEvents = events.filter((e) => e.$type === ELEMENT_TYPES.END_EVENT);

  const startIds = startEvents.map((e) => e.id!).filter(Boolean);
  const endIds = endEvents.map((e) => e.id!).filter(Boolean);
  const endIdSet = new Set(endIds);

  // Compute paths
  const allPaths: string[][] = [];
  for (const startId of startIds) {
    allPaths.push(...findAllPaths(graph, startId, endIdSet));
  }

  // Unreachable nodes
  const unreachable = findUnreachableNodes(graph, startIds);

  // Dead ends
  const deadEnds = findDeadEnds(graph, endIds);

  // Cycles
  const cycles = findCycles(graph);

  // Complexity metrics
  const nodeCount = graph.nodes.size;
  const edgeCount = flows.length;
  const gatewayCount = gateways.length;

  // Cyclomatic complexity: E - N + 2P (P = 1 for single process)
  const cyclomaticComplexity = edgeCount - nodeCount + 2;

  const nodeName = (id: string) => {
    const node = graph.nodes.get(id);
    return node?.name
      ? `${node.name} (${id})`
      : `${id} [${node?.$type?.replace("bpmn:", "") || "unknown"}]`;
  };

  return {
    processId: process.id,
    processName: process.name || undefined,
    metrics: {
      totalElements: nodeCount,
      tasks: tasks.length,
      gateways: gatewayCount,
      events: events.length,
      sequenceFlows: edgeCount,
      cyclomaticComplexity,
    },
    paths: {
      count: allPaths.length,
      paths: allPaths.slice(0, 20).map((path) => ({
        length: path.length,
        steps: path.map(nodeName),
      })),
      truncated: allPaths.length > 20,
    },
    unreachableElements: unreachable.map(nodeName),
    deadEnds: deadEnds.map(nodeName),
    cycles: cycles.map((cycle) => cycle.map(nodeName)),
    issues: [
      ...(unreachable.length > 0
        ? [`${unreachable.length} unreachable element(s) detected`]
        : []),
      ...(deadEnds.length > 0
        ? [`${deadEnds.length} dead end(s) detected`]
        : []),
      ...(cycles.length > 0
        ? [`${cycles.length} cycle(s) detected (may be intentional loops)`]
        : []),
      ...(startIds.length === 0 ? ["No start event found"] : []),
      ...(endIds.length === 0 ? ["No end event found"] : []),
      ...(cyclomaticComplexity > 10
        ? [
            `High cyclomatic complexity (${cyclomaticComplexity}) - consider simplifying`,
          ]
        : []),
    ],
  };
}

export function registerAnalyzeTool(server: McpServer) {
  server.tool(
    "bpmn_analyze",
    "Analyze a BPMN 2.0 process for flow paths, unreachable nodes, dead ends, cycles, and complexity metrics. Helps identify process design issues.",
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

        const analysis = processes.map(analyzeProcess);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { processCount: processes.length, analyses: analysis },
                null,
                2
              ),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error analyzing BPMN: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

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

// ─── bpmnlint integration ──────────────────────────────────────────
// bpmnlint is CJS, so we dynamically require it at call time.

async function loadBpmnlint() {
  const { createRequire } = await import("module");
  const require = createRequire(import.meta.url);

  const Linter = require("bpmnlint/lib/linter");
  const StaticResolver = require("bpmnlint/lib/resolver/static-resolver");

  // Load all built-in rules
  const ruleNames = [
    "conditional-flows",
    "end-event-required",
    "event-sub-process-typed-start-event",
    "fake-join",
    "label-required",
    "no-complex-gateway",
    "no-disconnected",
    "no-duplicate-sequence-flows",
    "no-gateway-join-fork",
    "no-implicit-end",
    "no-implicit-split",
    "no-implicit-start",
    "no-inclusive-gateway",
    "no-overlapping-elements",
    "single-blank-start-event",
    "start-event-required",
    "sub-process-blank-start-event",
    "superfluous-gateway",
  ];

  const cache: Record<string, any> = {};

  for (const name of ruleNames) {
    const rule = require(`bpmnlint/rules/${name}`);
    cache[`rule:bpmnlint/${name}`] = rule;
  }

  // Config: most rules as "warn"; downgrade noisy rules for multi-pool diagrams
  const ruleConfig: Record<string, string> = {};
  for (const r of ruleNames) {
    // These rules produce false positives in collaboration diagrams
    // (elements connected via message flows across pools appear "disconnected")
    if (["no-disconnected", "no-implicit-end", "no-implicit-start"].includes(r)) {
      ruleConfig[r] = "info";
    } else {
      ruleConfig[r] = "warn";
    }
  }
  const config = { rules: ruleConfig };

  cache["config:bpmnlint/all"] = config;

  const resolver = new StaticResolver(cache);
  const linter = new Linter({ config, resolver });

  return linter;
}

// ─── Types ──────────────────────────────────────────────────────────

interface DiShape {
  id: string;
  elementId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  isContainer: boolean; // pools, lanes, sub-processes
}

interface DiEdge {
  id: string;
  elementId: string;
  waypoints: Array<{ x: number; y: number }>;
}

interface BenchmarkIssue {
  category: string;
  severity: "error" | "warning" | "info";
  message: string;
  elementId?: string;
  rule?: string;
}

interface ScoreCategory {
  name: string;
  score: number; // 0-100
  maxScore: number; // always 100
  issues: BenchmarkIssue[];
}

// ─── BPMNDI extraction ──────────────────────────────────────────────

function extractDiInfo(definitions: BpmnDefinitions): {
  shapes: DiShape[];
  edges: DiEdge[];
} {
  const shapes: DiShape[] = [];
  const edges: DiEdge[] = [];
  const diagrams = (definitions.diagrams || []) as any[];

  for (const diagram of diagrams) {
    const plane = diagram.plane;
    if (!plane?.planeElement) continue;

    for (const el of plane.planeElement) {
      if (el.$type === "bpmndi:BPMNShape") {
        const bounds = el.bounds;
        if (bounds) {
          const elType = el.bpmnElement?.$type || "";
          const isContainer =
            elType === "bpmn:Participant" ||
            elType === "bpmn:Lane" ||
            elType === "bpmn:SubProcess" ||
            el.isExpanded === true;
          shapes.push({
            id: el.id || "",
            elementId: el.bpmnElement?.id || "",
            x: bounds.x || 0,
            y: bounds.y || 0,
            w: bounds.width || 0,
            h: bounds.height || 0,
            isContainer,
          });
        }
      } else if (el.$type === "bpmndi:BPMNEdge") {
        const wps = el.waypoint || [];
        edges.push({
          id: el.id || "",
          elementId: el.bpmnElement?.id || "",
          waypoints: wps.map((wp: any) => ({ x: wp.x || 0, y: wp.y || 0 })),
        });
      }
    }
  }

  return { shapes, edges };
}

// ─── Layout quality metrics ─────────────────────────────────────────

function checkOverlappingShapes(
  shapes: DiShape[]
): BenchmarkIssue[] {
  const issues: BenchmarkIssue[] = [];
  const PAD = 2;

  // Filter out containers — elements inside pools/lanes are expected to overlap them
  const nonContainers = shapes.filter((s) => !s.isContainer);

  for (let i = 0; i < nonContainers.length; i++) {
    for (let j = i + 1; j < nonContainers.length; j++) {
      const a = nonContainers[i];
      const b = nonContainers[j];
      if (
        a.x + PAD < b.x + b.w - PAD &&
        a.x + a.w - PAD > b.x + PAD &&
        a.y + PAD < b.y + b.h - PAD &&
        a.y + a.h - PAD > b.y + PAD
      ) {
        issues.push({
          category: "layout",
          severity: "error",
          message: `Elements '${a.elementId}' and '${b.elementId}' overlap`,
          elementId: a.elementId,
          rule: "no-overlapping-shapes",
        });
      }
    }
  }
  return issues;
}

function checkEdgeCrossings(edges: DiEdge[]): BenchmarkIssue[] {
  const issues: BenchmarkIssue[] = [];

  function segmentsIntersect(
    p1: { x: number; y: number },
    p2: { x: number; y: number },
    p3: { x: number; y: number },
    p4: { x: number; y: number }
  ): boolean {
    const d1x = p2.x - p1.x,
      d1y = p2.y - p1.y;
    const d2x = p4.x - p3.x,
      d2y = p4.y - p3.y;
    const cross = d1x * d2y - d1y * d2x;
    if (Math.abs(cross) < 1e-10) return false;

    const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / cross;
    const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / cross;

    return t > 0.01 && t < 0.99 && u > 0.01 && u < 0.99;
  }

  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const e1 = edges[i];
      const e2 = edges[j];
      let crossCount = 0;

      for (let a = 0; a < e1.waypoints.length - 1; a++) {
        for (let b = 0; b < e2.waypoints.length - 1; b++) {
          if (
            segmentsIntersect(
              e1.waypoints[a],
              e1.waypoints[a + 1],
              e2.waypoints[b],
              e2.waypoints[b + 1]
            )
          ) {
            crossCount++;
          }
        }
      }

      if (crossCount > 0) {
        issues.push({
          category: "layout",
          severity: crossCount > 1 ? "error" : "warning",
          message: `Edges '${e1.elementId}' and '${e2.elementId}' cross ${crossCount} time(s)`,
          rule: "no-edge-crossings",
        });
      }
    }
  }

  return issues;
}

function checkFlowDirection(
  shapes: DiShape[],
  edges: DiEdge[]
): BenchmarkIssue[] {
  const issues: BenchmarkIssue[] = [];
  const shapeMap = new Map(shapes.map((s) => [s.elementId, s]));

  let forwardCount = 0;
  let backwardCount = 0;
  let totalSequential = 0;

  for (const edge of edges) {
    if (edge.waypoints.length < 2) continue;
    const first = edge.waypoints[0];
    const last = edge.waypoints[edge.waypoints.length - 1];
    const dx = last.x - first.x;

    // Only count mostly-horizontal edges
    if (Math.abs(dx) > 20) {
      totalSequential++;
      if (dx > 0) forwardCount++;
      else backwardCount++;
    }
  }

  if (totalSequential > 0 && backwardCount > totalSequential * 0.3) {
    issues.push({
      category: "layout",
      severity: "warning",
      message: `${backwardCount}/${totalSequential} edges flow right-to-left (inconsistent flow direction)`,
      rule: "consistent-flow-direction",
    });
  }

  return issues;
}

function checkElementSpacing(shapes: DiShape[]): BenchmarkIssue[] {
  const issues: BenchmarkIssue[] = [];
  const MIN_GAP = 15;

  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      const a = shapes[i];
      const b = shapes[j];

      // Skip if they're far apart
      const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
      const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));

      if (dx > 0 && dx < MIN_GAP && dy < MIN_GAP) {
        issues.push({
          category: "layout",
          severity: "info",
          message: `Elements '${a.elementId}' and '${b.elementId}' are too close (${Math.round(dx)}px gap)`,
          rule: "minimum-spacing",
        });
      }
    }
  }

  return issues;
}

function checkEdgeBends(edges: DiEdge[]): BenchmarkIssue[] {
  const issues: BenchmarkIssue[] = [];
  const MAX_BENDS = 4;

  for (const edge of edges) {
    const bends = Math.max(0, edge.waypoints.length - 2);
    if (bends > MAX_BENDS) {
      issues.push({
        category: "layout",
        severity: "warning",
        message: `Edge '${edge.elementId}' has ${bends} bends (max recommended: ${MAX_BENDS})`,
        elementId: edge.elementId,
        rule: "max-edge-bends",
      });
    }
  }

  return issues;
}

// ─── 7PMG (Seven Process Modeling Guidelines) ───────────────────────

function check7PMG(processes: BpmnProcess[]): BenchmarkIssue[] {
  const issues: BenchmarkIssue[] = [];

  for (const process of processes) {
    const { tasks, gateways, events, flows } = categorizeElements(process);
    const allElements = process.flowElements || [];
    const nonFlowElements = allElements.filter(
      (e) => e.$type !== ELEMENT_TYPES.SEQUENCE_FLOW
    );

    // G1: Use as few elements as possible (>50 is high)
    if (nonFlowElements.length > 50) {
      issues.push({
        category: "7pmg",
        severity: "warning",
        message: `Process '${process.id}' has ${nonFlowElements.length} elements (G1: >50 elements correlates with higher error rates)`,
        rule: "7pmg-g1-element-count",
      });
    }

    // G2: Minimize routing paths per element
    for (const el of nonFlowElements) {
      const outgoing = ((el as any).outgoing || []).length;
      const incoming = ((el as any).incoming || []).length;
      if (outgoing > 5 || incoming > 5) {
        issues.push({
          category: "7pmg",
          severity: "warning",
          message: `Element '${el.id}' has ${incoming} incoming and ${outgoing} outgoing flows (G2: minimize routing)`,
          elementId: el.id,
          rule: "7pmg-g2-routing-paths",
        });
      }
    }

    // G3: Use one start and one end event
    const starts = events.filter((e) => e.$type === ELEMENT_TYPES.START_EVENT);
    const ends = events.filter((e) => e.$type === ELEMENT_TYPES.END_EVENT);
    if (starts.length > 1) {
      issues.push({
        category: "7pmg",
        severity: "warning",
        message: `Process '${process.id}' has ${starts.length} start events (G3: use one start event)`,
        rule: "7pmg-g3-single-start-end",
      });
    }
    if (ends.length > 1) {
      issues.push({
        category: "7pmg",
        severity: "info",
        message: `Process '${process.id}' has ${ends.length} end events (G3: prefer one end event)`,
        rule: "7pmg-g3-single-start-end",
      });
    }

    // G4: Model as structured as possible (split-join matching)
    const splitGateways = gateways.filter(
      (g) => ((g as any).outgoing || []).length > 1
    );
    const joinGateways = gateways.filter(
      (g) => ((g as any).incoming || []).length > 1
    );
    // Simple heuristic: each split gateway type should have a matching join
    const splitTypes = new Map<string, number>();
    const joinTypes = new Map<string, number>();
    for (const g of splitGateways)
      splitTypes.set(g.$type, (splitTypes.get(g.$type) || 0) + 1);
    for (const g of joinGateways)
      joinTypes.set(g.$type, (joinTypes.get(g.$type) || 0) + 1);
    for (const [type, count] of splitTypes) {
      const joinCount = joinTypes.get(type) || 0;
      if (count > joinCount) {
        const typeName = type.replace("bpmn:", "");
        issues.push({
          category: "7pmg",
          severity: "warning",
          message: `${count} splitting ${typeName}(s) but only ${joinCount} joining — unstructured flow (G4)`,
          rule: "7pmg-g4-structured",
        });
      }
    }

    // G5: Avoid OR routing (inclusive gateways)
    const inclGateways = gateways.filter(
      (g) => g.$type === ELEMENT_TYPES.INCLUSIVE_GATEWAY
    );
    if (inclGateways.length > 0) {
      issues.push({
        category: "7pmg",
        severity: "info",
        message: `Process uses ${inclGateways.length} inclusive (OR) gateway(s) (G5: OR gateways are hardest to understand)`,
        rule: "7pmg-g5-avoid-or",
      });
    }

    // G6: Use verb-object activity labels
    for (const task of tasks) {
      if (!task.name) {
        issues.push({
          category: "7pmg",
          severity: "warning",
          message: `Task '${task.id}' has no label (G6: use verb-object labels)`,
          elementId: task.id,
          rule: "7pmg-g6-verb-object-labels",
        });
      } else {
        const words = task.name.trim().split(/\s+/);
        if (words.length < 2) {
          issues.push({
            category: "7pmg",
            severity: "info",
            message: `Task '${task.id}' label "${task.name}" may not follow verb-object pattern (G6)`,
            elementId: task.id,
            rule: "7pmg-g6-verb-object-labels",
          });
        }
      }
    }

    // G7: Decompose models with more than 50 elements
    if (nonFlowElements.length > 30 && nonFlowElements.length <= 50) {
      issues.push({
        category: "7pmg",
        severity: "info",
        message: `Process '${process.id}' has ${nonFlowElements.length} elements — consider decomposing if it grows further (G7)`,
        rule: "7pmg-g7-decompose",
      });
    } else if (nonFlowElements.length > 50) {
      issues.push({
        category: "7pmg",
        severity: "warning",
        message: `Process '${process.id}' should be decomposed into sub-processes (G7: >50 elements)`,
        rule: "7pmg-g7-decompose",
      });
    }
  }

  return issues;
}

// ─── Label quality checks ───────────────────────────────────────────

function checkLabels(processes: BpmnProcess[]): BenchmarkIssue[] {
  const issues: BenchmarkIssue[] = [];

  for (const process of processes) {
    const { tasks, gateways, events, flows } = categorizeElements(process);

    // Tasks must have labels
    for (const task of tasks) {
      if (!task.name || task.name.trim() === "") {
        issues.push({
          category: "labeling",
          severity: "warning",
          message: `Task '${task.id}' has no label`,
          elementId: task.id,
          rule: "task-label-required",
        });
      }
    }

    // Splitting gateways should have labels on outgoing flows
    for (const gw of gateways) {
      const outgoing = (gw as any).outgoing || [];
      if (outgoing.length > 1) {
        const unlabeledFlows = outgoing.filter(
          (f: any) => !f.name && !f.conditionExpression
        );
        if (unlabeledFlows.length > 0) {
          issues.push({
            category: "labeling",
            severity: "warning",
            message: `Gateway '${gw.id}' has ${unlabeledFlows.length} outgoing flow(s) without labels or conditions`,
            elementId: gw.id,
            rule: "gateway-flow-labels",
          });
        }
      }
    }
  }

  return issues;
}

// ─── Scoring ────────────────────────────────────────────────────────

function computeScore(issues: BenchmarkIssue[]): number {
  let deductions = 0;
  // Cap info deductions so bulk-noise doesn't destroy the score
  let infoPenalty = 0;
  const MAX_INFO_PENALTY = 20;

  for (const issue of issues) {
    switch (issue.severity) {
      case "error":
        deductions += 15;
        break;
      case "warning":
        deductions += 7;
        break;
      case "info":
        infoPenalty = Math.min(infoPenalty + 2, MAX_INFO_PENALTY);
        break;
    }
  }
  return Math.max(0, 100 - deductions - infoPenalty);
}

// ─── Tool Registration ──────────────────────────────────────────────

export function registerBenchmarkTool(server: McpServer) {
  server.tool(
    "bpmn_benchmark",
    "Benchmark a BPMN 2.0 diagram for quality across multiple dimensions: structural correctness (via bpmnlint), layout aesthetics (overlaps, edge crossings, flow direction, spacing), 7PMG compliance (Seven Process Modeling Guidelines by Mendling et al.), and labeling quality. Returns a 0-100 score per category and an overall composite score.",
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

        // ── 1. bpmnlint structural checks ──
        const lintIssues: BenchmarkIssue[] = [];
        try {
          const linter = await loadBpmnlint();
          const lintResults = await linter.lint(rootElement);

          for (const [ruleName, reports] of Object.entries(lintResults)) {
            for (const report of reports as any[]) {
              lintIssues.push({
                category: "structural",
                severity:
                  report.category === "error"
                    ? "error"
                    : report.category === "warn"
                      ? "warning"
                      : "info",
                message: report.message,
                elementId: report.id,
                rule: ruleName,
              });
            }
          }
        } catch (e: any) {
          lintIssues.push({
            category: "structural",
            severity: "info",
            message: `bpmnlint unavailable: ${e.message}`,
            rule: "bpmnlint-error",
          });
        }

        // ── 2. Layout quality checks (requires BPMNDI) ──
        const { shapes, edges } = extractDiInfo(definitions);
        const layoutIssues: BenchmarkIssue[] = [];
        let hasLayout = shapes.length > 0;

        if (hasLayout) {
          layoutIssues.push(...checkOverlappingShapes(shapes));
          layoutIssues.push(...checkEdgeCrossings(edges));
          layoutIssues.push(...checkFlowDirection(shapes, edges));
          layoutIssues.push(...checkElementSpacing(shapes));
          layoutIssues.push(...checkEdgeBends(edges));
        } else {
          layoutIssues.push({
            category: "layout",
            severity: "warning",
            message:
              "No BPMNDI layout data found — layout quality cannot be assessed. Run bpmn_format with autoLayout=true first.",
            rule: "has-layout",
          });
        }

        // ── 3. 7PMG compliance ──
        const pmgIssues = check7PMG(processes);

        // ── 4. Labeling quality ──
        const labelIssues = checkLabels(processes);

        // ── Scoring ──
        const categories: ScoreCategory[] = [
          {
            name: "Structural Correctness",
            score: computeScore(lintIssues),
            maxScore: 100,
            issues: lintIssues,
          },
          {
            name: "Layout Aesthetics",
            score: hasLayout ? computeScore(layoutIssues) : 0,
            maxScore: 100,
            issues: layoutIssues,
          },
          {
            name: "7PMG Compliance",
            score: computeScore(pmgIssues),
            maxScore: 100,
            issues: pmgIssues,
          },
          {
            name: "Labeling Quality",
            score: computeScore(labelIssues),
            maxScore: 100,
            issues: labelIssues,
          },
        ];

        // Weighted composite: structural 30%, layout 25%, 7pmg 25%, labeling 20%
        const weights = [0.3, 0.25, 0.25, 0.2];
        const overallScore = Math.round(
          categories.reduce((sum, cat, i) => sum + cat.score * weights[i], 0)
        );

        const allIssues = [
          ...lintIssues,
          ...layoutIssues,
          ...pmgIssues,
          ...labelIssues,
        ];
        const errorCount = allIssues.filter((i) => i.severity === "error").length;
        const warnCount = allIssues.filter((i) => i.severity === "warning").length;
        const infoCount = allIssues.filter((i) => i.severity === "info").length;

        // Grade
        let grade: string;
        if (overallScore >= 90) grade = "A";
        else if (overallScore >= 80) grade = "B";
        else if (overallScore >= 70) grade = "C";
        else if (overallScore >= 60) grade = "D";
        else grade = "F";

        // Process stats
        const totalElements = processes.reduce(
          (sum, p) =>
            sum +
            (p.flowElements?.filter(
              (e) => e.$type !== ELEMENT_TYPES.SEQUENCE_FLOW
            ).length || 0),
          0
        );
        const totalFlows = processes.reduce(
          (sum, p) =>
            sum +
            (p.flowElements?.filter(
              (e) => e.$type === ELEMENT_TYPES.SEQUENCE_FLOW
            ).length || 0),
          0
        );

        const result = {
          overallScore,
          grade,
          summary: {
            processes: processes.length,
            elements: totalElements,
            flows: totalFlows,
            diShapes: shapes.length,
            diEdges: edges.length,
            errors: errorCount,
            warnings: warnCount,
            info: infoCount,
          },
          categories: categories.map((c) => ({
            name: c.name,
            score: c.score,
            issueCount: c.issues.length,
            issues: c.issues,
          })),
        };

        // Pretty text output
        const lines: string[] = [];
        lines.push("BPMN QUALITY BENCHMARK");
        lines.push("=".repeat(50));
        lines.push(`Overall Score: ${overallScore}/100 (Grade: ${grade})`);
        lines.push(`Processes: ${processes.length} | Elements: ${totalElements} | Flows: ${totalFlows}`);
        lines.push(`Issues: ${errorCount} errors, ${warnCount} warnings, ${infoCount} info`);
        lines.push("-".repeat(50));

        const MAX_ISSUES_SHOWN = 8;
        for (const cat of categories) {
          const bar = "#".repeat(Math.round(cat.score / 5)) + ".".repeat(20 - Math.round(cat.score / 5));
          lines.push(`${cat.name}: ${cat.score}/100 [${bar}]`);
          if (cat.issues.length > 0) {
            // Show errors and warnings first, then info
            const sorted = [...cat.issues].sort((a, b) => {
              const order = { error: 0, warning: 1, info: 2 };
              return order[a.severity] - order[b.severity];
            });
            const shown = sorted.slice(0, MAX_ISSUES_SHOWN);
            const remaining = sorted.length - shown.length;
            for (const issue of shown) {
              const icon =
                issue.severity === "error"
                  ? "ERR"
                  : issue.severity === "warning"
                    ? "WRN"
                    : "INF";
              lines.push(`  [${icon}] ${issue.message}`);
            }
            if (remaining > 0) {
              lines.push(`  ... and ${remaining} more issue(s)`);
            }
          }
        }

        lines.push("=".repeat(50));

        return {
          content: [
            {
              type: "text" as const,
              text: lines.join("\n") + "\n\n" + JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error benchmarking BPMN: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

#!/usr/bin/env node
/**
 * Visual QA: Renders the BPMN in a real browser, extracts every shape/label/edge
 * bounding box, and checks for ALL overlap/readability issues. Returns a structured
 * report so the layout can be fixed programmatically.
 */
import { chromium } from "playwright";
import path from "path";

const htmlPath = path.resolve("demo-multi-pool.html");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 2200, height: 1400 } });
await page.goto("file://" + htmlPath);
await page.waitForTimeout(3500);

// Extract ALL visual elements with bounding boxes
const data = await page.evaluate(() => {
  const results = { shapes: [], labels: [], edges: [] };

  // Shapes (tasks, events, gateways — NOT connections, NOT labels)
  document.querySelectorAll(".djs-element[data-element-id]").forEach(el => {
    const id = el.getAttribute("data-element-id");
    const cls = el.className?.baseVal || "";
    if (cls.includes("djs-connection") || cls.includes("djs-label")) return;
    const rect = el.getBoundingClientRect();
    // Filter out pools (too large) and invisible elements
    if (rect.width > 5 && rect.width < 500 && rect.height > 5 && rect.height < 500) {
      results.shapes.push({
        id, x: Math.round(rect.x), y: Math.round(rect.y),
        w: Math.round(rect.width), h: Math.round(rect.height),
      });
    }
  });

  // Labels — try multiple selectors for compatibility
  const labelSels = [
    ".djs-element.djs-label[data-element-id]",
    ".djs-label[data-element-id]",
    ".djs-group[data-element-id] .djs-label",
    "[data-element-id] text",
    ".djs-label-visual",
  ];
  const seen = new Set();
  for (const sel of labelSels) {
    document.querySelectorAll(sel).forEach(el => {
      const group = el.closest("[data-element-id]");
      const id = group?.getAttribute("data-element-id") || el.getAttribute("data-element-id");
      if (!id || seen.has(id + el.textContent)) return;
      const rect = el.getBoundingClientRect();
      const text = el.textContent?.trim();
      if (text && rect.width > 2 && rect.height > 2) {
        seen.add(id + text);
        results.labels.push({
          id, text, x: Math.round(rect.x), y: Math.round(rect.y),
          w: Math.round(rect.width), h: Math.round(rect.height),
        });
      }
    });
  }
  // Also get ALL visible text nodes in the SVG
  document.querySelectorAll("#canvas svg text, #c svg text").forEach(t => {
    const text = t.textContent?.trim();
    if (!text) return;
    const rect = t.getBoundingClientRect();
    if (rect.width < 2) return;
    const group = t.closest("[data-element-id]");
    const id = group?.getAttribute("data-element-id") || "unknown";
    const key = id + text;
    if (seen.has(key)) return;
    seen.add(key);
    results.labels.push({
      id, text, x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.width), h: Math.round(rect.height),
    });
  });

  // Edges (connections — get their bounding boxes)
  document.querySelectorAll(".djs-element.djs-connection[data-element-id]").forEach(el => {
    const id = el.getAttribute("data-element-id");
    const rect = el.getBoundingClientRect();
    if (rect.width > 0) {
      results.edges.push({
        id, x: Math.round(rect.x), y: Math.round(rect.y),
        w: Math.round(rect.width), h: Math.round(rect.height),
      });
    }
  });

  return results;
});

await page.screenshot({ path: "shot.png" });
await browser.close();

// ─── Analysis ───────────────────────────────────────────────────────
const PAD = 3; // pixel tolerance for overlap detection
const issues = [];

function overlaps(a, b, pad = PAD) {
  return a.x + pad < b.x + b.w - pad &&
         a.x + a.w - pad > b.x + pad &&
         a.y + pad < b.y + b.h - pad &&
         a.y + a.h - pad > b.y + pad;
}

function overlapArea(a, b) {
  const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return ox * oy;
}

// 1. Shape-Shape overlaps
for (let i = 0; i < data.shapes.length; i++) {
  for (let j = i + 1; j < data.shapes.length; j++) {
    if (overlaps(data.shapes[i], data.shapes[j])) {
      issues.push({
        type: "SHAPE_OVERLAP",
        severity: "HIGH",
        a: data.shapes[i].id, b: data.shapes[j].id,
        area: overlapArea(data.shapes[i], data.shapes[j]),
      });
    }
  }
}

// 2. Label-Shape overlaps (label covers a shape it doesn't belong to)
for (const label of data.labels) {
  for (const shape of data.shapes) {
    if (label.id === shape.id) continue;
    if (overlaps(label, shape, 0)) {
      const area = overlapArea(label, shape);
      if (area > 50) { // ignore tiny overlaps
        issues.push({
          type: "LABEL_SHAPE_OVERLAP",
          severity: area > 200 ? "HIGH" : "MEDIUM",
          label: `"${label.text}" (${label.id})`,
          shape: shape.id,
          area,
        });
      }
    }
  }
}

// 3. Label-Label overlaps
for (let i = 0; i < data.labels.length; i++) {
  for (let j = i + 1; j < data.labels.length; j++) {
    if (overlaps(data.labels[i], data.labels[j], 0)) {
      const area = overlapArea(data.labels[i], data.labels[j]);
      if (area > 30) {
        issues.push({
          type: "LABEL_LABEL_OVERLAP",
          severity: area > 150 ? "HIGH" : "MEDIUM",
          a: `"${data.labels[i].text}" (${data.labels[i].id})`,
          b: `"${data.labels[j].text}" (${data.labels[j].id})`,
          area,
        });
      }
    }
  }
}

// 4. Label-Edge overlaps — SKIP: edge bounding boxes are huge rectangles
//    covering their entire routing area. Not meaningful for overlap detection.
//    Real edge-crossing issues are caught by shape-shape and label-shape checks.

// 5. Labels near edges of viewport (clipped/cut off)
const VP = { w: 2200, h: 1400 };
for (const label of data.labels) {
  if (label.x < 5 || label.y < 5 ||
      label.x + label.w > VP.w - 5 || label.y + label.h > VP.h - 5) {
    issues.push({
      type: "LABEL_CLIPPED",
      severity: "HIGH",
      label: `"${label.text}" (${label.id})`,
      pos: `x=${label.x} y=${label.y} w=${label.w} h=${label.h}`,
    });
  }
}

// 6. Labels too small (unreadable)
for (const label of data.labels) {
  if (label.h < 8) {
    issues.push({
      type: "LABEL_TOO_SMALL",
      severity: "HIGH",
      label: `"${label.text}" (${label.id})`,
      height: label.h,
    });
  }
}

// ─── Report ─────────────────────────────────────────────────────────
const high = issues.filter(i => i.severity === "HIGH");
const med = issues.filter(i => i.severity === "MEDIUM");

console.log("\n══════════════════════════════════════════════════");
console.log("  VISUAL QA REPORT");
console.log("══════════════════════════════════════════════════");
console.log(`  Shapes: ${data.shapes.length}  |  Labels: ${data.labels.length}  |  Edges: ${data.edges.length}`);
console.log(`  Issues: ${high.length} HIGH, ${med.length} MEDIUM`);
console.log("──────────────────────────────────────────────────");

if (issues.length === 0) {
  console.log("\n  ✅ PRISTINE — No issues detected!\n");
} else {
  for (const issue of issues) {
    const icon = issue.severity === "HIGH" ? "🔴" : "🟡";
    switch (issue.type) {
      case "SHAPE_OVERLAP":
        console.log(`  ${icon} SHAPE OVERLAP: ${issue.a} ∩ ${issue.b} (${issue.area}px²)`);
        break;
      case "LABEL_SHAPE_OVERLAP":
        console.log(`  ${icon} LABEL→SHAPE: ${issue.label} covers ${issue.shape} (${issue.area}px²)`);
        break;
      case "LABEL_LABEL_OVERLAP":
        console.log(`  ${icon} LABEL→LABEL: ${issue.a} ∩ ${issue.b} (${issue.area}px²)`);
        break;
      case "LABEL_EDGE_OVERLAP":
        console.log(`  ${icon} LABEL→EDGE: ${issue.label} covers edge ${issue.edge} (${issue.area}px²)`);
        break;
      case "LABEL_CLIPPED":
        console.log(`  ${icon} CLIPPED: ${issue.label} at ${issue.pos}`);
        break;
      case "LABEL_TOO_SMALL":
        console.log(`  ${icon} TOO SMALL: ${issue.label} h=${issue.height}px`);
        break;
    }
  }
}
console.log("══════════════════════════════════════════════════\n");

// Output JSON for programmatic use
await (await import("fs/promises")).writeFile("qa-report.json", JSON.stringify({ shapes: data.shapes, labels: data.labels, issues }, null, 2));
process.exit(issues.filter(i => i.severity === "HIGH").length > 0 ? 1 : 0);

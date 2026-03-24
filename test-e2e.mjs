#!/usr/bin/env node
/**
 * End-to-end test for mcp-bpmn using MCP SDK Client.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let passed = 0, failed = 0;
const failures = [];

function assert(cond, name, detail) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; failures.push({ name, detail }); console.log(`  ❌ ${name}`); if (detail) console.log(`     ${String(detail).slice(0, 200)}`); }
}

function text(r) { return r?.content?.[0]?.text ?? ""; }

async function call(client, name, args) {
  return client.callTool({ name, arguments: args });
}

async function runTests() {
  const transport = new StdioClientTransport({
    command: "node", args: ["dist/index.js"],
    cwd: new URL(".", import.meta.url).pathname,
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "1.0.0" });

  try {
    console.log("\n📡 Connecting...");
    await client.connect(transport);

    // List tools
    console.log("\n🔧 Tools...");
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    for (const t of ["bpmn_parse","bpmn_create","bpmn_validate","bpmn_modify","bpmn_analyze","bpmn_convert","bpmn_format"]) {
      assert(names.includes(t), `Tool '${t}' registered`);
    }

    // ─── bpmn_create ─────────────────────────────────────────
    console.log("\n📝 bpmn_create...");
    const cr = await call(client, "bpmn_create", {
      processName: "Order Process",
      events: [
        { id: "start_1", type: "startEvent", name: "Order Received" },
        { id: "end_1", type: "endEvent", name: "Order Complete" },
        { id: "end_2", type: "endEvent", name: "Order Rejected" },
      ],
      tasks: [
        { id: "task_validate", type: "serviceTask", name: "Validate Order" },
        { id: "task_process", type: "userTask", name: "Process Order" },
        { id: "task_ship", type: "serviceTask", name: "Ship Order" },
        { id: "task_reject", type: "sendTask", name: "Send Rejection" },
      ],
      gateways: [
        { id: "gw_valid", type: "exclusive", name: "Order Valid?" },
        { id: "gw_merge", type: "exclusive" },
      ],
      flows: [
        { id: "f1", from: "start_1", to: "task_validate" },
        { id: "f2", from: "task_validate", to: "gw_valid" },
        { id: "f3", from: "gw_valid", to: "task_process", name: "Yes" },
        { id: "f4", from: "gw_valid", to: "task_reject", name: "No" },
        { id: "f5", from: "task_process", to: "task_ship" },
        { id: "f6", from: "task_ship", to: "gw_merge" },
        { id: "f7", from: "task_reject", to: "end_2" },
        { id: "f8", from: "gw_merge", to: "end_1" },
      ],
    });
    const xml = text(cr);
    assert(xml.includes("<bpmn:definitions"), "create: definitions");
    assert(xml.includes('name="Order Process"'), "create: process name");
    assert(xml.includes("<bpmn:startEvent"), "create: start event");
    assert(xml.includes("<bpmn:endEvent"), "create: end event");
    assert(xml.includes("<bpmn:serviceTask"), "create: service task");
    assert(xml.includes("<bpmn:userTask"), "create: user task");
    assert(xml.includes("<bpmn:sendTask"), "create: send task");
    assert(xml.includes("<bpmn:exclusiveGateway"), "create: gateway");
    assert(xml.includes("<bpmn:sequenceFlow"), "create: flows");

    // Duplicate IDs
    const dr = await call(client, "bpmn_create", {
      processName: "Dupe",
      events: [{ id: "x", type: "startEvent" }, { id: "x", type: "endEvent" }],
    });
    assert(text(dr).includes("Duplicate") || dr.isError, "create: duplicate ID error");

    // Missing ref
    const br = await call(client, "bpmn_create", {
      processName: "Bad",
      events: [{ id: "s1", type: "startEvent" }],
      flows: [{ from: "nope", to: "s1" }],
    });
    assert(text(br).includes("not found") || br.isError, "create: missing ref error");

    // ─── bpmn_parse ──────────────────────────────────────────
    console.log("\n🔍 bpmn_parse...");
    const pd = JSON.parse(text(await call(client, "bpmn_parse", { source: xml, sourceType: "xml", detailed: true })));
    assert(pd?.processCount === 1, "parse: 1 process");
    assert(pd?.processes?.[0]?.summary?.tasks === 4, "parse: 4 tasks", `Got: ${pd?.processes?.[0]?.summary?.tasks}`);
    assert(pd?.processes?.[0]?.summary?.gateways === 2, "parse: 2 gateways");
    assert(pd?.processes?.[0]?.summary?.events === 3, "parse: 3 events");
    assert(pd?.processes?.[0]?.summary?.sequenceFlows === 8, "parse: 8 flows");

    const sd = JSON.parse(text(await call(client, "bpmn_parse", { source: xml, sourceType: "xml", detailed: false })));
    assert(sd?.processes?.[0]?.elements?.length > 0, "parse: summary elements");
    assert(sd?.processes?.[0]?.flows?.length > 0, "parse: summary flows");

    // ─── bpmn_validate ───────────────────────────────────────
    console.log("\n✅ bpmn_validate...");
    const vd = JSON.parse(text(await call(client, "bpmn_validate", { source: xml, sourceType: "xml" })));
    assert(vd?.valid === true, "validate: good BPMN valid", JSON.stringify(vd?.issues?.filter(i => i.severity === "error")));

    const broken = `<?xml version="1.0" encoding="UTF-8"?><bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D" targetNamespace="http://bpmn.io/schema/bpmn"><bpmn:process id="P"><bpmn:task id="t1" name="Orphan"/></bpmn:process></bpmn:definitions>`;
    const bd = JSON.parse(text(await call(client, "bpmn_validate", { source: broken, sourceType: "xml" })));
    assert(bd?.valid === false, "validate: catches missing start");
    assert(bd?.summary?.errors > 0, "validate: reports errors");

    // ─── bpmn_analyze ────────────────────────────────────────
    console.log("\n📊 bpmn_analyze...");
    const ad = JSON.parse(text(await call(client, "bpmn_analyze", { source: xml, sourceType: "xml" })));
    assert(ad?.analyses?.[0]?.metrics?.totalElements > 0, "analyze: elements");
    assert(ad?.analyses?.[0]?.metrics?.cyclomaticComplexity > 0, "analyze: complexity");
    assert(ad?.analyses?.[0]?.paths?.count > 0, "analyze: paths", `${ad?.analyses?.[0]?.paths?.count}`);
    assert(ad?.analyses?.[0]?.unreachableElements?.length === 0, "analyze: no unreachable");

    // ─── bpmn_format ─────────────────────────────────────────
    console.log("\n🎨 bpmn_format...");
    const fr = await call(client, "bpmn_format", {
      source: xml, sourceType: "xml",
      normalizeIds: true, sortElements: true, removeOrphans: true, autoLayout: true,
    });
    const fc = text(fr);
    assert(!fr.isError, "format: no error", fc.slice(0, 200));
    assert(fc.includes("Formatting applied"), "format: reports changes");
    assert(fc.includes("<bpmndi:BPMNDiagram"), "format: BPMNDI");
    assert(fc.includes("<bpmndi:BPMNShape"), "format: shapes");
    assert(fc.includes("<bpmndi:BPMNEdge"), "format: edges");
    assert(fc.includes("dc:Bounds"), "format: bounds");
    assert(fc.includes("di:waypoint"), "format: waypoints");
    assert(fc.includes("Normalized"), "format: normalizes IDs");

    const fxml = fc.slice(fc.indexOf("<?xml"));
    assert(fxml.startsWith("<?xml"), "format: valid XML output");

    // No autoLayout
    const nl = await call(client, "bpmn_format", {
      source: xml, sourceType: "xml",
      normalizeIds: false, sortElements: true, removeOrphans: false, autoLayout: false,
    });
    assert(!nl.isError, "format: works without autoLayout");

    // ─── bpmn_modify ─────────────────────────────────────────
    console.log("\n✏️  bpmn_modify...");
    const mc = text(await call(client, "bpmn_modify", {
      source: xml, sourceType: "xml",
      operations: [
        { action: "addTask", id: "task_notify", name: "Notify Customer", type: "sendTask" },
        { action: "addFlow", id: "f_new", from: "task_ship", to: "task_notify" },
        { action: "renameElement", id: "task_process", name: "Fulfill Order" },
      ],
    }));
    assert(mc.includes("Added SendTask"), "modify: adds task");
    assert(mc.includes("Added SequenceFlow"), "modify: adds flow");
    assert(mc.includes("Renamed"), "modify: renames");
    assert(mc.includes("Fulfill Order"), "modify: rename applied");

    const rc = text(await call(client, "bpmn_modify", {
      source: xml, sourceType: "xml",
      operations: [{ action: "removeElement", id: "task_reject" }],
    }));
    assert(rc.includes("Removed"), "modify: removes element");

    const bc = text(await call(client, "bpmn_modify", {
      source: xml, sourceType: "xml",
      operations: [{ action: "addFlow", from: "nope", to: "start_1" }],
    }));
    assert(bc.includes("not found"), "modify: bad ref error");

    // ─── bpmn_convert ────────────────────────────────────────
    console.log("\n🔄 bpmn_convert...");

    const mm = text(await call(client, "bpmn_convert", { source: xml, sourceType: "xml", targetFormat: "mermaid" }));
    assert(mm.includes("flowchart LR"), "convert: mermaid header");
    assert(mm.includes("-->"), "convert: mermaid edges");

    const jc = text(await call(client, "bpmn_convert", { source: xml, sourceType: "xml", targetFormat: "json" }));
    const jd = JSON.parse(jc);
    assert(jd?.[0]?.elements?.length > 0, "convert: json elements");
    assert(jd?.[0]?.connections?.length > 0, "convert: json connections");

    const tc = text(await call(client, "bpmn_convert", { source: xml, sourceType: "xml", targetFormat: "text" }));
    assert(tc.includes("Process:"), "convert: text header");
    assert(tc.includes("-->"), "convert: text arrows");

    const rt = text(await call(client, "bpmn_convert", { source: jc, sourceType: "json", targetFormat: "bpmn" }));
    assert(rt.includes("<bpmn:definitions"), "convert: json->bpmn roundtrip");
    assert(rt.includes("<bpmn:sequenceFlow"), "convert: roundtrip flows");

    // ─── Error handling ──────────────────────────────────────
    console.log("\n💥 Error handling...");
    const ir = await call(client, "bpmn_parse", { source: "not xml", sourceType: "xml" });
    assert(text(ir).toLowerCase().includes("error"), "error: invalid XML");

    // ─── Full pipeline ───────────────────────────────────────
    console.log("\n🔗 Full pipeline...");
    const cx = text(await call(client, "bpmn_create", {
      processName: "Loan",
      events: [
        { id: "start", type: "startEvent", name: "Applied" },
        { id: "end_ok", type: "endEvent", name: "Approved" },
        { id: "end_no", type: "endEvent", name: "Rejected" },
      ],
      tasks: [
        { id: "t1", type: "userTask", name: "Review" },
        { id: "t2", type: "serviceTask", name: "Credit" },
        { id: "t3", type: "serviceTask", name: "Auto-OK" },
        { id: "t4", type: "userTask", name: "Manual" },
        { id: "t5", type: "sendTask", name: "Reject" },
      ],
      gateways: [
        { id: "g1", type: "exclusive", name: "Score?" },
        { id: "g2", type: "exclusive", name: "OK?" },
        { id: "g3", type: "exclusive" },
      ],
      flows: [
        { from: "start", to: "t1" }, { from: "t1", to: "t2" }, { from: "t2", to: "g1" },
        { from: "g1", to: "t3", name: "High" }, { from: "g1", to: "t4", name: "Med" },
        { from: "g1", to: "t5", name: "Low" }, { from: "t3", to: "g3" },
        { from: "t4", to: "g2" }, { from: "g2", to: "g3", name: "Yes" },
        { from: "g2", to: "t5", name: "No" }, { from: "g3", to: "end_ok" },
        { from: "t5", to: "end_no" },
      ],
    }));

    const cv = JSON.parse(text(await call(client, "bpmn_validate", { source: cx, sourceType: "xml" })));
    assert(cv?.valid === true, "pipeline: validates", JSON.stringify(cv?.issues?.filter(i => i.severity === "error")));

    const cf = text(await call(client, "bpmn_format", { source: cx, sourceType: "xml", autoLayout: true }));
    assert(cf.includes("<bpmndi:BPMNDiagram"), "pipeline: layout works");

    const cfx = cf.slice(cf.indexOf("<?xml"));
    const cp = JSON.parse(text(await call(client, "bpmn_parse", { source: cfx, sourceType: "xml", detailed: true })));
    assert(cp?.processes?.[0]?.summary?.tasks === 5, "pipeline: 5 tasks after format");

    const ca = JSON.parse(text(await call(client, "bpmn_analyze", { source: cfx, sourceType: "xml" })));
    assert(ca?.analyses?.[0]?.paths?.count >= 3, "pipeline: ≥3 paths", `${ca?.analyses?.[0]?.paths?.count}`);
    assert(ca?.analyses?.[0]?.deadEnds?.length === 0, "pipeline: no dead ends");
    assert(ca?.analyses?.[0]?.unreachableElements?.length === 0, "pipeline: no unreachable");

  } catch (err) {
    console.error("\n💀 Error:", err.message || err);
    failed++;
  } finally {
    await client.close();
  }

  console.log("\n" + "═".repeat(50));
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("\n  Failures:");
    for (const f of failures) {
      console.log(`    - ${f.name}`);
      if (f.detail) console.log(`      ${f.detail}`);
    }
  }
  console.log("═".repeat(50) + "\n");
  process.exit(failed > 0 ? 1 : 0);
}

runTests();

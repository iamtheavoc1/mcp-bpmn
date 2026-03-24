#!/usr/bin/env node
/**
 * Demo: Multi-pool Order-to-Cash BPMN.
 * Long-distance message flows route OUTSIDE intermediate pools
 * along the right margin so they never visually cross through elements.
 */
import fs from "fs/promises";
import path from "path";
import { exec } from "child_process";

// ─── Constants ──────────────────────────────────────────────────────
const POOL_LABEL_W = 30;
const POOL_PAD = 40;
const POOL_GAP = 30;
const SP = 150;          // column spacing
const TASK_W = 100;
const TASK_H = 80;
const EVT = 36;
const GW = 50;
const BRANCH_DY = 110;   // vertical offset for branch row

// ─── Helpers ────────────────────────────────────────────────────────
const shape = (id, x, y, w, h, pool) =>
  `      <bpmndi:BPMNShape id="${id}_di" bpmnElement="${id}"${pool ? ' isHorizontal="true"' : ''}>
        <dc:Bounds x="${x}" y="${y}" width="${w}" height="${h}" />
      </bpmndi:BPMNShape>`;
const edge = (id, wps) =>
  `      <bpmndi:BPMNEdge id="${id}_di" bpmnElement="${id}">
${wps.map(([x,y]) => `        <di:waypoint x="${x}" y="${y}" />`).join("\n")}
      </bpmndi:BPMNEdge>`;

const mid  = (e) => ({ cx: e.x + e.w/2, cy: e.y + e.h/2, r: e.x + e.w, b: e.y + e.h, t: e.y, l: e.x });
const hf   = (a, b) => [[mid(a).r, mid(a).cy], [b.x, mid(b).cy]]; // horizontal flow

// ─── Column X positions ─────────────────────────────────────────────
const X0 = POOL_LABEL_W + POOL_PAD + 30; // extra left pad so pool labels don't overlap start events
const C = []; // C[0] through C[8]
for (let i = 0; i < 9; i++) C[i] = X0 + i * SP;

// Right margin for message flow routing (outside all elements)
const RIGHT_MARGIN = C[8] + TASK_W + 120;
const POOL_W = RIGHT_MARGIN + 200 - 50; // pool width — enough for labels on right margin

// Element position factory
const mk = (col, row, type = "task") => {
  const w = type === "evt" ? EVT : type === "gw" ? GW : TASK_W;
  const h = type === "evt" ? EVT : type === "gw" ? GW : TASK_H;
  const yOff = type === "task" ? 0 : (TASK_H - h) / 2;
  return { x: C[col], y: row + yOff, w, h };
};

// ─── Pool 1: Customer ──────────────────────────────────────────────
const P1 = 50;
const R1 = P1 + POOL_PAD + 10;            // main row
const R1b = R1 + BRANCH_DY;               // branch row
const P1H = BRANCH_DY + TASK_H + POOL_PAD * 2 + 10;

const cust = {
  start:   mk(0, R1, "evt"),
  browse:  mk(1, R1),
  order:   mk(2, R1),
  gwAvail: mk(3, R1, "gw"),
  pay:     mk(4, R1),
  //skip col5 (used by Sales forward)
  receive: mk(6, R1),
  confirm: mk(7, R1),
  endOk:   mk(8, R1, "evt"),
  endNo:   mk(4, R1b, "evt"),
};

// ─── Pool 2: Sales ─────────────────────────────────────────────────
const P2 = P1 + P1H + POOL_GAP;
const R2 = P2 + POOL_PAD + 10;
const R2b = R2 + BRANCH_DY;
const P2H = BRANCH_DY + TASK_H + POOL_PAD * 2 + 10;

const sales = {
  start:    mk(0, R2, "evt"),
  validate: mk(1, R2),
  credit:   mk(2, R2),
  gwCredit: mk(3, R2, "gw"),
  approve:  mk(4, R2),
  forward:  mk(5, R2),
  gwMerge:  mk(6, R2, "gw"),
  end:      mk(7, R2, "evt"),
  reject:   mk(5, R2b),
};

// ─── Pool 3: Fulfillment ───────────────────────────────────────────
const P3 = P2 + P2H + POOL_GAP;
const R3 = P3 + POOL_PAD + 10;
const P3H = TASK_H + POOL_PAD * 2 + 50;

const ful = {
  start:   mk(0, R3, "evt"),
  pick:    mk(1, R3),
  pack:    mk(2, R3),
  quality: mk(3, R3),
  gwQc:    mk(4, R3, "gw"),
  ship:    mk(5, R3),
  notify:  mk(6, R3),
  end:     mk(7, R3, "evt"),
};

// ─── Pool 4: Finance ───────────────────────────────────────────────
const P4 = P3 + P3H + POOL_GAP;
const R4 = P4 + POOL_PAD + 10;
const P4H = TASK_H + POOL_PAD * 2 + 20;

const fin = {
  start:   mk(3, R4, "evt"),
  verify:  mk(4, R4),
  invoice: mk(5, R4),
  send:    mk(6, R4),
  record:  mk(7, R4),
  end:     mk(8, R4, "evt"),
};

// ─── Message flow routing ───────────────────────────────────────────
// Adjacent pools: straight down/up between the two
// Non-adjacent: route along the RIGHT MARGIN (outside all elements)

// Order Details: c_order(col2) → s_start(col0) — adjacent, route through gap
const mf_order = [
  [mid(cust.order).cx, mid(cust.order).b],
  [mid(cust.order).cx, P1 + P1H + 5],
  [mid(sales.start).cx, P1 + P1H + 5],
  [mid(sales.start).cx, sales.start.y],
];

// Availability: s_validate(col1) → c_gwAvail(col3) — adjacent, route through gap
const mf_avail = [
  [mid(sales.validate).cx, sales.validate.y],
  [mid(sales.validate).cx, P2 - 5],
  [mid(cust.gwAvail).cx,   P2 - 5],
  [mid(cust.gwAvail).cx,   mid(cust.gwAvail).b],
];

// Fulfillment Request: s_forward(col5) → f_start(col0) — adjacent
const mf_fulfill = [
  [mid(sales.forward).cx, mid(sales.forward).b],
  [mid(sales.forward).cx, P2 + P2H + POOL_GAP/2],
  [mid(ful.start).cx,     P2 + P2H + POOL_GAP/2],
  [mid(ful.start).cx,     ful.start.y],
];

// Payment: c_pay(col4) → fi_start(col3) — SKIPS 2 pools!
// Route: down from c_pay → right to RIGHT_MARGIN → straight down past Sales+Fulfillment → left to fi_start
const mf_payment = [
  [mid(cust.pay).cx,   mid(cust.pay).b],
  [mid(cust.pay).cx,   P1 + P1H + POOL_GAP/2],
  [RIGHT_MARGIN + 30,  P1 + P1H + POOL_GAP/2],
  [RIGHT_MARGIN + 30,  P4 - POOL_GAP/2],
  [mid(fin.start).cx,  P4 - POOL_GAP/2],
  [mid(fin.start).cx,  fin.start.y],
];

// Tracking Info: f_notify(col6) → c_receive(col6) — SKIPS Sales pool
// Route: up from f_notify → right to RIGHT_MARGIN → straight up past Sales → left to c_receive
const mf_tracking = [
  [mid(ful.notify).cx,   ful.notify.y],
  [mid(ful.notify).cx,   P3 - POOL_GAP/2],
  [RIGHT_MARGIN,         P3 - POOL_GAP/2],
  [RIGHT_MARGIN,         P1 + P1H + 5],
  [mid(cust.receive).cx, P1 + P1H + 5],
  [mid(cust.receive).cx, mid(cust.receive).b],
];

// Invoice: fi_send(col6) → c_confirm(col7) — SKIPS 2 pools!
// Route: up from fi_send → right to RIGHT_MARGIN+60 → straight up past everything → left to c_confirm
const mf_invoice = [
  [mid(fin.send).cx,     fin.send.y],
  [mid(fin.send).cx,     P4 - POOL_GAP/2 + 10],
  [RIGHT_MARGIN + 60,    P4 - POOL_GAP/2 + 10],
  [RIGHT_MARGIN + 60,    P2 - 5],
  [mid(cust.confirm).cx, P2 - 5],
  [mid(cust.confirm).cx, mid(cust.confirm).b],
];

// ─── Build XML ──────────────────────────────────────────────────────
const FULL_W = RIGHT_MARGIN + 100;
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
                  id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">

  <bpmn:collaboration id="Collab">
    <bpmn:participant id="Pool_Cust" name="Customer" processRef="Proc_Cust" />
    <bpmn:participant id="Pool_Sales" name="Sales Department" processRef="Proc_Sales" />
    <bpmn:participant id="Pool_Ful" name="Fulfillment" processRef="Proc_Ful" />
    <bpmn:participant id="Pool_Fin" name="Finance" processRef="Proc_Fin" />
    <bpmn:messageFlow id="MF_order" name="Order Details" sourceRef="c_order" targetRef="s_start" />
    <bpmn:messageFlow id="MF_avail" name="Availability" sourceRef="s_validate" targetRef="c_gwAvail" />
    <bpmn:messageFlow id="MF_fulfill" name="Fulfillment Request" sourceRef="s_forward" targetRef="f_start" />
    <bpmn:messageFlow id="MF_payment" name="Payment" sourceRef="c_pay" targetRef="fi_start" />
    <bpmn:messageFlow id="MF_tracking" name="Tracking Info" sourceRef="f_notify" targetRef="c_receive" />
    <bpmn:messageFlow id="MF_invoice" name="Invoice" sourceRef="fi_send" targetRef="c_confirm" />
  </bpmn:collaboration>

  <bpmn:process id="Proc_Cust" name="Customer" isExecutable="false">
    <bpmn:startEvent id="c_start" name="Need Product" />
    <bpmn:userTask id="c_browse" name="Browse Catalog" />
    <bpmn:userTask id="c_order" name="Place Order" />
    <bpmn:exclusiveGateway id="c_gwAvail" name="In Stock?" />
    <bpmn:userTask id="c_pay" name="Make Payment" />
    <bpmn:userTask id="c_receive" name="Receive Shipment" />
    <bpmn:sendTask id="c_confirm" name="Confirm Receipt" />
    <bpmn:endEvent id="c_endOk" name="Product Received" />
    <bpmn:endEvent id="c_endNo" name="Order Cancelled" />
    <bpmn:sequenceFlow id="cf1" sourceRef="c_start" targetRef="c_browse" />
    <bpmn:sequenceFlow id="cf2" sourceRef="c_browse" targetRef="c_order" />
    <bpmn:sequenceFlow id="cf3" sourceRef="c_order" targetRef="c_gwAvail" />
    <bpmn:sequenceFlow id="cf4" name="Yes" sourceRef="c_gwAvail" targetRef="c_pay" />
    <bpmn:sequenceFlow id="cf5" name="No" sourceRef="c_gwAvail" targetRef="c_endNo" />
    <bpmn:sequenceFlow id="cf6" sourceRef="c_pay" targetRef="c_receive" />
    <bpmn:sequenceFlow id="cf7" sourceRef="c_receive" targetRef="c_confirm" />
    <bpmn:sequenceFlow id="cf8" sourceRef="c_confirm" targetRef="c_endOk" />
  </bpmn:process>

  <bpmn:process id="Proc_Sales" name="Sales Department" isExecutable="false">
    <bpmn:startEvent id="s_start" name="Order Received" />
    <bpmn:serviceTask id="s_validate" name="Validate Order" />
    <bpmn:serviceTask id="s_credit" name="Credit Check" />
    <bpmn:exclusiveGateway id="s_gwCredit" name="Credit OK?" />
    <bpmn:userTask id="s_approve" name="Approve Order" />
    <bpmn:sendTask id="s_forward" name="Forward to Fulfillment" />
    <bpmn:exclusiveGateway id="s_gwMerge" />
    <bpmn:endEvent id="s_end" name="Order Closed" />
    <bpmn:sendTask id="s_reject" name="Reject Order" />
    <bpmn:sequenceFlow id="sf1" sourceRef="s_start" targetRef="s_validate" />
    <bpmn:sequenceFlow id="sf2" sourceRef="s_validate" targetRef="s_credit" />
    <bpmn:sequenceFlow id="sf3" sourceRef="s_credit" targetRef="s_gwCredit" />
    <bpmn:sequenceFlow id="sf4" name="Yes" sourceRef="s_gwCredit" targetRef="s_approve" />
    <bpmn:sequenceFlow id="sf5" name="No" sourceRef="s_gwCredit" targetRef="s_reject" />
    <bpmn:sequenceFlow id="sf6" sourceRef="s_approve" targetRef="s_forward" />
    <bpmn:sequenceFlow id="sf7" sourceRef="s_forward" targetRef="s_gwMerge" />
    <bpmn:sequenceFlow id="sf8" sourceRef="s_reject" targetRef="s_gwMerge" />
    <bpmn:sequenceFlow id="sf9" sourceRef="s_gwMerge" targetRef="s_end" />
  </bpmn:process>

  <bpmn:process id="Proc_Ful" name="Fulfillment" isExecutable="false">
    <bpmn:startEvent id="f_start" name="Fulfillment Request" />
    <bpmn:manualTask id="f_pick" name="Pick Items" />
    <bpmn:manualTask id="f_pack" name="Pack Order" />
    <bpmn:userTask id="f_quality" name="Quality Check" />
    <bpmn:exclusiveGateway id="f_gwQc" name="QC Passed?" />
    <bpmn:serviceTask id="f_ship" name="Arrange Shipping" />
    <bpmn:sendTask id="f_notify" name="Send Tracking Info" />
    <bpmn:endEvent id="f_end" name="Shipment Complete" />
    <bpmn:sequenceFlow id="ff1" sourceRef="f_start" targetRef="f_pick" />
    <bpmn:sequenceFlow id="ff2" sourceRef="f_pick" targetRef="f_pack" />
    <bpmn:sequenceFlow id="ff3" sourceRef="f_pack" targetRef="f_quality" />
    <bpmn:sequenceFlow id="ff4" sourceRef="f_quality" targetRef="f_gwQc" />
    <bpmn:sequenceFlow id="ff5" name="Yes" sourceRef="f_gwQc" targetRef="f_ship" />
    <bpmn:sequenceFlow id="ff6" name="No" sourceRef="f_gwQc" targetRef="f_pick" />
    <bpmn:sequenceFlow id="ff7" sourceRef="f_ship" targetRef="f_notify" />
    <bpmn:sequenceFlow id="ff8" sourceRef="f_notify" targetRef="f_end" />
  </bpmn:process>

  <bpmn:process id="Proc_Fin" name="Finance" isExecutable="false">
    <bpmn:startEvent id="fi_start" name="Payment Received" />
    <bpmn:serviceTask id="fi_verify" name="Verify Payment" />
    <bpmn:serviceTask id="fi_invoice" name="Generate Invoice" />
    <bpmn:sendTask id="fi_send" name="Send Invoice" />
    <bpmn:serviceTask id="fi_record" name="Record Revenue" />
    <bpmn:endEvent id="fi_end" name="Revenue Recorded" />
    <bpmn:sequenceFlow id="fif1" sourceRef="fi_start" targetRef="fi_verify" />
    <bpmn:sequenceFlow id="fif2" sourceRef="fi_verify" targetRef="fi_invoice" />
    <bpmn:sequenceFlow id="fif3" sourceRef="fi_invoice" targetRef="fi_send" />
    <bpmn:sequenceFlow id="fif4" sourceRef="fi_send" targetRef="fi_record" />
    <bpmn:sequenceFlow id="fif5" sourceRef="fi_record" targetRef="fi_end" />
  </bpmn:process>

  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Collab">
${shape("Pool_Cust",  50, P1, FULL_W - 50, P1H, true)}
${shape("Pool_Sales", 50, P2, FULL_W - 50, P2H, true)}
${shape("Pool_Ful",   50, P3, FULL_W - 50, P3H, true)}
${shape("Pool_Fin",   50, P4, FULL_W - 50, P4H, true)}

${Object.entries(cust).map(([k,v]) => shape("c_"+k, v.x, v.y, v.w, v.h)).join("\n")}
${Object.entries(sales).map(([k,v]) => shape("s_"+k, v.x, v.y, v.w, v.h)).join("\n")}
${Object.entries(ful).map(([k,v]) => shape("f_"+k, v.x, v.y, v.w, v.h)).join("\n")}
${Object.entries(fin).map(([k,v]) => shape("fi_"+k, v.x, v.y, v.w, v.h)).join("\n")}

${edge("cf1", hf(cust.start, cust.browse))}
${edge("cf2", hf(cust.browse, cust.order))}
${edge("cf3", hf(cust.order, cust.gwAvail))}
${edge("cf4", hf(cust.gwAvail, cust.pay))}
${edge("cf5", [[mid(cust.gwAvail).cx, mid(cust.gwAvail).b], [mid(cust.gwAvail).cx, mid(cust.endNo).cy], [cust.endNo.x, mid(cust.endNo).cy]])}
${edge("cf6", hf(cust.pay, cust.receive))}
${edge("cf7", hf(cust.receive, cust.confirm))}
${edge("cf8", hf(cust.confirm, cust.endOk))}

${edge("sf1", hf(sales.start, sales.validate))}
${edge("sf2", hf(sales.validate, sales.credit))}
${edge("sf3", hf(sales.credit, sales.gwCredit))}
${edge("sf4", hf(sales.gwCredit, sales.approve))}
${edge("sf5", [[mid(sales.gwCredit).cx, mid(sales.gwCredit).b], [mid(sales.gwCredit).cx, mid(sales.reject).cy], [sales.reject.x, mid(sales.reject).cy]])}
${edge("sf6", hf(sales.approve, sales.forward))}
${edge("sf7", hf(sales.forward, sales.gwMerge))}
${edge("sf8", [[mid(sales.reject).r, mid(sales.reject).cy], [sales.gwMerge.x - 20, mid(sales.reject).cy], [sales.gwMerge.x - 20, mid(sales.gwMerge).cy], [sales.gwMerge.x, mid(sales.gwMerge).cy]])}
${edge("sf9", hf(sales.gwMerge, sales.end))}

${edge("ff1", hf(ful.start, ful.pick))}
${edge("ff2", hf(ful.pick, ful.pack))}
${edge("ff3", hf(ful.pack, ful.quality))}
${edge("ff4", hf(ful.quality, ful.gwQc))}
${edge("ff5", hf(ful.gwQc, ful.ship))}
${edge("ff6", [[mid(ful.gwQc).cx, mid(ful.gwQc).b], [mid(ful.gwQc).cx, mid(ful.gwQc).b + 40], [mid(ful.pick).cx, mid(ful.gwQc).b + 40], [mid(ful.pick).cx, mid(ful.pick).b]])}
${edge("ff7", hf(ful.ship, ful.notify))}
${edge("ff8", hf(ful.notify, ful.end))}

${edge("fif1", hf(fin.start, fin.verify))}
${edge("fif2", hf(fin.verify, fin.invoice))}
${edge("fif3", hf(fin.invoice, fin.send))}
${edge("fif4", hf(fin.send, fin.record))}
${edge("fif5", hf(fin.record, fin.end))}

${edge("MF_order", mf_order)}
${edge("MF_avail", mf_avail)}
${edge("MF_fulfill", mf_fulfill)}
${edge("MF_payment", mf_payment)}
${edge("MF_tracking", mf_tracking)}
${edge("MF_invoice", mf_invoice)}

    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

// ─── Write + open ───────────────────────────────────────────────────
await fs.writeFile("demo-multi-pool.bpmn", xml);
const jsPath = path.resolve("node_modules/bpmn-js/dist/bpmn-navigated-viewer.production.min.js");
const html = `<!DOCTYPE html><html><head><title>MCP-BPMN Demo</title>
<style>html,body{height:100%;margin:0;font-family:system-ui}
#h{background:#1a1a2e;color:#fff;padding:12px 24px;display:flex;align-items:center;gap:16px}
#h h1{font-size:16px;font-weight:600;margin:0}
#h .t{background:#e94560;padding:2px 10px;border-radius:12px;font-size:12px}
#h .i{color:#aaa;font-size:13px;margin-left:auto}
#c{height:calc(100% - 48px);background:#f8f9fa}</style></head><body>
<div id="h"><h1>mcp-bpmn</h1><span class="t">Multi-Pool Demo</span>
<span class="i">4 pools · 6 message flows · Order-to-Cash · Scroll to zoom, drag to pan</span></div>
<div id="c"></div>
<script src="file://${jsPath}"><\/script><script>
window.READY=false;const v=new BpmnJS({container:"#c"});
v.importXML(${JSON.stringify(xml)}).then(()=>{v.get("canvas").zoom("fit-viewport",true);window.READY=true})
.catch(e=>document.getElementById("c").innerHTML="<pre style='padding:20px;color:red'>"+e+"</pre>");
<\/script></body></html>`;
await fs.writeFile("demo-multi-pool.html", html);
console.log("Done");
exec(`open "${path.resolve("demo-multi-pool.html")}"`);

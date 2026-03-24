#!/usr/bin/env node
import { BpmnModdle } from "bpmn-moddle";
import { layoutProcess } from "bpmn-auto-layout";
import { writeFile } from "fs/promises";

const moddle = new BpmnModdle();

const start = moddle.create("bpmn:StartEvent", { id: "Start", name: "Order Received" });
const review = moddle.create("bpmn:UserTask", { id: "Review", name: "Review Order" });
const gw1 = moddle.create("bpmn:ExclusiveGateway", { id: "GW1", name: "Valid?" });
const pay = moddle.create("bpmn:ServiceTask", { id: "Process", name: "Process Payment" });
const reject = moddle.create("bpmn:UserTask", { id: "Reject", name: "Reject Order" });
const gw2 = moddle.create("bpmn:ExclusiveGateway", { id: "GW2", name: "Payment OK?" });
const ship = moddle.create("bpmn:ServiceTask", { id: "Ship", name: "Ship Order" });
const retry = moddle.create("bpmn:UserTask", { id: "Retry", name: "Retry Payment" });
const notify = moddle.create("bpmn:SendTask", { id: "Notify", name: "Send Confirmation" });
const endOk = moddle.create("bpmn:EndEvent", { id: "EndOk", name: "Order Complete" });
const endNo = moddle.create("bpmn:EndEvent", { id: "EndReject", name: "Order Rejected" });

const elements = [start, review, gw1, pay, reject, gw2, ship, retry, notify, endOk, endNo];
const map = new Map(elements.map(e => [e.id, e]));

function flow(id, from, to, name) {
  const s = map.get(from), t = map.get(to);
  const f = moddle.create("bpmn:SequenceFlow", { id, sourceRef: s, targetRef: t, name });
  (s.outgoing ??= []).push(f);
  (t.incoming ??= []).push(f);
  return f;
}

const flows = [
  flow("F1", "Start", "Review"),
  flow("F2", "Review", "GW1"),
  flow("F3", "GW1", "Process", "Yes"),
  flow("F4", "GW1", "Reject", "No"),
  flow("F5", "Process", "GW2"),
  flow("F6", "GW2", "Ship", "Success"),
  flow("F7", "GW2", "Retry", "Failed"),
  flow("F8", "Retry", "Process"),
  flow("F9", "Ship", "Notify"),
  flow("F10", "Notify", "EndOk"),
  flow("F11", "Reject", "EndReject"),
];

const proc = moddle.create("bpmn:Process", {
  id: "OrderProcess", name: "Order Processing", isExecutable: true,
  flowElements: [...elements, ...flows],
});
const defs = moddle.create("bpmn:Definitions", {
  id: "Definitions_1", targetNamespace: "http://bpmn.io/schema/bpmn",
  rootElements: [proc],
});

const { xml: rawXml } = await moddle.toXML(defs, { format: true });
await writeFile("sample-raw.bpmn", rawXml);
console.log("wrote sample-raw.bpmn  (no layout — invisible in viewers)");

const prettyXml = await layoutProcess(rawXml);
await writeFile("sample-pretty.bpmn", prettyXml);
console.log("wrote sample-pretty.bpmn  (with full BPMNDI layout)");

console.log(`\n  raw:    ${rawXml.length} chars`);
console.log(`  pretty: ${prettyXml.length} chars  (+${prettyXml.length - rawXml.length} chars of layout)\n`);

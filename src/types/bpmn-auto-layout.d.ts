declare module "bpmn-auto-layout" {
  export function layoutProcess(xmlStr: string): Promise<string>;
}

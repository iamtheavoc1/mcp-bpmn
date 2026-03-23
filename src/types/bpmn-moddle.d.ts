declare module "bpmn-moddle" {
  interface ModdleElement {
    $type: string;
    id?: string;
    name?: string;
    [key: string]: any;
  }

  interface ParseResult {
    rootElement: ModdleElement;
    references: any[];
    warnings: any[];
    elementsById: Record<string, ModdleElement>;
  }

  interface SerializationResult {
    xml: string;
  }

  export class BpmnModdle {
    constructor(packages?: any, options?: any);
    fromXML(
      xmlStr: string,
      typeName?: string,
      options?: any
    ): Promise<ParseResult>;
    toXML(element: ModdleElement, options?: any): Promise<SerializationResult>;
    create(type: string, attrs?: Record<string, any>): ModdleElement;
    getType(type: string): any;
    hasType(element: ModdleElement, type: string): boolean;
  }
}

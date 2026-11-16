import { XMLParser, XMLValidator } from "fast-xml-parser";

// Preserve ordered text/markup and resolve namespaces in their lexical scope.
// Removing prefixes globally would also discard RSS extension identity.
const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  processEntities: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  maxNestedTags: 100,
});
export interface XmlElement {
  name: string;
  namespace: string;
  attributes: Record<string, string>;
  children: (XmlElement | string)[];
  base: string;
}
type OrderedNode = Record<string, unknown>;
function elements(
  nodes: OrderedNode[],
  parentNamespaces: Map<string, string>,
  base: string,
): (XmlElement | string)[] {
  return nodes.flatMap<XmlElement | string>((node) => {
    const name = Object.keys(node).find((key) => key !== ":@");
    if (!name || name.startsWith("?") || name.startsWith("#comment")) return [];
    if (name === "#text") return [String(node[name])];
    const attributes = (node[":@"] ?? {}) as Record<string, string>;
    const namespaces = new Map(parentNamespaces);
    for (const [key, value] of Object.entries(attributes)) {
      if (key === "xmlns") namespaces.set("", value);
      else if (key.startsWith("xmlns:")) namespaces.set(key.slice(6), value);
    }
    for (const [key, value] of Object.entries(attributes)) {
      const separator = key.indexOf(":");
      if (separator > 0 && namespaces.has(key.slice(0, separator)))
        attributes[
          `{${namespaces.get(key.slice(0, separator))}}${key.slice(separator + 1)}`
        ] = value;
    }
    const colon = name.indexOf(":");
    const prefix = colon < 0 ? "" : name.slice(0, colon);
    const localName = colon < 0 ? name : name.slice(colon + 1);
    let elementBase = base;
    if (attributes["xml:base"]) {
      try {
        elementBase = new URL(attributes["xml:base"], base).href;
      } catch {
        /* Invalid bases leave links unavailable at resolution. */ elementBase =
          attributes["xml:base"];
      }
    }
    return [
      {
        name: localName,
        namespace:
          namespaces.get(prefix) ?? (prefix ? `unbound:${prefix}` : ""),
        attributes,
        base: elementBase,
        children: elements(
          node[name] as OrderedNode[],
          namespaces,
          elementBase,
        ),
      },
    ];
  });
}
const predefinedEntities = new Set(["amp", "lt", "gt", "quot", "apos"]);
const unsafeDeclaration = /<!DOCTYPE|<!ENTITY/i;
const isWellFormed = (xml: string) => XMLValidator.validate(xml) === true;

// Escapes only a bare `&` that does not begin a predefined or numeric reference.
// CDATA sections, comments and processing instructions are copied unchanged.
export function repairBareAmpersands(xml: string): {
  xml: string;
  repairs: number;
} {
  let repairs = 0;
  const repaired = xml.replace(
    /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|&([A-Za-z_][\w.-]*|#[0-9]+|#x[0-9a-fA-F]+);|&/g,
    (match, reference: string | undefined) => {
      if (match.startsWith("<")) return match;
      if (reference !== undefined && reference.startsWith("#")) return match;
      if (reference !== undefined && predefinedEntities.has(reference))
        return match;
      repairs++;
      return reference === undefined ? "&amp;" : `&amp;${reference};`;
    },
  );
  return { xml: repaired, repairs };
}

export function validateXml(xml: string): { xml: string; repairs: number } {
  if (unsafeDeclaration.test(xml))
    throw new Error("Invalid or unsafe feed XML");
  if (isWellFormed(xml)) return { xml, repairs: 0 };
  const repaired = repairBareAmpersands(xml);
  if (
    repaired.repairs === 0 ||
    unsafeDeclaration.test(repaired.xml) ||
    !isWellFormed(repaired.xml)
  )
    throw new Error("Invalid or unsafe feed XML");
  return repaired;
}

export function parseXml(
  xml: string,
  base: string,
  diagnostics?: { repairs: number },
): XmlElement {
  const checked = validateXml(xml);
  if (diagnostics) diagnostics.repairs = checked.repairs;
  const root = elements(
    parser.parse(checked.xml) as OrderedNode[],
    new Map(),
    base,
  ).find((node): node is XmlElement => typeof node !== "string");
  if (!root) throw new Error("Expected RSS or Atom feed");
  return root;
}
export function childElements(
  node: XmlElement,
  name: string,
  namespace = node.namespace,
): XmlElement[] {
  return node.children.filter(
    (child): child is XmlElement =>
      typeof child !== "string" &&
      child.name === name &&
      child.namespace === namespace,
  );
}
export function child(
  node: XmlElement,
  name: string,
  namespace = node.namespace,
): XmlElement | undefined {
  return childElements(node, name, namespace)[0];
}
export function xmlText(node: XmlElement | undefined): string {
  return (
    node?.children
      .map((c) => (typeof c === "string" ? c : xmlText(c)))
      .join("") ?? ""
  );
}
const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
export function xhtmlMarkup(node: XmlElement): string {
  return node.children
    .map((c) => {
      if (typeof c === "string") return escapeHtml(c);
      // The HTML view uses local names, so prefixed XHTML anchors remain anchors.
      const attrs = Object.entries(c.attributes)
        .filter(([key]) => !key.startsWith("xmlns") && !key.startsWith("{"))
        .map(([key, value]) => {
          if (key === "href") {
            try {
              value = new URL(value, c.base).href;
            } catch {
              /* Validation occurs at candidate resolution. */
            }
          }
          return ` ${key}="${escapeHtml(value)}"`;
        })
        .join("");
      return `<${c.name}${attrs}>${xhtmlMarkup(c)}</${c.name}>`;
    })
    .join("");
}

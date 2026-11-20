import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";

type H = (type: any, props?: any, ...children: any[]) => any;

const URL = /\bhttps?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g;

function linkify(h: H, text: string, key: string): any[] {
  const out: any[] = [];
  let last = 0;
  for (const match of text.matchAll(URL)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push(h("a", { key: `${key}-${at}`, href: match[0], target: "_blank", rel: "noreferrer" }, match[0]));
    last = at + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function render(h: H, node: Nodes, key: string): any {
  const kids = () => ("children" in node ? (node.children as Nodes[]).map((child, i) => render(h, child, `${key}.${i}`)) : []);
  switch (node.type) {
    case "root":
      return h("div", { key, className: "bv-md" }, ...kids());
    case "paragraph":
      return h("p", { key }, ...kids());
    case "text":
      return h("span", { key }, ...linkify(h, node.value, key));
    case "strong":
      return h("strong", { key }, ...kids());
    case "emphasis":
      return h("em", { key }, ...kids());
    case "delete":
      return h("del", { key }, ...kids());
    case "inlineCode":
      return h("code", { key }, node.value);
    case "code":
      return h("pre", { key }, h("code", null, node.value));
    case "link":
      return h("a", { key, href: node.url, target: "_blank", rel: "noreferrer" }, ...kids());
    case "image":
      return h("a", { key, href: node.url, target: "_blank", rel: "noreferrer" }, node.alt || node.url);
    case "heading":
      return h("p", { key, className: "bv-md-heading" }, ...kids());
    case "blockquote":
      return h("blockquote", { key }, ...kids());
    case "list":
      return h(node.ordered ? "ol" : "ul", { key, start: node.ordered ? (node.start ?? undefined) : undefined }, ...kids());
    case "listItem":
      return h("li", { key }, node.checked == null ? null : node.checked ? "☑ " : "☐ ", ...kids());
    case "break":
      return h("br", { key });
    case "thematicBreak":
      return h("hr", { key });
    case "html":
      return h("span", { key }, node.value);
    default:
      return "value" in node && typeof node.value === "string" ? h("span", { key }, node.value) : h("span", { key }, ...kids());
  }
}

export function markdown(h: H, text: string): any {
  try {
    return render(h, fromMarkdown(text), "md");
  } catch {
    return h("p", { className: "bv-md" }, text);
  }
}

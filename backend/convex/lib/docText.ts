import { LIMITS } from "./constants";

type PMNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
};

function inline(nodes: PMNode[] | undefined): string {
  let out = "";
  for (const node of nodes ?? []) {
    if (node.type === "text") out += node.text ?? "";
    else if (node.type === "hardBreak") out += "\n";
    else if (node.type === "mention") out += `@${String(node.attrs?.label ?? node.attrs?.id ?? "")}`;
    else out += inline(node.content);
  }
  return out;
}

function blocks(nodes: PMNode[] | undefined, prefix = ""): string[] {
  const lines: string[] = [];
  for (const node of nodes ?? []) {
    switch (node.type) {
      case "heading": {
        const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)));
        lines.push(`${prefix}${"#".repeat(level)} ${inline(node.content)}`);
        break;
      }
      case "paragraph":
        lines.push(`${prefix}${inline(node.content)}`);
        break;
      case "bulletList":
      case "orderedList":
      case "taskList":
        node.content?.forEach((item, i) => {
          const marker =
            node.type === "orderedList" ? `${i + 1}. ` : node.type === "taskList" ? (item.attrs?.checked ? "- [x] " : "- [ ] ") : "- ";
          const [first = "", ...rest] = blocks(item.content);
          lines.push(`${prefix}${marker}${first}`, ...rest.map((line) => `${prefix}  ${line}`));
        });
        break;
      case "blockquote":
        lines.push(...blocks(node.content, `${prefix}> `));
        break;
      case "codeBlock":
        lines.push(`${prefix}\`\`\``, ...inline(node.content).split("\n").map((l) => prefix + l), `${prefix}\`\`\``);
        break;
      case "horizontalRule":
        lines.push(`${prefix}---`);
        break;
      default:
        if (node.content) lines.push(...blocks(node.content, prefix));
        else if (node.text) lines.push(prefix + node.text);
    }
  }
  return lines;
}

/** Markdown-ish plain text of a saved ProseMirror snapshot, capped for the model. */
export function snapshotText(snapshot: string | null | undefined): string {
  if (!snapshot) return "";
  let root: PMNode;
  try {
    root = JSON.parse(snapshot) as PMNode;
  } catch {
    return "";
  }
  const text = blocks(root.content)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > LIMITS.aiDocText ? text.slice(0, LIMITS.aiDocText) : text;
}

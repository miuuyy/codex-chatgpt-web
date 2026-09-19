import { micromark } from "micromark";
import { gfmAutolinkLiteral, gfmAutolinkLiteralHtml } from "micromark-extension-gfm-autolink-literal";
export function render(value: string): string {
  return micromark(value, { extensions: [gfmAutolinkLiteral()], htmlExtensions: [gfmAutolinkLiteralHtml()] });
}

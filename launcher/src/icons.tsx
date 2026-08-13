import type { SVGProps } from "react";

export type IconName =
  | "activity"
  | "alert"
  | "back"
  | "browser"
  | "check"
  | "chevron"
  | "close"
  | "external"
  | "forward"
  | "github"
  | "globe"
  | "logs"
  | "mcp"
  | "minus"
  | "plus"
  | "reload"
  | "settings"
  | "setup"
  | "sidebar"
  | "update"
  | "x";

export function Icon({ name, ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  const common = { fill: "none", stroke: "currentColor", strokeLinecap: "round" as const, strokeLinejoin: "round" as const, strokeWidth: 1.7 };
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" {...props}>
      {name === "activity" ? <><path {...common} d="M3 12h4l2.2-6 4.1 12 2.3-6H21" /></> : null}
      {name === "alert" ? <><path {...common} d="M10.3 4.2 2.8 17.1A2 2 0 0 0 4.5 20h15a2 2 0 0 0 1.7-2.9L13.7 4.2a2 2 0 0 0-3.4 0Z" /><path {...common} d="M12 9v4M12 16.5h.01" /></> : null}
      {name === "back" ? <path {...common} d="m14.5 6-6 6 6 6" /> : null}
      {name === "browser" ? <><rect {...common} x="3" y="4" width="18" height="16" rx="3" /><path {...common} d="M3 9h18M7 6.5h.01M10 6.5h.01" /></> : null}
      {name === "check" ? <path {...common} d="m5 12.5 4.2 4.2L19 7" /> : null}
      {name === "chevron" ? <path {...common} d="m9 6 6 6-6 6" /> : null}
      {name === "close" ? <path {...common} d="m6 6 12 12M18 6 6 18" /> : null}
      {name === "external" ? <><path {...common} d="M14 5h5v5M19 5l-8 8" /><path {...common} d="M18 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></> : null}
      {name === "forward" ? <path {...common} d="m9.5 6 6 6-6 6" /> : null}
      {name === "github" ? <path fill="currentColor" d="M12 2.6a9.6 9.6 0 0 0-3 18.7c.5.1.7-.2.7-.5v-1.9c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 0 1.6 1.1 1.6 1.1.9 1.6 2.4 1.1 3 .8.1-.7.4-1.1.7-1.4-2.3-.3-4.7-1.1-4.7-4.8 0-1.1.4-2 1-2.6-.1-.3-.4-1.3.1-2.6 0 0 .8-.3 2.7 1a9.3 9.3 0 0 1 4.9 0c1.9-1.3 2.7-1 2.7-1 .5 1.3.2 2.3.1 2.6.7.7 1 1.5 1 2.6 0 3.7-2.4 4.5-4.7 4.8.4.3.7 1 .7 1.9v2.8c0 .4.2.6.7.5A9.6 9.6 0 0 0 12 2.6Z" /> : null}
      {name === "globe" ? <><circle {...common} cx="12" cy="12" r="9" /><path {...common} d="M3 12h18M12 3c2.4 2.4 3.6 5.4 3.6 9S14.4 18.6 12 21c-2.4-2.4-3.6-5.4-3.6-9S9.6 5.4 12 3Z" /></> : null}
      {name === "logs" ? <><path {...common} d="M6 4h12v16H6zM9 8h6M9 12h6M9 16h4" /></> : null}
      {name === "mcp" ? <><path {...common} d="M8 7.5 12 4l4 3.5v5L12 16l-4-3.5v-5Z" /><path {...common} d="m8 12.5-3 2.7v3.3L8 21l3-2.5V16M16 12.5l3 2.7v3.3L16 21l-3-2.5V16" /></> : null}
      {name === "minus" ? <path {...common} d="M5 12h14" /> : null}
      {name === "plus" ? <path {...common} d="M5 12h14M12 5v14" /> : null}
      {name === "reload" ? <><path {...common} d="M19 8a8 8 0 1 0 .3 7" /><path {...common} d="M19 4v4h-4" /></> : null}
      {name === "settings" ? <><circle {...common} cx="12" cy="12" r="3" /><path {...common} d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.97 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15 1.7 1.7 0 0 0 3.08 14H3v-4h.08A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 8.97 4.6 1.7 1.7 0 0 0 10 3.08V3h4v.08A1.7 1.7 0 0 0 15.03 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9 1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z" /></> : null}
      {name === "setup" ? <><path {...common} d="M14.7 6.3a4 4 0 0 0-5 5L4 17l3 3 5.7-5.7a4 4 0 0 0 5-5l-2.5 2.5-3-3 2.5-2.5Z" /></> : null}
      {name === "sidebar" ? <><rect {...common} x="3" y="4" width="18" height="16" rx="2.5" /><path {...common} d="M9 4v16" /></> : null}
      {name === "update" ? <><path {...common} d="M12 3v12M7.5 10.5 12 15l4.5-4.5" /><path {...common} d="M5 19h14" /></> : null}
      {name === "x" ? <path fill="currentColor" d="M5 4h3.9l3.8 5.1L17.1 4H19l-5.4 6.4L19.5 20h-3.9l-4.1-5.6L6.7 20H4.8l5.8-6.9L5 4Zm3 1.5 8.4 13h1.2l-8.4-13H8Z" /> : null}
    </svg>
  );
}

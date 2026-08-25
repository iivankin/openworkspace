import { Check, Clipboard } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const MCP_TOKEN_PLACEHOLDER = "<YOUR_API_TOKEN>";

type McpClient = {
  id: string;
  label: string;
  hint: string;
  snippet: (url: string, token: string) => string;
};

const MCP_CLIENTS: McpClient[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    hint: "Run in your terminal:",
    snippet: (url, token) => [
      "claude mcp add openworkspace \\",
      "  --transport http \\",
      `  ${url} \\`,
      `  -H "Authorization: Bearer ${token}"`,
    ].join("\n"),
  },
  {
    id: "opencode",
    label: "OpenCode",
    hint: "Add to opencode.jsonc:",
    snippet: (url, token) => JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      mcp: {
        servers: {
          openworkspace: {
            type: "remote",
            url,
            oauth: false,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      },
    }, null, 2),
  },
  {
    id: "codex",
    label: "Codex",
    hint: "Add to ~/.codex/config.toml:",
    snippet: (url, token) => [
      "[mcp_servers.openworkspace]",
      `url = "${url}"`,
      "",
      "[mcp_servers.openworkspace.http_headers]",
      `Authorization = "Bearer ${token}"`,
    ].join("\n"),
  },
  {
    id: "cursor",
    label: "Cursor",
    hint: "Add to .cursor/mcp.json in your project:",
    snippet: (url, token) => JSON.stringify({
      mcpServers: {
        openworkspace: {
          url,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    }, null, 2),
  },
  {
    id: "vscode",
    label: "VS Code",
    hint: "Add to .vscode/mcp.json in your project:",
    snippet: (url, token) => JSON.stringify({
      servers: {
        openworkspace: {
          type: "http",
          url,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    }, null, 2),
  },
  {
    id: "windsurf",
    label: "Windsurf",
    hint: "Add to ~/.codeium/windsurf/mcp_config.json:",
    snippet: (url, token) => JSON.stringify({
      mcpServers: {
        openworkspace: {
          url,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    }, null, 2),
  },
  {
    id: "zed",
    label: "Zed",
    hint: "Add to your Zed settings.json:",
    snippet: (url, token) => JSON.stringify({
      context_servers: {
        openworkspace: {
          url,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    }, null, 2),
  },
  {
    id: "cline",
    label: "Cline",
    hint: "Add via MCP Servers or cline_mcp_settings.json:",
    snippet: (url, token) => JSON.stringify({
      mcpServers: {
        openworkspace: {
          type: "streamableHttp",
          url,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    }, null, 2),
  },
];

export function McpConnectionGuide({
  className,
  endpoint,
  token = MCP_TOKEN_PLACEHOLDER,
  title = "Connect a client",
}: {
  className?: string;
  endpoint: string;
  token?: string;
  title?: string;
}) {
  const [clientId, setClientId] = useState(MCP_CLIENTS[0].id);
  const [copied, setCopied] = useState(false);
  const client = MCP_CLIENTS.find((item) => item.id === clientId) ?? MCP_CLIENTS[0];
  const snippet = client.snippet(endpoint, token);

  async function copySnippet() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      toast.success(`${client.label} config copied`);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      toast.error("Client config could not be copied");
    }
  }

  return (
    <section className={cn("space-y-3", className)}>
      <div>
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Choose your MCP client and copy its configuration.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="MCP clients">
        {MCP_CLIENTS.map((item) => (
          <Button
            key={item.id}
            type="button"
            variant="outline"
            size="xs"
            role="tab"
            aria-selected={clientId === item.id}
            className={cn(
              "font-normal",
              clientId === item.id && "border-primary/50 bg-primary/12 text-foreground",
            )}
            onClick={() => {
              setClientId(item.id);
              setCopied(false);
            }}
          >
            {item.label}
          </Button>
        ))}
      </div>

      <div className="space-y-2" role="tabpanel">
        <p className="text-xs text-muted-foreground">{client.hint}</p>
        <div className="relative overflow-hidden bg-surface-sunken ring-1 ring-border">
          <pre className="max-h-72 overflow-auto p-4 pr-24 font-mono text-[11px] leading-relaxed text-foreground">
            {snippet}
          </pre>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="absolute top-2 right-2 bg-surface/90 backdrop-blur-sm"
            onClick={() => void copySnippet()}
          >
            {copied ? <Check /> : <Clipboard />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>

      {token === MCP_TOKEN_PLACEHOLDER ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Replace <code className="font-mono text-foreground/75">{MCP_TOKEN_PLACEHOLDER}</code> with a token created below.
        </p>
      ) : null}
    </section>
  );
}

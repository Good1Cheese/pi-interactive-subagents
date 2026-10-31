import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Compatibility alias; the separately loaded dcg guard checks both shell tools. */
export default function (pi: ExtensionAPI) {
  const bashTool = createBashTool(process.cwd());
  pi.registerTool({
    name: "safe_bash",
    label: "Bash (dcg checked when available)",
    description: "Execute a bash command. dcg checks it when installed; this is not an OS sandbox.",
    parameters: Type.Object({
      command: Type.String({ description: "Bash command to execute" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate) {
      return bashTool.execute(toolCallId, params, signal, onUpdate);
    },
  });
}

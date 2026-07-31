import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBgModule } from "./src/bg.js";
import { JobManager } from "./src/manager.js";
import { registerSubagentModule } from "./src/subagent.js";

export default async function (pi: ExtensionAPI) {
  const manager = new JobManager(pi);
  manager.init();

  registerBgModule(pi, manager);
  registerSubagentModule(pi, manager);
}

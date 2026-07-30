import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBgModule } from "./src/bg.js";
import { JobManager } from "./src/manager.js";
import { registerSubagentModule } from "./src/subagent.js";
import { loadCustomProviders } from "./src/utils.js";

export default function (pi: ExtensionAPI) {
  const manager = new JobManager(pi);
  manager.init();

  void loadCustomProviders(pi);

  registerBgModule(pi, manager);
  registerSubagentModule(pi, manager);
}

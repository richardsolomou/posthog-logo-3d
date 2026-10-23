import { defineConfig, oxfmt, oxlint } from "ras-stack/config";

export default defineConfig({
  tooling: [oxfmt, oxlint],
});

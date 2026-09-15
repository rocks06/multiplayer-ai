import {defineConfig,devices} from '@playwright/test';

// Component-browser isolation: no API server, database, seed or truncate hooks.
export default defineConfig({
  testDir:'.',testMatch:['attachments.playwright.ts','empty-room-layout.playwright.ts'],workers:1,
  use:{...devices['Desktop Chrome'],viewport:{width:1024,height:640}},
  outputDir:'../../test-results/attachments',
});

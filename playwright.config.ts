import {defineConfig,devices} from '@playwright/test';

export default defineConfig({
 testDir:'./tests/e2e',testMatch:['room-ui.playwright.ts','artifact-stabilization.playwright.ts','mentions-unread.playwright.ts'],fullyParallel:false,workers:1,timeout:45_000,
 expect:{timeout:7_000},use:{baseURL:'http://127.0.0.1:4310',trace:'retain-on-failure',screenshot:'only-on-failure',viewport:{width:1440,height:960}},
 webServer:{command:'pnpm build && pnpm exec tsx tests/e2e/ui-server.ts',url:'http://127.0.0.1:4310/__e2e/fixture',reuseExistingServer:false,timeout:120_000},
 projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}],
 outputDir:'test-results/playwright'
});

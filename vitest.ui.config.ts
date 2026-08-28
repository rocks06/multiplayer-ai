import {defineConfig} from 'vitest/config';

export default defineConfig({
  test:{
    testTimeout:20_000,
    hookTimeout:20_000,
    fileParallelism:false,
    include:['tests/room-ui.test.tsx','tests/marketing-site.test.tsx'],
  },
});

import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root:'apps/marketing',
  plugins:[react()],
  build:{outDir:'../../dist/marketing',emptyOutDir:true,target:'es2022'},
  server:{port:4174},
});

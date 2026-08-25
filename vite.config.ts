import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root:'apps/web',
  plugins:[react()],
  build:{outDir:'../../dist/web',emptyOutDir:true,target:'es2022'},
  server:{port:4173,proxy:{'/v1':{target:'http://127.0.0.1:4100',ws:true},'/health':'http://127.0.0.1:4100'}},
});
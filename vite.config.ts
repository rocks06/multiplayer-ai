import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget=process.env.VITE_API_TARGET??'http://127.0.0.1:4100';

export default defineConfig({
  root:'apps/web',
  plugins:[react()],
  build:{outDir:'../../dist/web',emptyOutDir:true,target:'es2022'},
  server:{port:4173,proxy:{'/v1':{target:apiTarget,ws:true},'/health':apiTarget}},
});
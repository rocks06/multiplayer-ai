import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root:'apps/marketing',
  plugins:[react()],
  build:{
    outDir:'../../dist/marketing',emptyOutDir:true,target:'es2022',
    /* Two pages, not one. The sign-in page is where an emailed link lands: it carries no
       application code, only enough to hand the token to the Mac app and get out of the way. */
    rollupOptions:{input:{
      index:'apps/marketing/index.html',
      signin:'apps/marketing/signin.html',
      download:'apps/marketing/download.html',
    }},
  },
  server:{port:4174},
});

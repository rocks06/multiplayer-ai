import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import MarketingSite from './MarketingSite';
import './marketing.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode><MarketingSite/></StrictMode>,
);

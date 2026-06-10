/// <reference types="@dotuix/types" />
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { Report } from './Report';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Report />
  </StrictMode>,
);

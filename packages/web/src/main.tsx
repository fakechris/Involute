import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './App';
import { WorkReferenceProvider } from './components/WorkReference';
import { AppApolloProvider } from './lib/apollo';
import { RevisitRefresh } from './lib/revisit-refresh';
import './styles/app.css';
import './styles/controls.css';
import './styles/layout.css';
import './styles/in-review.css';
import './styles/content.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <AppApolloProvider>
      <BrowserRouter>
        <RevisitRefresh />
        {/* The references in prose ask the server about themselves (INV-1466). */}
        <WorkReferenceProvider>
          <App />
        </WorkReferenceProvider>
      </BrowserRouter>
    </AppApolloProvider>
  </React.StrictMode>,
);

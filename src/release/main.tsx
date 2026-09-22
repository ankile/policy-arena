import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { selectedTask, validateRelease } from './types';
import type { Release } from './types';
import App from './App';

const root = createRoot(document.getElementById('root')!);
fetch('/data/release.json').then(async response => {
  if (!response.ok) throw new Error(`Release data returned ${response.status}`);
  const data = validateRelease(await response.json() as Release);
  selectedTask(data, new URLSearchParams(location.search).get('task'));
  root.render(<StrictMode><App data={data} /></StrictMode>);
}).catch(error => root.render(<main className="release-error"><h1>Release unavailable</h1><p>{String(error)}</p><a href="/">Return to the release overview</a></main>));

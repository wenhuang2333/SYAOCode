import { createRoot } from 'react-dom/client';
import { useWorkbench } from './use-workbench';
import { WorkbenchView } from './workbench';
import '@syaocode/ui/styles.css';
import './workbench.css';
import './dashboard.css';

function App() {
  const workbench = useWorkbench();
  return <WorkbenchView w={workbench} />;
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
